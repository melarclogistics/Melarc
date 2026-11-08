import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileWindowCounter, WindowCounterUnreadableError } from './window-counter.js';

/**
 * The count of messages a controlled window has sent (S1.12d). It is a safety net for the owner's money and the owner's recipients: the
 * cap holds across restarts and across two processes, and a count that cannot be read stops the sending instead of starting again at zero.
 */
describe('the window counter', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'melarc-window-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const counter = (cap = 3, approvalRef = 'OWNER-2026-10-29-SMS') =>
    new FileWindowCounter({ directory, approvalRef, cap });

  // Break caught: a cap that lets one message too many through, or counts a slot it did not take.
  it('takes slots up to the cap and then refuses, and says how many it has taken', async () => {
    const window = counter(3);
    expect(await window.taken()).toBe(0);
    expect([await window.take(), await window.take(), await window.take()]).toEqual([
      true,
      true,
      true,
    ]);
    expect(await window.take()).toBe(false);
    expect(await window.take()).toBe(false);
    expect(await window.taken()).toBe(3);
  });

  // Break caught: a counter that needs its folder to exist, which a worker that has captured nothing has not made: the first send of a
  // real window would then fail for a reason nobody can see.
  it('makes its folder when it is missing', async () => {
    const nested = join(directory, 'not', 'yet', 'made');
    const window = new FileWindowCounter({
      directory: nested,
      approvalRef: 'OWNER-2026-10-29-SMS',
      cap: 2,
    });
    expect(await window.take()).toBe(true);
    expect(await window.taken()).toBe(1);
    expect((await readdir(nested)).filter((entry) => entry.endsWith('.count'))).toHaveLength(1);
  });

  // Break caught: a count that restarts from zero when the file cannot be read for a reason other than that it is not there: the one
  // failure in which the cap must hold. Here the name of the count file is a folder.
  it('stops the sending when the count file cannot be read, and never starts again at zero', async () => {
    const window = counter(3);
    await window.take();
    const [name] = (await readdir(directory)).filter((entry) => entry.endsWith('.count'));
    if (name === undefined) throw new Error('the counter wrote no file');
    await rm(join(directory, name));
    await mkdir(join(directory, name));
    await expect(window.take()).rejects.toBeInstanceOf(WindowCounterUnreadableError);
    await expect(window.taken()).rejects.toBeInstanceOf(WindowCounterUnreadableError);
  });

  // Break caught (review m2): a count file that vanishes under a running worker (a clearing of the capture folder, a disk that lost a
  // file) read as a window that has sent nothing, which reopens the cap in the middle of the window. A file that was never there is how
  // every window starts, so a counter that has not seen its file reads zero.
  it('stops the sending when the file it has written is gone, and starts at zero when it has never been there', async () => {
    const window = counter(3);
    expect(await window.taken()).toBe(0);
    expect(await window.take()).toBe(true);
    const [name] = (await readdir(directory)).filter((entry) => entry.endsWith('.count'));
    if (name === undefined) throw new Error('the counter wrote no file');
    await rm(join(directory, name));
    await expect(window.take()).rejects.toBeInstanceOf(WindowCounterUnreadableError);
    await expect(window.taken()).rejects.toBeInstanceOf(WindowCounterUnreadableError);
    // A counter made after the file went (a restarted worker, a smoke run) has not seen it: for it the window has sent nothing.
    expect(await counter(3).taken()).toBe(0);
  });

  // Break caught: a count kept in memory, which a restart of the worker would give back to the window.
  it('keeps the count across instances and restarts', async () => {
    expect(await counter(5).take()).toBe(true);
    expect(await counter(5).take()).toBe(true);
    expect(await counter(5).taken()).toBe(2);
    const lowered = counter(2);
    expect(await lowered.take()).toBe(false);
  });

  // Break caught: two windows sharing a count, so that a renewed approval starts half spent or a second one is starved.
  it('keeps a count for each approval reference', async () => {
    await counter(1, 'WINDOW-ONE-2026').take();
    expect(await counter(1, 'WINDOW-ONE-2026').take()).toBe(false);
    expect(await counter(1, 'WINDOW-TWO-2026').take()).toBe(true);
  });

  // Break caught: a read-modify-write without a lock, which two worker processes (or the worker and the smoke command) would both win.
  it('never hands out more than the cap, however many callers race for it', async () => {
    const first = counter(20);
    const second = counter(20);
    const answers = await Promise.all(
      Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? first : second).take()),
    );
    expect(answers.filter(Boolean)).toHaveLength(20);
    expect(await counter(20).taken()).toBe(20);
  });

  // Break caught: a count that restarts from zero when it cannot be read: the one failure in which the cap must hold.
  it.each([
    ['not JSON', 'not json'],
    ['a count that is not a whole number', JSON.stringify({ ref: 'x', taken: 1.5 })],
    ['a negative count', JSON.stringify({ ref: 'x', taken: -1 })],
    ['an empty file', ''],
  ])(
    'stops the sending when the file holds %s, and never starts again at zero',
    async (_label, content) => {
      const window = counter(3);
      await window.take();
      const [name] = (await readdir(directory)).filter((entry) => entry.endsWith('.count'));
      if (name === undefined) throw new Error('the counter wrote no file');
      await writeFile(join(directory, name), content);
      await expect(window.take()).rejects.toBeInstanceOf(WindowCounterUnreadableError);
      await expect(window.taken()).rejects.toBeInstanceOf(WindowCounterUnreadableError);
    },
  );

  // Break caught: a count file of another window read as this one's.
  it('stops the sending when the file belongs to another window', async () => {
    await counter(3, 'WINDOW-ONE-2026').take();
    const [name] = (await readdir(directory)).filter((entry) => entry.endsWith('.count'));
    if (name === undefined) throw new Error('the counter wrote no file');
    const text = await readFile(join(directory, name), 'utf8');
    const other = new FileWindowCounter({ directory, approvalRef: 'WINDOW-TWO-2026', cap: 3 });
    await writeFile(join(directory, other.fileName), text);
    await expect(other.take()).rejects.toBeInstanceOf(WindowCounterUnreadableError);
  });

  // Break caught: a lock left by a worker that was killed holding it, which would stop the sending for good.
  it('takes over a lock that was left behind a long time ago', async () => {
    const window = counter(3);
    await window.take();
    const lock = join(directory, window.lockName);
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await window.take()).toBe(true);
    expect(await window.taken()).toBe(2);
  });

  // Break caught: the approval reference, or anything of the message, written into a file in a folder that a person reads.
  it('writes the count and a digest of the reference, and nothing else', async () => {
    await counter(3, 'OWNER-2026-10-29-SMS').take();
    const files = (await readdir(directory)).filter((entry) => entry.endsWith('.count'));
    expect(files).toHaveLength(1);
    const text = await readFile(join(directory, files[0] ?? ''), 'utf8');
    expect(text).not.toContain('OWNER-2026-10-29-SMS');
    expect(files[0]).not.toContain('OWNER');
    expect(Object.keys(JSON.parse(text) as object).toSorted()).toEqual(['ref', 'taken']);
    expect((JSON.parse(text) as { taken: number }).taken).toBe(1);
  });

  it('refuses a cap that is not a whole number of at least one', () => {
    for (const cap of [0, -1, 1.5, Number.NaN]) {
      expect(() => counter(cap)).toThrow(RangeError);
    }
  });
});
