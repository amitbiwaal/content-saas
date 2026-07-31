/**
 * Content export — serialising what already exists.
 *
 *   request → validate → ask a SERVICE → project → serialise
 *
 * ── It never touches a store ───────────────────────────────────────────────
 * There is no repository, no store and no criteria type anywhere in this
 * module. Everything it exports comes from a service that already owns the
 * question: History for a run and its artifacts, Draft Management for a draft,
 * Search for a page of anything. That is what "never query storage directly"
 * has to mean, and it is checkable — the module imports no port at all.
 *
 * ── It reads, and only reads ───────────────────────────────────────────────
 * No provider, no runtime, no orchestrator, and none of the write methods any
 * of those services offer. An export leaves the platform exactly as it found
 * it.
 *
 * ── A bulk export is a page, not a scan ────────────────────────────────────
 * Search decides what a page is, and an export of "everything" is a caller
 * walking cursors — the same walk a dashboard does. An exporter that quietly
 * paged forever on a caller's behalf would be a query engine with no bound,
 * and the first large workspace would find out.
 *
 * ── No clock, no id generator ──────────────────────────────────────────────
 * Both injected. `exportedAt` and `exportId` are IN the bytes, so an export
 * that read a clock could never produce the same bytes twice, and "same input,
 * same output" would be untestable.
 */

import type { ContentDraft } from '../drafts/draft.js';
import type { DraftService } from '../drafts/service.js';
import type { RunHistoryService } from '../history/service.js';
import type { ArtifactHistoryView, RunHistoryView } from '../history/views.js';
import type { StoredRecordIssue } from '../runs/stored.js';
import type { ContentSearchQuery } from '../search/query.js';
import { SEARCH_CODES, type ContentSearchService } from '../search/service.js';
import { formatVersionOf, serializeExport } from './format.js';
import {
  CONTENT_EXPORT_FORMATS,
  EXPORT_SCHEMA_VERSION,
  isContentExportFormat,
  isSupportedExportSchemaVersion,
  type BulkExportRequest,
  type ContentExport,
  type ContentExportRequest,
  type ContentExportType,
  type ExportItem,
  type ExportMetadata,
  SUPPORTED_EXPORT_SCHEMA_VERSIONS,
} from './model.js';

/**
 * Why an export was refused.
 *
 * Search's codes — themselves history's, plus what search adds — spread in
 * rather than restated, plus the three things only an export can refuse.
 */
export const EXPORT_CODES = [
  ...SEARCH_CODES,
  'UnsupportedFormat',
  'IncompatibleExportVersion',
  'InvalidRequest',
] as const;

export type ExportCode = (typeof EXPORT_CODES)[number];

export function isExportCode(value: unknown): value is ExportCode {
  return typeof value === 'string' && (EXPORT_CODES as readonly string[]).includes(value);
}

export interface ExportRefusal {
  readonly outcome: 'refused';
  readonly code: ExportCode;
  /** For operators. Never returned to a caller — see `ai/http.ts`. */
  readonly reason: string;
  readonly issues: readonly StoredRecordIssue[];
}

export type ExportResult =
  | { readonly outcome: 'ok'; readonly export: ContentExport }
  | ExportRefusal;

export interface ContentExportService {
  /** One run and everything it produced. */
  exportRun(runId: string, request: ContentExportRequest): Promise<ExportResult>;
  /** A page of runs, optionally with their artifacts. */
  exportRuns(query: ContentSearchQuery, request: BulkExportRequest): Promise<ExportResult>;
  /** One draft, whole: every revision and every input. */
  exportDraft(draftId: string, request: ContentExportRequest): Promise<ExportResult>;
  /** A page of drafts, each loaded whole. */
  exportDrafts(query: ContentSearchQuery, request: ContentExportRequest): Promise<ExportResult>;
  /** A page of artifacts, across runs. */
  exportArtifacts(query: ContentSearchQuery, request: ContentExportRequest): Promise<ExportResult>;
}

export interface ContentExportOptions {
  /** S4.5. Where a run and its artifacts come from. */
  readonly history: RunHistoryService;
  /** S4.6. Where a whole draft comes from. */
  readonly drafts: DraftService;
  /** S4.7. Where a page of anything comes from. */
  readonly search: ContentSearchService;
  /** Injected. `exportedAt` is in the bytes; a real clock would break determinism. */
  readonly now: () => Date;
  /** Injected. Generation is not pure, and an export id is in the bytes too. */
  readonly newExportId: () => string;
}

const refuse = (
  code: ExportCode,
  reason: string,
  issues: readonly StoredRecordIssue[] = [],
): ExportRefusal => Object.freeze({ outcome: 'refused' as const, code, reason, issues });

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      frozen((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Check the parts of a request that do not depend on what is being exported. */
function checkRequest(request: ContentExportRequest): ExportRefusal | null {
  if (!isContentExportFormat(request.format)) {
    return refuse(
      'UnsupportedFormat',
      `'${String(request.format)}' is not a format this build writes. Available: ${CONTENT_EXPORT_FORMATS.join(', ')}.`,
    );
  }

  if (request.exportSchemaVersion !== undefined) {
    if (!isSupportedExportSchemaVersion(request.exportSchemaVersion)) {
      // A caller with a reader for one version must not silently receive
      // another. Refusing is loud; writing a version they cannot parse is not.
      return refuse(
        'IncompatibleExportVersion',
        `Export schema version ${String(request.exportSchemaVersion)} is not one this build writes (${SUPPORTED_EXPORT_SCHEMA_VERSIONS.join(', ')}). Exports are refused rather than upgraded.`,
      );
    }
    if (request.exportSchemaVersion !== EXPORT_SCHEMA_VERSION) {
      return refuse(
        'IncompatibleExportVersion',
        `This build writes export schema version ${String(EXPORT_SCHEMA_VERSION)}; ${String(request.exportSchemaVersion)} was asked for. Exports are refused rather than upgraded.`,
      );
    }
  }

  for (const field of ['organizationId', 'workspaceId'] as const) {
    const value = request[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return refuse('InvalidRequest', `An export records whose it is; '${field}' is required.`, [
        { field, code: 'MISSING', detail: `'${field}' is required.` },
      ]);
    }
  }

  return null;
}

export function createContentExport(options: ContentExportOptions): ContentExportService {
  const { history, drafts, search, now, newExportId } = options;

  /** Envelope, body, record — from one clock read, so nothing can disagree. */
  function assemble(
    request: ContentExportRequest,
    exportType: ContentExportType,
    items: readonly ExportItem[],
  ): ExportResult {
    const at = now().toISOString();

    const metadata: ExportMetadata = {
      exportId: newExportId(),
      exportType,
      format: request.format,
      exportSchemaVersion: EXPORT_SCHEMA_VERSION,
      formatVersion: formatVersionOf(request.format),
      exportedAt: at,
      organizationId: request.organizationId,
      workspaceId: request.workspaceId,
      itemCount: items.length,
    };

    return Object.freeze({
      outcome: 'ok' as const,
      export: frozen({
        metadata,
        items: [...items],
        body: serializeExport({ metadata, items }),
        createdAt: at,
      }),
    });
  }

  /** One run's artifacts, through History. Never a store. */
  async function artifactsOf(
    runId: string,
  ): Promise<readonly ArtifactHistoryView[] | ExportRefusal> {
    const result = await history.listArtifacts(runId);
    return result.outcome === 'refused'
      ? refuse(result.code, result.reason, result.issues)
      : result.artifacts;
  }

  return {
    async exportRun(runId: string, request: ContentExportRequest): Promise<ExportResult> {
      const bad = checkRequest(request);
      if (bad !== null) return bad;

      const found = await history.getRunById(runId);
      if (found.outcome === 'refused') return refuse(found.code, found.reason, found.issues);

      const artifacts = await artifactsOf(runId);
      if ('outcome' in artifacts) return artifacts;

      return assemble(request, 'run', [{ kind: 'run', run: found.run, artifacts }]);
    },

    async exportRuns(query: ContentSearchQuery, request: BulkExportRequest): Promise<ExportResult> {
      const bad = checkRequest(request);
      if (bad !== null) return bad;

      const page = await search.searchRuns(query);
      if (page.outcome === 'refused') return refuse(page.code, page.reason, page.issues);

      const runs: RunHistoryView[] = [];
      for (const hit of page.page.items) {
        if (hit.kind === 'run') runs.push(hit.run);
      }

      const items: ExportItem[] = [];
      for (const run of runs) {
        if (request.includeArtifacts !== true) {
          items.push({ kind: 'run', run, artifacts: [] });
          continue;
        }
        const artifacts = await artifactsOf(run.runId);
        if ('outcome' in artifacts) return artifacts;
        items.push({ kind: 'run', run, artifacts });
      }

      return assemble(request, 'runs', items);
    },

    async exportDraft(draftId: string, request: ContentExportRequest): Promise<ExportResult> {
      const bad = checkRequest(request);
      if (bad !== null) return bad;

      const loaded = await drafts.load(draftId);
      if (loaded.outcome === 'refused') {
        // The draft service's own codes are already in the taxonomy, spread in
        // from search's. A paraphrase here would let the two drift.
        return refuse(
          loaded.code === 'UnknownDraft' ? 'UnknownDraft' : 'InvalidRequest',
          loaded.reason,
          loaded.issues,
        );
      }

      return assemble(request, 'draft', [{ kind: 'draft', draft: loaded.draft }]);
    },

    async exportDrafts(
      query: ContentSearchQuery,
      request: ContentExportRequest,
    ): Promise<ExportResult> {
      const bad = checkRequest(request);
      if (bad !== null) return bad;

      const page = await search.searchDrafts(query);
      if (page.outcome === 'refused') return refuse(page.code, page.reason, page.issues);

      // Search finds them; Draft Management supplies them whole. A search hit
      // is a pointer and withholds what a person typed — which is right for a
      // listing and wrong for a download.
      const found: ContentDraft[] = [];
      for (const hit of page.page.items) {
        if (hit.kind !== 'draft') continue;
        const loaded = await drafts.load(hit.draft.draftId);
        if (loaded.outcome === 'refused') {
          return refuse(
            loaded.code === 'UnknownDraft' ? 'UnknownDraft' : 'InvalidRequest',
            loaded.reason,
            loaded.issues,
          );
        }
        found.push(loaded.draft);
      }

      return assemble(
        request,
        'drafts',
        found.map((draft) => ({ kind: 'draft' as const, draft })),
      );
    },

    async exportArtifacts(
      query: ContentSearchQuery,
      request: ContentExportRequest,
    ): Promise<ExportResult> {
      const bad = checkRequest(request);
      if (bad !== null) return bad;

      const page = await search.searchArtifacts(query);
      if (page.outcome === 'refused') return refuse(page.code, page.reason, page.issues);

      const items: ExportItem[] = [];
      for (const hit of page.page.items) {
        if (hit.kind === 'artifact') items.push({ kind: 'artifact', artifact: hit.artifact });
      }

      return assemble(request, 'artifacts', items);
    },
  };
}
