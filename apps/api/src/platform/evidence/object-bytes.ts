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

/** The store had nothing at the key when the scanner came to read it (it had something when the platform looked): the object is missing. */
export class MissingObjectError extends Error {
  constructor() {
    super('The object is not in the store');
    this.name = 'MissingObjectError';
  }
}

export interface LazyObject {
  /** The bytes of the object. The store is asked for them when the first byte is read, and not before. */
  readonly bytes: ObjectBytes;
  /**
   * Lets go of the store's body when it was opened and has not been read to its end, so that a body nobody reads does not hold a connection until the store gives up. It is **not waited for**
   * (a body that is stalled does not answer a request to let go of it, and the caller must not wait for one), it never raises, and it may be called twice.
   */
  release(): void;
}

/**
 * The object of a record, opened **only when the scanner reads it** (Run B, Part 1, item 5 of the review of Run A2). The store's read was opened before the scanner was asked anything, so a scanner
 * that was not configured, or whose version was not answered, never read the body and never let go of it: the store's connection was held for its own time on every retry. Here the scanner is
 * asked first, and a body is opened only once the scanner has said it can decide and reads its first byte; `release` lets go of whatever was opened and not finished, whatever the scan did.
 */
export function lazyObject(open: () => Promise<ObjectBytes | undefined>): LazyObject {
  let iterator: AsyncIterator<Uint8Array> | undefined;
  // Held in an object because the flags change while an await is pending, which a plain variable would not show to the compiler.
  const state = { finished: false, released: false };
  const wasReleased = (): boolean => state.released;
  const letGo = (body: AsyncIterator<Uint8Array>): void => {
    try {
      void Promise.resolve(body.return?.()).catch(() => undefined);
    } catch {
      // A body that cannot be let go of has nothing more to be done with.
    }
  };
  const release = (): void => {
    state.released = true;
    if (iterator === undefined || state.finished) return;
    state.finished = true;
    letGo(iterator);
  };
  const bytes: ObjectBytes = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        if (state.released || state.finished) return { value: undefined, done: true };
        if (iterator === undefined) {
          const object = await open();
          if (object === undefined) {
            state.finished = true;
            throw new MissingObjectError();
          }
          const opened = object[Symbol.asyncIterator]();
          // The scan may have ended while the store was being asked: what it opened is let go of at once and not read.
          if (wasReleased()) {
            letGo(opened);
            return { value: undefined, done: true };
          }
          iterator = opened;
        }
        const step = await iterator.next();
        if (step.done === true) state.finished = true;
        return step;
      },
      return: (): Promise<IteratorResult<Uint8Array>> => {
        release();
        return Promise.resolve({ value: undefined, done: true });
      },
    }),
  };
  return { bytes, release };
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
