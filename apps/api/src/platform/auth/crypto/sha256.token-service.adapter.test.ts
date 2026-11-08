import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeBase64Url32 } from './canonical-base64url.js';
import { Sha256TokenService } from './sha256.token-service.adapter.js';

// The comparison is the claim ("constant-time compare"), so the primitive that makes it is counted: the real function, wrapped.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const comparisons = vi.mocked(timingSafeEqual);
const sha256 = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();

beforeEach(() => {
  comparisons.mockClear();
});

describe('Sha256TokenService (S0.3b)', () => {
  describe('issue', () => {
    it('makes 32 random bytes shown as 43 characters of unpadded base64url (SECURITY_DESIGN.md §14.9)', () => {
      const { token } = new Sha256TokenService().issue();

      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decodeBase64Url32(token)).toBeDefined();
    });

    // Break caught: a hash of the wrong thing, or the raw token kept: what is stored must be the SHA-256 of the 32 bytes.
    it('returns the SHA-256 of those 32 bytes as the only form to keep', () => {
      const { token, hash } = new Sha256TokenService().issue();
      const bytes = decodeBase64Url32(token);

      expect(bytes).toBeDefined();
      expect(hash).toHaveLength(32);
      expect(Buffer.from(hash).equals(sha256(bytes ?? Buffer.alloc(0)))).toBe(true);
      expect(Buffer.from(hash).toString('base64url')).not.toBe(token);
      expect(Buffer.from(hash).toString('hex')).not.toContain(Buffer.from(token).toString('hex'));
    });

    // Break caught: a generator that is not random (a counter, a timestamp, a constant): no byte position is stuck, and
    // across 200 tokens a position takes a wide spread of values (about 139 distinct values expected of 256).
    it('is random in every byte and never repeats', () => {
      const service = new Sha256TokenService();
      const tokens = Array.from({ length: 200 }, () => service.issue().token);
      const decoded = tokens.map((token) => decodeBase64Url32(token) ?? Buffer.alloc(0));

      expect(new Set(tokens).size).toBe(200);
      for (let position = 0; position < 32; position += 1) {
        const seen = new Set(decoded.map((bytes) => bytes.readUInt8(position)));
        expect(seen.size, `byte ${String(position)}`).toBeGreaterThan(60);
      }
    });

    it('gives each issue its own hash', () => {
      const service = new Sha256TokenService();

      const first = service.issue();
      const second = service.issue();

      expect(Buffer.from(first.hash).equals(second.hash)).toBe(false);
    });
  });

  describe('hash', () => {
    // A published value: SHA-256 of 32 zero bytes. It pins that the hash is over the 32 bytes a token spells and not over its
    // 43 characters, which would give a different value for the same token.
    it('is the SHA-256 of the 32 bytes the token spells', () => {
      const service = new Sha256TokenService();
      const zeroToken = 'A'.repeat(43);

      expect(Buffer.from(service.hash(zeroToken) ?? []).toString('hex')).toBe(
        '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
      );
      expect(Buffer.from(service.hash(zeroToken) ?? []).toString('hex')).not.toBe(
        createHash('sha256').update(zeroToken, 'ascii').digest('hex'),
      );
    });

    it('is the same for the same token, and what issue returned', () => {
      const service = new Sha256TokenService();
      const issued = service.issue();

      const hashed = (): Buffer => Buffer.from(service.hash(issued.token) ?? []);

      expect(hashed().equals(issued.hash)).toBe(true);
      expect(hashed().equals(hashed())).toBe(true);
    });

    // The service applies the shape to a presented token "before any hash, lookup or limiter key", so a malformed value is
    // neither more expensive nor distinguishable (SECURITY_DESIGN.md §13.6).
    it.each([
      ['an empty string', ''],
      ['42 characters', 'A'.repeat(42)],
      ['44 characters', 'A'.repeat(44)],
      ['padding', `${'A'.repeat(42)}=`],
      ['standard base64 characters', `${'A'.repeat(40)}+/A`],
      ['surrounding white space', ` ${'A'.repeat(43)} `],
      ['a newline', `${'A'.repeat(43)}\n`],
      ['a non-canonical spelling', `${'A'.repeat(42)}B`],
      ['a value of another type', 12345 as unknown as string],
      ['undefined', undefined as unknown as string],
      ['a very long string', 'A'.repeat(1_000_000)],
    ])('returns null for %s, without hashing it', (_label, token) => {
      expect(new Sha256TokenService().hash(token)).toBeNull();
    });
  });

  describe('matches', () => {
    it('is true for the token that was issued and the hash that was kept', () => {
      const service = new Sha256TokenService();
      const { token, hash } = service.issue();

      expect(service.matches(token, hash)).toBe(true);
    });

    it('is true when the hash comes back from a database as a Buffer', () => {
      const service = new Sha256TokenService();
      const { token, hash } = service.issue();

      expect(service.matches(token, Buffer.from(hash))).toBe(true);
    });

    it('is false for another token', () => {
      const service = new Sha256TokenService();
      const { hash } = service.issue();

      expect(service.matches(service.issue().token, hash)).toBe(false);
    });

    // Break caught: comparing only a prefix, or the hash of the wrong bytes: one flipped bit anywhere must not match.
    it('is false when any single bit of the stored hash differs', () => {
      const service = new Sha256TokenService();
      const { token, hash } = service.issue();

      for (let byte = 0; byte < 32; byte += 1) {
        const altered = Buffer.from(hash);
        altered.writeUInt8(altered.readUInt8(byte) ^ 0x01, byte);
        expect(service.matches(token, altered), `byte ${String(byte)}`).toBe(false);
      }
    });

    it('is false for a token that is not well formed, as a token that matches nothing', () => {
      const service = new Sha256TokenService();
      const { token, hash } = service.issue();

      for (const malformed of [
        '',
        token.slice(1),
        `${token}A`,
        ` ${token}`,
        `${token}\n`,
        token.replace(/.$/, '='),
      ]) {
        expect(service.matches(malformed, hash)).toBe(false);
      }
      expect(service.matches(undefined as unknown as string, hash)).toBe(false);
    });

    // Break caught: a stored value of the wrong length reaching the comparison, which throws instead of answering: a corrupt
    // row must read as "does not match".
    it.each([
      ['empty', Buffer.alloc(0)],
      ['31 bytes', randomBytes(31)],
      ['33 bytes', randomBytes(33)],
      ['null', null],
      ['undefined', undefined],
      ['text', 'a'.repeat(64)],
    ])('is false, and does not throw, for a stored hash that is %s', (_label, stored) => {
      const service = new Sha256TokenService();
      const { token } = service.issue();

      expect(service.matches(token, stored as unknown as Uint8Array)).toBe(false);
    });

    describe('compares in constant time', () => {
      it("hands the presented token's hash and the stored hash to crypto.timingSafeEqual, once", () => {
        const service = new Sha256TokenService();
        const { token, hash } = service.issue();

        expect(service.matches(token, hash)).toBe(true);

        expect(comparisons).toHaveBeenCalledTimes(1);
        const [left, right] = comparisons.mock.calls[0] ?? [];
        expect(Buffer.from(left as Uint8Array).equals(hash)).toBe(true);
        expect(Buffer.from(right as Uint8Array).equals(hash)).toBe(true);
      });

      it('uses it for a mismatch as well, so a wrong token costs the same comparison as a right one', () => {
        const service = new Sha256TokenService();
        const { token, hash } = service.issue();
        const other = service.issue().token;

        expect(service.matches(other, hash)).toBe(false);
        expect(service.matches(token, hash)).toBe(true);

        expect(comparisons).toHaveBeenCalledTimes(2);
      });

      it('does not reach it for what cannot match: a malformed token or a stored hash of the wrong length', () => {
        const service = new Sha256TokenService();
        const { token, hash } = service.issue();

        service.matches('malformed', hash);
        service.matches(token, hash.slice(1));

        expect(comparisons).not.toHaveBeenCalled();
      });
    });
  });

  // The plan's rule for every task that touches a secret (§3, "Secrets"): a sentinel test.
  describe('sentinel: it holds and prints nothing', () => {
    it('keeps no token, and shows nothing when printed or serialised', () => {
      const service = new Sha256TokenService();
      const { token } = service.issue();
      service.hash(token);
      service.matches(token, randomBytes(32));

      const seen = [
        Object.prototype.toString.call(service),
        JSON.stringify(service),
        inspect(service, { showHidden: true, depth: 8 }),
      ];

      for (const text of seen) expect(text).not.toContain(token);
      expect(Object.getOwnPropertyNames(service)).toEqual([]);
    });
  });
});
