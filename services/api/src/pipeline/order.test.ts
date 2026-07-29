import { describe, expect, it } from 'vitest';

import {
  assertPipelineOrder,
  ORDER_INVARIANTS,
  PIPELINE_ORDER,
  PRE_BODY_STAGES,
  stageIndex,
  type StageName,
} from './order.js';

describe('pipeline order — the canonical sequence', () => {
  it('holds the approved stages', () => {
    expect(PIPELINE_ORDER).toEqual([
      'request-id',
      'logging',
      'metrics',
      'size-limit',
      'rate-limit-pre-auth',
      'authentication',
      'rate-limit-post-auth',
      'csrf',
      'validation',
      'idempotency',
      'tenant-resolution',
      'authorization',
      'handler',
      'output-filter',
      'security-headers',
    ]);
  });

  it('passes its own invariants', () => {
    expect(() => {
      assertPipelineOrder();
    }).not.toThrow();
  });

  it('lists no stage twice', () => {
    expect(new Set(PIPELINE_ORDER).size).toBe(PIPELINE_ORDER.length);
  });
});

// "Ordering is a security property, not a style choice."
describe('the three placements that carry weight', () => {
  it('rejects a 500 MB body before authenticating it', () => {
    expect(stageIndex('size-limit')).toBeLessThan(stageIndex('authentication'));
  });

  it('rejects oversize before spending a rate-limit slot', () => {
    expect(stageIndex('size-limit')).toBeLessThan(stageIndex('rate-limit-pre-auth'));
  });

  it('rate-limits BOTH before and after authentication', () => {
    expect(stageIndex('rate-limit-pre-auth')).toBeLessThan(stageIndex('authentication'));
    expect(stageIndex('authentication')).toBeLessThan(stageIndex('rate-limit-post-auth'));
  });

  // Placing it earlier would force it to trust a client-supplied tenant.
  it('authorizes AFTER the tenant is resolved from the resource', () => {
    expect(stageIndex('tenant-resolution')).toBeLessThan(stageIndex('authorization'));
  });

  it('authorizes immediately before the handler', () => {
    expect(stageIndex('authorization')).toBe(stageIndex('handler') - 1);
  });

  it('validates after authentication but before resolution', () => {
    expect(stageIndex('authentication')).toBeLessThan(stageIndex('validation'));
    expect(stageIndex('validation')).toBeLessThan(stageIndex('tenant-resolution'));
  });

  it('assigns correlation before anything can log', () => {
    expect(stageIndex('request-id')).toBe(0);
    expect(stageIndex('request-id')).toBeLessThan(stageIndex('logging'));
  });

  it('runs only cheap stages before the body is read', () => {
    for (const stage of PRE_BODY_STAGES) {
      expect(stageIndex(stage)).toBeLessThan(stageIndex('authentication'));
    }
  });
});

describe('order enforcement', () => {
  it('names the violated invariant and its reason', () => {
    const swapped = PIPELINE_ORDER.filter((s) => s !== 'authorization');
    const bad = ['authorization', ...swapped] as StageName[];
    expect(() => {
      assertPipelineOrder(bad);
    }).toThrow(/must precede/);
  });

  it('rejects authorization before tenant resolution with the tenant reason', () => {
    const bad = PIPELINE_ORDER.filter(
      (s) => s !== 'authorization' && s !== 'tenant-resolution',
    ) as StageName[];
    const reordered = [
      ...bad.slice(0, 10),
      'authorization',
      'tenant-resolution',
      ...bad.slice(10),
    ] as StageName[];
    expect(() => {
      assertPipelineOrder(reordered);
    }).toThrow(/client-supplied tenant/);
  });

  it('rejects authentication before size limits', () => {
    const bad = PIPELINE_ORDER.filter((s) => s !== 'size-limit');
    expect(() => {
      assertPipelineOrder([...bad, 'size-limit'] as StageName[]);
    }).toThrow(/size-limit/);
  });

  it('rejects a duplicated stage', () => {
    expect(() => {
      assertPipelineOrder([...PIPELINE_ORDER, 'csrf'] as StageName[]);
    }).toThrow(/more than once/);
  });

  it('rejects a missing stage', () => {
    expect(() => {
      assertPipelineOrder(PIPELINE_ORDER.filter((s) => s !== 'authorization') as StageName[]);
    }).toThrow(/missing a required stage/);
  });

  it('documents a reason for every invariant', () => {
    for (const invariant of ORDER_INVARIANTS) {
      expect(invariant.because.length).toBeGreaterThan(20);
    }
  });
});
