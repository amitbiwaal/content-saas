/**
 * What an export is.
 *
 * ── An export carries the read models that already exist ───────────────────
 * A run is a `RunHistoryView`, an artifact is an `ArtifactHistoryView`. Both
 * already exclude persistence-only fields BY TYPE, so an export inherits that
 * guarantee rather than restating it — and a field added to a stored record
 * later stays out of every export without anyone remembering.
 *
 * ── A draft export carries the WHOLE draft ─────────────────────────────────
 * Deliberately unlike a search hit. A listing is a pointer, so it withholds
 * what a person typed; an export is a download of the thing itself, which is
 * the entire point of asking for one. Every revision, every input, in order.
 *
 * ── Two clocks, one instant ────────────────────────────────────────────────
 * `exportedAt` is when the content was serialised and `createdAt` is when the
 * export record was made. They come from ONE clock read, so they can never
 * disagree — and both are named because a reader of the envelope should not
 * have to look at the record to date it, and vice versa.
 *
 * ── Nothing here queries anything ──────────────────────────────────────────
 * Values. No store, no repository, no service.
 */

import type { ContentDraft } from '../drafts/draft.js';
import type { ArtifactHistoryView, RunHistoryView } from '../history/views.js';

export const CONTENT_EXPORT_FORMATS = ['json', 'ndjson'] as const;

export type ContentExportFormat = (typeof CONTENT_EXPORT_FORMATS)[number];

export function isContentExportFormat(value: unknown): value is ContentExportFormat {
  return typeof value === 'string' && (CONTENT_EXPORT_FORMATS as readonly string[]).includes(value);
}

export const CONTENT_EXPORT_TYPES = ['run', 'runs', 'draft', 'drafts', 'artifacts'] as const;

export type ContentExportType = (typeof CONTENT_EXPORT_TYPES)[number];

export function isContentExportType(value: unknown): value is ContentExportType {
  return typeof value === 'string' && (CONTENT_EXPORT_TYPES as readonly string[]).includes(value);
}

/**
 * The version of the export ENVELOPE this build writes.
 *
 * Monotonic, and its own number: an export lives in somebody's downloads
 * folder for years, quite separately from the records it was taken from. Tying
 * it to the persistence schema would invalidate every file on disk whenever a
 * stored column changed.
 */
export const EXPORT_SCHEMA_VERSION = 1;

/** Every envelope version this build can READ back. */
export const SUPPORTED_EXPORT_SCHEMA_VERSIONS: readonly number[] = Object.freeze([1]);

export function isSupportedExportSchemaVersion(value: unknown): value is number {
  return typeof value === 'number' && SUPPORTED_EXPORT_SCHEMA_VERSIONS.includes(value);
}

/**
 * The version of each FORMAT's layout.
 *
 * Separate from the envelope's, because "what the JSON document looks like" and
 * "what fields an export carries" are different questions. NDJSON's header line
 * could change without any field changing, and a reader needs to tell the two
 * apart.
 */
export const EXPORT_FORMAT_VERSIONS: Readonly<Record<ContentExportFormat, number>> = Object.freeze({
  json: 1,
  ndjson: 1,
});

/**
 * One content artifact, in its exported form.
 *
 * An alias of the history projection, not a copy. Three layers now agree on
 * what an artifact looks like to a reader, because there is one definition.
 */
export type ExportArtifact = ArtifactHistoryView;

/**
 * One exported thing.
 *
 * A discriminated union rather than three export shapes: one file can hold one
 * kind, and a reader narrows on `kind` instead of guessing from which field
 * happens to be present. Distinct from `SearchHit` because an export carries
 * MORE — a run brings its artifacts, and a draft brings everything.
 */
export type ExportItem =
  | {
      readonly kind: 'run';
      readonly run: RunHistoryView;
      /** In step order. Empty when the caller asked for records only. */
      readonly artifacts: readonly ExportArtifact[];
    }
  | { readonly kind: 'draft'; readonly draft: ContentDraft }
  | { readonly kind: 'artifact'; readonly artifact: ExportArtifact };

/** The envelope. Everything a reader needs before it reads a single item. */
export interface ExportMetadata {
  readonly exportId: string;
  readonly exportType: ContentExportType;
  readonly format: ContentExportFormat;
  readonly exportSchemaVersion: number;
  readonly formatVersion: number;
  /** When the content was serialised. */
  readonly exportedAt: string;
  readonly organizationId: string;
  /** The workspace IS the tenant (ADR-017). */
  readonly workspaceId: string;
  /** How many items the body holds. A partial read is detectable. */
  readonly itemCount: number;
}

export interface ContentExport {
  readonly metadata: ExportMetadata;
  readonly items: readonly ExportItem[];
  /** The serialised bytes, as a string. */
  readonly body: string;
  /** When the export record was made. The same instant as `exportedAt`. */
  readonly createdAt: string;
}

export interface ContentExportRequest {
  readonly format: ContentExportFormat;
  /** Whose export it is. Recorded on the envelope; never inferred from content. */
  readonly organizationId: string;
  readonly workspaceId: string;
  /**
   * The envelope version the caller expects.
   *
   * Omitted means "whatever this build writes". Named means "refuse unless you
   * write that one" — a caller with a reader for version 1 should not silently
   * receive version 2.
   */
  readonly exportSchemaVersion?: number;
}

/**
 * A bulk export also names which page.
 *
 * The SEARCH query, reused: filtering, ordering, page bounds and cursors are
 * already decided, validated and tested, and a second query vocabulary would be
 * one more thing to keep in step.
 */
export interface BulkExportRequest extends ContentExportRequest {
  /**
   * Whether each run's artifacts are fetched too.
   *
   * Explicit, and off by default. A page of a hundred runs with their artifacts
   * is a different order of magnitude from a page of a hundred run records, and
   * which one a caller wants is not something to guess.
   */
  readonly includeArtifacts?: boolean;
}
