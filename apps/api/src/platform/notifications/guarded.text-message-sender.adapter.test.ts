import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DeliveryOutcome } from '../auth/ports/delivery-queue.port.js';
import type {
  TextMessage,
  TextMessageSender,
  TextStatus,
} from '../auth/ports/text-message-sender.port.js';
import { GuardedTextMessageSender } from './guarded.text-message-sender.adapter.js';
import { GUARD_REFUSALS } from './notification-vocabulary.js';
import {
  FileWindowCounter,
  WindowCounterUnreadableError,
  type WindowCounter,
} from './window-counter.js';

/**
 * The guards of the controlled window (S1.12d), in front of a real provider: nothing reaches the provider unless the window is open, the
 * number is the owner's and a slot of the cap is free. The provider here counts the calls it receives, because "no provider call" is the
 * property under test.
 */
const OWNER = '+233244000111';
const STRANGER = '+233244000222';
const OPENS = new Date('2026-11-01T08:00:00Z');
const ENDS = new Date('2026-11-05T23:59:59Z');

class CountingProvider implements TextMessageSender {
  calls = 0;
  statusCalls = 0;
  send(): Promise<DeliveryOutcome> {
    this.calls += 1;
    return Promise.resolve({
      outcome: 'ACCEPTED',
      providerMessageRef: `ref-${String(this.calls)}`,
    });
  }
  status(): Promise<TextStatus> {
    this.statusCalls += 1;
    return Promise.resolve({ state: 'DELIVERED' });
  }
}

const message = (destination = OWNER): TextMessage => ({
  dedupeId: '2f1c6c8e-0000-4000-8000-000000000001',
  destination,
  text: 'Melarc test',
});

describe('the guards of the controlled window', () => {
  let directory: string;
  let provider: CountingProvider;
  let now: Date;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'melarc-guard-'));
    provider = new CountingProvider();
    now = OPENS;
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const guard = (
    over: { allow?: readonly string[]; cap?: number; counter?: WindowCounter; endsAt?: Date } = {},
  ) =>
    new GuardedTextMessageSender({
      inner: provider,
      clock: { now: () => now },
      allowList: new Set(over.allow ?? [OWNER]),
      endsAt: over.endsAt ?? ENDS,
      counter:
        over.counter ??
        new FileWindowCounter({
          directory,
          approvalRef: 'OWNER-2026-10-29-SMS',
          cap: over.cap ?? 3,
        }),
    });

  // Break caught: a guard that lets the first message through and forgets the rest, or one that refuses what it should send.
  it('sends to a number on the allow-list while the window is open and a slot is free', async () => {
    expect(await guard().send(message())).toEqual({
      outcome: 'ACCEPTED',
      providerMessageRef: 'ref-1',
    });
    expect(provider.calls).toBe(1);
  });

  // Break caught: a number outside the allow-list reaching the provider: a real person the owner does not control gets a text.
  it('never asks the provider about a number that is not on the allow-list, and takes no slot for it', async () => {
    const counter = new FileWindowCounter({
      directory,
      approvalRef: 'OWNER-2026-10-29-SMS',
      cap: 3,
    });
    const sender = guard({ counter });
    expect(await sender.send(message(STRANGER))).toEqual({
      outcome: 'REJECTED',
      outcomeClass: GUARD_REFUSALS.DESTINATION_NOT_ALLOWED,
    });
    expect(provider.calls).toBe(0);
    expect(await counter.taken()).toBe(0);
  });

  // Break caught: a comparison that is looser than the list: a number with a different form or a prefix of an allowed one.
  it.each([
    '+23324400011',
    '+2332440001111',
    '233244000111',
    '0244000111',
    ' +233244000111',
    '+233244000111 ',
  ])('reads the allow-list exactly: %s is not on it', async (destination) => {
    expect((await guard().send(message(destination))).outcome).toBe('REJECTED');
    expect(provider.calls).toBe(0);
  });

  // Break caught: a window that stays open after its end.
  it('sends nothing at or after the end of the window, and sends up to the last moment before it', async () => {
    now = new Date(ENDS.getTime() - 1);
    expect((await guard().send(message())).outcome).toBe('ACCEPTED');
    now = ENDS;
    expect(await guard().send(message())).toEqual({
      outcome: 'REJECTED',
      outcomeClass: GUARD_REFUSALS.WINDOW_ENDED,
    });
    now = new Date(ENDS.getTime() + 86_400_000);
    expect((await guard().send(message())).outcome).toBe('REJECTED');
    expect(provider.calls).toBe(1);
  });

  // Break caught: a cap that is a count of successes, or that a restart gives back, or that lets the next message through.
  it('stops at the cap, across instances, and takes the slot before it asks', async () => {
    for (let each = 0; each < 3; each += 1)
      expect((await guard().send(message())).outcome).toBe('ACCEPTED');
    expect(await guard().send(message())).toEqual({
      outcome: 'REJECTED',
      outcomeClass: GUARD_REFUSALS.WINDOW_CAP,
    });
    expect(provider.calls).toBe(3);
  });

  // Break caught: a slot given back when the provider does not answer, which lets a flapping provider send past the cap.
  it('does not give a slot back when the provider refuses or does not answer', async () => {
    const refusing: TextMessageSender = {
      send: () => Promise.resolve({ outcome: 'UNKNOWN' }),
      status: () => Promise.resolve({ state: 'UNKNOWN' }),
    };
    const sender = new GuardedTextMessageSender({
      inner: refusing,
      clock: { now: () => now },
      allowList: new Set([OWNER]),
      endsAt: ENDS,
      counter: new FileWindowCounter({ directory, approvalRef: 'OWNER-2026-10-29-SMS', cap: 2 }),
    });
    expect((await sender.send(message())).outcome).toBe('UNKNOWN');
    expect((await sender.send(message())).outcome).toBe('UNKNOWN');
    expect(await sender.send(message())).toEqual({
      outcome: 'REJECTED',
      outcomeClass: GUARD_REFUSALS.WINDOW_CAP,
    });
  });

  // Break caught (the one failure in which the cap must hold): a count that cannot be read restarting the window at zero.
  it('sends nothing when the count cannot be read, and asks again later', async () => {
    const unreadable: WindowCounter = {
      take: () => Promise.reject(new WindowCounterUnreadableError()),
      taken: () => Promise.reject(new WindowCounterUnreadableError()),
    };
    const outcome = await guard({ counter: unreadable }).send(message());
    expect(outcome).toEqual({ outcome: 'UNKNOWN', retryAfterMs: 60_000 });
    expect(provider.calls).toBe(0);
  });

  it('does not hide a defect of the counter behind a retry', async () => {
    const broken: WindowCounter = {
      take: () => Promise.reject(new TypeError('a defect')),
      taken: () => Promise.resolve(0),
    };
    await expect(guard({ counter: broken }).send(message())).rejects.toThrow('a defect');
    expect(provider.calls).toBe(0);
  });

  // Break caught: the order of the guards: a closed window or a stranger taking a slot of the cap.
  it('checks the end and the allow-list before it takes a slot', async () => {
    const counter = new FileWindowCounter({
      directory,
      approvalRef: 'OWNER-2026-10-29-SMS',
      cap: 3,
    });
    now = ENDS;
    await guard({ counter }).send(message());
    now = OPENS;
    await guard({ counter }).send(message(STRANGER));
    expect(await counter.taken()).toBe(0);
  });

  it('asks the provider for a status as it is: it sends nothing and costs nothing', async () => {
    now = new Date(ENDS.getTime() + 1);
    expect(await guard().status('ref-1')).toEqual({ state: 'DELIVERED' });
    expect(provider.statusCalls).toBe(1);
    expect(provider.calls).toBe(0);
  });
});
