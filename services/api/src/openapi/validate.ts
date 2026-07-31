/**
 * Structural validation of the generated document.
 *
 * ── What this is, and honestly what it is not ───────────────────────────────
 * This checks the OpenAPI 3.1 rules that a generator can actually get wrong:
 * unresolved `$ref`s, duplicate `operationId`s, responses with no description,
 * security requirements naming a scheme that does not exist, paths that do not
 * begin with a slash, path templates whose parameters are not declared.
 *
 * It is NOT a full JSON Schema metaschema validation of the 3.1 specification.
 * Doing that properly means a validator dependency, a licence review and a
 * lockfile entry; the checks below are the ones that catch a real defect in a
 * document this codebase generates, and the limit is stated here rather than
 * implied by the function's name.
 *
 * ── Why an unresolved `$ref` is the check that matters most ─────────────────
 * The whole design of the document is "reference the canonical component, do
 * not restate it". A `$ref` that points at nothing is what that design fails
 * as — and it fails silently, because most tooling renders the surrounding
 * document perfectly and shows an empty box where the schema should be.
 */

import type { OpenApiDocument } from './document.js';

export interface OpenApiIssue {
  /** Where, in JSON-pointer-ish form: 'paths./v1/ai/execute.post.responses'. */
  readonly at: string;
  readonly problem: string;
}

export type OpenApiValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly OpenApiIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every `$ref` in the document, with the path it was found at. */
function collectRefs(node: unknown, at: string, found: { at: string; ref: string }[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      collectRefs(item, `${at}[${String(index)}]`, found);
    });
    return;
  }
  if (!isRecord(node)) return;

  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      found.push({ at, ref: value });
      continue;
    }
    collectRefs(value, `${at}.${key}`, found);
  }
}

/** Resolve a local `#/a/b/c` pointer. Null when it goes nowhere. */
function resolve(document: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith('#/')) return null;
  let node: unknown = document;
  for (const segment of ref.slice(2).split('/')) {
    if (!isRecord(node)) return null;
    node = node[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) return null;
  }
  return node;
}

const PATH_PARAMETER = /\{([^}]+)\}/g;

export function validateOpenApiDocument(document: OpenApiDocument): OpenApiValidation {
  const issues: OpenApiIssue[] = [];
  const add = (at: string, problem: string): void => {
    issues.push({ at, problem });
  };

  // ── The document's own required fields ───────────────────────────────────
  if (!/^3\.1\.\d+$/.test(document.openapi)) {
    add('openapi', `'${document.openapi}' is not a 3.1.x version string.`);
  }
  if (document.info.title.trim() === '') add('info.title', 'is empty');
  if (document.info.version.trim() === '') add('info.version', 'is empty');
  if (Object.keys(document.paths).length === 0) add('paths', 'declares no endpoints');

  // ── Every `$ref` resolves ────────────────────────────────────────────────
  const refs: { at: string; ref: string }[] = [];
  collectRefs(document, '', refs);
  for (const { at, ref } of refs) {
    if (resolve(document, ref) === null) add(at || 'document', `'${ref}' resolves to nothing`);
  }

  // ── Operations ───────────────────────────────────────────────────────────
  const operationIds = new Set<string>();
  const schemeNames = new Set(Object.keys(document.components.securitySchemes));

  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith('/')) add(`paths.${path}`, 'does not begin with a slash');
    if (Object.keys(item).length === 0) add(`paths.${path}`, 'declares no operations');

    const templated = [...path.matchAll(PATH_PARAMETER)].map((match) => match[1]);

    for (const [method, operation] of Object.entries(item)) {
      const where = `paths.${path}.${method}`;

      if (operation.operationId.trim() === '') add(where, 'has no operationId');
      if (operationIds.has(operation.operationId)) {
        add(where, `operationId '${operation.operationId}' is not unique`);
      }
      operationIds.add(operation.operationId);

      if (operation.summary.trim() === '') add(where, 'has no summary');
      if (Object.keys(operation.responses).length === 0) add(`${where}.responses`, 'is empty');

      // Every path template parameter must be declared, or a generator has
      // produced a URL nobody can fill in.
      for (const name of templated) {
        const declared = (operation.parameters ?? []).some((parameter) => {
          if ('$ref' in parameter) {
            const target = resolve(document, parameter.$ref);
            return isRecord(target) && target['in'] === 'path' && target['name'] === name;
          }
          return parameter.in === 'path' && parameter.name === name;
        });
        if (!declared) add(where, `path parameter '${String(name)}' is not declared`);
      }

      for (const requirement of operation.security) {
        for (const scheme of Object.keys(requirement)) {
          if (!schemeNames.has(scheme)) {
            add(`${where}.security`, `names scheme '${scheme}', which is not declared`);
          }
        }
      }

      for (const [status, response] of Object.entries(operation.responses)) {
        if (!/^[1-5][0-9]{2}$/.test(status) && status !== 'default') {
          add(`${where}.responses.${status}`, 'is not a status code');
        }
        if (!('$ref' in response) && response.description.trim() === '') {
          add(`${where}.responses.${status}`, 'has no description');
        }
      }
    }
  }

  // ── Components ───────────────────────────────────────────────────────────
  for (const [name, response] of Object.entries(document.components.responses)) {
    if (response.description.trim() === '') {
      add(`components.responses.${name}`, 'has no description');
    }
  }
  for (const [name, scheme] of Object.entries(document.components.securitySchemes)) {
    if (typeof scheme['type'] !== 'string') {
      add(`components.securitySchemes.${name}`, 'declares no type');
    }
  }
  for (const requirement of document.security) {
    for (const scheme of Object.keys(requirement)) {
      if (!schemeNames.has(scheme)) {
        add('security', `names scheme '${scheme}', which is not declared`);
      }
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues: Object.freeze(issues) };
}

/**
 * The document as the JSON that would be served.
 *
 * Deterministic — `createOpenApiDocument` reads no clock and no random source,
 * so two builds of one tree produce identical bytes and a specification diff
 * is reviewable.
 */
export function serializeOpenApiDocument(document: OpenApiDocument): string {
  return JSON.stringify(document, null, 2);
}
