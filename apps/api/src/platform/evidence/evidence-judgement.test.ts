import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  ContentScanner,
  ObjectBytes,
  ScanVerdict,
} from '../auth/ports/content-scanner.port.js';
import type { EvidenceStore, StoredObjectFacts } from '../auth/ports/evidence-store.port.js';
import { ContentScannerError } from './content-scanner-error.js';
import { judgeStoredObject } from './evidence-judgement.js';

/**
 * `judgeStoredObject`, the one place that decides whether the object the store holds may be stored (Run A2), against a fake store and a fake scanner. Run B (Part 1, item 5 of the review of Run A2)
 * adds what the scan does with the store's body: **the scanner is asked first and the body is opened only when the scanner reads it**, the body is **let go of whatever the scan does**, and **only a
 * `CLEAN` verdict is accepted**. Each test names the fault it catches and failed on 809817b.
 */
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const DECLARED = {
  storageRef: 'ev/object',
  contentType: 'image/jpeg',
  byteSize: JPEG.length,
  checksumSha256: createHash('sha256').update(JPEG).digest('hex'),
};

interface FakeStore extends Pick<EvidenceStore, 'inspect' | 'read' | 'remove'> {
  /** How many times the store was asked for the body. */
  reads: number;
  /** How many times a body was let go of. */
  returned: number;
  removed: number;
}

function fakeStore(over: { readonly present?: boolean } = {}): FakeStore {
  const store: FakeStore = {
    reads: 0,
    returned: 0,
    removed: 0,
    inspect: () =>
      Promise.resolve<StoredObjectFacts>({
        byteSize: JPEG.length,
        checksumSha256: DECLARED.checksumSha256,
        contentType: 'image/jpeg',
        head: JPEG,
      }),
    read: () => {
      store.reads += 1;
      if (over.present === false) return Promise.resolve(undefined);
      const body: ObjectBytes = {
        [Symbol.asyncIterator]() {
          let at = 0;
          return {
            next: () => {
              const half = Math.ceil(JPEG.length / 2);
              const parts = [JPEG.subarray(0, half), JPEG.subarray(half)];
              const part = parts[at];
              at += 1;
              return Promise.resolve(
                part === undefined
                  ? { value: undefined, done: true }
                  : { value: part, done: false },
              );
            },
            return: () => {
              store.returned += 1;
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      };
      return Promise.resolve(body);
    },
    remove: () => {
      store.removed += 1;
      return Promise.resolve();
    },
  };
  return store;
}

const metrics = { increment: () => undefined, observe: () => undefined };
const CLEAN: ScanVerdict = { verdict: 'CLEAN', scanner: 'fake', signatureVersion: 'v1' };

/** Reads the object to its end, as a scanner does. */
async function drain(object: ObjectBytes): Promise<number> {
  let total = 0;
  for await (const part of object) total += part.byteLength;
  return total;
}

const judge = (store: FakeStore, scanner: ContentScanner) =>
  judgeStoredObject({ store, scanner, metrics }, DECLARED);

describe('the scan and the store’s body', () => {
  // Break caught: the body opened before the scanner was asked, so that a scanner that is not configured, or whose version is not answered, left a read open to the store for its own timeout on every retry.
  it('does not open the store’s body when the scanner cannot be asked', async () => {
    const store = fakeStore();
    const scanner: ContentScanner = {
      scan: () =>
        Promise.reject(
          new ContentScannerError('SCANNER_NOT_CONFIGURED', 'No scanner is configured'),
        ),
    };
    await expect(judge(store, scanner)).rejects.toBeInstanceOf(ContentScannerError);
    expect(store.reads).toBe(0);
  });

  // Break caught: a body never let go of when the scanner failed part-way, which held the store's connection until the store gave up.
  it('lets go of the body when the scanner fails after it began to read', async () => {
    const store = fakeStore();
    const scanner: ContentScanner = {
      scan: async (object) => {
        const reader = object[Symbol.asyncIterator]();
        await reader.next();
        throw new ContentScannerError('SCANNER_UNAVAILABLE', 'The scanner went away');
      },
    };
    await expect(judge(store, scanner)).rejects.toBeInstanceOf(ContentScannerError);
    expect(store.reads).toBe(1);
    expect(store.returned).toBe(1);
  });

  // Break caught: a verdict used for an object the scanner did not read to its end (the stream's size and hash are checked at its end, so a scanner that stops early is never checked), and the
  // body it stopped reading left open.
  it('does not take the verdict of a scanner that did not read the object to its end, and lets go of the body', async () => {
    const store = fakeStore();
    const scanner: ContentScanner = {
      scan: async (object) => {
        await object[Symbol.asyncIterator]().next();
        return CLEAN;
      },
    };
    await expect(judge(store, scanner)).rejects.toMatchObject({
      name: 'ContentScannerError',
      code: 'SCANNER_UNAVAILABLE',
    });
    expect(store.returned).toBe(1);
  });

  it('judges an object the scanner reads to its end, once, and lets go of nothing that is already finished', async () => {
    const store = fakeStore();
    const scanner: ContentScanner = {
      scan: async (object) => {
        await drain(object);
        return CLEAN;
      },
    };
    const judged = await judge(store, scanner);
    expect(judged).toMatchObject({ accepted: true, signature: 'JPEG' });
    expect(store.reads).toBe(1);
    // A body read to its end is finished: nothing was left open to let go of.
    expect(store.returned).toBe(0);
  });

  // Break caught: an object that went missing between the look at it and the scan, which the scanner was handed as no bytes at all.
  it('refuses as missing an object the store no longer has when the scanner comes to read it', async () => {
    const store = fakeStore({ present: false });
    const scanner: ContentScanner = {
      scan: async (object) => {
        await drain(object);
        return CLEAN;
      },
    };
    expect(await judge(store, scanner)).toEqual({ accepted: false, rule: 'missing' });
  });
});

describe('the verdict', () => {
  // Break caught: "anything but FLAGGED" accepted, so that a scanner that answered something else (or a future verdict nobody handled) stored a file nobody had called clean.
  it.each(['MAYBE', 'SKIPPED', 'clean', '', undefined])(
    'accepts only CLEAN: %s is a scanner that did not decide, and the object is removed by nobody and stored by nobody',
    async (word) => {
      const store = fakeStore();
      const scanner: ContentScanner = {
        scan: async (object) => {
          await drain(object);
          return { ...CLEAN, verdict: word } as unknown as ScanVerdict;
        },
      };
      await expect(judge(store, scanner)).rejects.toMatchObject({
        name: 'ContentScannerError',
        code: 'SCANNER_UNAVAILABLE',
      });
      expect(store.removed).toBe(0);
    },
  );
});
