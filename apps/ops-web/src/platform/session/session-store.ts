import type { components } from '@melarc/api-client';

import { isNotSignedIn } from '../api/api-response';

/**
 * The caller's own session as `getCurrentSession` answers it (the contract's `CurrentSession`): who is signed in, the
 * hubs they act in, and the permission keys the session holds. The keys are a source for what to show; the server
 * checks the key on every request, so what a page hides decides nothing.
 */
export type SessionView = components['schemas']['CurrentSession'];

/**
 * What the application knows about who is signed in.
 *
 * `loading`: the first read has not been answered. `signed-out`: the API said nobody is signed in, or the session ended.
 * `unavailable`: the read got no answer that says either (no connection, a fault), so nothing is known and the person
 * is not signed out for it.
 */
export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-in'; readonly session: SessionView }
  | { readonly status: 'signed-out' }
  | { readonly status: 'unavailable' };

const LOADING: SessionState = { status: 'loading' };
const SIGNED_OUT: SessionState = { status: 'signed-out' };
const UNAVAILABLE: SessionState = { status: 'unavailable' };

/**
 * The session of one application instance, as a small external store (read with `useSyncExternalStore`).
 *
 * It is not kept in the query cache on purpose. The cache is cleared when a session ends (`endSession`), and a cleared
 * query leaves the components that observe it holding their last answer; the person who had the session must be gone
 * from the screen at once, and the next person's read must start from nothing. Nothing here is persisted: the session
 * is an `HttpOnly` cookie the page cannot read, and what this holds is only what the API said about it, in memory, for
 * as long as the page lives.
 */
export class SessionStore {
  #state: SessionState = LOADING;
  #listeners = new Set<() => void>();
  #reading: Promise<void> | undefined;
  /** Counts the changes of who the session is (an end, a sign-in), so that an answer to a request that began before one is not taken as current. */
  #epoch = 0;

  readonly getState = (): SessionState => this.#state;

  /**
   * Which session this is, as a number that changes whenever the session does: when it ends and when somebody signs in. A request, a
   * secret or a command key records it when it begins, and what it learns is current only while this still reads the same
   * (`SessionBoundary`, `useTransientSecret`, the command-key slot). It says nothing about who is signed in.
   */
  get generation(): number {
    return this.#epoch;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #set(state: SessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * Reads who is signed in, once. A read already under way is the answer to every caller (a page that renders twice
   * must not ask twice), and nothing is read when somebody is already signed in. Retrying after `unavailable` reads
   * again and shows `loading` meanwhile.
   */
  load(read: () => Promise<SessionView>): Promise<void> {
    if (this.#reading !== undefined) return this.#reading;
    if (this.#state.status === 'signed-in') return Promise.resolve();

    const epoch = this.#epoch;
    this.#set(LOADING);
    const reading = (async () => {
      let next: SessionState;
      try {
        next = { status: 'signed-in', session: await read() };
      } catch (error) {
        next = isNotSignedIn(error) ? SIGNED_OUT : UNAVAILABLE;
      }
      if (epoch === this.#epoch) this.#set(next);
    })().finally(() => {
      this.#reading = undefined;
    });
    this.#reading = reading;
    return reading;
  }

  /** Somebody signed in: the session a sign-in answered. */
  signedIn(session: SessionView): void {
    this.#epoch += 1;
    this.#set({ status: 'signed-in', session });
  }

  /** The session ended: sign-out, or the API said so. Nothing of who it was stays. */
  end(): void {
    this.#epoch += 1;
    this.#set(SIGNED_OUT);
  }
}
