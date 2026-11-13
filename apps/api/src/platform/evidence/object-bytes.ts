import { createHash } from 'node:crypto';

import type { ObjectBytes } from '../auth/ports/content-scanner.port.js';

/**
 * The bytes a scanner reads are the bytes the record declared (Run A2; SECURITY_DESIGN.md section 14.18b). The platform streams an object from the store to the scanner and, as the
 * bytes pass, counts them and hashes them; the verdict is used only if the stream turns out to be exactly the declared size and the declared SHA-256. So a verdict is always about
 * the object the record names, whatever the store's own metadata claims, and an object that was replaced, truncated or extended between the look at it and the scan is refused before
 * any verdict can be recorded. The check costs one pass over bytes the scanner is reading anyway and keeps nothing of them.
 */
export class StreamMismatchError extends Error {
  readonly rule: 'byte_size' | 'checksum';

  constructor(rule: 'byte_size' | 'checksum') {
    super(`The bytes read from the store are not the ones declared (${rule})`);
    this.name = 'StreamMismatchError';
    this.rule = rule;
  }
}

export interface DeclaredBytes {
  /** The declared size, in bytes. */
  readonly byteSize: number;
  /** The declared SHA-256, 64 lower-case hex digits. */
  readonly checksumSha256: string;
}

/**
 * Passes the bytes of `source` on unchanged and fails the stream, at the point it is known, with a `StreamMismatchError`: at once when more bytes arrive than were declared (the
 * scanner is never made to read an object of a size nobody declared), and at the end when the count or the hash is not the declared one. A failure at the end is raised by the
 * stream's last step, so a consumer that has read every byte has not concluded until it has seen the stream finish.
 */
export async function* verifiedBytes(
  source: ObjectBytes,
  declared: DeclaredBytes,
): AsyncGenerator<Uint8Array, void, undefined> {
  const hash = createHash('sha256');
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > declared.byteSize) throw new StreamMismatchError('byte_size');
    hash.update(chunk);
    yield chunk;
  }
  if (total !== declared.byteSize) throw new StreamMismatchError('byte_size');
  if (hash.digest('hex') !== declared.checksumSha256) throw new StreamMismatchError('checksum');
}
