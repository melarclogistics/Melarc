import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../test-support/manual-clock.js';
import type { TextMessageSender } from '../auth/ports/text-message-sender.port.js';
import {
  CaptureDirectoryInsideCheckoutError,
  CaptureDirectoryNotPrivateError,
  checkoutRootOf,
  type PrivacyProbe,
} from '../delivery/worker/outside-checkout.js';
import {
  CaptureTextMessageSender,
  FileTextCaptureSink,
  type TextCaptureEntry,
  type TextCaptureSink,
} from './capture.text-message-sender.adapter.js';

const DEDUPE = '3f2b8c1e-5d7a-4e9b-8a61-0c4d2e7f9a10';
const DESTINATION = '+233244000111';
const TEXT = 'SENTINEL_TEXT_5d2e';
const AT = '2026-10-29T12:00:00.000Z';

const message = { dedupeId: DEDUPE, destination: DESTINATION, text: TEXT };

/** A sink that keeps what it is given in a list, or fails as told. */
class RecordingSink implements TextCaptureSink {
  readonly entries: TextCaptureEntry[] = [];
  failing = false;

  record(entry: TextCaptureEntry): Promise<void> {
    if (this.failing) return Promise.reject(new Error(`disk full ${TEXT} ${DESTINATION}`));
    this.entries.push(entry);
    return Promise.resolve();
  }
}

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'melarc-text-capture-test-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function capture(sink: TextCaptureSink = new RecordingSink()) {
  const clock = new ManualClock(new Date(AT));
  const sender: TextMessageSender = new CaptureTextMessageSender({ sink, clock });
  return { sender, clock };
}

describe('the text-message capture adapter', () => {
  // Break caught: a message that is not recorded, recorded without what a developer needs to read it, or answered as anything but a
  // message the provider took, with a reference that is not the one the lane keeps.
  it('records the message with the instant of the clock and answers accepted, naming it capture:<identity>', async () => {
    const sink = new RecordingSink();
    const { sender, clock } = capture(sink);

    const first = await sender.send(message);
    clock.advance(30_000);
    const second = await sender.send({ ...message, dedupeId: 'another-identity-0000' });

    expect(first).toStrictEqual({ outcome: 'ACCEPTED', providerMessageRef: `capture:${DEDUPE}` });
    expect(second).toStrictEqual({
      outcome: 'ACCEPTED',
      providerMessageRef: 'capture:another-identity-0000',
    });
    expect(sink.entries).toStrictEqual([
      { dedupeId: DEDUPE, destination: DESTINATION, text: TEXT, at: AT },
      {
        dedupeId: 'another-identity-0000',
        destination: DESTINATION,
        text: TEXT,
        at: '2026-10-29T12:00:30.000Z',
      },
    ]);
  });

  // Break caught: the outcome carrying what the sink holds in clear: only the sink may hold the message.
  it('answers with a reference that holds nothing of the message but its identity', async () => {
    const { sender } = capture();

    const outcome = JSON.stringify(await sender.send(message));

    for (const held of [DESTINATION, DESTINATION.slice(1), TEXT]) {
      expect(outcome).not.toContain(held);
    }
  });

  // Break caught: a status that says delivered for a message nobody captured, or that does not know one it captured.
  it('says delivered for a reference it issued and unknown for any other', async () => {
    const { sender } = capture();
    const outcome = await sender.send(message);
    const reference = outcome.outcome === 'ACCEPTED' ? (outcome.providerMessageRef ?? '') : '';

    expect(reference).toBe(`capture:${DEDUPE}`);
    expect(await sender.status(reference)).toStrictEqual({ state: 'DELIVERED' });
    for (const other of [
      `capture:${DEDUPE}x`,
      'capture:never-sent-0000',
      DEDUPE,
      'capture:',
      '',
      `CAPTURE:${DEDUPE}`,
      'MSG-0001',
    ]) {
      expect(await sender.status(other), other).toStrictEqual({ state: 'UNKNOWN' });
    }
  });

  it('does not know a reference that another instance issued', async () => {
    const issuer = capture().sender;
    const outcome = await issuer.send(message);
    const reference = outcome.outcome === 'ACCEPTED' ? (outcome.providerMessageRef ?? '') : '';

    expect(await capture().sender.status(reference)).toStrictEqual({ state: 'UNKNOWN' });
  });

  // Break caught: a sink that cannot be written reported as a success (a message nobody can read) or as a refusal (a retry that never
  // comes); nothing is known about the message, which is what unknown says. And its error is not carried out.
  it('answers unknown, issues no reference and carries nothing of the failure when the sink cannot be written', async () => {
    const sink = new RecordingSink();
    const { sender } = capture(sink);
    sink.failing = true;

    const outcome = await sender.send(message);

    expect(outcome).toStrictEqual({ outcome: 'UNKNOWN' });
    expect(JSON.stringify(outcome)).not.toContain(TEXT);
    expect(await sender.status(`capture:${DEDUPE}`)).toStrictEqual({ state: 'UNKNOWN' });
    sink.failing = false;
    expect((await sender.send(message)).outcome).toBe('ACCEPTED');
    expect(await sender.status(`capture:${DEDUPE}`)).toStrictEqual({ state: 'DELIVERED' });
  });

  it('records every send it is given, and answers the same reference to the same identity', async () => {
    const sink = new RecordingSink();
    const { sender } = capture(sink);

    const first = await sender.send(message);
    const again = await sender.send(message);

    expect(again).toStrictEqual(first);
    expect(sink.entries).toHaveLength(2);
  });

  // Break caught: the references it keeps growing for as long as the process lives.
  it('remembers the most recent ten thousand references and forgets the oldest', async () => {
    const { sender } = capture();
    for (let index = 0; index <= 10_000; index += 1) {
      await sender.send({ ...message, dedupeId: `identity-${String(index).padStart(8, '0')}` });
    }

    expect(await sender.status('capture:identity-00000000')).toStrictEqual({ state: 'UNKNOWN' });
    expect(await sender.status('capture:identity-00000001')).toStrictEqual({ state: 'DELIVERED' });
    expect(await sender.status('capture:identity-00010000')).toStrictEqual({ state: 'DELIVERED' });
  });
});

describe('the file sink of the text-message capture', () => {
  const entry = (over: Partial<TextCaptureEntry> = {}): TextCaptureEntry => ({
    dedupeId: DEDUPE,
    destination: DESTINATION,
    text: TEXT,
    at: AT,
    ...over,
  });

  // Break caught: a message that is not written where a developer looks, or not whole, or not as the entry.
  it('writes one file per message, named by its identity, holding the entry, in a folder outside the checkout', async () => {
    const sink = new FileTextCaptureSink(join(base, 'sink'));

    await sink.record(entry());

    expect(await readdir(join(base, 'sink'))).toEqual([`${DEDUPE}.json`]);
    const text = await readFile(join(base, 'sink', `${DEDUPE}.json`), 'utf8');
    expect(JSON.parse(text)).toStrictEqual(entry());
    expect(text.endsWith('\n')).toBe(true);
  });

  it('keeps one file for one identity however often it is written, and one for each identity', async () => {
    const sink = new FileTextCaptureSink(base);

    await sink.record(entry({ at: AT }));
    await sink.record(entry({ at: '2026-10-29T12:00:30.000Z' }));
    await sink.record(entry({ dedupeId: '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d' }));

    expect((await readdir(base)).toSorted()).toEqual([
      `${DEDUPE}.json`,
      '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.json',
    ]);
    expect(JSON.parse(await readFile(join(base, `${DEDUPE}.json`), 'utf8'))).toMatchObject({
      at: '2026-10-29T12:00:30.000Z',
    });
  });

  // Break caught: a file left half-written, or a temporary name left behind, which a reader of the folder would take for a message.
  it('leaves no temporary file behind, after a write or after a failed one', async () => {
    const sink = new FileTextCaptureSink(base);
    await sink.record(entry());
    expect((await readdir(base)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    const blocked = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
    await mkdir(join(base, `${blocked}.json`));

    await expect(sink.record(entry({ dedupeId: blocked }))).rejects.toBeInstanceOf(Error);

    expect((await readdir(base)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  // Break caught: a name taken from the message being a way out of the folder.
  it.each([
    '../escape',
    'a/b',
    'a\\b',
    '',
    'short',
    'a'.repeat(129),
    'has space in it ok??',
    'x\0y-aaaaaaaaaaaaaaaa',
  ])('refuses to name a file by %j, and writes nothing', async (name) => {
    const sink = new FileTextCaptureSink(base);

    await expect(sink.record(entry({ dedupeId: name }))).rejects.toBeInstanceOf(TypeError);
    expect(await readdir(base)).toEqual([]);
  });

  // Break caught: a folder and files that others can read where the file system has permission bits (the message is held in clear).
  it.skipIf(process.platform === 'win32')(
    'makes the folder and its files private to their owner',
    async () => {
      const inner = join(base, 'private-sink');
      const sink = new FileTextCaptureSink(inner);

      await sink.record(entry());

      expect((await stat(inner)).mode & 0o777).toBe(0o700);
      expect((await stat(join(inner, `${DEDUPE}.json`))).mode & 0o777).toBe(0o600);
    },
  );

  // Break caught: a sink inside the repository, which the source package is built from, so that a message held in clear could end up in an
  // archive shared for review. By default the folder is judged against the checkout of this module's own folder (and of the working
  // directory). Where this code runs with no checkout around it, as from an unpacked source package, there is nothing to be inside of
  // and the rule does nothing, as it says; the explicit checkout of the next test holds in every place.
  it('refuses a folder inside the checkout it runs from by default, and makes nothing there', async () => {
    const inside = join(import.meta.dirname, 'text-capture-that-must-not-exist');
    const guarded = checkoutRootOf(import.meta.dirname) !== undefined;

    if (guarded) {
      expect(() => new FileTextCaptureSink(inside)).toThrow(CaptureDirectoryInsideCheckoutError);
    } else {
      expect(() => new FileTextCaptureSink(inside)).not.toThrow();
    }
    await expect(stat(inside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('judges the folder against the checkout it is told of, and lets one outside it be', async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'apps', 'api'), { recursive: true });
    const startingPoints = [join(repo, 'apps', 'api')];

    expect(() => new FileTextCaptureSink(join(repo, 'tmp', 'capture'), { startingPoints })).toThrow(
      CaptureDirectoryInsideCheckoutError,
    );
    expect(() => new FileTextCaptureSink(join(base, 'capture'), { startingPoints })).not.toThrow();
  });

  // Break caught: a folder that exists and other users can enter, or that another user owns, taken for a place to hold messages in clear.
  it('refuses a folder that exists and is not private to its owner, where the file system can say so', () => {
    const probe = (mode: number, uid: number): PrivacyProbe => ({
      platform: 'linux',
      userId: 1000,
      stat: () => ({ isDirectory: () => true, mode, uid }),
    });
    const folder = join(base, 'existing');

    expect(() => new FileTextCaptureSink(folder, { privacyProbe: probe(0o40755, 1000) })).toThrow(
      CaptureDirectoryNotPrivateError,
    );
    expect(() => new FileTextCaptureSink(folder, { privacyProbe: probe(0o40700, 2000) })).toThrow(
      CaptureDirectoryNotPrivateError,
    );
    expect(
      () => new FileTextCaptureSink(folder, { privacyProbe: probe(0o40700, 1000) }),
    ).not.toThrow();
  });
});

describe('the capture adapter over the file sink', () => {
  it('captures the message in a file and answers accepted, and unknown with nothing written for an identity that cannot name a file', async () => {
    const clock = new ManualClock(new Date(AT));
    const sender: TextMessageSender = new CaptureTextMessageSender({
      sink: new FileTextCaptureSink(base),
      clock,
    });

    const outcome = await sender.send(message);
    const refused = await sender.send({ ...message, dedupeId: '../../escape' });

    expect(outcome).toStrictEqual({ outcome: 'ACCEPTED', providerMessageRef: `capture:${DEDUPE}` });
    expect(refused).toStrictEqual({ outcome: 'UNKNOWN' });
    expect(await readdir(base)).toEqual([`${DEDUPE}.json`]);
    expect(JSON.parse(await readFile(join(base, `${DEDUPE}.json`), 'utf8'))).toStrictEqual({
      dedupeId: DEDUPE,
      destination: DESTINATION,
      text: TEXT,
      at: AT,
    });
    expect(await sender.status(`capture:${DEDUPE}`)).toStrictEqual({ state: 'DELIVERED' });
  });

  it('answers unknown where the folder cannot be made', async () => {
    const file = join(base, 'a-file');
    await writeFile(file, 'not a folder');
    const sender = new CaptureTextMessageSender({
      sink: new FileTextCaptureSink(join(file, 'inside')),
      clock: new ManualClock(new Date(AT)),
    });

    expect(await sender.send(message)).toStrictEqual({ outcome: 'UNKNOWN' });
  });
});
