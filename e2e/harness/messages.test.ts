import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox, makeCaptureDirectory, readMessages } from './messages.ts';
import { removeDirectory } from './custody.ts';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'melarc-messages-test-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const LINK = 'http://127.0.0.1:5199/setup/credential#token=SENTINEL-TOKEN-OF-A-LINK-0001';

/** A message as the capture sink writes it (`capture-sink.ts`): one JSON file named for its deduplication identity. */
function put(
  id: string,
  overrides: Partial<{ capturedAt: string; destination: string; kind: string; link: string }> = {},
): void {
  writeFileSync(
    join(directory, `${id}.json`),
    `${JSON.stringify(
      {
        capturedAt: '2026-10-25T09:00:00.000Z',
        dedupeId: id,
        kind: 'STAFF_CREDENTIAL_SETUP',
        channel: 'EMAIL',
        destination: 'kofi@melarc.example',
        link: LINK,
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

const ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const ID_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';

describe('readMessages', () => {
  // Break caught: a folder that does not exist yet (the sink makes it with the first message) read as a failure.
  it('returns nothing when the sink has not been written to', () => {
    expect(readMessages(join(directory, 'absent'))).toEqual([]);
  });

  // Break caught: a message half written. The sink writes under another name and renames, so a reader never sees half a message, and a
  // leftover temporary file is not a message.
  it('reads the finished messages, in the order they were captured, and skips what is not one', () => {
    put(ID_2, { capturedAt: '2026-10-25T09:00:02.000Z' });
    put(ID_1, { capturedAt: '2026-10-25T09:00:01.000Z' });
    writeFileSync(join(directory, `${ID_1}.json.tmp-abcdef`), '{"capturedAt":"');
    writeFileSync(join(directory, 'notes.txt'), 'not a message');

    expect(readMessages(directory).map((message) => message.dedupeId)).toEqual([ID_1, ID_2]);
  });

  // Break caught: a link reaching a log or an assertion's diff through the message that carries it.
  it('holds the link where it prints as nothing', () => {
    put(ID_1);
    const [message] = readMessages(directory);
    expect(JSON.stringify(message)).not.toContain('SENTINEL-TOKEN');
    expect(message?.link.reveal()).toBe(LINK);
  });
});

describe('Inbox', () => {
  // Break caught: a journey that takes the message of an earlier act for the message of this one (the link of a first grant after a
  // new one was sent), and follows a link that has been replaced.
  it('hands each message over once, and the next one for the same address after it', async () => {
    put(ID_1, { capturedAt: '2026-10-25T09:00:01.000Z' });
    const inbox = new Inbox(directory, { pollMs: 5, timeoutMs: 200 });

    const first = await inbox.next({ to: 'kofi@melarc.example' });
    expect(first.dedupeId).toBe(ID_1);
    await expect(inbox.next({ to: 'kofi@melarc.example' })).rejects.toThrow(/no new message/);

    put(ID_2, { capturedAt: '2026-10-25T09:00:02.000Z' });
    expect((await inbox.next({ to: 'kofi@melarc.example' })).dedupeId).toBe(ID_2);
  });

  // Break caught: a message to someone else, or of another kind, being followed.
  it('takes only a message to that address, of that kind', async () => {
    put(ID_1, { destination: 'someone@melarc.example' });
    put(ID_2, { kind: 'MFA_REENROLMENT' });
    const inbox = new Inbox(directory, { pollMs: 5, timeoutMs: 100 });

    await expect(
      inbox.next({ to: 'kofi@melarc.example', kind: 'STAFF_CREDENTIAL_SETUP' }),
    ).rejects.toThrow(/no new message/);
    expect(
      (await inbox.next({ to: 'kofi@melarc.example', kind: 'MFA_REENROLMENT' })).dedupeId,
    ).toBe(ID_2);
  });

  // Break caught: the address compared as typed, so a capitalised address would never be found.
  it('compares an address in its canonical form', async () => {
    put(ID_1, { destination: 'Kofi@Melarc.Example' });
    const inbox = new Inbox(directory, { pollMs: 5, timeoutMs: 100 });
    expect((await inbox.next({ to: 'kofi@melarc.example' })).dedupeId).toBe(ID_1);
  });

  // Break caught: a message that arrives while the journey waits not being seen.
  it('waits for a message that arrives later', async () => {
    const inbox = new Inbox(directory, { pollMs: 5, timeoutMs: 2_000 });
    setTimeout(() => {
      put(ID_1);
    }, 50);
    expect((await inbox.next({ to: 'kofi@melarc.example' })).dedupeId).toBe(ID_1);
  });

  // Break caught: a timeout that tells nothing, or one that repeats a destination or a link.
  it('says how many messages there are, and repeats no address and no link when it gives up', async () => {
    put(ID_1, { destination: 'someone.else@melarc.example' });
    const inbox = new Inbox(directory, { pollMs: 5, timeoutMs: 50 });
    let message = '';
    try {
      await inbox.next({ to: 'kofi@melarc.example' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/1 message/);
    expect(message).not.toContain('kofi@melarc.example');
    expect(message).not.toContain('someone.else');
    expect(message).not.toContain('SENTINEL-TOKEN');
  });
});

describe('makeCaptureDirectory', () => {
  it('is a new folder, and removeDirectory takes it away', () => {
    const made = makeCaptureDirectory();
    expect(existsSync(made)).toBe(true);
    removeDirectory(made);
    expect(existsSync(made)).toBe(false);
  });
});
