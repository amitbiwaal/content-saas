/**
 * Redaction — layer 3, the pattern backstop.
 *
 * The URI arm of this suite exists because of a real gap: the scanner caught
 * `Bearer …` but let `postgres://user:password@host/db` through verbatim, so
 * every connection string in an error message reached the log store in the
 * clear. Each case below is a shape that reached, or could reach, a log line.
 */
import { describe, expect, it } from 'vitest';

import { REDACTED, SecretValue, scanForCredentials } from './redaction.js';

/**
 * The full contract for one bare URI: the secret is gone, the diagnostic parts
 * survive, and the result still parses.
 *
 * Parseability is asserted rather than eyeballed because a redactor that emits
 * a broken URI has traded one operational problem for another — logs get
 * re-parsed by tooling downstream, not just read by people.
 */
function expectRedacted(input: string, expected: string): void {
  const { value, hits } = scanForCredentials(input);
  expect(value).toBe(expected);
  expect(hits).toBe(1);
  expect(() => new URL(value)).not.toThrow();
  expect(new URL(value).host).toBe(new URL(input).host);
}

/** Nothing matched: byte-identical output, and no hit on a counter that pages. */
function expectUntouched(input: string): void {
  expect(scanForCredentials(input)).toEqual({ value: input, hits: 0 });
}

describe('scanForCredentials — connection URI credentials', () => {
  it('redacts a PostgreSQL URI, keeping user, host, port, path and query', () => {
    expectRedacted(
      'postgres://app_user:s3cr3t-pw@db.internal:5432/contentos?sslmode=require',
      `postgres://app_user:${REDACTED}@db.internal:5432/contentos?sslmode=require`,
    );
  });

  it('redacts the postgresql:// spelling of the same scheme', () => {
    expectRedacted(
      'postgresql://app_user:s3cr3t-pw@db.internal:5432/contentos',
      `postgresql://app_user:${REDACTED}@db.internal:5432/contentos`,
    );
  });

  it('redacts a Redis URI with the conventional default user', () => {
    expectRedacted(
      'redis://default:e7f2a91c@cache.internal:6379/0',
      `redis://default:${REDACTED}@cache.internal:6379/0`,
    );
  });

  // The regression that motivated widening the user group from `+` to `*`.
  // Password-only is the CANONICAL Redis URI — `requirepass` sets no username —
  // so the driver most likely to omit a user was the one still leaking.
  it('redacts a Redis URI that has a password but no username', () => {
    expectRedacted(
      'rediss://:e7f2a91c@cache.internal:6380',
      `rediss://:${REDACTED}@cache.internal:6380`,
    );
  });

  it('redacts a MongoDB URI across a multi-host replica set', () => {
    const { value, hits } = scanForCredentials(
      'mongodb://admin:m0ngo-pw@rs1.internal:27017,rs2.internal:27017/app?replicaSet=rs0',
    );
    expect(value).toBe(
      `mongodb://admin:${REDACTED}@rs1.internal:27017,rs2.internal:27017/app?replicaSet=rs0`,
    );
    expect(hits).toBe(1);
    expect(value).not.toContain('m0ngo-pw');
  });

  it('redacts an AMQP URI, keeping the vhost', () => {
    expectRedacted(
      'amqp://svc_publisher:rabbit-pw@mq.internal:5672/contentos',
      `amqp://svc_publisher:${REDACTED}@mq.internal:5672/contentos`,
    );
  });

  it('redacts a Kafka URI', () => {
    expectRedacted(
      'kafka://relay:kafka-pw@broker-1.internal:9092',
      `kafka://relay:${REDACTED}@broker-1.internal:9092`,
    );
  });

  it('redacts a MySQL URI', () => {
    expectRedacted(
      'mysql://root:mysql-pw@mysql.internal:3306/app',
      `mysql://root:${REDACTED}@mysql.internal:3306/app`,
    );
  });

  it('redacts a MariaDB URI', () => {
    expectRedacted(
      'mariadb://root:maria-pw@maria.internal:3306/app',
      `mariadb://root:${REDACTED}@maria.internal:3306/app`,
    );
  });

  it('redacts a NATS URI', () => {
    expectRedacted(
      'nats://svc:nats-pw@nats.internal:4222',
      `nats://svc:${REDACTED}@nats.internal:4222`,
    );
  });

  // The scheme list in the hotfix brief is a floor, not an allowlist: the shape
  // `scheme://user:password@` is credential-bearing by construction, so a
  // driver nobody has adopted yet is covered the day it appears.
  it('covers every required scheme, and any other, by shape rather than by list', () => {
    const required = [
      'postgres',
      'postgresql',
      'redis',
      'rediss',
      'mysql',
      'mariadb',
      'mongodb',
      'amqp',
      'kafka',
      'nats',
    ];

    for (const scheme of [...required, 'mssql', 'ldap', 'clickhouse+native']) {
      const { value, hits } = scanForCredentials(`${scheme}://u:pw-${scheme}@host:1234/db`);
      expect(value, scheme).toBe(`${scheme}://u:${REDACTED}@host:1234/db`);
      expect(hits, scheme).toBe(1);
    }
  });

  it('preserves the scheme and username casing as written', () => {
    expectRedacted(
      'POSTGRES://App_User:Secret@Db.Internal/app',
      `POSTGRES://App_User:${REDACTED}@Db.Internal/app`,
    );
  });

  it('redacts a password containing colons and percent-encoding', () => {
    expectRedacted(
      'postgres://user:p%40ss:w0rd%21@db.internal/app',
      `postgres://user:${REDACTED}@db.internal/app`,
    );
  });

  it('redacts a URI embedded in a sentence without disturbing the prose', () => {
    const { value, hits } = scanForCredentials(
      'connection refused for postgres://app:hunter2@db.internal:5432/app after 3 retries',
    );
    expect(value).toBe(
      `connection refused for postgres://app:${REDACTED}@db.internal:5432/app after 3 retries`,
    );
    expect(hits).toBe(1);
    expect(value).not.toContain('hunter2');
  });
});

describe('scanForCredentials — multiple and mixed credentials', () => {
  it('redacts every URI in a message and counts each one', () => {
    const { value, hits } = scanForCredentials(
      'primary=postgres://app:pw-one@db1.internal:5432/main ' +
        'replica=postgres://app:pw-two@db2.internal:5432/main ' +
        'cache=rediss://:pw-three@cache.internal:6380',
    );

    expect(hits).toBe(3);
    for (const secret of ['pw-one', 'pw-two', 'pw-three']) {
      expect(value).not.toContain(secret);
    }
    // Each host survives — telling the replica from the primary is the reason
    // the message was logged at all.
    for (const host of ['db1.internal:5432', 'db2.internal:5432', 'cache.internal:6380']) {
      expect(value).toContain(host);
    }
  });

  it('redacts adjacent URIs with no whitespace between them', () => {
    const { value, hits } = scanForCredentials('postgres://a:pw-a@h1/db,postgres://b:pw-b@h2/db');
    expect(value).toBe(`postgres://a:${REDACTED}@h1/db,postgres://b:${REDACTED}@h2/db`);
    expect(hits).toBe(2);
  });

  it('redacts a bearer token and a URI in the same message', () => {
    const { value, hits } = scanForCredentials(
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 — upstream postgres://svc:db-pw@db.internal/app',
    );

    expect(value).toBe(
      `Authorization: ${REDACTED} — upstream postgres://svc:${REDACTED}@db.internal/app`,
    );
    expect(hits).toBe(2);
    expect(value).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(value).not.toContain('db-pw');
  });

  // An API key used as a database password is matched by BOTH the `sk-` arm and
  // the URI arm. It must be redacted once, not counted twice: the hit counter is
  // paged on, so an inflated count is a false alarm at 3am.
  it('counts a password that is itself a known token shape exactly once', () => {
    const { value, hits } = scanForCredentials(
      'postgres://user:sk-ABCDEFGHIJKLMNOP0123@db.internal/app',
    );
    expect(value).toBe(`postgres://user:${REDACTED}@db.internal/app`);
    expect(hits).toBe(1);
  });
});

describe('scanForCredentials — URIs that must NOT be touched', () => {
  // The `@` is what separates a credential from a port. Redacting `6379` here
  // would destroy the only useful part of a connection-failure message.
  it('leaves a credential-free URI exactly as written', () => {
    expectUntouched('redis://cache.internal:6379/0');
    expectUntouched('postgres://db.internal:5432/contentos?sslmode=require');
    expectUntouched('mongodb://rs1.internal:27017,rs2.internal:27017/app');
    expectUntouched('amqp://mq.internal:5672/contentos');
  });

  it('leaves ordinary URLs alone', () => {
    expectUntouched('GET https://api.example.com:8443/v1/health returned 503');
    expectUntouched('fetched https://cdn.example.com/assets/app.js in 42ms');
  });

  // Requiring a scheme is what keeps `user@host` shapes out of the match. An
  // email address and an SSH remote are not credentials, and redacting them
  // would make the scanner untrustworthy — and therefore turned off.
  it('does not treat an email address or an SSH remote as a credential', () => {
    expectUntouched('invite sent to ops.oncall@example.com');
    expectUntouched('cloning git@github.com:contentos/platform.git');
  });

  it('leaves a URI whose password is empty', () => {
    expectUntouched('postgres://user:@db.internal/app');
  });
});

describe('scanForCredentials — already-redacted and malformed input', () => {
  // Re-scanning happens for real: a message can pass through the scanner at the
  // logger and again at a relay. The second pass must report ZERO, because any
  // non-zero value on `redaction_pattern_hits_total` is an alert.
  it('reports no hit for an already-redacted URI', () => {
    expectUntouched(`postgres://app_user:${REDACTED}@db.internal:5432/contentos`);
    expectUntouched(`rediss://:${REDACTED}@cache.internal:6380`);
  });

  it('is idempotent — scanning its own output changes nothing', () => {
    const once = scanForCredentials('postgres://app:hunter2@db.internal:5432/app');
    const twice = scanForCredentials(once.value);
    expect(twice.value).toBe(once.value);
    expect(twice.hits).toBe(0);
  });

  it('handles malformed URI-like text without throwing or mangling it', () => {
    // No scheme, no authority, or nothing after the marker: none of these is a
    // connection URI, and none is altered.
    expectUntouched('postgres://');
    expectUntouched('postgres:///app');
    expectUntouched('not-a-uri');
    expectUntouched('postgres:/app:pw@host');
    expectUntouched('://app:pw@host');
    expectUntouched('');
  });

  it('does not run a match past the authority into a path or the next word', () => {
    expectUntouched('see postgres://db.internal:5432/reports/q3:draft@2026 for detail');
  });
});

describe('scanForCredentials — existing behaviour is unchanged', () => {
  /**
   * Every value here is synthetic, and has to STAY credential-shaped: a fixture
   * watered down until a scanner ignores it no longer proves the scanner it is
   * actually testing still works.
   *
   * The three `gitleaks:allow` markers are the three the repo secret scanner
   * flags. They are per-line rather than a path allowlist in `.gitleaks.toml`
   * on purpose — exempting the whole file would stop gitleaks catching a real
   * secret pasted in here later.
   */
  const CASES: readonly (readonly [string, string])[] = [
    ['bearer token', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'],
    ['basic auth', 'Authorization: Basic YWRtaW46aHVudGVyMnBhc3N3b3Jk'],
    ['openai key', 'key=sk-ABCDEFGHIJKLMNOPQRSTUVWX'], // gitleaks:allow
    ['github token', 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'],
    ['slack token', 'xoxb-1234567890-ABCDEFGHIJ'], // gitleaks:allow
    ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', // gitleaks:allow
    ],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['presigned url', 'https://s3.example.com/o?X-Amz-Signature=abcdef0123456789'],
  ];

  for (const [name, input] of CASES) {
    it(`still redacts a ${name}`, () => {
      const { value, hits } = scanForCredentials(input);
      expect(hits).toBeGreaterThan(0);
      expect(value).toContain(REDACTED);
    });
  }

  it('leaves ordinary text untouched', () => {
    expectUntouched('run 01J8 finished in 1240ms with outcome=success');
  });

  it('still redacts a SecretValue through toString and toJSON', () => {
    const secret = new SecretValue('super-secret');
    expect(String(secret)).toBe(REDACTED);
    expect(JSON.stringify({ dsn: secret })).toBe(`{"dsn":"${REDACTED}"}`);
    expect(secret.revealForUseOnly()).toBe('super-secret');
  });
});
