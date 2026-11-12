import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { ContentScannerError } from './content-scanner-error.js';
import { ClamavContentScanner } from './clamav.content-scanner.adapter.js';

/**
 * The ClamAV adapter of the content scanner (Run A2; D-A6), against a fake clamd that speaks the subset of the protocol the adapter uses (clamd(8): `zVERSION` and `zINSTREAM`, frames of a
 * four-byte network-order length, the reply ended by a NUL). Nothing here reaches a real daemon: the owner's smoke command does (`pnpm --filter @melarc/api run evidence:smoke`).
 *
 * What these prove: the bytes go to the daemon exactly as they came, in frames within a bound, ended by the zero frame; a verdict is only what the daemon said; every other outcome is
 * `SCANNER_UNAVAILABLE` (never clean, never skipped), within the time given; a failure of the source of the bytes is not the scanner's; and no message says where the daemon is or what it said.
 */
const VERSION = 'ClamAV 1.4.2/27836/Wed Nov 12 08:05:44 2026';
const FRAME_LIMIT = 64 * 1024;

type InstreamBehaviour =
  | { readonly reply: string }
  | { readonly hang: true }
  | { readonly close: true }
  | { readonly reset: true };

interface Fake {
  readonly port: number;
  /** The commands in the order they arrived, one per connection. */
  readonly commands: string[];
  /** The payload of every frame the daemon was sent, and the size of each. */
  readonly frames: number[];
  readonly received: Buffer[];
  /** Bytes that arrived after the zero frame: there must be none. */
  trailing: number;
  stop(): Promise<void>;
}

const running: Fake[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((fake) => fake.stop()));
});

async function fakeClamd(options: {
  readonly version?: string | { readonly hang: true } | { readonly close: true };
  readonly instream?: InstreamBehaviour;
}): Promise<Fake> {
  const sockets = new Set<Socket>();
  const fake: Fake = {
    port: 0,
    commands: [],
    frames: [],
    received: [],
    trailing: 0,
    stop: () => Promise.resolve(),
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let pending = Buffer.alloc(0);
    let state: 'command' | 'frames' | 'done' = 'command';
    socket.on('data', (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      for (;;) {
        if (state === 'done') {
          fake.trailing += pending.length;
          pending = Buffer.alloc(0);
          return;
        }
        if (state === 'command') {
          const end = pending.indexOf(0);
          if (end < 0) return;
          const command = pending.subarray(0, end).toString('latin1');
          pending = pending.subarray(end + 1);
          fake.commands.push(command);
          if (command === 'zVERSION') {
            const version = options.version ?? VERSION;
            if (typeof version === 'string') socket.write(`${version}\0`);
            else if ('close' in version) socket.end();
            return;
          }
          if (command === 'zINSTREAM') {
            state = 'frames';
            continue;
          }
          socket.destroy();
          return;
        }
        if (pending.length < 4) return;
        const length = pending.readUInt32BE(0);
        if (length === 0) {
          pending = pending.subarray(4);
          state = 'done';
          const behaviour = options.instream ?? { reply: 'stream: OK' };
          if ('reply' in behaviour) socket.write(`${behaviour.reply}\0`);
          else if ('close' in behaviour) socket.end();
          else if ('reset' in behaviour) socket.destroy();
          continue;
        }
        if (pending.length < 4 + length) return;
        fake.frames.push(length);
        fake.received.push(Buffer.from(pending.subarray(4, 4 + length)));
        pending = pending.subarray(4 + length);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const stop = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const made = Object.assign(fake, { port: address.port, stop });
  running.push(made);
  return made;
}

async function* framesOf(...parts: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    await Promise.resolve();
    yield part;
  }
}

const scannerFor = (fake: Fake, timeoutMs = 3000): ClamavContentScanner =>
  new ClamavContentScanner({ host: '127.0.0.1', port: fake.port, timeoutMs });

async function failureOf(work: Promise<unknown>): Promise<ContentScannerError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ContentScannerError) return error;
    throw error;
  }
  throw new Error('the scan did not fail');
}

describe('the ClamAV scanner', () => {
  // Break caught: a verdict made of anything but the daemon's own word, or a version line that is not the daemon's.
  it('answers CLEAN with the version of the signatures when the daemon says stream: OK', async () => {
    const fake = await fakeClamd({});
    const verdict = await scannerFor(fake).scan(framesOf(Buffer.from('hello')));
    expect(verdict).toEqual({ verdict: 'CLEAN', scanner: 'clamav', signatureVersion: VERSION });
  });

  it('answers FLAGGED with the name of the signature when the daemon says FOUND', async () => {
    const fake = await fakeClamd({ instream: { reply: 'stream: Eicar-Test-Signature FOUND' } });
    const verdict = await scannerFor(fake).scan(framesOf(Buffer.from('X5O!...')));
    expect(verdict).toEqual({
      verdict: 'FLAGGED',
      scanner: 'clamav',
      signatureVersion: VERSION,
      signature: 'Eicar-Test-Signature',
    });
  });

  // Break caught: bytes altered, dropped or reordered on the way, a frame beyond the bound the daemon's own limits assume, a missing zero frame, or anything sent after it.
  it('streams the object to the daemon as it came, in frames within the bound, ended by the zero frame and followed by nothing', async () => {
    const fake = await fakeClamd({});
    const whole = Buffer.alloc(200_000);
    for (let at = 0; at < whole.length; at += 1) whole[at] = at % 251;
    // The object arrives in uneven chunks, one of them larger than a frame.
    const chunks = [
      whole.subarray(0, 1000),
      whole.subarray(1000, 150_000),
      whole.subarray(150_000),
    ];
    await scannerFor(fake).scan(framesOf(...chunks));
    expect(Buffer.concat(fake.received).equals(whole)).toBe(true);
    expect(Math.max(...fake.frames)).toBeLessThanOrEqual(FRAME_LIMIT);
    expect(fake.frames.reduce((sum, size) => sum + size, 0)).toBe(whole.length);
    expect(fake.trailing).toBe(0);
  });

  it('asks the version first and then streams, each on a connection of its own', async () => {
    const fake = await fakeClamd({});
    await scannerFor(fake).scan(framesOf(Buffer.from('x')));
    expect(fake.commands).toEqual(['zVERSION', 'zINSTREAM']);
  });

  it('streams an object of no bytes, which the daemon is told by the zero frame alone', async () => {
    const fake = await fakeClamd({});
    const verdict = await scannerFor(fake).scan(framesOf());
    expect(verdict.verdict).toBe('CLEAN');
    expect(fake.frames).toEqual([]);
  });

  // Break caught: a failure to decide read as a clean verdict, or as "skipped". Each of these must be unavailable, and none of them may be anything else.
  it.each([
    [
      'an ERROR reply (the daemon refuses the stream: its size limit is below the object)',
      { reply: 'INSTREAM size limit exceeded. ERROR' },
    ],
    ['a reply that is not a reply', { reply: 'hello' }],
    ['an empty reply', { reply: '' }],
    ['a reply naming a signature in a form no signature has', { reply: 'stream: ../../etc FOUND' }],
    ['a connection closed without a reply', { close: true as const }],
    ['a connection reset', { reset: true as const }],
  ])('is unavailable on %s', async (_name, instream) => {
    const fake = await fakeClamd({ instream });
    const error = await failureOf(scannerFor(fake).scan(framesOf(Buffer.from('x'))));
    expect(error.code).toBe('SCANNER_UNAVAILABLE');
  });

  it('is unavailable when the daemon does not answer in time, and returns within the time it was given', async () => {
    const fake = await fakeClamd({ instream: { hang: true } });
    const began = Date.now();
    const error = await failureOf(scannerFor(fake, 300).scan(framesOf(Buffer.from('x'))));
    expect(error.code).toBe('SCANNER_UNAVAILABLE');
    expect(Date.now() - began).toBeLessThan(2500);
  });

  it('is unavailable when the version is not answered, or is not a ClamAV version', async () => {
    for (const version of [{ hang: true as const }, { close: true as const }, 'Apache/2.4', '']) {
      const fake = await fakeClamd({ version });
      const error = await failureOf(scannerFor(fake, 300).scan(framesOf(Buffer.from('x'))));
      expect(error.code).toBe('SCANNER_UNAVAILABLE');
      expect(fake.commands).toEqual(['zVERSION']);
    }
  });

  it('is unavailable when nothing listens at the address', async () => {
    const fake = await fakeClamd({});
    await fake.stop();
    running.splice(running.indexOf(fake), 1);
    const error = await failureOf(scannerFor(fake, 1000).scan(framesOf(Buffer.from('x'))));
    expect(error.code).toBe('SCANNER_UNAVAILABLE');
  });

  // Break caught: a message that says where the daemon is, what it replied, or what the object was.
  it('says nothing of the address, the reply or the object in what it raises', async () => {
    const cases: readonly { readonly instream: InstreamBehaviour; readonly marker: string }[] = [
      { instream: { reply: 'INSTREAM size limit exceeded. ERROR' }, marker: 'size limit' },
      { instream: { reply: 'stream: ../../etc FOUND' }, marker: 'etc' },
    ];
    for (const { instream, marker } of cases) {
      const fake = await fakeClamd({ instream });
      const error = await failureOf(scannerFor(fake).scan(framesOf(Buffer.from('SECRET-BYTES'))));
      const text = `${error.message} ${JSON.stringify(error)}`;
      expect(text).not.toContain('127.0.0.1');
      expect(text).not.toContain(String(fake.port));
      expect(text).not.toContain(marker);
      expect(text).not.toContain('SECRET-BYTES');
    }
  });

  // Break caught: the store's failure to deliver the bytes reported as the scanner's, which would send an operator to the wrong place.
  it('lets a failure of the source pass as it was, and lets go of the connection', async () => {
    const fake = await fakeClamd({});
    const broken = new Error('the store stopped sending');
    async function* failing(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield Buffer.from('first');
      throw broken;
    }
    await expect(scannerFor(fake).scan(failing())).rejects.toBe(broken);
  });

  it('is not configured without a host, a port and a time', () => {
    for (const options of [
      { host: '', port: 3310, timeoutMs: 1000 },
      { host: 'clamav', port: 0, timeoutMs: 1000 },
      { host: 'clamav', port: 70_000, timeoutMs: 1000 },
      { host: 'clamav', port: 3310, timeoutMs: 0 },
    ]) {
      expect(() => new ClamavContentScanner(options)).toThrow(ContentScannerError);
    }
  });
});
