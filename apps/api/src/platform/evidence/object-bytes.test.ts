import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { StreamMismatchError, verifiedBytes } from './object-bytes.js';

/**
 * The bytes a scanner reads are the bytes the record declared (Run A2; SECURITY_DESIGN.md section 14.18b): the stream is counted and hashed as it passes, and the verdict is only
 * ever used if the count and the SHA-256 are the declared ones. Nothing here touches a store or a scanner.
 */
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const PARTS = [
  Buffer.from('a file of some '),
  Buffer.from('length, in three '),
  Buffer.from('parts'),
];
const WHOLE = Buffer.concat(PARTS);
const DECLARED = { byteSize: WHOLE.length, checksumSha256: sha(WHOLE) };

async function* framesOf(...parts: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    await Promise.resolve();
    yield part;
  }
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const taken: Uint8Array[] = [];
  for await (const chunk of stream) taken.push(chunk);
  return Buffer.concat(taken);
}

describe('verifiedBytes', () => {
  // Break caught: a pass-through that alters, drops or reorders a byte, so that the scanner judges something other than the object.
  it('passes the bytes on unchanged when the count and the hash are the declared ones', async () => {
    expect((await drain(verifiedBytes(framesOf(...PARTS), DECLARED))).equals(WHOLE)).toBe(true);
  });

  // Break caught: a verdict accepted for an object whose bytes are not the declared ones (replaced between the look at it and the scan).
  it('fails at the end when the hash is not the declared one', async () => {
    const other = Buffer.from('a file of some length, in three PARTS');
    expect(other.length).toBe(WHOLE.length);
    await expect(drain(verifiedBytes(framesOf(other), DECLARED))).rejects.toMatchObject({
      name: 'StreamMismatchError',
      rule: 'checksum',
    });
  });

  it('fails at the end when fewer bytes arrive than were declared', async () => {
    const short = Buffer.concat(PARTS.slice(0, 2));
    await expect(drain(verifiedBytes(framesOf(short), DECLARED))).rejects.toMatchObject({
      rule: 'byte_size',
    });
    await expect(drain(verifiedBytes(framesOf(), DECLARED))).rejects.toMatchObject({
      rule: 'byte_size',
    });
  });

  // Break caught: a scanner made to read an object of a size nobody declared, however large, before anything is judged.
  it('fails as soon as more bytes arrive than were declared, without reading the rest', async () => {
    let pulled = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        pulled += 1;
        await Promise.resolve();
        yield Buffer.alloc(1024);
      }
    }
    await expect(
      drain(verifiedBytes(endless(), { byteSize: 2048, checksumSha256: sha(Buffer.alloc(2048)) })),
    ).rejects.toMatchObject({ rule: 'byte_size' });
    expect(pulled).toBe(3);
  });

  // Break caught: a check at the end that is raised before the consumer has seen the last byte, or never raised to a consumer that stops at the last byte it needs.
  it('raises its failure from the last step of the stream, after every byte has gone through', async () => {
    const other = Buffer.from('a file of some length, in three PARTS');
    const seen: Uint8Array[] = [];
    const run = async (): Promise<void> => {
      for await (const chunk of verifiedBytes(framesOf(other), DECLARED)) seen.push(chunk);
    };
    await expect(run()).rejects.toBeInstanceOf(StreamMismatchError);
    expect(Buffer.concat(seen).equals(other)).toBe(true);
  });

  // Break caught: a failure of the store's own stream turned into a mismatch of the bytes, which would name the object as the wrong one.
  it('lets a failure of the source pass as it was', async () => {
    const broken = new Error('the store stopped sending');
    async function* failing(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield PARTS[0] ?? Buffer.alloc(0);
      throw broken;
    }
    await expect(drain(verifiedBytes(failing(), DECLARED))).rejects.toBe(broken);
  });

  it('counts an object of no bytes against a declared size of none, and refuses it against any other', async () => {
    const none = { byteSize: 0, checksumSha256: sha(Buffer.alloc(0)) };
    expect((await drain(verifiedBytes(framesOf(), none))).length).toBe(0);
    await expect(drain(verifiedBytes(framesOf(), DECLARED))).rejects.toMatchObject({
      rule: 'byte_size',
    });
  });
});
