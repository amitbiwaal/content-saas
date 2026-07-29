import { describe, expect, it } from 'vitest';

import {
  decodeBase32,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCodes,
  hotp,
  mfaRequirement,
  totpAt,
  totpEnrolmentUri,
  verifyRecoveryCode,
  verifyTotp,
} from './mfa.js';

// RFC 4226 Appendix D — the canonical HOTP vectors for secret "12345678901234567890".
const RFC4226_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC4226 = [
  '755224',
  '287082',
  '359152',
  '969429',
  '338314',
  '254676',
  '287922',
  '162583',
  '399871',
  '520489',
];

describe('HOTP — RFC 4226', () => {
  it('matches every published vector', () => {
    RFC4226.forEach((expected, counter) => {
      expect(hotp(RFC4226_SECRET, counter)).toBe(expected);
    });
  });
  it('produces the configured digit count', () => {
    expect(hotp(RFC4226_SECRET, 0)).toHaveLength(6);
    expect(hotp(RFC4226_SECRET, 0, 8)).toHaveLength(8);
  });
});

describe('TOTP — RFC 6238', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of the RFC secret
  it('decodes base32 to the RFC secret', () => {
    expect(decodeBase32(secret).toString('ascii')).toBe('12345678901234567890');
  });
  it('is stable within a 30-second window', () => {
    const a = totpAt(secret, new Date('2026-07-29T10:00:00Z'));
    const b = totpAt(secret, new Date('2026-07-29T10:00:29Z'));
    expect(a).toBe(b);
  });
  it('changes at the window boundary', () => {
    const a = totpAt(secret, new Date('2026-07-29T10:00:29Z'));
    const b = totpAt(secret, new Date('2026-07-29T10:00:30Z'));
    expect(a).not.toBe(b);
  });
  it('accepts the current code', () => {
    const at = new Date('2026-07-29T10:00:00Z');
    expect(verifyTotp(secret, totpAt(secret, at), at)).toBe(true);
  });
  it('tolerates one step of clock skew in both directions', () => {
    const at = new Date('2026-07-29T10:01:00Z');
    const past = totpAt(secret, new Date(at.getTime() - 30_000));
    const future = totpAt(secret, new Date(at.getTime() + 30_000));
    expect(verifyTotp(secret, past, at)).toBe(true);
    expect(verifyTotp(secret, future, at)).toBe(true);
  });
  it('rejects a code two steps away', () => {
    const at = new Date('2026-07-29T10:01:00Z');
    expect(verifyTotp(secret, totpAt(secret, new Date(at.getTime() - 90_000)), at)).toBe(false);
  });
  it('rejects a wrong code', () => {
    expect(verifyTotp(secret, '000000', new Date('2026-07-29T10:00:00Z'))).toBe(false);
  });
  it('rejects an invalid base32 secret', () => {
    expect(() => decodeBase32('!!!!')).toThrow(/Invalid base32/);
  });
  it('generates base32 secrets', () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]+$/);
  });

  // Regression: indexed access into the alphabet is `string | undefined` under
  // noUncheckedIndexedAccess, and `+=` on an undefined appends the literal
  // "undefined" — a corrupted secret that a length-only or charset-only check
  // on a single sample can miss.
  it('never emits the literal "undefined" in a secret, across many samples', () => {
    for (let i = 0; i < 200; i += 1) {
      const secret = generateTotpSecret();
      expect(secret).not.toContain('undefined');
      expect(secret).toMatch(/^[A-Z2-7]+$/);
    }
  });

  it('generates a secret of the expected length', () => {
    // ceil(20 * 8 / 5) = 32 characters for the default 20 bytes.
    expect(generateTotpSecret()).toHaveLength(32);
    expect(generateTotpSecret(10)).toHaveLength(16);
  });
  it('builds an otpauth URI carrying the parameters', () => {
    const uri = totpEnrolmentUri('ContentOS', 'a@b.com', 'ABCD');
    expect(uri.startsWith('otpauth://totp/ContentOS%3Aa%40b.com?')).toBe(true);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('recovery codes', () => {
  it('generates ten by default', () => {
    expect(generateRecoveryCodes()).toHaveLength(10);
  });
  it('generates unique codes', () => {
    expect(new Set(generateRecoveryCodes(50)).size).toBe(50);
  });
  it('omits ambiguous characters', () => {
    for (const code of generateRecoveryCodes(30)) expect(code).not.toMatch(/[IO01]/);
  });

  // Same regression as the TOTP secret: a corrupted code is unusable and the
  // user only discovers it when they are locked out.
  it('never emits the literal "undefined" in a recovery code', () => {
    for (const code of generateRecoveryCodes(200)) {
      expect(code).not.toContain('undefined');
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    }
  });
  it('accepts a valid code and reports which was consumed', async () => {
    const codes = generateRecoveryCodes(3);
    const hashes = await hashRecoveryCodes(codes);
    const result = await verifyRecoveryCode(codes[1]!, hashes);
    expect(result.accepted).toBe(true);
    expect(result.consumedIndex).toBe(1);
  });
  it('is case- and separator-insensitive', async () => {
    const codes = generateRecoveryCodes(1);
    const hashes = await hashRecoveryCodes(codes);
    expect(
      (await verifyRecoveryCode(codes[0]!.toLowerCase().replace('-', ''), hashes)).accepted,
    ).toBe(true);
  });
  it('rejects an unknown code', async () => {
    const hashes = await hashRecoveryCodes(generateRecoveryCodes(3));
    const result = await verifyRecoveryCode('AAAAA-AAAAA', hashes);
    expect(result.accepted).toBe(false);
    expect(result.consumedIndex).toBeNull();
  });
  it('rejects against an empty hash list', async () => {
    expect((await verifyRecoveryCode('AAAAA-AAAAA', [])).accepted).toBe(false);
  });
});

describe('MFA policy', () => {
  const base = { enforced: false, requiredForRoles: [] as string[] };
  it('requires MFA when the organization enforces it', () => {
    expect(
      mfaRequirement({ policy: { ...base, enforced: true }, roles: [], method: 'password' }),
    ).toBe('required');
  });
  it('requires MFA for a mandated role', () => {
    expect(
      mfaRequirement({
        policy: { ...base, requiredForRoles: ['org_owner'] },
        roles: ['org_owner'],
        method: 'password',
      }),
    ).toBe('required');
  });
  it('is optional otherwise', () => {
    expect(mfaRequirement({ policy: base, roles: ['viewer'], method: 'password' })).toBe(
      'optional',
    );
  });
  // The IdP performs the second factor; prompting again adds no assurance.
  it('exempts SSO methods', () => {
    expect(mfaRequirement({ policy: { ...base, enforced: true }, roles: [], method: 'saml' })).toBe(
      'optional',
    );
    expect(mfaRequirement({ policy: { ...base, enforced: true }, roles: [], method: 'oidc' })).toBe(
      'optional',
    );
  });
  it('is deterministic', () => {
    const input = { policy: { ...base, enforced: true }, roles: ['editor'], method: 'password' };
    expect(mfaRequirement(input)).toBe(mfaRequirement(input));
  });
});
