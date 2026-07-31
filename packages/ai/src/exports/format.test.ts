import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  FORMAT_FILE_EXTENSIONS,
  FORMAT_MEDIA_TYPES,
  formatVersionOf,
  readExportMetadata,
  serializeExport,
} from './format.js';
import {
  CONTENT_EXPORT_FORMATS,
  EXPORT_FORMAT_VERSIONS,
  EXPORT_SCHEMA_VERSION,
  isContentExportFormat,
  isContentExportType,
  isSupportedExportSchemaVersion,
  SUPPORTED_EXPORT_SCHEMA_VERSIONS,
  type ExportItem,
  type ExportMetadata,
} from './model.js';

const AT = '2026-07-31T12:00:00.000Z';

const metadata = (overrides: Partial<ExportMetadata> = {}): ExportMetadata => ({
  exportId: 'export-1',
  exportType: 'artifacts',
  format: 'json',
  exportSchemaVersion: EXPORT_SCHEMA_VERSION,
  formatVersion: 1,
  exportedAt: AT,
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  itemCount: 1,
  ...overrides,
});

const artifactItem: ExportItem = {
  kind: 'artifact',
  artifact: {
    runId: 'run-1',
    stepId: 'outline',
    sequence: 0,
    prompt: {
      templateId: 'planning.outline',
      templateVersion: 7,
      promptVersion: 'planning.outline@7',
    },
    providerId: 'openai',
    model: 'gpt-4o-2026-05-01',
    capability: 'chat',
    content: 'An outline.',
    finishReason: 'stop',
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      tokensEstimated: false,
      currency: 'USD',
      amount: '0.000225',
      latencyMs: 12,
    },
    attempts: 1,
    metadata: { plannedProviderId: 'openai' },
  },
};

// ── Canonical JSON ──────────────────────────────────────────────────────────

describe('canonical JSON', () => {
  it('sorts every object’s keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('produces the same bytes for values written in different orders', () => {
    // `JSON.stringify` follows insertion order, so two equal values can
    // serialise differently — and the difference shows up as a spurious change
    // in whatever compares them.
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 1 }),
    );
  });

  it('sorts nested objects too, at every depth', () => {
    expect(canonicalJson({ z: { y: { x: 1, a: 2 } } })).toBe('{"z":{"y":{"a":2,"x":1}}}');
  });

  it('leaves array order alone, because an array’s order IS its meaning', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ items: ['b', 'a'] })).toBe('{"items":["b","a"]}');
  });

  it('drops undefined rather than writing null for it', () => {
    // "Not set" and "set to nothing" must not become the same on the way back.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('keeps an explicit null', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it('is compact — no indentation, no padding', () => {
    expect(canonicalJson({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });

  it('handles the primitives an export actually carries', () => {
    expect(canonicalJson('text')).toBe('"text"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });

  it('escapes what JSON escapes', () => {
    expect(canonicalJson({ 'a"b': 'c\nd' })).toBe('{"a\\"b":"c\\nd"}');
  });

  it('round-trips through JSON.parse unchanged', () => {
    const value = { b: [1, { d: 2, c: 3 }], a: 'x' };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });
});

// ── Formats ─────────────────────────────────────────────────────────────────

describe('the format vocabulary', () => {
  it('writes JSON and NDJSON, and nothing else', () => {
    expect([...CONTENT_EXPORT_FORMATS]).toEqual(['json', 'ndjson']);
  });

  it('recognises its own formats', () => {
    expect(isContentExportFormat('json')).toBe(true);
    expect(isContentExportFormat('JSON')).toBe(false);
    expect(isContentExportFormat('csv')).toBe(false);
    expect(isContentExportFormat('zip')).toBe(false);
  });

  it('recognises its own export types', () => {
    expect(isContentExportType('runs')).toBe(true);
    expect(isContentExportType('templates')).toBe(false);
  });

  it('versions each format separately from the envelope', () => {
    // "What the document looks like" and "what fields it carries" are different
    // questions, and a reader needs to tell them apart.
    expect(formatVersionOf('json')).toBe(EXPORT_FORMAT_VERSIONS.json);
    expect(formatVersionOf('ndjson')).toBe(EXPORT_FORMAT_VERSIONS.ndjson);
  });

  it('names a media type and a file extension for each', () => {
    expect(FORMAT_MEDIA_TYPES.json).toBe('application/json');
    expect(FORMAT_MEDIA_TYPES.ndjson).toBe('application/x-ndjson');
    expect(FORMAT_FILE_EXTENSIONS.ndjson).toBe('ndjson');
  });

  it('reads only the envelope versions it declares', () => {
    expect(SUPPORTED_EXPORT_SCHEMA_VERSIONS).toContain(EXPORT_SCHEMA_VERSION);
    for (const version of [0, 2, 99, '1']) {
      expect(isSupportedExportSchemaVersion(version)).toBe(false);
    }
  });

  it('freezes its tables', () => {
    expect(Object.isFrozen(EXPORT_FORMAT_VERSIONS)).toBe(true);
    expect(Object.isFrozen(FORMAT_MEDIA_TYPES)).toBe(true);
    expect(Object.isFrozen(SUPPORTED_EXPORT_SCHEMA_VERSIONS)).toBe(true);
  });
});

describe('serialising as JSON', () => {
  const body = (): string => serializeExport({ metadata: metadata(), items: [artifactItem] });

  it('is one document holding the envelope and the items', () => {
    const parsed: unknown = JSON.parse(body());

    expect(parsed).toHaveProperty('metadata');
    expect(parsed).toHaveProperty('items');
  });

  it('carries the schema version, the format version and when it was made', () => {
    const parsed = JSON.parse(body()) as { metadata: ExportMetadata };

    expect(parsed.metadata.exportSchemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(parsed.metadata.formatVersion).toBe(1);
    expect(parsed.metadata.exportedAt).toBe(AT);
  });

  it('ends with a newline', () => {
    // A file that does not is a file whose last line disappears when something
    // concatenates it.
    expect(body().endsWith('\n')).toBe(true);
  });

  it('is byte-identical for the same input', () => {
    expect(body()).toBe(body());
  });

  it('preserves every artifact field', () => {
    const parsed = JSON.parse(body()) as { items: readonly ExportItem[] };
    expect(parsed.items).toEqual([artifactItem]);
  });
});

describe('serialising as NDJSON', () => {
  const body = (): string =>
    serializeExport({
      metadata: metadata({ format: 'ndjson', itemCount: 2 }),
      items: [artifactItem, artifactItem],
    });

  it('puts the envelope on the FIRST line', () => {
    // NDJSON has no place for a wrapper, and a streaming reader must know the
    // schema version before it reads an item.
    const first = body().split('\n')[0] ?? '';
    const parsed = JSON.parse(first) as { record: string; metadata: ExportMetadata };

    expect(parsed.record).toBe('metadata');
    expect(parsed.metadata.exportSchemaVersion).toBe(EXPORT_SCHEMA_VERSION);
  });

  it('writes one object per item, after the envelope', () => {
    const lines = body().trimEnd().split('\n');

    expect(lines).toHaveLength(3);
    for (const line of lines.slice(1)) {
      const parsed = JSON.parse(line) as { record: string; item: ExportItem };
      expect(parsed.record).toBe('item');
      expect(parsed.item).toEqual(artifactItem);
    }
  });

  it('tags every line, so a reader never counts to tell them apart', () => {
    for (const line of body().trimEnd().split('\n')) {
      expect(JSON.parse(line)).toHaveProperty('record');
    }
  });

  it('ends with a newline', () => {
    expect(body().endsWith('\n')).toBe(true);
  });

  it('holds no newline inside a record', () => {
    // One record per line is the whole contract; a pretty-printed object would
    // silently break every reader.
    expect(body().trimEnd().split('\n')).toHaveLength(3);
  });

  it('is byte-identical for the same input', () => {
    expect(body()).toBe(body());
  });

  it('is empty of items when there are none, but still carries the envelope', () => {
    const empty = serializeExport({
      metadata: metadata({ format: 'ndjson', itemCount: 0 }),
      items: [],
    });

    expect(empty.trimEnd().split('\n')).toHaveLength(1);
    expect(empty.endsWith('\n')).toBe(true);
  });
});

describe('determinism across formats', () => {
  it('does not depend on the order fields were built in', () => {
    const one = serializeExport({
      metadata: metadata(),
      items: [artifactItem],
    });
    const other = serializeExport({
      metadata: {
        itemCount: 1,
        workspaceId: 'ws-1',
        organizationId: 'org-1',
        exportedAt: AT,
        formatVersion: 1,
        exportSchemaVersion: EXPORT_SCHEMA_VERSION,
        format: 'json',
        exportType: 'artifacts',
        exportId: 'export-1',
      },
      items: [artifactItem],
    });

    expect(other).toBe(one);
  });

  it('changes when any value changes', () => {
    const base = serializeExport({ metadata: metadata(), items: [artifactItem] });
    const later = serializeExport({
      metadata: metadata({ exportedAt: '2026-07-31T12:00:01.000Z' }),
      items: [artifactItem],
    });

    expect(later).not.toBe(base);
  });
});

describe('reading an envelope back', () => {
  it('finds it in a JSON export', () => {
    const parsed = readExportMetadata(
      serializeExport({ metadata: metadata(), items: [artifactItem] }),
      'json',
    ) as ExportMetadata;

    expect(parsed.exportSchemaVersion).toBe(EXPORT_SCHEMA_VERSION);
  });

  it('finds it on the first line of an NDJSON export', () => {
    const parsed = readExportMetadata(
      serializeExport({
        metadata: metadata({ format: 'ndjson' }),
        items: [artifactItem],
      }),
      'ndjson',
    ) as ExportMetadata;

    expect(parsed.exportId).toBe('export-1');
  });

  it('returns null for bytes that are not an export', () => {
    expect(readExportMetadata('not json at all', 'json')).toBeNull();
    expect(readExportMetadata('{"nope":1}', 'json')).toBeNull();
    expect(readExportMetadata('', 'ndjson')).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    for (const value of ['', '{', '[]', 'null', '\n\n\n']) {
      expect(() => readExportMetadata(value, 'json')).not.toThrow();
      expect(() => readExportMetadata(value, 'ndjson')).not.toThrow();
    }
  });
});
