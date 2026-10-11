import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../../test-support/manual-clock.js';
import { AllowListedDeliveryProvider } from './allow-listed.delivery-provider.adapter.js';
import { CaptureDeliveryProvider } from './capture.delivery-provider.adapter.js';
import { FileCaptureSink, MemoryCaptureSink, type CapturedMessage } from './capture-sink.js';
import { parseAllowList } from './delivery-allow-list.js';

const DEDUPE = '3f2b8c1e-5d7a-4e9b-8a61-0c4d2e7f9a10';
const MESSAGE = {
  dedupeId: DEDUPE,
  kind: 'SETUP_GRANT',
  channel: 'EMAIL',
  destination: 'staff@example.test',
  link: 'https://ops.example.test/setup/credential#token=SENTINEL-CAPTURED-TOKEN',
} as const;

const captured = (over: Partial<CapturedMessage> = {}): CapturedMessage => ({
  capturedAt: '2026-10-10T08:00:00.000Z',
  ...MESSAGE,
  ...over,
});

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'melarc-capture-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('the file capture sink (S0.18)', () => {
  // Break caught: a message that is not written where a developer looks for it, or not whole, or not as a message.
  it('writes one file per message, named by its deduplication identity, holding the message', async () => {
    const sink = new FileCaptureSink(join(directory, 'sink'));

    await sink.write(captured());

    expect(await readdir(join(directory, 'sink'))).toEqual([`${DEDUPE}.json`]);
    const text = await readFile(join(directory, 'sink', `${DEDUPE}.json`), 'utf8');
    expect(JSON.parse(text)).toEqual(captured());
    expect(await sink.has(DEDUPE)).toBe(true);
    expect(await sink.has('7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d')).toBe(false);
  });

  // Break caught: a retry of the same message adding a second file (the provider deduplicates; the sink behaves as one) or failing.
  it('keeps one message for one identity however often it is written', async () => {
    const sink = new FileCaptureSink(directory);

    await sink.write(captured({ capturedAt: '2026-10-10T08:00:00.000Z' }));
    await sink.write(captured({ capturedAt: '2026-10-10T08:00:30.000Z' }));

    expect(await readdir(directory)).toEqual([`${DEDUPE}.json`]);
    expect(JSON.parse(await readFile(join(directory, `${DEDUPE}.json`), 'utf8'))).toMatchObject({
      capturedAt: '2026-10-10T08:00:30.000Z',
    });
  });

  // Break caught: a file left half-written or a temporary name left behind, which a reader of the folder would take for a message.
  it('leaves no temporary file behind, after a write or after a failed one', async () => {
    const sink = new FileCaptureSink(directory);
    await sink.write(captured());
    expect((await readdir(directory)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    // The final name is a directory, so the rename fails; the temporary file must not stay behind.
    const blocked = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
    await mkdir(join(directory, `${blocked}.json`));

    await expect(sink.write(captured({ dedupeId: blocked }))).rejects.toBeInstanceOf(Error);

    expect((await readdir(directory)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  // Break caught: a name taken from a message being a way out of the directory, or a name the file system would read as something else.
  it.each([
    '../escape',
    'a/b',
    'a\\b',
    '',
    'short',
    'a'.repeat(129),
    'has space in it ok??',
    'x\0y-aaaaaaaaaaaaaaaa',
  ])('refuses to name a file by %j', async (name) => {
    const sink = new FileCaptureSink(directory);

    await expect(sink.write(captured({ dedupeId: name }))).rejects.toBeInstanceOf(TypeError);
    await expect(sink.has(name)).rejects.toBeInstanceOf(TypeError);
    expect(await readdir(directory)).toEqual([]);
  });

  // Break caught: a sink readable by others where the file system has permission bits (the message holds a live token).
  it.skipIf(process.platform === 'win32')(
    'makes the directory and its files private to their owner',
    async () => {
      const inner = join(directory, 'private-sink');
      const sink = new FileCaptureSink(inner);

      await sink.write(captured());

      expect((await stat(inner)).mode & 0o777).toBe(0o700);
      expect((await stat(join(inner, `${DEDUPE}.json`))).mode & 0o777).toBe(0o600);
    },
  );
});

describe('the capture adapter as a provider (S0.18)', () => {
  const clock = new ManualClock(new Date('2026-10-10T08:00:00.000Z'));

  // Break caught: a captured message answered as anything but an acceptance, or an acceptance that names the message's content.
  it('captures the message and answers accepted, with a reference that holds nothing of it', async () => {
    const sink = new MemoryCaptureSink();
    const provider = new CaptureDeliveryProvider({ sink, clock });

    const outcome = await provider.send(MESSAGE);

    expect(outcome).toEqual({ outcome: 'ACCEPTED', providerMessageRef: `capture-${DEDUPE}` });
    expect(sink.messages.get(DEDUPE)).toEqual(captured());
    const reference = outcome.outcome === 'ACCEPTED' ? (outcome.providerMessageRef ?? '') : '';
    expect(reference).not.toContain('SENTINEL');
    expect(reference).not.toContain('example.test');
  });

  // Break caught: a retry of the same identity sending a second message, or a status query that does not know what it captured.
  it('is one message for one identity, and says so when asked', async () => {
    const sink = new MemoryCaptureSink();
    const provider = new CaptureDeliveryProvider({ sink, clock });

    expect(await provider.status(DEDUPE)).toBeNull();
    await provider.send(MESSAGE);
    await provider.send(MESSAGE);

    expect(sink.messages.size).toBe(1);
    expect(await provider.status(DEDUPE)).toEqual({
      outcome: 'ACCEPTED',
      providerMessageRef: `capture-${DEDUPE}`,
    });
  });

  // Break caught: a sink that cannot be written being reported as a success (a message nobody can read) or as a rejection (a retry
  // that never comes): nothing is known about the message, which is what UNKNOWN says.
  it('answers unknown, and not accepted, when the sink cannot be written, and null when it cannot be read', async () => {
    const failing = {
      write: () => Promise.reject(new Error('disk full SENTINEL-DISK-TEXT')),
      has: () => Promise.reject(new Error('unreadable')),
    };
    const provider = new CaptureDeliveryProvider({ sink: failing, clock });

    expect(await provider.send(MESSAGE)).toEqual({ outcome: 'UNKNOWN' });
    expect(await provider.status(DEDUPE)).toBeNull();
  });

  // Break caught: the adapter writing to a real directory through a name from the message that escapes it.
  it('answers unknown for an identity that cannot name a file, and writes nothing', async () => {
    const provider = new CaptureDeliveryProvider({ sink: new FileCaptureSink(directory), clock });

    expect(await provider.send({ ...MESSAGE, dedupeId: '../../escape' })).toEqual({
      outcome: 'UNKNOWN',
    });
    expect(await readdir(directory)).toEqual([]);
  });
});

describe('the allow-list in front of a provider (S0.18; DEPLOYMENT_AND_ENVIRONMENTS.md section 4.1)', () => {
  const list = parseAllowList('staff@example.test,+233201234567');
  if (list === undefined) throw new Error('unreachable');

  function countingProvider() {
    const sent: string[] = [];
    return {
      sent,
      provider: {
        send: (message: { destination: string }) => {
          sent.push(message.destination);
          return Promise.resolve({ outcome: 'ACCEPTED' as const, providerMessageRef: 'ref' });
        },
        status: () => Promise.resolve(null),
      },
    };
  }

  // Break caught: a message to a destination off the list reaching the provider (a live link to a real person), or answered with a
  // class other than the document's.
  it('refuses a destination off the list as DESTINATION_NOT_ALLOWED and never calls the provider', async () => {
    const inner = countingProvider();
    const guarded = new AllowListedDeliveryProvider(inner.provider, list);

    expect(await guarded.send({ ...MESSAGE, destination: 'someone.else@example.test' })).toEqual({
      outcome: 'REJECTED',
      outcomeClass: 'DESTINATION_NOT_ALLOWED',
    });
    expect(
      await guarded.send({ ...MESSAGE, channel: 'SMS', destination: '+233209999999' }),
    ).toEqual({ outcome: 'REJECTED', outcomeClass: 'DESTINATION_NOT_ALLOWED' });
    expect(inner.sent).toEqual([]);
  });

  // Break caught: a guard that blocks the people it was meant to let through, or changes what the provider answers.
  it('lets a destination on the list through, and returns the provider’s own answer', async () => {
    const inner = countingProvider();
    const guarded = new AllowListedDeliveryProvider(inner.provider, list);

    expect(await guarded.send(MESSAGE)).toEqual({ outcome: 'ACCEPTED', providerMessageRef: 'ref' });
    expect(
      await guarded.send({ ...MESSAGE, channel: 'SMS', destination: '+233201234567' }),
    ).toEqual({ outcome: 'ACCEPTED', providerMessageRef: 'ref' });
    expect(inner.sent).toEqual(['staff@example.test', '+233201234567']);
  });

  // Break caught: a status query blocked by the guard (it sends nothing), or answered by the guard instead of the provider.
  it('passes a status query to the provider', async () => {
    const inner = countingProvider();
    const guarded = new AllowListedDeliveryProvider(inner.provider, list);

    expect(await guarded.status(DEDUPE)).toBeNull();
  });
});
