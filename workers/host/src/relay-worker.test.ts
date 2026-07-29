import { describe, expect, it } from 'vitest';

import {
  bindShutdownSignals,
  createRelayWorker,
  type CycleOutcome,
  type RelayWorkerDeps,
} from './relay-worker.js';

const noSleep = (): Promise<void> => Promise.resolve();

function worker(over: Partial<RelayWorkerDeps> = {}) {
  const cycles: CycleOutcome[] = [];
  const errors: unknown[] = [];
  const deps: RelayWorkerDeps = {
    drainOutbox: () => Promise.resolve(0),
    recoverPending: () => Promise.resolve(0),
    hostedGroups: ['read-models'],
    sleep: noSleep,
    onCycle: (o) => cycles.push(o),
    onError: (e) => errors.push(e),
    ...over,
  };
  return { instance: createRelayWorker(deps), cycles, errors };
}

describe('poll cycle', () => {
  it('drains the outbox', async () => {
    let drained = 0;
    const w = worker({
      drainOutbox: () => {
        drained += 1;
        return Promise.resolve(3);
      },
    });
    const outcome = await w.instance.runCycle();
    expect(outcome.relayed).toBe(3);
    expect(drained).toBe(1);
  });

  // Startup and crash recovery are the same operation: a worker cannot tell
  // whether pending entries were abandoned by a peer or by its own last life.
  it('recovers pending entries on the first cycle, before adding work', async () => {
    const order: string[] = [];
    const w = worker({
      recoverPending: () => {
        order.push('recover');
        return Promise.resolve(2);
      },
      drainOutbox: () => {
        order.push('drain');
        return Promise.resolve(0);
      },
    });
    const outcome = await w.instance.runCycle();
    expect(order).toEqual(['recover', 'drain']);
    expect(outcome.recovered).toBe(2);
  });

  // Recovery is a sweep, not a hot path.
  it('does not recover on every cycle', async () => {
    let recoveries = 0;
    const w = worker({
      recoverPending: () => {
        recoveries += 1;
        return Promise.resolve(0);
      },
      recoverEveryCycles: 5,
    });
    for (let i = 0; i < 5; i += 1) await w.instance.runCycle();
    expect(recoveries).toBe(1);
  });

  it('sweeps again once the interval elapses', async () => {
    let recoveries = 0;
    const w = worker({
      recoverPending: () => {
        recoveries += 1;
        return Promise.resolve(0);
      },
      recoverEveryCycles: 2,
    });
    for (let i = 0; i < 4; i += 1) await w.instance.runCycle();
    expect(recoveries).toBe(2);
  });

  it('reports each cycle', async () => {
    const w = worker({ drainOutbox: () => Promise.resolve(1) });
    await w.instance.runCycle();
    expect(w.cycles).toEqual([{ relayed: 1, recovered: 0 }]);
  });
});

describe('loop resilience', () => {
  // The events are still in the outbox — unpublished, therefore not lost.
  it('survives a failing cycle and keeps running', async () => {
    let calls = 0;
    const w = worker({
      drainOutbox: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('database unavailable'));
        return Promise.resolve(0);
      },
    });

    const running = w.instance.start();
    await new Promise((r) => setTimeout(r, 5));
    await w.instance.shutdown();
    await running;

    expect(w.errors).toHaveLength(1);
    expect(calls).toBeGreaterThan(1);
  });

  // The loop is pure promise work: `await` on a resolved promise drains only
  // the microtask queue. Without an explicit event-loop turn per cycle a worker
  // configured with a zero interval starves the process — timers stop firing
  // and the SIGTERM handler can never run, so the orchestrator escalates to
  // SIGKILL and the worker dies mid-publish.
  it('turns the event loop every cycle, even when the interval is immediate', async () => {
    const w = worker({ sleep: noSleep });
    const running = w.instance.start();

    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 5);
    await new Promise((r) => setTimeout(r, 20));

    expect(timerFired).toBe(true);
    expect(w.cycles.length).toBeGreaterThan(1);

    await w.instance.shutdown();
    await running;
  });

  it('reports the failure rather than swallowing it', async () => {
    const boom = new Error('redis unreachable');
    const w = worker({ drainOutbox: () => Promise.reject(boom) });
    const running = w.instance.start();
    await new Promise((r) => setTimeout(r, 5));
    await w.instance.shutdown();
    await running;
    expect(w.errors[0]).toBe(boom);
  });
});

describe('graceful shutdown', () => {
  it('stops the loop', async () => {
    const w = worker();
    const running = w.instance.start();
    await new Promise((r) => setTimeout(r, 5));
    await w.instance.shutdown();
    await running;
    expect(w.instance.health().status).toBe('stopped');
  });

  it('reports draining then stopped', async () => {
    const w = worker();
    const running = w.instance.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(w.instance.health().status).toBe('ready');
    await w.instance.shutdown();
    await running;
    expect(w.instance.health().status).toBe('stopped');
  });

  // Abandoning a cycle mid-publish would leave entries pending for a peer to
  // reclaim, turning every deploy into a recovery event.
  it('finishes the in-flight cycle before resolving', async () => {
    let finished = false;
    const w = worker({
      drainOutbox: async () => {
        await new Promise((r) => setTimeout(r, 20));
        finished = true;
        return 0;
      },
    });
    const running = w.instance.start();
    await new Promise((r) => setTimeout(r, 5));
    await w.instance.shutdown();
    await running;
    expect(finished).toBe(true);
    expect(w.instance.health().inFlight).toBe(0);
  });

  // A second SIGTERM must not cut the first drain short.
  it('is idempotent', async () => {
    const w = worker();
    const running = w.instance.start();
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all([w.instance.shutdown(), w.instance.shutdown()]);
    await running;
    expect(w.instance.health().status).toBe('stopped');
  });

  it('starts no new cycle once shutting down', async () => {
    let calls = 0;
    const w = worker({
      drainOutbox: () => {
        calls += 1;
        return Promise.resolve(0);
      },
    });
    const running = w.instance.start();
    await new Promise((r) => setTimeout(r, 5));
    await w.instance.shutdown();
    const after = calls;
    await new Promise((r) => setTimeout(r, 10));
    await running;
    expect(calls).toBe(after);
  });

  it('returns the same promise from repeated start calls', async () => {
    const w = worker();
    const a = w.instance.start();
    const b = w.instance.start();
    expect(a).toBe(b);
    await w.instance.shutdown();
    await a;
  });
});

describe('signal handling', () => {
  // SIGTERM is what an orchestrator sends before SIGKILL; ignoring it means
  // being killed mid-publish.
  //
  // The registered listener is invoked directly rather than via
  // `process.emit('SIGTERM')`: emitting a real signal terminates the vitest
  // worker thread, so the test would kill its own runner.
  it('shuts down when the SIGTERM handler fires, and unbinds cleanly', async () => {
    const w = worker();
    const seen: string[] = [];
    const running = w.instance.start();
    const dispose = bindShutdownSignals(w.instance, ['SIGTERM'], (s) => seen.push(s));

    const listener = process.listeners('SIGTERM').at(-1) as () => void;
    listener();
    await new Promise((r) => setTimeout(r, 10));
    await running;

    expect(seen).toEqual(['SIGTERM']);
    expect(w.instance.health().status).toBe('stopped');
    dispose();
  });

  it('binds every requested signal', () => {
    const w = worker();
    const before = process.listenerCount('SIGINT');
    const dispose = bindShutdownSignals(w.instance, ['SIGTERM', 'SIGINT']);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    dispose();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('health', () => {
  it('starts in the starting state', () => {
    expect(worker().instance.health().status).toBe('starting');
  });

  it('reports the hosted groups, since one binary hosts any handler set', () => {
    const w = worker({ hostedGroups: ['read-models', 'analytics'] });
    expect(w.instance.health().hostedGroups).toEqual(['read-models', 'analytics']);
  });

  it('counts completed cycles and records the last cycle time', async () => {
    const at = new Date('2026-07-29T10:00:00Z');
    const w = worker({ now: () => at });
    await w.instance.runCycle();
    await w.instance.runCycle();
    const health = w.instance.health();
    expect(health.cyclesCompleted).toBe(2);
    expect(health.lastCycleAt).toEqual(at);
  });

  it('reports zero in-flight when idle', () => {
    expect(worker().instance.health().inFlight).toBe(0);
  });
});
