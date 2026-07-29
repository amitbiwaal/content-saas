import { describe, expect, it } from 'vitest';

import {
  contextBindings,
  currentContext,
  newCorrelationId,
  runWithContext,
  withContext,
  type RequestContext,
} from './request-context.js';

const CTX: RequestContext = {
  correlationId: 'corr-1',
  tenantId: 'ws-1',
  organizationId: 'org-1',
  source: 'request',
};

describe('correlation ids', () => {
  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newCorrelationId()));
    expect(ids.size).toBe(200);
  });

  it('generates a UUID-shaped id', () => {
    expect(newCorrelationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe('context propagation', () => {
  it('is undefined outside any scope', () => {
    expect(currentContext()).toBeUndefined();
  });

  it('exposes the context inside the scope', () => {
    runWithContext(CTX, () => {
      expect(currentContext()).toEqual(CTX);
    });
  });

  it('does not leak the context after the scope ends', () => {
    runWithContext(CTX, () => currentContext());
    expect(currentContext()).toBeUndefined();
  });

  it('propagates across await boundaries', async () => {
    await runWithContext(CTX, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentContext()?.correlationId).toBe('corr-1');
    });
  });

  it('propagates into nested async callbacks', async () => {
    const seen = await runWithContext(CTX, async () =>
      Promise.all([
        Promise.resolve().then(() => currentContext()?.correlationId),
        new Promise<string | undefined>((resolve) =>
          setTimeout(() => {
            resolve(currentContext()?.correlationId);
          }, 1),
        ),
      ]),
    );
    expect(seen).toEqual(['corr-1', 'corr-1']);
  });

  it('keeps concurrent scopes isolated', async () => {
    const [a, b] = await Promise.all([
      runWithContext({ ...CTX, correlationId: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentContext()?.correlationId;
      }),
      runWithContext({ ...CTX, correlationId: 'b' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentContext()?.correlationId;
      }),
    ]);
    expect([a, b]).toEqual(['a', 'b']);
  });

  it('nests scopes, restoring the outer one on exit', () => {
    runWithContext({ ...CTX, correlationId: 'outer' }, () => {
      runWithContext({ ...CTX, correlationId: 'inner' }, () => {
        expect(currentContext()?.correlationId).toBe('inner');
      });
      expect(currentContext()?.correlationId).toBe('outer');
    });
  });
});

describe('withContext', () => {
  // The correlation id is the chain an incident query depends on.
  it('preserves correlationId when deriving a child', () => {
    runWithContext(CTX, () => {
      const derived = withContext({ tenantId: 'ws-2', source: 'event' });
      expect(derived.correlationId).toBe('corr-1');
      expect(derived.tenantId).toBe('ws-2');
      expect(derived.source).toBe('event');
    });
  });

  it('mints a correlationId when derived outside any scope', () => {
    const derived = withContext({ tenantId: 'ws-9' });
    expect(derived.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(derived.source).toBe('job');
  });
});

describe('contextBindings', () => {
  it('always includes correlationId', () => {
    expect(contextBindings({ correlationId: 'c', source: 'job' })).toEqual({ correlationId: 'c' });
  });

  it('includes tenant and trace identifiers when present', () => {
    const bindings = contextBindings({
      ...CTX,
      actorId: 'user-1',
      span: { traceId: 't'.repeat(32), spanId: 's'.repeat(16), parentSpanId: null, sampled: true },
    });
    expect(bindings).toMatchObject({
      correlationId: 'corr-1',
      tenantId: 'ws-1',
      organizationId: 'org-1',
      actorId: 'user-1',
      traceId: 't'.repeat(32),
      spanId: 's'.repeat(16),
    });
  });

  it('omits absent optional identifiers', () => {
    expect(contextBindings({ correlationId: 'c', source: 'request' })).not.toHaveProperty(
      'tenantId',
    );
  });
});
