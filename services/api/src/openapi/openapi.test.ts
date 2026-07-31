import { AI_CAPABILITIES } from '@contentos/contracts';
import { STREAM_EVENT_KINDS } from '@contentos/ai';
import { describe, expect, it } from 'vitest';

import { API_ERROR_MESSAGES } from '../ai/http.js';
import { AI_ROUTES } from '../ai/routes.js';
import { EXECUTION_BODY_FIELDS } from '../ai/validation.js';
import { createVersionRegistry, type ApiVersion } from '../versioning/registry.js';
import {
  createOpenApiDocument,
  OPENAPI_VERSION,
  toOpenApiPath,
  type OpenApiDocument,
} from './document.js';
import { serializeOpenApiDocument, validateOpenApiDocument } from './validate.js';

const V1: ApiVersion = { version: 'v1', status: 'current', releasedAt: '2026-01-01T00:00:00.000Z' };

const registry = createVersionRegistry({ versions: [V1] });

const document = (): OpenApiDocument =>
  createOpenApiDocument({ registry, serviceVersion: '2.0.0' });

/** Follow a local `#/a/b/c` pointer. */
function resolve(from: OpenApiDocument, ref: string): unknown {
  let node: unknown = from;
  for (const segment of ref.slice(2).split('/')) {
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

describe('the document itself', () => {
  it('declares OpenAPI 3.1', () => {
    expect(document().openapi).toBe(OPENAPI_VERSION);
    expect(OPENAPI_VERSION).toMatch(/^3\.1\./);
  });

  it('validates', () => {
    expect(validateOpenApiDocument(document())).toEqual({ ok: true });
  });

  it('is deterministic, so a specification diff is reviewable', () => {
    // No clock, no random source, and paths in the route table's own order.
    expect(serializeOpenApiDocument(document())).toBe(serializeOpenApiDocument(document()));
  });

  it('is frozen', () => {
    const built = document();
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.paths)).toBe(true);
    expect(() => {
      (built as unknown as { openapi: string }).openapi = '3.0.0';
    }).toThrow(TypeError);
  });

  it('reports the version landscape in its description', () => {
    expect(document().info.description).toContain('`v1`');
    expect(document().info.description).toContain('never defaulted');
  });
});

describe('endpoint coverage', () => {
  it('documents every route, exactly once', () => {
    const built = document();
    const documented = Object.entries(built.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
    );
    const expected = AI_ROUTES.map((route) => `${route.method} ${toOpenApiPath(route.pattern)}`);

    expect([...documented].sort()).toEqual([...expected].sort());
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('converts a route parameter to the OpenAPI form', () => {
    expect(toOpenApiPath('/v1/ai/jobs/:id')).toBe('/v1/ai/jobs/{id}');
    expect(toOpenApiPath('/v1/ai/health')).toBe('/v1/ai/health');
  });

  it('gives every operation a unique operationId', () => {
    const ids = Object.values(document().paths).flatMap((item) =>
      Object.values(item).map((operation) => operation.operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('records the permission and rate-limit class each route declares', () => {
    const built = document();
    for (const route of AI_ROUTES) {
      const operation = built.paths[toOpenApiPath(route.pattern)]?.[route.method.toLowerCase()];
      expect(operation?.description, route.pattern).toContain(route.permission);
      expect(operation?.description, route.pattern).toContain(route.rateLimitClass);
    }
  });

  it('adds an endpoint to the document when one is added to the table', () => {
    // The property that makes this generated rather than transcribed.
    const extended = createOpenApiDocument({
      registry,
      serviceVersion: '2.0.0',
      routes: [
        ...AI_ROUTES,
        {
          method: 'GET',
          pattern: '/v1/ai/models/:id',
          handler: 'job',
          permission: 'run:read',
          rateLimitClass: 'read',
        },
      ],
    });
    expect(Object.keys(extended.paths)).toContain('/v1/ai/models/{id}');
  });
});

describe('schemas are generated from the contracts', () => {
  it('builds the request body from the fields the validator accepts', () => {
    // A hand-written schema beside a hand-written validator is two
    // descriptions of one contract, and the published one is the half nobody
    // runs — so it is the half that drifts.
    const schema = document().components.schemas['ExecuteRequest'];
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
      EXECUTION_BODY_FIELDS.map((field) => field.name).sort(),
    );
    expect([...(schema?.required ?? [])].sort()).toEqual(
      EXECUTION_BODY_FIELDS.filter((field) => field.required)
        .map((field) => field.name)
        .sort(),
    );
  });

  it('rejects unknown request keys, as the validator does', () => {
    expect(document().components.schemas['ExecuteRequest']?.additionalProperties).toBe(false);
  });

  it('takes the capability enum from the contracts package', () => {
    const capability = document().components.schemas['ExecuteRequest']?.properties?.['capability'];
    expect(capability?.enum).toEqual([...AI_CAPABILITIES]);
  });

  it('takes the error code enum from the envelope vocabulary', () => {
    const schema = document().components.schemas['Error'];
    const code = schema?.properties?.['error']?.properties?.['code'];
    expect(code?.enum).toEqual(Object.keys(API_ERROR_MESSAGES));
  });

  it('takes the stream event kinds from the streaming framework', () => {
    const kind = document().components.schemas['StreamEvent']?.properties?.['kind'];
    expect(kind?.enum).toEqual([...STREAM_EVENT_KINDS]);
  });

  it('documents that a field error never carries a value', () => {
    const schema = document().components.schemas['FieldError'];
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(['code', 'path']);
    expect(schema?.description).toContain('NEVER the value');
  });
});

describe('reuse rather than duplication', () => {
  it('defines the error envelope once and references it everywhere', () => {
    const built = document();
    const inline = JSON.stringify(built.paths).split('"requestId"').length - 1;
    // Every operation points at `components.responses.ErrorNNN`, which points
    // at the one `Error` schema. Nothing restates the envelope inline.
    expect(inline).toBe(0);
    expect(built.components.schemas['Error']).toBeDefined();
  });

  it('references every documented status through a shared response component', () => {
    const built = document();
    for (const item of Object.values(built.paths)) {
      for (const operation of Object.values(item)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          if (status === '200') continue;
          expect(response, status).toHaveProperty('$ref');
          expect((response as { $ref: string }).$ref).toMatch(
            /^#\/components\/responses\/Error\d{3}$/,
          );
        }
      }
    }
  });

  it('resolves every reference it makes', () => {
    const built = document();
    const refs = JSON.stringify(built).match(/"#\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(20);
    for (const quoted of new Set(refs)) {
      const ref = quoted.slice(1, -1);
      expect(resolve(built, ref), ref).toBeDefined();
    }
  });

  it('shares parameters rather than restating them per operation', () => {
    const built = document();
    for (const item of Object.values(built.paths)) {
      for (const operation of Object.values(item)) {
        for (const parameter of operation.parameters ?? []) {
          expect(parameter).toHaveProperty('$ref');
        }
      }
    }
  });
});

describe('security documentation', () => {
  it('documents both credentials the middleware accepts', () => {
    const schemes = document().components.securitySchemes;
    expect(Object.keys(schemes).sort()).toEqual(['apiKeyAuth', 'bearerAuth']);
    expect(schemes['bearerAuth']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    expect(schemes['apiKeyAuth']).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });
  });

  it('records that either credential suffices, not both', () => {
    // Two entries mean OR; one entry with two keys would mean AND, and
    // requiring both is not what the middleware does.
    for (const item of Object.values(document().paths)) {
      for (const operation of Object.values(item)) {
        expect(operation.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
      }
    }
  });

  it('mentions the alternative Authorization form the middleware also accepts', () => {
    expect(document().components.securitySchemes['apiKeyAuth']?.['description']).toContain(
      'ApiKey',
    );
  });

  it('documents that token claims never grant authority', () => {
    expect(document().components.securitySchemes['bearerAuth']?.['description']).toContain(
      'IGNORED',
    );
  });

  it('documents the 401 challenge header', () => {
    const built = document();
    const unauthorized = built.components.responses['Error401'];
    expect(unauthorized?.headers?.['www-authenticate']).toBeDefined();
  });
});

describe('error documentation', () => {
  const REQUIRED = [400, 401, 403, 404, 405, 409, 429, 500, 502, 503];

  it('documents every status the increment names', () => {
    const built = document();
    for (const status of REQUIRED) {
      expect(built.components.responses[`Error${String(status)}`], String(status)).toBeDefined();
    }
  });

  it('documents 410, which versioning adds', () => {
    expect(document().components.responses['Error410']).toBeDefined();
  });

  it('names the codes each status can carry', () => {
    const built = document();
    expect(built.components.responses['Error429']?.description).toContain('rate_limited');
    expect(built.components.responses['Error409']?.description).toContain('idempotency_conflict');
    expect(built.components.responses['Error410']?.description).toContain('version_retired');
    expect(built.components.responses['Error400']?.description).toContain('unsupported_version');
  });

  it('gives every error response the version header, so a client always knows', () => {
    for (const response of Object.values(document().components.responses)) {
      expect(response.headers?.['api-version']).toBeDefined();
    }
  });

  it('documents that codes are stable and response enums are open', () => {
    const code =
      document().components.schemas['Error']?.properties?.['error']?.properties?.['code'];
    expect(code?.description).toContain('Stable across API versions');
    expect(code?.description).toContain('OPEN');
  });
});

describe('streaming documentation', () => {
  const streamOperation = () => document().paths['/v1/ai/stream']?.['post'];

  it('documents an NDJSON response', () => {
    expect(streamOperation()?.responses['200']).toMatchObject({
      content: { 'application/x-ndjson': { schema: { $ref: '#/components/schemas/StreamEvent' } } },
    });
  });

  it('documents the chunk shape, including the gapless sequence rule', () => {
    const chunk = document().components.schemas['StreamChunk'];
    expect(Object.keys(chunk?.properties ?? {}).sort()).toEqual([
      'content',
      'finishReason',
      'metadata',
      'sequence',
      'usage',
    ]);
    expect(chunk?.description).toContain('gapless');
  });

  it('documents how a stream terminates, and what an interruption looks like', () => {
    const event = document().components.schemas['StreamEvent'];
    expect(event?.description).toContain('completed');
    expect(event?.description).toContain('failed');
    expect(event?.description).toContain('resume');
  });

  it('documents the failure event as carrying a code, never a vendor message', () => {
    const code = document().components.schemas['StreamEvent']?.properties?.['code'];
    expect(code?.description).toContain('never a vendor message');
  });

  it('documents the resume parameters', () => {
    const refs = (streamOperation()?.parameters ?? []).map((p) => (p as { $ref: string }).$ref);
    expect(refs).toContain('#/components/parameters/ResumeToken');
    expect(refs).toContain('#/components/parameters/LastEventId');
  });
});

describe('versioning and idempotency documentation', () => {
  it('documents the deprecation headers', () => {
    const headers = document().components.headers;
    for (const name of ['ApiVersion', 'Deprecation', 'Sunset', 'Link']) {
      expect(headers[name], name).toBeDefined();
    }
  });

  it('documents the rate-limit headers as present on every response', () => {
    expect(document().components.headers['RateLimitLimit']?.description).toContain('EVERY');
  });

  it('documents the idempotency contract on the execution endpoints', () => {
    const built = document();
    const refs = (built.paths['/v1/ai/execute']?.['post']?.parameters ?? []).map(
      (p) => (p as { $ref: string }).$ref,
    );
    expect(refs).toContain('#/components/parameters/IdempotencyKey');
    expect(built.components.parameters['IdempotencyKey']?.description).toContain('24 hours');
    expect(built.components.headers['IdempotentReplay']).toBeDefined();
  });

  it('does not require an idempotency key on a read', () => {
    const refs = (document().paths['/v1/ai/providers']?.['get']?.parameters ?? []).map(
      (p) => (p as { $ref: string }).$ref,
    );
    expect(refs).not.toContain('#/components/parameters/IdempotencyKey');
  });
});

describe('validation catches what a generator gets wrong', () => {
  const broken = (mutate: (document: Record<string, unknown>) => void): OpenApiDocument => {
    const copy = JSON.parse(serializeOpenApiDocument(document())) as Record<string, unknown>;
    mutate(copy);
    return copy as unknown as OpenApiDocument;
  };

  it('catches an unresolved reference', () => {
    // The check that matters most: the whole design is "reference the canonical
    // component", and a dangling ref fails that silently.
    const result = validateOpenApiDocument(
      broken((copy) => {
        (copy['components'] as Record<string, unknown>)['schemas'] = {};
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.problem.includes('resolves to nothing'))).toBe(true);
  });

  it('catches a duplicate operationId', () => {
    const result = validateOpenApiDocument(
      broken((copy) => {
        const paths = copy['paths'] as Record<string, Record<string, Record<string, unknown>>>;
        const health = paths['/v1/ai/health'];
        if (health?.['get'] !== undefined) health['get']['operationId'] = 'execute';
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.problem.includes('not unique'))).toBe(true);
  });

  it('catches a path parameter nothing declares', () => {
    const result = validateOpenApiDocument(
      broken((copy) => {
        const paths = copy['paths'] as Record<string, unknown>;
        paths['/v1/ai/things/{thingId}'] = paths['/v1/ai/health'];
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.problem.includes("'thingId' is not declared"))).toBe(
      true,
    );
  });

  it('catches a security requirement naming a scheme that does not exist', () => {
    const result = validateOpenApiDocument(
      broken((copy) => {
        copy['security'] = [{ oauth2: [] }];
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.problem.includes('not declared'))).toBe(true);
  });

  it('catches a wrong specification version', () => {
    const result = validateOpenApiDocument(
      broken((copy) => {
        copy['openapi'] = '3.0.3';
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('catches an empty paths object', () => {
    const result = validateOpenApiDocument(
      broken((copy) => {
        copy['paths'] = {};
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('catches a response with no description', () => {
    const result = validateOpenApiDocument(
      broken((copy) => {
        const responses = (
          copy['components'] as Record<string, Record<string, Record<string, unknown>>>
        )['responses'];
        if (responses?.['Error400'] !== undefined) responses['Error400']['description'] = '  ';
      }),
    );
    expect(result.ok).toBe(false);
  });
});
