import { describe, expect, it } from 'vitest';

import { HealthMonitor, type LocalDependencyCheck, type RemoteDependencyCheck } from './health.js';

function local(name: string, status: 'healthy' | 'degraded' | 'unhealthy'): LocalDependencyCheck {
  return { name, kind: 'local', check: () => Promise.resolve({ status }) };
}

function remote(name: string, status: 'healthy' | 'unhealthy'): RemoteDependencyCheck {
  return { name, kind: 'remote', check: () => Promise.resolve({ status }) };
}

const BASE = { service: 'api', version: '1.0.0' };

describe('/health/live', () => {
  // Process is running; NO dependency checks, by design.
  it('reports healthy without consulting any dependency', () => {
    let called = false;
    const monitor = new HealthMonitor({
      ...BASE,
      localChecks: [
        {
          name: 'db',
          kind: 'local',
          check: () => {
            called = true;
            return Promise.resolve({ status: 'unhealthy' as const });
          },
        },
      ],
    });
    expect(monitor.live().status).toBe('healthy');
    expect(called).toBe(false);
  });

  it('reports service identity and uptime', () => {
    let clock = 10_000;
    const monitor = new HealthMonitor({ ...BASE, now: () => clock, startedAtMs: 10_000 });
    clock = 42_000;
    expect(monitor.live()).toMatchObject({ service: 'api', version: '1.0.0', uptimeSeconds: 32 });
  });
});

describe('/health/ready', () => {
  it('is healthy when local dependencies are healthy', async () => {
    const monitor = new HealthMonitor({ ...BASE, localChecks: [local('db', 'healthy')] });
    const report = await monitor.ready();
    expect(report.status).toBe('healthy');
    expect(report.dependencies).toHaveLength(1);
  });

  it('takes the worst local dependency status', async () => {
    const monitor = new HealthMonitor({
      ...BASE,
      localChecks: [local('db', 'healthy'), local('redis', 'degraded')],
    });
    expect((await monitor.ready()).status).toBe('degraded');

    const worse = new HealthMonitor({
      ...BASE,
      localChecks: [local('db', 'degraded'), local('redis', 'unhealthy')],
    });
    expect((await worse.ready()).status).toBe('unhealthy');
  });

  // Must not cascade — a readiness check never consults a remote dependency.
  it('does NOT run remote checks', async () => {
    let called = false;
    const monitor = new HealthMonitor({
      ...BASE,
      localChecks: [local('db', 'healthy')],
      remoteChecks: [
        {
          name: 'model-provider',
          kind: 'remote',
          check: () => {
            called = true;
            return Promise.resolve({ status: 'unhealthy' as const });
          },
        },
      ],
    });
    const report = await monitor.ready();
    expect(called).toBe(false);
    expect(report.status).toBe('healthy');
  });

  it('is unhealthy when the migration version is not current', async () => {
    const monitor = new HealthMonitor({
      ...BASE,
      localChecks: [local('db', 'healthy')],
      migrationVersion: () => Promise.resolve({ version: '0007', current: false }),
    });
    const report = await monitor.ready();
    expect(report.status).toBe('unhealthy');
    expect(report.migrationVersion).toBe('0007');
    expect(report.migrationCurrent).toBe(false);
  });

  it('treats an unreadable migration version as not current', async () => {
    const monitor = new HealthMonitor({
      ...BASE,
      migrationVersion: () => Promise.reject(new Error('db down')),
    });
    expect((await monitor.ready()).status).toBe('unhealthy');
  });

  it('reports a throwing check as unhealthy with a sanitised detail', async () => {
    const monitor = new HealthMonitor({
      ...BASE,
      localChecks: [
        {
          name: 'db',
          kind: 'local',
          check: () => Promise.reject(new Error('password=hunter2 at 10.0.0.1')),
        },
      ],
    });
    const report = await monitor.ready();
    expect(report.status).toBe('unhealthy');
    expect(report.dependencies[0]?.detail).toBe('Error');
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });

  it('records a latency per dependency', async () => {
    const monitor = new HealthMonitor({ ...BASE, localChecks: [local('db', 'healthy')] });
    expect((await monitor.ready()).dependencies[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('/health/deep', () => {
  it('includes both local and remote dependencies', async () => {
    const monitor = new HealthMonitor({
      ...BASE,
      localChecks: [local('db', 'healthy')],
      remoteChecks: [remote('model-provider', 'unhealthy')],
    });
    const report = await monitor.deep();
    expect(report.dependencies.map((d) => d.name)).toEqual(['db']);
    expect(report.remote.map((d) => d.name)).toEqual(['model-provider']);
  });

  // Remote failure is visible in deep but must not have made readiness unready.
  it('does not let a failing remote dependency change the readiness status', async () => {
    const monitor = new HealthMonitor({
      ...BASE,
      localChecks: [local('db', 'healthy')],
      remoteChecks: [remote('model-provider', 'unhealthy')],
    });
    const report = await monitor.deep();
    expect(report.status).toBe('healthy');
    expect(report.remote[0]?.status).toBe('unhealthy');
  });
});
