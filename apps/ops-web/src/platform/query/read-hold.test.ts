import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RATE_LIMIT_WAIT_SECONDS } from '../problem/rate-limit';
import { holdOf, ReadHold } from './read-hold';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const seconds = (n: number): number => n * 1000;

describe('the hold: how the page waits when the API has said a request was too fast (A2 of the audit)', () => {
  // Break caught: an automatic read held when nothing was refused, so that every page waits for nothing.
  it('runs an automatic read at once when nothing is held', () => {
    const hold = new ReadHold();
    const run = vi.fn();

    hold.whenFree('summary', run);

    expect(hold.held).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  // Break caught: an automatic read sent while the API has asked the page to wait (the load it refused), or sent before the wait is over, or never.
  it('keeps an automatic read until the wait the API asked for is over, then runs it once', () => {
    const hold = new ReadHold();
    const run = vi.fn();

    hold.hold(30);
    hold.whenFree('summary', run);

    expect(hold.held).toBe(true);
    vi.advanceTimersByTime(seconds(29));
    expect(run).not.toHaveBeenCalled();
    expect(hold.held).toBe(true);

    vi.advanceTimersByTime(seconds(1));
    expect(hold.held).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(seconds(120));
    expect(run).toHaveBeenCalledTimes(1);
  });

  // Break caught: the wait ignored when the API gave none or an absurd one (an hour in which nothing is read).
  it.each([
    [undefined, DEFAULT_RATE_LIMIT_WAIT_SECONDS],
    [0, DEFAULT_RATE_LIMIT_WAIT_SECONDS],
    [10_000, 60],
  ])('keeps a wait asked for as %s for %s seconds', (asked, kept) => {
    const hold = new ReadHold();

    hold.hold(asked);

    vi.advanceTimersByTime(seconds(kept) - 1);
    expect(hold.held).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hold.held).toBe(false);
  });

  // Break caught: a second refusal that shortens the wait the first asked for (the page would read again while the API still wanted it still), or one
  // that does not lengthen it.
  it('is made longer by a longer wait and never shorter by a shorter one', () => {
    const hold = new ReadHold();

    hold.hold(30);
    vi.advanceTimersByTime(seconds(10));
    hold.hold(5);
    vi.advanceTimersByTime(seconds(19));
    expect(hold.held).toBe(true);
    vi.advanceTimersByTime(seconds(1));
    expect(hold.held).toBe(false);

    hold.hold(10);
    vi.advanceTimersByTime(seconds(5));
    hold.hold(40);
    vi.advanceTimersByTime(seconds(39));
    expect(hold.held).toBe(true);
    vi.advanceTimersByTime(seconds(1));
    expect(hold.held).toBe(false);
  });

  // Break caught: the same trigger queued many times and run many times at the end (a page returned to again and again, each a read), or an earlier
  // text run instead of the latest.
  it('runs the latest read under a key once, and a read under each other key once', () => {
    const hold = new ReadHold();
    const first = vi.fn();
    const latest = vi.fn();
    const other = vi.fn();

    hold.hold(10);
    hold.whenFree('summary', first);
    hold.whenFree('summary', latest);
    hold.whenFree('lookup', other);
    vi.advanceTimersByTime(seconds(10));

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });

  // Break caught: a trigger that is no longer wanted (the text has changed, the page has gone) still sent when the wait ends.
  it('forgets a read that is no longer wanted', () => {
    const hold = new ReadHold();
    const run = vi.fn();

    hold.hold(10);
    hold.whenFree('lookup', run);
    hold.forget('lookup');
    vi.advanceTimersByTime(seconds(10));

    expect(run).not.toHaveBeenCalled();
  });

  // Break caught (no automatic retry loop): a read that is refused when the wait ends being queued again by the hold, so that the page asks, is
  // refused, waits and asks again for ever. The hold runs what was asked while it was on, once; the refusal begins a wait and nothing else.
  it('does not send a refused read again by itself: a refusal after the release begins a wait and queues nothing', () => {
    const hold = new ReadHold();
    const sent = vi.fn(() => {
      // The read was refused: the session boundary tells the hold, as it does for every 429.
      hold.hold(10);
    });

    hold.hold(10);
    hold.whenFree('summary', sent);
    vi.advanceTimersByTime(seconds(10));
    expect(sent).toHaveBeenCalledTimes(1);
    expect(hold.held).toBe(true);

    vi.advanceTimersByTime(seconds(600));
    expect(sent).toHaveBeenCalledTimes(1);
    expect(hold.held).toBe(false);
  });

  // Break caught: a hold that outlives the session it was kept for, so that a new person starts by waiting, or the previous person's read is sent
  // for them.
  it('ends with the session: the wait is over at once and what waited is dropped', () => {
    const hold = new ReadHold();
    const run = vi.fn();
    hold.hold(30);
    hold.whenFree('summary', run);

    hold.clear();
    vi.advanceTimersByTime(seconds(60));

    expect(hold.held).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  // Break caught: a component that does not hear the hold begin or end, so that the palette would not say why it is waiting.
  it('tells the pages that listen when it begins and when it ends', () => {
    const hold = new ReadHold();
    const heard: boolean[] = [];
    const stop = hold.subscribe(() => {
      heard.push(hold.snapshot());
    });

    hold.hold(10);
    hold.hold(20);
    vi.advanceTimersByTime(seconds(20));
    stop();
    hold.hold(5);

    expect(heard).toEqual([true, false]);
  });
});

describe('the wait of work that has a promise to wait on', () => {
  // Break caught: automatic work (a file that has not begun to upload, the link of a photo) that waits when nothing is held, or that does not wait when something is.
  it('is free at once when nothing is held, and waits for the end of the hold when something is', async () => {
    const hold = new ReadHold();
    let free = false;

    await hold.untilFree('upload');
    hold.hold(30);
    void hold.untilFree('upload').then(() => {
      free = true;
    });
    await vi.advanceTimersByTimeAsync(seconds(29));
    expect(free).toBe(false);
    await vi.advanceTimersByTimeAsync(seconds(1));
    expect(free).toBe(true);
  });

  // Break caught: the latest under a key replacing an earlier one, as the reads do: two files (or a tile and the viewer of the same photo) that wait under one name, and one of them never going on.
  it('lets every waiter go on when the hold ends, even those that wait under one name', async () => {
    const hold = new ReadHold();
    const done: number[] = [];

    hold.hold(10);
    for (const n of [1, 2, 3]) {
      void hold.untilFree('photo').then(() => {
        done.push(n);
      });
    }
    await vi.advanceTimersByTimeAsync(seconds(10));

    expect(done.toSorted()).toEqual([1, 2, 3]);
  });

  // Break caught: a waiter that was left out (a file the person removed, a tile that scrolled away) that still goes on, or one that is left waiting for ever.
  it('ends the wait of a waiter that is abandoned, with an abort, and lets the others go on', async () => {
    const hold = new ReadHold();
    const left = new AbortController();
    const done: string[] = [];
    const failures: unknown[] = [];

    hold.hold(10);
    void hold
      .untilFree('a', left.signal)
      .then(() => done.push('a'))
      .catch((error: unknown) => failures.push(error));
    void hold.untilFree('b').then(() => done.push('b'));
    left.abort();
    await vi.advanceTimersByTimeAsync(seconds(10));

    expect(done).toEqual(['b']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ name: 'AbortError' });
  });

  it('refuses at once for a signal that was already aborted, even when nothing is held', async () => {
    const hold = new ReadHold();
    const left = new AbortController();
    hold.hold(5);
    left.abort();

    await expect(hold.untilFree('a', left.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  // Break caught: work that goes on into a limit that has only just been told: a hold that began again while a waiter was being released.
  it('waits out a hold that began again by the time it was released', async () => {
    const hold = new ReadHold();
    let free = false;

    hold.hold(5);
    void hold.untilFree('upload').then(() => {
      free = true;
    });
    // The wait ends and, as the waiter runs, a refusal begins a new one.
    await vi.advanceTimersByTimeAsync(seconds(5));
    expect(free).toBe(true);

    free = false;
    hold.hold(5);
    const again = hold.untilFree('upload').then(() => {
      free = true;
    });
    hold.hold(20);
    await vi.advanceTimersByTimeAsync(seconds(5));
    expect(free).toBe(false);
    await vi.advanceTimersByTimeAsync(seconds(15));
    await again;
    expect(free).toBe(true);
  });
});

describe('the hold of an application instance', () => {
  // Break caught: one hold for every client, so that a wait kept for one application instance (a test, a second window of a shared module) is kept for all.
  it('belongs to one query client, and is the same each time it is asked for', () => {
    const one = new QueryClient();
    const another = new QueryClient();

    expect(holdOf(one)).toBe(holdOf(one));
    expect(holdOf(one)).not.toBe(holdOf(another));
    holdOf(one).hold(10);
    expect(holdOf(another).held).toBe(false);
  });
});
