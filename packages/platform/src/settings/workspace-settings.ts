/**
 * Workspace settings updates — the STORAGE layer.
 *
 * `04-platform/workspaces.md` §Non-responsibilities: this service owns the
 * `workspaces.settings` column as storage and does NOT resolve how a workspace
 * value combines with an organization default or a project override. That is
 * `settings.md` and Proposed ADR-024. Nothing here reads a setting to decide
 * anything; it only records what an administrator declared.
 *
 * ── Append-only history ─────────────────────────────────────────────────────
 * `workspace_settings_history` has no `version`, no `deleted_at` and no
 * `updated_*`, and UPDATE/DELETE are revoked from `contentos_app` at the role
 * level (migration 0004). Append-only is a privilege, not a convention, so
 * there is no code path here that could amend a past entry even by mistake.
 *
 * ── Changed keys only, and only changed values ──────────────────────────────
 * `changed_keys` carries the names that differ, and `before`/`after` carry ONLY
 * those keys. Writing the whole settings object into every history row would
 * copy unchanged secrets forward on every edit and make "what actually changed"
 * a diff someone has to compute later. `ck_workspace_settings_history__keys_present`
 * requires at least one key, which is the database agreeing that a no-op edit
 * is not an event in the history.
 */

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type { AuditContext, AuditWriter, NewAuditRecord } from '@contentos/security';
import { roleCatalogue, secureId, WORKSPACE_ROLES, type WorkspaceRole } from '@contentos/security';

import { isWorkspaceStatus, type WorkspaceStatus } from '../workspaces/lifecycle.js';
import {
  changedSettingsKeys,
  WORKSPACE_SETTINGS_KEYS,
  type WorkspaceSettings,
  type WorkspaceSettingsKey,
} from '../workspaces/settings.js';
import { workspaceSettingsUpdated, type SettingsEventContext } from './events.js';

export interface SettingsExecutor extends Transaction {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

export interface SettingsActor {
  readonly id: string;
  readonly kind: 'user' | 'api-key' | 'service' | 'operator';
}

export const WORKSPACE_SETTINGS_AUDIT_ACTION = 'workspace.settings.updated';

/**
 * The permission a settings change requires, taken from the existing catalogue
 * rather than re-deriving "owner and admin" as a second list.
 *
 * `workspace.md` rule 15 says only owner and admin may change settings; in the
 * four roles the schema and catalogue define, `workspace:update` is held by
 * `workspace_admin` alone, which is the owner-equivalent.
 */
export const SETTINGS_UPDATE_PERMISSION = 'workspace:update';

/**
 * Statuses in which settings may still be written.
 *
 * `archived` is "read-only permanently" (rule 17) and `pending_deletion` opens a
 * read-only recovery window (rule 18); both refuse writes. `suspended` is
 * defined by what it blocks — new runs and publishing (rule 16) — and settings
 * are not on that list, so they remain editable. Stated as data rather than as
 * a condition, so a future state has to be classified rather than defaulted.
 */
export const SETTINGS_WRITABLE_STATUSES: readonly WorkspaceStatus[] = ['active', 'suspended'];

export type SettingsErrorCode =
  | 'WorkspaceNotFound'
  | 'ConcurrentModification'
  | 'SettingsNotWritable'
  | 'NotPermitted'
  | 'ActorNotMember';

export class WorkspaceSettingsError extends Error {
  readonly code: SettingsErrorCode;

  constructor(code: SettingsErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceSettingsError';
    this.code = code;
  }
}

const SELECT_WORKSPACE_SQL = `
  SELECT id, organization_id, status, settings, version
    FROM workspaces
   WHERE id = $1 AND deleted_at IS NULL`;

const SELECT_ACTOR_MEMBERSHIP_SQL = `
  SELECT role, status
    FROM workspace_memberships
   WHERE tenant_id = $1 AND user_id = $2`;

const UPDATE_SETTINGS_SQL = `
  UPDATE workspaces
     SET settings = $1, version = version + 1, updated_at = now(), updated_by = $2
   WHERE id = $3 AND version = $4 AND deleted_at IS NULL
  RETURNING version`;

/** Append-only: no id to update, no row to amend, by privilege. */
const INSERT_HISTORY_SQL = `
  INSERT INTO workspace_settings_history (
    tenant_id, organization_id, changed_keys, before, after, changed_by
  ) VALUES ($1,$2,$3,$4,$5,$6)
  RETURNING id`;

interface WorkspaceRow {
  readonly id: string;
  readonly organization_id: string;
  readonly status: string;
  readonly settings: unknown;
  readonly version: number;
}

function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/**
 * The stored column is JSONB, so a driver may hand back an object or a string
 * depending on its parsing configuration. Both are accepted; anything else
 * reads as "no settings recorded" rather than throwing, because a malformed
 * column should not make a workspace uneditable.
 */
function parseSettings(value: unknown): Partial<WorkspaceSettings> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Partial<WorkspaceSettings>;
    } catch {
      return {};
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Partial<WorkspaceSettings>;
  }
  return {};
}

/** Only the named keys, so an unchanged value is never copied into history. */
function project(
  settings: Partial<WorkspaceSettings>,
  keys: readonly WorkspaceSettingsKey[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = settings[key] ?? null;
  }
  return out;
}

export interface WorkspaceSettingsServiceOptions {
  readonly publisher: EventPublisher;
  readonly audit: AuditWriter;
  readonly now?: () => Date;
  readonly newEventId?: () => string;
}

export interface UpdateWorkspaceSettingsCommand {
  readonly workspaceId: string;
  readonly organizationId: string;
  /** Only the keys being changed need to be present. */
  readonly patch: Partial<WorkspaceSettings>;
  readonly actor: SettingsActor;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly reason?: string;
  readonly expectedVersion?: number;
  readonly context?: AuditContext;
}

export interface WorkspaceSettingsResult {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly changedKeys: readonly WorkspaceSettingsKey[];
  readonly settings: Partial<WorkspaceSettings>;
  readonly version: number;
  /** False when the patch changed nothing: no history row, no audit, no event. */
  readonly changed: boolean;
  readonly historyId: string | null;
  readonly event: DomainEvent<unknown> | null;
}

export interface WorkspaceSettingsService {
  update(
    tx: SettingsExecutor,
    command: UpdateWorkspaceSettingsCommand,
  ): Promise<WorkspaceSettingsResult>;
}

const EMPTY_CONTEXT: AuditContext = {
  ipAddress: null,
  userAgent: null,
  sessionId: null,
  stepUpSatisfied: false,
};

export function createWorkspaceSettingsService(
  options: WorkspaceSettingsServiceOptions,
): WorkspaceSettingsService {
  const now = options.now ?? ((): Date => new Date());
  const newEventId = options.newEventId ?? secureId;
  const { publisher, audit } = options;

  /**
   * The audit record for a settings change.
   *
   * `changedKeys` is recorded; the values are NOT. Rule 15 asks for
   * before/after, and the append-only history row carries exactly that under
   * the same RLS as the settings themselves. The audit trail is read far more
   * widely, so it names what changed and points at the history entry.
   */
  function auditEntry(
    command: UpdateWorkspaceSettingsCommand,
    changedKeys: readonly string[],
    historyId: string,
  ): NewAuditRecord {
    return {
      tenantId: command.workspaceId,
      organizationId: command.organizationId,
      actorId: command.actor.id,
      actorKind: command.actor.kind,
      correlationId: command.correlationId,
      action: WORKSPACE_SETTINGS_AUDIT_ACTION,
      target: {
        kind: 'workspace_settings',
        id: command.workspaceId,
        tenantId: command.workspaceId,
      },
      result: 'success',
      reason: command.reason ?? 'Workspace settings updated.',
      context: {
        ...(command.context ?? EMPTY_CONTEXT),
        detail: {
          ...(command.context ?? EMPTY_CONTEXT).detail,
          changedKeys: changedKeys.join(','),
          settingsHistoryId: historyId,
        },
      },
    };
  }

  async function assertMayUpdate(
    tx: SettingsExecutor,
    command: UpdateWorkspaceSettingsCommand,
  ): Promise<void> {
    // A service or operator actor holds no workspace membership by
    // construction; `actorKind` keeps such an action attributable in the trail.
    if (command.actor.kind !== 'user') return;

    const rows = await tx.query<{ role: string; status: string }>(SELECT_ACTOR_MEMBERSHIP_SQL, [
      command.workspaceId,
      command.actor.id,
    ]);
    const membership = rows[0];
    if (membership === undefined || membership.status !== 'active') {
      throw new WorkspaceSettingsError(
        'ActorNotMember',
        `Actor '${command.actor.id}' holds no active membership in workspace '${command.workspaceId}'.`,
      );
    }
    if (
      !isWorkspaceRole(membership.role) ||
      !roleCatalogue.permissionsOf(membership.role).includes(SETTINGS_UPDATE_PERMISSION)
    ) {
      throw new WorkspaceSettingsError(
        'NotPermitted',
        `Role '${membership.role}' does not hold '${SETTINGS_UPDATE_PERMISSION}'.`,
      );
    }
  }

  return {
    async update(tx, command) {
      const rows = await tx.query<WorkspaceRow>(SELECT_WORKSPACE_SQL, [command.workspaceId]);
      const workspace = rows[0];
      if (workspace === undefined) {
        // Cross-workspace access is answered as absence.
        throw new WorkspaceSettingsError(
          'WorkspaceNotFound',
          `Workspace '${command.workspaceId}' does not exist.`,
        );
      }
      if (!isWorkspaceStatus(workspace.status)) {
        throw new WorkspaceSettingsError(
          'SettingsNotWritable',
          `Workspace '${command.workspaceId}' holds unknown status '${workspace.status}'.`,
        );
      }
      if (!SETTINGS_WRITABLE_STATUSES.includes(workspace.status)) {
        throw new WorkspaceSettingsError(
          'SettingsNotWritable',
          `Workspace '${command.workspaceId}' is '${workspace.status}' and is read-only.`,
        );
      }

      await assertMayUpdate(tx, command);

      const before = parseSettings(workspace.settings);
      // The patch is applied over the stored layer; keys it omits are untouched.
      const after: Partial<WorkspaceSettings> = { ...before };
      for (const key of WORKSPACE_SETTINGS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(command.patch, key)) {
          Object.assign(after, { [key]: command.patch[key] });
        }
      }

      const changedKeys = changedSettingsKeys(before, after);
      if (changedKeys.length === 0) {
        // Nothing changed. The database would refuse a history row with no
        // keys, and an event announcing nothing is noise a consumer must learn
        // to ignore.
        return {
          workspaceId: command.workspaceId,
          organizationId: workspace.organization_id,
          changedKeys: [],
          settings: before,
          version: workspace.version,
          changed: false,
          historyId: null,
          event: null,
        };
      }

      const expectedVersion = command.expectedVersion ?? workspace.version;
      const updated = await tx.query<{ version: number }>(UPDATE_SETTINGS_SQL, [
        JSON.stringify(after),
        command.actor.id,
        command.workspaceId,
        expectedVersion,
      ]);
      const version = updated[0]?.version;
      if (version === undefined) {
        // Concurrent settings edits fail the loser rather than silently
        // overwriting (§Performance).
        throw new WorkspaceSettingsError(
          'ConcurrentModification',
          `Workspace '${command.workspaceId}' changed under this transaction; expected version ${String(expectedVersion)}.`,
        );
      }

      const historyRows = await tx.query<{ id: string }>(INSERT_HISTORY_SQL, [
        command.workspaceId,
        workspace.organization_id,
        [...changedKeys],
        JSON.stringify(project(before, changedKeys)),
        JSON.stringify(project(after, changedKeys)),
        command.actor.id,
      ]);
      const historyId = historyRows[0]?.id;
      if (historyId === undefined) {
        throw new WorkspaceSettingsError(
          'ConcurrentModification',
          'The settings history insert returned no row; the change would be unrecorded.',
        );
      }

      await audit.record(tx, auditEntry(command, changedKeys, historyId));

      const ctx: SettingsEventContext = {
        eventId: newEventId(),
        correlationId: command.correlationId,
        causationId: command.causationId ?? null,
        occurredAt: now().toISOString(),
        organizationId: workspace.organization_id,
      };
      const event = workspaceSettingsUpdated(ctx, {
        workspaceId: command.workspaceId,
        changedKeys: [...changedKeys],
        changedBy: command.actor.id,
      });
      await publisher.publish(tx, event);

      return {
        workspaceId: command.workspaceId,
        organizationId: workspace.organization_id,
        changedKeys,
        settings: after,
        version,
        changed: true,
        historyId,
        event,
      };
    },
  };
}
