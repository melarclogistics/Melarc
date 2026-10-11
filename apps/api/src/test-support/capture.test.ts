import { describe, expect, it } from 'vitest';

import type { CapturedMessage } from '../platform/delivery/worker/capture-sink.js';
import { createCapture, deliverySinkOver } from './capture.js';

/**
 * The capture reader (S0.10). The delivery adapters in the `capture` mode keep what they would have sent in memory
 * (DEPLOYMENT_AND_ENVIRONMENTS.md section 4: a staging or local run sends nothing to anyone), and a test reads it here: the setup
 * link a vendor would have received. The reader is the kit's half, and what it must be from the first day is empty; the capture
 * adapter writes to it through `deliverySinkOver` (OB-88).
 */
describe('createCapture', () => {
  // Break caught: a reader that starts with something in it, so that a test which expects "nothing was sent" passes or fails on
  // what an earlier test left.
  it('is empty by default', () => {
    const { reader } = createCapture<string>();
    expect(reader.all()).toEqual([]);
    expect(reader.size).toBe(0);
    expect(reader.last()).toBeUndefined();
  });

  it('reads what the sink received, in order', () => {
    const { reader, sink } = createCapture<{ to: string }>();
    sink.push({ to: 'a' });
    sink.push({ to: 'b' });
    expect(reader.all()).toEqual([{ to: 'a' }, { to: 'b' }]);
    expect(reader.last()).toEqual({ to: 'b' });
    expect(reader.size).toBe(2);
  });

  // Break caught: a reader that hands out the store itself, so that a test (or the code under test) changes what was captured.
  it('hands out a copy: changing it changes nothing captured', () => {
    const { reader, sink } = createCapture<string>();
    sink.push('x');
    (reader.all() as string[]).push('forged');
    expect(reader.all()).toEqual(['x']);
  });

  it('finds the latest entry that matches, and none when nothing does', () => {
    const { reader, sink } = createCapture<{ to: string; n: number }>();
    sink.push({ to: 'a', n: 1 });
    sink.push({ to: 'b', n: 2 });
    sink.push({ to: 'a', n: 3 });
    expect(reader.last((entry) => entry.to === 'a')).toEqual({ to: 'a', n: 3 });
    expect(reader.last((entry) => entry.to === 'z')).toBeUndefined();
    expect(reader.where((entry) => entry.to === 'a').map((entry) => entry.n)).toEqual([1, 3]);
  });

  // Break caught: a clear that leaves entries, which would carry one test's mail into the next.
  it('is emptied by clear, which only the sink can do', () => {
    const { reader, sink } = createCapture<string>();
    sink.push('x');
    sink.clear();
    expect(reader.all()).toEqual([]);
    expect('clear' in reader).toBe(false);
    expect('push' in reader).toBe(false);
  });

  it('keeps two captures apart', () => {
    const one = createCapture<string>();
    const two = createCapture<string>();
    one.sink.push('x');
    expect(two.reader.all()).toEqual([]);
  });
});

describe('deliverySinkOver (OB-88)', () => {
  const FIRST = 'a'.repeat(32);
  const SECOND = 'b'.repeat(32);
  const message = (
    dedupeId: string,
    link = 'https://ops.example.test/setup#token=t-one',
  ): CapturedMessage => ({
    capturedAt: '2026-10-10T12:00:00.000Z',
    dedupeId,
    kind: 'SETUP_GRANT',
    channel: 'EMAIL',
    destination: 'someone@example.test',
    link,
  });

  // Break caught: a sink the capture adapter writes to that the reader does not read, so that a test would find nothing was sent.
  it('puts what the capture adapter writes where the reader reads it, in the order it was written', async () => {
    const { reader, sink } = createCapture<CapturedMessage>();
    const delivery = deliverySinkOver(reader, sink);

    await delivery.write(message(FIRST));
    await delivery.write(message(SECOND, 'https://ops.example.test/setup#token=t-two'));

    expect(reader.all().map((entry) => entry.dedupeId)).toEqual([FIRST, SECOND]);
    expect(reader.last()?.link).toBe('https://ops.example.test/setup#token=t-two');
  });

  // Break caught: a retried send captured twice. The adapter's rule is one message for one deduplication identity.
  it('keeps one message for one deduplication identity: a send tried again leaves one', async () => {
    const { reader, sink } = createCapture<CapturedMessage>();
    const delivery = deliverySinkOver(reader, sink);

    await delivery.write(message(FIRST));
    await delivery.write(message(FIRST));
    await delivery.write(message(SECOND));

    expect(reader.all().map((entry) => entry.dedupeId)).toEqual([FIRST, SECOND]);
  });

  // Break caught: a `has` that answers for every identity, for none, or for the wrong one; or one that outlives a clear.
  it('says whether a message is held by its deduplication identity, and no longer once the capture is cleared', async () => {
    const { reader, sink } = createCapture<CapturedMessage>();
    const delivery = deliverySinkOver(reader, sink);
    expect(await delivery.has(FIRST)).toBe(false);

    await delivery.write(message(FIRST));

    expect(await delivery.has(FIRST)).toBe(true);
    expect(await delivery.has(SECOND)).toBe(false);
    sink.clear();
    expect(await delivery.has(FIRST)).toBe(false);
    await delivery.write(message(FIRST));
    expect(reader.size).toBe(1);
  });

  // Break caught: two captures sharing one store, so that one test's mail reaches the next.
  it('writes to the capture it was given and to no other', async () => {
    const one = createCapture<CapturedMessage>();
    const two = createCapture<CapturedMessage>();

    await deliverySinkOver(one.reader, one.sink).write(message(FIRST));

    expect(one.reader.size).toBe(1);
    expect(two.reader.size).toBe(0);
  });
});
