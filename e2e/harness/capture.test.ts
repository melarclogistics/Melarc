import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertNoExternalAttempts, readCaptured } from './capture.ts';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'melarc-capture-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const line = (host: string) =>
  JSON.stringify({ at: '2026-10-05T09:00:00.000Z', kind: 'blocked-connection', host, port: 443 });

describe('readCaptured', () => {
  // Break caught: a missing file read as a failure. A run in which nothing was attempted writes nothing.
  it('returns nothing when no attempt was ever recorded', () => {
    expect(readCaptured(join(directory, 'absent.jsonl'))).toEqual([]);
  });

  it('reads one attempt per line, in order', () => {
    const file = join(directory, 'capture.jsonl');
    writeFileSync(file, `${line('one.example')}\n${line('two.example')}\n`);

    expect(readCaptured(file).map((entry) => entry.host)).toEqual(['one.example', 'two.example']);
  });

  // Break caught: a half-written final line, from a process killed while it wrote, hiding the attempts before
  // it or crashing the reader.
  it('skips a line that is not complete, and keeps the rest', () => {
    const file = join(directory, 'capture.jsonl');
    writeFileSync(file, `${line('one.example')}\n{"at":"2026-10-05T09:0`);

    expect(readCaptured(file).map((entry) => entry.host)).toEqual(['one.example']);
  });
});

describe('assertNoExternalAttempts', () => {
  it('passes when nothing was attempted', () => {
    expect(() => {
      assertNoExternalAttempts(join(directory, 'absent.jsonl'));
    }).not.toThrow();
  });

  // Break caught: an attempted external effect that does not fail the run. The message names each host, so the
  // person reading it knows which provider the code tried to reach.
  it('fails, naming every host the code tried to reach', () => {
    const file = join(directory, 'capture.jsonl');
    writeFileSync(file, `${line('payments.example')}\n${line('sms.example')}\n`);

    expect(() => {
      assertNoExternalAttempts(file);
    }).toThrow(/payments\.example:443[\s\S]*sms\.example:443/);
  });
});
