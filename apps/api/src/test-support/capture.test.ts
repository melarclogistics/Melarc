import { describe, expect, it } from 'vitest';

import { createCapture } from './capture.js';

/**
 * The capture reader (S0.10). The delivery adapters in the `capture` mode keep what they would have sent in memory
 * (DEPLOYMENT_AND_ENVIRONMENTS.md section 4: a staging or local run sends nothing to anyone), and a test reads it here: the setup
 * link a vendor would have received, the code a recipient would have been texted. The adapter arrives with S0.17; the reader is the
 * kit's half, and what it must be from the first day is empty.
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
