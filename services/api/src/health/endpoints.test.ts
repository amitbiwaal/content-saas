import { describe, expect, it } from 'vitest';

import {
  HealthMonitor,
  type LocalDependencyCheck,
  type RemoteDependencyCheck,
} from '@contentos/observability';

import { HEALTH_PATHS, isHealthPath, live, ready, startup, StartupTracker } from './endpoints.js';

const local = (
  name: string,
  status: 'healthy' | 'degraded' | 'unhealthy',
): LocalDependencyCheck => ({
  name,
  kind: 'local',
  check: () => Promise.resolve({ status }),
});

const remote = (name: string): RemoteDependencyCheck => ({
  name,
  kind: 'remote',
  check: () => Promise.resolve({ status: 'unhealthy' as const }),
});

const BASE = { service: 'api', version: '1.0.0' };

describe('/health/live', () => {
  it('returns 200 without consulting a dependency', () => {
    const monitor = new HealthMonitor({ ...BASE, localChecks: [local('db', 'unhealthy')] });
    expect(live(monitor).status).toBe(200);
  });

  it('reports service identity', () => {
    const response = live(new HealthMonitor(BASE));
    expect(response.body).toMatchObject({ service: 'api', version: '1.0.0' });
  });
});

describe('/health/ready', () => {
  it('returns 200 when local dependencies are healthy', async () => {
    const monitor = new HealthMonitor({ ...BASE, localChecks: [local('db', 'healthy')] });
    expect((await ready(monitor)).status).toBe(200);
  });

  it('returns 503 when a local dependency is unhealthy', async () => {
    const monitor = new HealthMonitor({ ...BASE, localChecks: [local('db', 'unhealthy')] });
    expect((await ready(monitor)).status).toBe(503);
  });

  // Degraded means reduced capability, not inability to serve.
  it('returns 200 when degraded rather than pulling every instance', async () => {
    const monitor = new HealthMonitor({ ...BASE, localChecks: [local('redis', 'degraded')] });
    expect((await ready(monitor)).status).toBe(200);
  });

  it('returns 503 when the migration version is not current', async () => {
    const monitor = new HealthMonitor({
      ...BASE,
      migrationVersion: () => Promise.resolve({ version: '0004', current: false }),
    });
    expect((await ready(monitor)).status).toBe(503);
  });

  // A readiness check that calls a provider turns a provider outage into a
  // full platform outage.
  it('does NOT cascade to a remote dependency', async () => {
    const monitor = new HealthMonitor({
      ...BASE,
      localChecks: [local('db', 'healthy')],
      remoteChecks: [remote('model-provider')],
    });
    expect((await ready(monitor)).status).toBe(200);
  });
});

describe('/health/startup', () => {
  it('returns 503 before boot completes', () => {
    expect(startup(new StartupTracker()).status).toBe(503);
  });

  it('returns 200 once complete', () => {
    const tracker = new StartupTracker();
    tracker.markComplete();
    expect(startup(tracker).status).toBe(200);
  });

  it('records the completion time', () => {
    const at = new Date('2026-07-29T10:00:00Z');
    const tracker = new StartupTracker(() => at);
    tracker.markComplete();
    expect(tracker.state().completedAt).toEqual(at);
  });

  it('is idempotent — the first completion wins', () => {
    let tick = 0;
    const tracker = new StartupTracker(() => new Date(1000 + tick++));
    tracker.markComplete();
    const first = tracker.state().completedAt;
    tracker.markComplete();
    expect(tracker.state().completedAt).toEqual(first);
  });
});

describe('health paths', () => {
  it('exposes exactly three probes', () => {
    expect(Object.values(HEALTH_PATHS)).toEqual([
      '/health/live',
      '/health/ready',
      '/health/startup',
    ]);
  });

  it('recognises probe paths', () => {
    expect(isHealthPath('/health/live')).toBe(true);
    expect(isHealthPath('/v1/articles')).toBe(false);
  });
});
