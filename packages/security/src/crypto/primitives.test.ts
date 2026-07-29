import { describe, expect, it } from 'vitest';

import {
  constantTimeEquals,
  hashSecret,
  hmacSha1,
  needsRehash,
  secureId,
  secureRandomInt,
  secureToken,
  verifySecret,
} from './primitives.js';

describe('secure random', () => {
  it('generates unique ids', () => {
    expect(new Set(Array.from({ length: 500 }, () => secureId())).size).toBe(500);
  });
  it('generates UUID-shaped ids', () => {
    expect(secureId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  it('generates 256-bit URL-safe tokens by default', () => {
    const token = secureToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('generates unique tokens', () => {
    expect(new Set(Array.from({ length: 500 }, () => secureToken())).size).toBe(500);
  });
  it('bounds random integers to [0, max)', () => {
    for (let i = 0; i < 200; i += 1) {
      const n = secureRandomInt(10);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(10);
    }
  });
});

describe('constant-time comparison', () => {
  it('matches identical strings', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
  });
  it('rejects differing strings of equal length', () => {
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });
  it('rejects differing lengths without throwing', () => {
    expect(constantTimeEquals('a', 'abcdef')).toBe(false);
  });
  it('handles empty strings', () => {
    expect(constantTimeEquals('', '')).toBe(true);
  });
  it('is unicode-safe', () => {
    expect(constantTimeEquals('héllo', 'héllo')).toBe(true);
  });
});

describe('secret hashing', () => {
  it('verifies a correct secret', async () => {
    expect(await verifySecret('correct horse', await hashSecret('correct horse'))).toBe(true);
  });
  it('rejects an incorrect secret', async () => {
    expect(await verifySecret('wrong', await hashSecret('correct horse'))).toBe(false);
  });
  it('salts, so equal secrets hash differently', async () => {
    expect(await hashSecret('same')).not.toBe(await hashSecret('same'));
  });
  it('records its parameters so cost can be raised later', async () => {
    const hash = await hashSecret('x');
    expect(hash.split('$')[0]).toBe('scrypt');
    expect(hash.split('$')).toHaveLength(6);
  });
  it('rejects malformed stored hashes rather than throwing', async () => {
    expect(await verifySecret('x', 'garbage')).toBe(false);
    expect(await verifySecret('x', 'scrypt$1$2$3')).toBe(false);
    expect(await verifySecret('x', 'bcrypt$1$1$1$aaaa$bbbb')).toBe(false);
    expect(await verifySecret('x', 'scrypt$N$r$p$aaaa$bbbb')).toBe(false);
  });
  it('flags weaker hashes for rehash', () => {
    expect(needsRehash('scrypt$1024$8$1$aaaa$bbbb')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });
  it('does not flag a current hash', async () => {
    expect(needsRehash(await hashSecret('x'))).toBe(false);
  });
});

describe('hmac', () => {
  // RFC 2202 test case 1 for HMAC-SHA1.
  it('matches the RFC 2202 HMAC-SHA1 vector', () => {
    const key = Buffer.alloc(20, 0x0b);
    expect(hmacSha1(key, Buffer.from('Hi There')).toString('hex')).toBe(
      'b617318655057264e28bc0b6fb378c8ef146be00',
    );
  });
});
