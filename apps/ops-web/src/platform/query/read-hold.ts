import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { rateLimitWaitSeconds } from '../problem/rate-limit';

/**
 * The hold: how the page waits when the API has said a request was too fast (`429`, `Retry-After`; surfaces/ops-portal.md section 8, A2 of the
 * audit). While it is on, the **automatic** reads wait; the reads a person asks for by pressing a control never do.
 *
 * - **What is automatic** is a read the page starts without the person asking for that read: the refresh of the counts beside the menu when a
 *   page is returned to (`useRefreshQueueSummaryOnReturn`), the search sent as the person types (`useRecordLookup`), a read of a cached query that
 *   a page's opening would renew (`refetchOnMount`, set once for every query in `createQueryClient`), and any poll or timer a later task adds.
 *   Such a read asks the hold first: `whenFree(key, run)` runs it now, or once when the hold ends (the renewal on opening is not made while it
 *   lasts, and the next opening renews it). A read the person asks for (*Refresh*, *Try again*, a command) is sent as it always was and is never
 *   held, whatever the hold says, and neither is the read that follows the person's own act (a page reads a record again to learn the version the
 *   next command needs, and a hold would leave the old one on the screen).
 * - **It starts by itself**: the session boundary tells it of every `429` an answer for the current session carries (`onRateLimited`), for any
 *   call, those made outside the cache included, and `hold(seconds)` keeps the wait to a few seconds when the API gave none and to a minute when
 *   it gave more. A hold that is on is made longer by a longer wait and never shorter by a shorter one.
 * - **It never retries.** What waited under a key is what was *asked* while the hold was on, once, and the latest ask under a key replaces the
 *   earlier: a read that was refused is not queued, so a refusal that follows the release begins a new hold and queues nothing of itself. There is
 *   no timer that sends a read again, so there is no loop; the wait ends, and the next thing the person does reads.
 * - **It ends with the session** (`clear`): a new person starts without a wait and without the previous person's reads.
 *
 * One hold belongs to one query client (`holdOf`), that is to one application instance; the words and the wait of the refusal are
 * `platform/problem/rate-limit.ts`'s.
 */
export class ReadHold {
  #until = 0;
  #held = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #waiting = new Map<string, () => void>();
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** Whether the automatic reads are waiting now. */
  get held(): boolean {
    return this.#held;
  }

  /**
   * Starts a hold of the wait the API asked for (a few seconds when it asked for nothing usable, a minute at most), or makes the one that is on
   * longer. A shorter wait than the one that remains changes nothing.
   */
  hold(askedSeconds: number | undefined): void {
    const wait = rateLimitWaitSeconds(askedSeconds) * 1000;
    const until = this.#now() + wait;
    if (this.#held && until <= this.#until) return;
    this.#until = until;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.release();
    }, wait);
    this.#set(true);
  }

  /**
   * Runs `run` now when nothing is held, or once when the hold ends. The latest `run` under a key replaces an earlier one, so a trigger that
   * fires again while it waits is one read at the end and not many.
   */
  whenFree(key: string, run: () => void): void {
    if (!this.#held) {
      this.#waiting.delete(key);
      run();
      return;
    }
    this.#waiting.set(key, run);
  }

  /** Drops what waits under `key`: the trigger it was for is no longer wanted (the text has changed, the page has gone). */
  forget(key: string): void {
    this.#waiting.delete(key);
  }

  /**
   * Ends the hold now and runs what waited, each once. The timer calls it when the wait is over. What runs sees the hold off, so a read that is
   * refused again begins a new hold and nothing here sends it a second time.
   */
  release(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const runs = [...this.#waiting.values()];
    this.#waiting.clear();
    this.#set(false);
    for (const run of runs) run();
  }

  /** Ends the hold now and forgets what waited: the session it was kept for is over. */
  clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#waiting.clear();
    this.#set(false);
  }

  /** For `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** For `useSyncExternalStore`. */
  readonly snapshot = (): boolean => this.#held;

  #set(held: boolean): void {
    if (this.#held === held) return;
    this.#held = held;
    for (const listener of [...this.#listeners]) listener();
  }
}

const HOLDS = new WeakMap<QueryClient, ReadHold>();

/** The hold of an application instance: one for each query client, made when it is first asked for. */
export function holdOf(client: QueryClient): ReadHold {
  let hold = HOLDS.get(client);
  if (hold === undefined) {
    hold = new ReadHold();
    HOLDS.set(client, hold);
  }
  return hold;
}

/**
 * Whether the page is holding its automatic reads for a wait the API asked for, and re-renders when that changes. The command palette says so in
 * its status line, in the words of `RATE_LIMITED_MESSAGE`, beside a search that is waiting to be sent.
 */
export function useReadHeld(): boolean {
  const hold = holdOf(useQueryClient());
  return useSyncExternalStore(hold.subscribe, hold.snapshot);
}
