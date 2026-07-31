/**
 * Draft management — create, revise, load, list, remove.
 *
 * ── Every change is a new revision ─────────────────────────────────────────
 * There is one write path, `revise`, and it appends. Status moves, input edits
 * and title changes all go through it, so "what did this look like before?" is
 * always answerable and the answer is a record rather than a reconstruction.
 *
 * ── Validation decides what a revision may become ──────────────────────────
 * Moving to READY runs the validator; a draft that does not validate stays a
 * draft and the caller is told every reason. Nothing is ever quietly promoted.
 *
 * ── It executes nothing ────────────────────────────────────────────────────
 * No orchestrator, no runtime, no provider, no dispatch. Submitting a draft
 * marks it submitted and hands back a compiled request; running that request is
 * the caller's decision and the orchestrator's job.
 *
 * ── No clock and no id generator ───────────────────────────────────────────
 * Both injected, for the reason the orchestrator's are: a draft's revision
 * timestamps and its id are things a test must be able to fix, and a service
 * that read a clock could not be asserted on.
 */

import type { WorkflowRegistry } from '../blueprints/registry.js';
import { resolveWorkflow } from '../blueprints/resolve.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { StoredPromptReference, StoredRecordIssue } from '../runs/stored.js';
import type { TemplateLibrary } from '../templates/library.js';
import { resolveTemplate } from '../templates/resolve.js';
import {
  appendRevision,
  draftStatus,
  latestRevision,
  newDraft,
  type ContentDraft,
  type DraftMetadata,
  type RevisionChanges,
} from './draft.js';
import type { DraftListCriteria, DraftRepository } from './repository.js';
import { assertTransitionAllowed, type DraftStatus, type DraftTransition } from './status.js';
import { validateDraft } from './validation.js';

export const DRAFT_SERVICE_CODES = [
  'UnknownDraft',
  'DraftInvalid',
  'IllegalTransition',
  'TenancyMismatch',
  'WorkflowUnresolved',
  'ImmutableDraft',
] as const;

export type DraftServiceCode = (typeof DRAFT_SERVICE_CODES)[number];

export function isDraftServiceCode(value: unknown): value is DraftServiceCode {
  return typeof value === 'string' && (DRAFT_SERVICE_CODES as readonly string[]).includes(value);
}

export interface DraftRefusal {
  readonly outcome: 'refused';
  readonly code: DraftServiceCode;
  /** For operators. Never returned to a caller — see `ai/http.ts`. */
  readonly reason: string;
  readonly issues: readonly StoredRecordIssue[];
}

export type DraftResult = { readonly outcome: 'ok'; readonly draft: ContentDraft } | DraftRefusal;

export type DraftListResult =
  | { readonly outcome: 'ok'; readonly drafts: readonly ContentDraft[] }
  | DraftRefusal;

export type DraftRemovalResult = { readonly outcome: 'ok' } | DraftRefusal;

export interface CreateDraftOptions {
  readonly metadata: DraftMetadata;
  readonly workflowId: string;
  /** Pinned. A draft against `latest-stable` would move under its author. */
  readonly workflowVersion: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly note?: string;
}

export interface ReviseDraftOptions {
  readonly draftId: string;
  readonly transition: DraftTransition;
  readonly changes?: RevisionChanges;
  readonly note: string;
  /** The revision the caller edited. A mismatch means somebody else revised it. */
  readonly expectedRevision?: number;
}

export interface DraftService {
  create(options: CreateDraftOptions): Promise<DraftResult>;
  load(draftId: string): Promise<DraftResult>;
  revise(options: ReviseDraftOptions): Promise<DraftResult>;
  remove(draftId: string): Promise<DraftRemovalResult>;
  list(criteria?: Partial<DraftListCriteria>): Promise<DraftListResult>;
  /** Re-run the validator without changing anything. */
  validate(draftId: string): Promise<DraftResult>;
}

export interface DraftServiceOptions {
  readonly repository: DraftRepository;
  readonly workflows: WorkflowRegistry;
  readonly templates: TemplateLibrary;
  readonly providers?: ProviderRegistry;
  /** Injected. A revision's timestamp must be a value a test can fix. */
  readonly now: () => Date;
  /** Injected. Generation is not pure, and a draft id must be reproducible. */
  readonly newDraftId: () => string;
  /** The most a listing may return. */
  readonly maxListLimit?: number;
}

export const DEFAULT_DRAFT_LIST_LIMIT = 25;
export const MAX_DRAFT_LIST_LIMIT = 100;

const refuse = (
  code: DraftServiceCode,
  reason: string,
  issues: readonly StoredRecordIssue[] = [],
): DraftRefusal => Object.freeze({ outcome: 'refused' as const, code, reason, issues });

const ok = (draft: ContentDraft): DraftResult => Object.freeze({ outcome: 'ok' as const, draft });

export function createDraftService(options: DraftServiceOptions): DraftService {
  const { repository, workflows, templates, now, newDraftId } = options;
  const providerOption = options.providers === undefined ? {} : { providers: options.providers };
  const maxLimit = options.maxListLimit ?? MAX_DRAFT_LIST_LIMIT;

  const validationOf = (draft: ContentDraft) =>
    validateDraft({ draft, workflows, templates, ...providerOption });

  return {
    async create(input: CreateDraftOptions): Promise<DraftResult> {
      // The workflow is resolved at the PINNED version, which is what fixes the
      // template references a draft records.
      const resolution = resolveWorkflow({
        registry: workflows,
        id: input.workflowId,
        selector: { kind: 'explicit', version: input.workflowVersion },
      });
      if (resolution.outcome === 'refused') {
        return refuse('WorkflowUnresolved', resolution.reason);
      }

      const { resolved } = resolution;

      // Resolved once, here, and recorded. Everything afterwards checks against
      // what was recorded rather than resolving again and hoping.
      const references: StoredPromptReference[] = [];
      for (const step of resolved.version.steps) {
        if (step.kind !== 'prompt') continue;
        const templateResolution = resolveTemplate({
          library: templates,
          id: step.templateRef.id,
          selector: step.templateRef.selector,
          capability: resolved.version.capability.capability,
          ...providerOption,
        });
        if (templateResolution.outcome === 'refused') {
          return refuse(
            'DraftInvalid',
            'The workflow references a template that does not resolve.',
            [
              {
                field: `steps.${step.id}.templateRef`,
                code: templateResolution.code,
                detail: templateResolution.reason,
              },
            ],
          );
        }
        references.push({
          templateId: templateResolution.resolved.version.prompt.id,
          templateVersion: templateResolution.resolved.version.prompt.version,
          promptVersion: templateResolution.resolved.promptVersion,
        });
      }

      const draft = newDraft({
        draftId: newDraftId(),
        metadata: input.metadata,
        workflowId: resolved.workflow.id,
        workflowVersion: resolved.version.version,
        workflowRef: resolved.workflowVersion,
        capability: resolved.version.capability.capability,
        templateReferences: references,
        inputs: input.inputs,
        now: now().toISOString(),
        ...(input.note === undefined ? {} : { note: input.note }),
      });

      await repository.saveDraft(draft);
      return ok(draft);
    },

    async load(draftId: string): Promise<DraftResult> {
      if (draftId.trim() === '') return refuse('UnknownDraft', 'A draft id is required.');
      const draft = await repository.loadDraft(draftId);
      return draft === null ? refuse('UnknownDraft', `There is no draft '${draftId}'.`) : ok(draft);
    },

    async validate(draftId: string): Promise<DraftResult> {
      const loaded = await repository.loadDraft(draftId);
      if (loaded === null) return refuse('UnknownDraft', `There is no draft '${draftId}'.`);

      const validation = validationOf(loaded);
      return validation.ok
        ? ok(loaded)
        : refuse('DraftInvalid', 'The draft does not validate.', validation.issues);
    },

    async revise(input: ReviseDraftOptions): Promise<DraftResult> {
      const loaded = await repository.loadDraft(input.draftId);
      if (loaded === null) return refuse('UnknownDraft', `There is no draft '${input.draftId}'.`);

      const current = latestRevision(loaded);

      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        // Somebody else revised it in between. Writing over them would lose
        // their edit, and losing an edit silently is worse than refusing one.
        return refuse(
          'ImmutableDraft',
          `This edit was built on revision ${String(input.expectedRevision)}; the draft is at ${String(current.revision)}.`,
        );
      }

      let next: DraftStatus;
      try {
        next = assertTransitionAllowed(current.status, input.transition);
      } catch (failure) {
        return refuse(
          'IllegalTransition',
          failure instanceof Error ? failure.message : String(failure),
        );
      }

      if (input.note.trim() === '') {
        return refuse('DraftInvalid', 'A revision says why it exists.', [
          {
            field: 'note',
            code: 'MISSING',
            detail: 'A change nobody can explain is one nobody can undo.',
          },
        ]);
      }

      const revised = appendRevision({
        draft: loaded,
        status: next,
        ...(input.changes === undefined ? {} : { changes: input.changes }),
        note: input.note,
        now: now().toISOString(),
      });

      // A draft only becomes READY if it validates NOW, with the changes
      // applied. Promoting an invalid draft would make 'ready' a label rather
      // than a claim.
      if (next === 'ready') {
        const validation = validationOf(revised);
        if (!validation.ok) {
          return refuse('DraftInvalid', 'The draft is not ready.', validation.issues);
        }
      }

      await repository.updateDraft({ draft: revised, expectedRevision: current.revision });
      return ok(revised);
    },

    async remove(draftId: string): Promise<DraftRemovalResult> {
      const loaded = await repository.loadDraft(draftId);
      if (loaded === null) return refuse('UnknownDraft', `There is no draft '${draftId}'.`);

      if (draftStatus(loaded) === 'submitted') {
        // A submitted draft is the record of what was submitted. Deleting it
        // destroys the provenance of a run that already happened; discard an
        // unsubmitted one instead.
        return refuse(
          'ImmutableDraft',
          `Draft '${draftId}' was submitted and is the record of what ran. It cannot be deleted.`,
        );
      }

      await repository.deleteDraft(draftId);
      return Object.freeze({ outcome: 'ok' as const });
    },

    async list(criteria: Partial<DraftListCriteria> = {}): Promise<DraftListResult> {
      if (
        criteria.statuses !== undefined &&
        criteria.statuses !== null &&
        criteria.statuses.length === 0
      ) {
        return refuse('DraftInvalid', 'The listing cannot be run as asked.', [
          {
            field: 'statuses',
            code: 'EMPTY',
            detail: 'An empty status set matches nothing, and an empty list reads as "no drafts".',
          },
        ]);
      }

      const limit = criteria.limit ?? DEFAULT_DRAFT_LIST_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
        return refuse('DraftInvalid', 'The listing cannot be run as asked.', [
          {
            field: 'limit',
            code: 'OUT_OF_RANGE',
            detail: `'${String(limit)}' is not a size between 1 and ${String(maxLimit)}.`,
          },
        ]);
      }

      const slice = await repository.listDrafts({
        organizationId: criteria.organizationId ?? null,
        workspaceId: criteria.workspaceId ?? null,
        principalId: criteria.principalId ?? null,
        workflowId: criteria.workflowId ?? null,
        statuses: criteria.statuses ?? null,
        limit,
      });

      // Newest first, enforced rather than assumed — the same reason history
      // sorts what its store returns.
      const ordered = [...slice.drafts].sort((left, right) => {
        if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
        return left.draftId < right.draftId ? 1 : -1;
      });

      return Object.freeze({ outcome: 'ok' as const, drafts: Object.freeze(ordered) });
    },
  };
}
