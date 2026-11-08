import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox, makeCaptureDirectory, readMessages, readTexts } from './messages.ts';
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

/** A text message as the notification lane's capture writes it (`capture.text-message-sender.adapter.ts`): the text, not a link. */
function putText(
  id: string,
  overrides: Partial<{ at: string; destination: string; text: string }> = {},
): void {
  writeFileSync(
    join(directory, `${id}.json`),
    `${JSON.stringify({
      dedupeId: id,
      destination: '+99900000002',
      text: 'SENTINEL-TEXT-OF-A-MESSAGE',
      at: '2026-11-03T09:00:00.000Z',
      ...overrides,
    })}
`,
  );
}

describe('the text messages of the notification lane', () => {
  // Break caught: a text taken for a message with a link, or a message with a link taken for a text, so that one sink read two ways counts twice.
  it('reads the texts and the messages with a link apart, from the one folder', () => {
    put(ID_1);
    putText(ID_2);

    expect(readMessages(directory).map((message) => message.dedupeId)).toEqual([ID_1]);
    expect(readTexts(directory).map((text) => text.dedupeId)).toEqual([ID_2]);
  });

  it('holds the text where it prints as nothing', () => {
    putText(ID_1);
    const [text] = readTexts(directory);

    expect(String(text?.text)).not.toContain('SENTINEL');
    expect(JSON.stringify(text)).not.toContain('SENTINEL');
    expect(text?.text.reveal()).toBe('SENTINEL-TEXT-OF-A-MESSAGE');
  });

  it('hands each text over once, to the address it was sent to', async () => {
    putText(ID_1, { destination: '+99900000002' });
    putText(ID_2, { destination: '+99900000001', at: '2026-11-03T09:00:01.000Z' });
    const inbox = new Inbox(directory, { timeoutMs: 300, pollMs: 10 });

    expect((await inbox.nextText({ to: '+99900000001' })).dedupeId).toBe(ID_2);
    expect((await inbox.nextText({ to: '+99900000002' })).dedupeId).toBe(ID_1);
    await expect(inbox.nextText({ to: '+99900000002' })).rejects.toThrow(/no new text/);
  });

  it('skips a file that is not a text', () => {
    writeFileSync(
      join(directory, `${ID_1}.json`),
      '{"dedupeId":"x","destination":3,"text":"t","at":"a"}',
    );
    writeFileSync(join(directory, `${ID_2}.json`), 'not json');

    expect(readTexts(directory)).toEqual([]);
  });
});
