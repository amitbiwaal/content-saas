import { get as httpGet } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  createHealthServer,
  DEFAULT_STALL_THRESHOLD_MS,
  HEALTH_ROUTES,
  livenessProbe,
  readinessProbe,
  type DependencyReport,
} from './health-endpoint.js';
import type { WorkerHealth, WorkerStatus } from './relay-worker.js';

/**
 * Probe over `node:http` rather than `fetch`.
 *
 * `fetch` is banned repo-wide so that outbound requests go through
 * `SafeUrlFetcher` — a single audited chokepoint is what makes the SSRF
 * controls verifiable. A test calling its own ephemeral loopback server is not
 * the risk that rule guards, but silencing a security rule for convenience is
 * how such rules stop meaning anything, so the test uses the raw client.
 */
interface Probe {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function probe(url: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
  });
}

const START = new Date('2026-07-29T10:00:00.000Z');
const at = (msAfterStart: number): Date => new Date(START.getTime() + msAfterStart);

function health(over: Partial<WorkerHealth> = {}): WorkerHealth {
  return {
    status: 'ready',
    hostedGroups: ['read-models'],
    inFlight: 0,
    lastCycleAt: at(1000),
    cyclesCompleted: 12,
    startedAt: START,
    ...over,
  };
}

describe('liveness', () => {
  it('passes while cycles keep completing', () => {
    const result = livenessProbe(health(), { now: () => at(2000) });
    expect(result.state).toBe('pass');
    expect(result.httpStatus).toBe(200);
  });

  // A loop that stops turning cannot be recovered in place: the loop already
  // catches and reports its own cycle errors, so silence means it is blocked.
  it('fails when no cycle has completed within the stall threshold', () => {
    const result = livenessProbe(health(), {
      now: () => at(1000 + DEFAULT_STALL_THRESHOLD_MS + 1),
    });
    expect(result.state).toBe('fail');
    expect(result.httpStatus).toBe(503);
    expect(result.reason).toMatch(/No cycle completed/);
  });

  it('measures startup from startedAt under the startup grace', () => {
    const starting = health({ status: 'starting', lastCycleAt: null, cyclesCompleted: 0 });
    expect(livenessProbe(starting, { now: () => at(5_000) }).state).toBe('pass');
    expect(livenessProbe(starting, { now: () => at(31_000) }).state).toBe('fail');
  });

  // THE CENTRAL ASYMMETRY: a draining worker is not ready, but it is alive.
  // Failing liveness here would have the orchestrator SIGKILL a worker that is
  // shutting down correctly, abandoning in-flight work.
  it('keeps passing while draining, however long the drain takes', () => {
    const draining = health({ status: 'draining', inFlight: 1 });
    const result = livenessProbe(draining, {
      now: () => at(1000 + DEFAULT_STALL_THRESHOLD_MS * 10),
    });
    expect(result.state).toBe('pass');
  });

  it('keeps passing once stopped', () => {
    expect(livenessProbe(health({ status: 'stopped' }), { now: () => at(1e9) }).state).toBe('pass');
  });

  it('reports how long it has been idle, so an operator can see the margin', () => {
    const result = livenessProbe(health(), { now: () => at(4000) });
    expect(result.detail['idleMs']).toBe(3000);
  });
});

describe('readiness', () => {
  it('passes when ready with healthy dependencies', () => {
    const result = readinessProbe(health(), [{ name: 'redis', healthy: true }]);
    expect(result.state).toBe('pass');
  });

  // Readiness must fail the INSTANT SIGTERM lands, so the worker leaves
  // rotation with its full grace period still available for draining.
  it('fails immediately on draining', () => {
    const result = readinessProbe(health({ status: 'draining' }));
    expect(result.state).toBe('fail');
    expect(result.httpStatus).toBe(503);
  });

  it.each<WorkerStatus>(['starting', 'draining', 'stopped'])('fails when %s', (status) => {
    expect(readinessProbe(health({ status })).state).toBe('fail');
  });

  it('fails when a dependency is unavailable', () => {
    const deps: DependencyReport[] = [
      { name: 'postgres', healthy: true },
      { name: 'redis', healthy: false, detail: 'ECONNREFUSED' },
    ];
    const result = readinessProbe(health(), deps);
    expect(result.state).toBe('fail');
    expect(result.reason).toContain('redis');
  });

  it('names which dependency failed rather than just failing', () => {
    const result = readinessProbe(health(), [
      { name: 'redis', healthy: false, detail: 'ECONNREFUSED' },
    ]);
    expect(result.detail['unhealthy']).toEqual([{ name: 'redis', detail: 'ECONNREFUSED' }]);
  });

  it('reports the hosted groups, since readiness is per handler set', () => {
    const result = readinessProbe(health({ hostedGroups: ['analytics'] }));
    expect(result.detail['hostedGroups']).toEqual(['analytics']);
  });
});

describe('http endpoints', () => {
  async function serve(
    deps: Parameters<typeof createHealthServer>[0],
  ): Promise<{ base: string; close: () => Promise<void> }> {
    const server = createHealthServer(deps);
    const port = await server.listen(0, '127.0.0.1');
    return { base: `http://127.0.0.1:${String(port)}`, close: () => server.close() };
  }

  it('serves liveness and readiness on distinct routes', async () => {
    const s = await serve({ health: () => health(), probeOptions: { now: () => at(2000) } });
    try {
      const live = await probe(`${s.base}${HEALTH_ROUTES.live}`);
      const ready = await probe(`${s.base}${HEALTH_ROUTES.ready}`);
      expect(live.status).toBe(200);
      expect(ready.status).toBe(200);
      expect((JSON.parse(live.body) as { state: string }).state).toBe('pass');
    } finally {
      await s.close();
    }
  });

  // The whole reason for two routes: one says "stop sending work", the other
  // says "do not kill me".
  it('answers 503 on readiness and 200 on liveness while draining', async () => {
    const s = await serve({
      health: () => health({ status: 'draining' }),
      probeOptions: { now: () => at(2000) },
    });
    try {
      expect((await probe(`${s.base}${HEALTH_ROUTES.ready}`)).status).toBe(503);
      expect((await probe(`${s.base}${HEALTH_ROUTES.live}`)).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('runs dependency checks on readiness', async () => {
    let checked = 0;
    const s = await serve({
      health: () => health(),
      checkDependencies: () => {
        checked += 1;
        return Promise.resolve([{ name: 'redis', healthy: false }]);
      },
      probeOptions: { now: () => at(2000) },
    });
    try {
      const res = await probe(`${s.base}${HEALTH_ROUTES.ready}`);
      expect(res.status).toBe(503);
      expect(checked).toBe(1);
    } finally {
      await s.close();
    }
  });

  // A probe that 500s or hangs tells the orchestrator nothing actionable.
  it('reports a thrown dependency check as not ready, not as a crash', async () => {
    const errors: unknown[] = [];
    const s = await serve({
      health: () => health(),
      checkDependencies: () => Promise.reject(new Error('ECONNREFUSED')),
      onProbeError: (e) => errors.push(e),
      probeOptions: { now: () => at(2000) },
    });
    try {
      const res = await probe(`${s.base}${HEALTH_ROUTES.ready}`);
      expect(res.status).toBe(503);
      // A thrown check cannot say WHICH dependency died, so it reports one
      // synthetic entry carrying the error rather than guessing a name.
      const body = JSON.parse(res.body) as {
        reason: string;
        unhealthy: { name: string; detail: string }[];
      };
      expect(body.reason).toContain('dependencies');
      expect(body.unhealthy).toEqual([{ name: 'dependencies', detail: 'ECONNREFUSED' }]);
      expect(errors).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it('does not block the status route on a dependency check', async () => {
    let checked = 0;
    const s = await serve({
      health: () => health(),
      checkDependencies: () => {
        checked += 1;
        return Promise.resolve([]);
      },
      probeOptions: { now: () => at(2000) },
    });
    try {
      const res = await probe(`${s.base}${HEALTH_ROUTES.status}`);
      const body = JSON.parse(res.body) as { hostedGroups: string[]; startedAt: string };
      expect(res.status).toBe(200);
      expect(body.hostedGroups).toEqual(['read-models']);
      expect(body.startedAt).toBe(START.toISOString());
      expect(checked).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('never caches a probe response', async () => {
    const s = await serve({ health: () => health(), probeOptions: { now: () => at(2000) } });
    try {
      const res = await probe(`${s.base}${HEALTH_ROUTES.live}`);
      expect(res.headers['cache-control']).toBe('no-store');
    } finally {
      await s.close();
    }
  });

  it('404s an unknown route', async () => {
    const s = await serve({ health: () => health() });
    try {
      expect((await probe(`${s.base}/nope`)).status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('ignores the query string when routing', async () => {
    const s = await serve({ health: () => health(), probeOptions: { now: () => at(2000) } });
    try {
      expect((await probe(`${s.base}${HEALTH_ROUTES.live}?probe=1`)).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('closes cleanly and stops answering', async () => {
    const s = await serve({ health: () => health() });
    await s.close();
    await expect(probe(`${s.base}${HEALTH_ROUTES.live}`)).rejects.toThrow();
  });
});
