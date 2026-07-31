/**
 * Serialising an export.
 *
 * ── Same input, same bytes ─────────────────────────────────────────────────
 * Not "same fields" — the same string, every time, on every machine. That is
 * what makes an export diffable, checksummable and safe to compare across a
 * restore. `JSON.stringify` does not give it: object key order follows
 * insertion order, so two values that are equal can serialise differently, and
 * the difference shows up as a spurious change in whatever compares them.
 *
 * `canonicalJson` sorts every object's keys, drops every `undefined`, and
 * leaves array order alone (an array's order IS its meaning).
 *
 * ── No hidden fields ───────────────────────────────────────────────────────
 * Nothing is added on the way out and nothing is filtered. What the model says
 * an export carries is exactly what the bytes hold, which is checkable by
 * parsing the output back and comparing it to the input.
 *
 * ── Two formats, one content ───────────────────────────────────────────────
 * JSON is one document: `{ metadata, items }`. NDJSON is one object per line,
 * and because it has no place for a wrapper the METADATA IS THE FIRST LINE — a
 * streaming reader must know the schema version before it reads an item, and a
 * trailer would mean buffering the whole file to find out.
 *
 * Both end with a newline. A file that does not is a file whose last line
 * disappears when something concatenates it.
 */

import {
  EXPORT_FORMAT_VERSIONS,
  type ContentExportFormat,
  type ExportItem,
  type ExportMetadata,
} from './model.js';

/**
 * JSON with every object's keys in sorted order.
 *
 * Compact — no indentation and no padding. An export is a machine format, and
 * whitespace is bytes that carry nothing and must then be reproduced exactly by
 * anything that rewrites the file.
 */
export function canonicalJson(value: unknown): string {
  // Nothing an export carries is a function or a symbol, and JSON has no
  // spelling for either. Naming them here means the serialiser is total: it
  // returns a string for every input rather than `undefined` for two of them.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return 'null';
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is absence, and absence has no serialisation. Keeping it as
    // `null` would make "not set" and "set to nothing" the same on the way back.
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

export const FORMAT_MEDIA_TYPES: Readonly<Record<ContentExportFormat, string>> = Object.freeze({
  json: 'application/json',
  ndjson: 'application/x-ndjson',
});

export const FORMAT_FILE_EXTENSIONS: Readonly<Record<ContentExportFormat, string>> = Object.freeze({
  json: 'json',
  ndjson: 'ndjson',
});

export function formatVersionOf(format: ContentExportFormat): number {
  return EXPORT_FORMAT_VERSIONS[format];
}

export interface SerializeOptions {
  readonly metadata: ExportMetadata;
  readonly items: readonly ExportItem[];
}

/** One document: the envelope, then the items, in the order they were found. */
function toJson(options: SerializeOptions): string {
  return `${canonicalJson({ metadata: options.metadata, items: options.items })}\n`;
}

/**
 * One object per line.
 *
 * The first line is the envelope, tagged so a reader can tell it from an item
 * without counting lines. Every item line carries its own `kind`, which the
 * union already provides.
 */
function toNdjson(options: SerializeOptions): string {
  const lines = [
    canonicalJson({ record: 'metadata', metadata: options.metadata }),
    ...options.items.map((item) => canonicalJson({ record: 'item', item })),
  ];
  return `${lines.join('\n')}\n`;
}

export function serializeExport(options: SerializeOptions): string {
  switch (options.metadata.format) {
    case 'json':
      return toJson(options);
    case 'ndjson':
      return toNdjson(options);
  }
}

/**
 * Read an export's envelope back, without parsing the whole thing.
 *
 * For a reader deciding whether it understands a file at all. Returns null when
 * the bytes are not an export this build recognises — refusing is the caller's
 * decision to make with a code, and this is only the fact it needs.
 */
export function readExportMetadata(body: string, format: ContentExportFormat): unknown {
  try {
    if (format === 'ndjson') {
      const first = body.split('\n')[0] ?? '';
      const parsed: unknown = JSON.parse(first);
      return typeof parsed === 'object' && parsed !== null
        ? ((parsed as { metadata?: unknown }).metadata ?? null)
        : null;
    }
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null
      ? ((parsed as { metadata?: unknown }).metadata ?? null)
      : null;
  } catch {
    return null;
  }
}
