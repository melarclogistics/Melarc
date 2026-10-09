import { describe, expect, it } from 'vitest';

import { ARGON2ID_LIMITS, DEVELOPMENT_QUALIFIED_ARGON2ID } from './argon2-parameters.js';
import { argon2idTag } from './argon2id.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

// The qualification of the plan's S0.3a: Node's built-in `crypto.argon2` on the pinned Node, against published vectors. A vector
// that disagreed with the library would be a stop condition (plan S0.3: "Stop if. A published vector disagrees with the library").
describe('argon2idTag, the one place the application calls crypto.argon2', () => {
  // RFC 9106 section 5.3 (Argon2id test vector): version 0x13, 32 KiB, 3 passes, 4 lanes, a 32-byte tag, with a secret value and
  // associated data, so the pepper and the context inputs of the Hasher are exercised too.
  it('reproduces the RFC 9106 section 5.3 Argon2id test vector', async () => {
    const tag = await argon2idTag({
      message: Buffer.alloc(32, 0x01),
      salt: Buffer.alloc(16, 0x02),
      parameters: { memoryKiB: 32, passes: 3, parallelism: 4 },
      pepper: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
    });

    expect(hex(tag)).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  // The Argon2 reference implementation's own Argon2id test (test.c): "password" / "somesalt", 2 passes, 64 MiB, one lane. It is
  // also the development-qualified cost, so the cost the application uses by default is the one a published vector covers.
  it('reproduces the Argon2 reference implementation vector at the development-qualified cost', async () => {
    expect(DEVELOPMENT_QUALIFIED_ARGON2ID).toEqual({ memoryKiB: 65536, passes: 2, parallelism: 1 });

    const tag = await argon2idTag({
      message: Buffer.from('password'),
      salt: Buffer.from('somesalt'),
      parameters: DEVELOPMENT_QUALIFIED_ARGON2ID,
      pepper: Buffer.alloc(0),
      associatedData: Buffer.alloc(0),
    });

    expect(hex(tag)).toBe('09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7');
    expect(Buffer.from(tag).toString('base64').replace(/=+$/, '')).toBe(
      'CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
    );
  });

  describe('every input changes the tag, so none is ignored', () => {
    const cheap = { memoryKiB: 64, passes: 1, parallelism: 1 } as const;
    const base = {
      message: Buffer.from('synthetic message'),
      salt: Buffer.alloc(16, 0x07),
      parameters: cheap,
      pepper: Buffer.alloc(32, 0x09),
      associatedData: Buffer.from('context'),
    };

    // Break caught: a pepper or a context that is passed but never reaches the algorithm, which would make every hash portable to
    // another deployment or another kind of credential.
    it.each([
      ['the message', { message: Buffer.from('synthetic messagf') }],
      ['the salt', { salt: Buffer.alloc(16, 0x08) }],
      ['the memory', { parameters: { ...cheap, memoryKiB: 68 } }],
      ['the passes', { parameters: { ...cheap, passes: 2 } }],
      ['the pepper', { pepper: Buffer.alloc(32, 0x0a) }],
      ['the associated data', { associatedData: Buffer.from('contexu') }],
    ])('%s', async (_label, change) => {
      const reference = await argon2idTag(base);
      const changed = await argon2idTag({ ...base, ...change });

      expect(Buffer.from(changed).equals(reference)).toBe(false);
    });

    it('gives the same tag for the same inputs', async () => {
      expect(Buffer.from(await argon2idTag(base)).equals(await argon2idTag({ ...base }))).toBe(
        true,
      );
    });

    it('treats an absent pepper and associated data as empty ones', async () => {
      const empty = await argon2idTag({
        ...base,
        pepper: Buffer.alloc(0),
        associatedData: Buffer.alloc(0),
      });

      expect(empty).toHaveLength(32);
    });
  });

  // Break caught: a path to the library that skips the limits, so a cost taken from storage or configuration can ask for
  // unbounded memory.
  it('refuses parameters outside the limits before the library is reached', async () => {
    await expect(
      argon2idTag({
        message: Buffer.from('x'),
        salt: Buffer.alloc(16),
        parameters: { memoryKiB: ARGON2ID_LIMITS.maxMemoryKiB + 4, passes: 1, parallelism: 1 },
        pepper: Buffer.alloc(32),
        associatedData: Buffer.alloc(0),
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      argon2idTag({
        message: Buffer.from('x'),
        salt: Buffer.alloc(16),
        parameters: { memoryKiB: 65537, passes: 1, parallelism: 1 },
        pepper: Buffer.alloc(32),
        associatedData: Buffer.alloc(0),
      }),
    ).rejects.toThrow(RangeError);
  });

  it('refuses a salt shorter than the 8 bytes the algorithm requires', async () => {
    await expect(
      argon2idTag({
        message: Buffer.from('x'),
        salt: Buffer.alloc(7),
        parameters: { memoryKiB: 64, passes: 1, parallelism: 1 },
        pepper: Buffer.alloc(32),
        associatedData: Buffer.alloc(0),
      }),
    ).rejects.toThrow(RangeError);
  });

  // The Hasher's promise is that hashing runs off the request's event loop (SECURITY_DESIGN.md §13.4c). The event loop gets a turn
  // while the derivation is still running; with a synchronous implementation the derivation would be finished before this
  // function returned.
  it('does not block the event loop while it works', async () => {
    const work = argon2idTag({
      message: Buffer.from('synthetic'),
      salt: Buffer.alloc(16, 1),
      parameters: { memoryKiB: 19456, passes: 2, parallelism: 1 },
      pepper: Buffer.alloc(32, 2),
      associatedData: Buffer.alloc(0),
    });

    const first = await Promise.race([
      work.then(() => 'hash'),
      new Promise<string>((resolve) => {
        setImmediate(() => {
          resolve('turn');
        });
      }),
    ]);

    expect(first).toBe('turn');
    await work;
  });
});
