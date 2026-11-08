import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, type Location } from 'react-router';

import { useSessionStore } from '../session/session-context';

/**
 * The longest a page keeps a secret in memory, whatever lifetime the server gave it: 15 minutes. It is a client hygiene
 * bound and not a product value: it is long enough to scan a code and type the one it shows, and it keeps a secret from
 * outliving a person who walked away. It is also far inside the longest delay a timer can have (about 24.8 days, beyond
 * which a browser runs it at once). A provisional engineering parameter, listed for the Product Owner.
 */
export const MAX_HOLD_MS = 15 * 60 * 1000;

export type SecretStatus = 'none' | 'held' | 'expired';

/**
 * One ask for a secret, from the moment it is begun until its answer is delivered or it is called off. A screen begins a flow before it
 * sends the request, sends the request with the flow's `signal`, and gives the answer to `hold` with the flow: an answer that arrives
 * after the flow was called off is refused there, however the request ended up (a request that ignores its signal, or loses the race
 * with the cancellation, is refused all the same).
 */
export interface SecretFlow {
  /** Aborted when the flow is called off. Pass it to the request, so the network is told; the refusal in `hold` does not depend on it. */
  readonly signal: AbortSignal;
  /** Whether the flow may still deliver a secret. */
  readonly current: () => boolean;
}

/**
 * Which address the person is at, as far as one secret is concerned: the secret is let go of whenever this text changes. The default is
 * the location's own key, so any navigation counts, even a new query string on the same page. A screen that spans several routes names
 * the family they belong to (the setup pages hand the enrolment material from one route to the next), and a page that rewrites its own
 * address (the one that removes a grant from the fragment) names the path alone, so its own rewriting is not "the person navigated".
 */
export type TransientScope = (location: Location) => string;

export interface TransientSecretOptions {
  readonly scope?: TransientScope;
}

export interface TransientSecret<T> {
  /** `none`: nothing held. `held`: `value` is there. `expired`: it had a lifetime and the lifetime ended. */
  readonly status: SecretStatus;
  /** The secret, and only while its status is `held` and its deadline has not passed. */
  readonly value: T | undefined;
  /** Begins a flow, and calls off every earlier one: only the answer to the latest ask may be held. */
  readonly begin: () => SecretFlow;
  /**
   * Takes the secret a flow was asked for into memory for at most `lifetimeMs` (and never more than {@link MAX_HOLD_MS}), and says
   * whether it did. It does not when the flow was called off (the person navigated, finished, the session ended, the page was hidden or
   * the screen went away, or another flow began), when the flow already delivered, and when the lifetime is not positive (expired at
   * once; the secret is never exposed). A refused secret is not kept anywhere.
   */
  readonly hold: (flow: SecretFlow, secret: T, lifetimeMs: number) => boolean;
  /** The secret has done its work: it is gone at once, and every flow in flight is called off. */
  readonly clear: () => void;
}

/** When a held secret ends, on both clocks: it ends at the earlier. */
interface Deadline {
  /** `performance.now()`: monotonic, so a clock set back does not extend it. */
  readonly monotonic: number;
  /** `Date.now()`: it also runs while the machine sleeps, as the server's lifetime does. */
  readonly wall: number;
}

type Held<T> =
  | { readonly status: 'none' }
  | { readonly status: 'expired' }
  | { readonly status: 'held'; readonly value: T; readonly deadline: Deadline };

const NONE = { status: 'none' } as const;
const EXPIRED = { status: 'expired' } as const;

const isPast = (deadline: Deadline): boolean =>
  performance.now() >= deadline.monotonic || Date.now() >= deadline.wall;

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * How long a secret the server gave an expiry for has left, in milliseconds, at `nowMs`. Not a number a person can trust when the
 * expiry is absent or not an instant: that is `NaN`, which {@link TransientSecret.hold} treats as already expired. The page holds the
 * lesser of this and {@link MAX_HOLD_MS}.
 */
export function lifetimeFromExpiry(
  expiresAt: string | null | undefined,
  nowMs = Date.now(),
): number {
  if (typeof expiresAt !== 'string' || !INSTANT.test(expiresAt)) return Number.NaN;
  return Date.parse(expiresAt) - nowMs;
}

/**
 * Where a transient credential lives on a page: in the memory of one component, and nowhere else. A TOTP seed, a QR
 * payload and the other enrolment material are bearer secrets (plan section 3, Secrets): they never enter the query
 * cache, web storage, the address or the history, a log or an analytics call (the sentinel test of this folder plants
 * one and looks everywhere), and they are gone when
 *
 * - the person completes what they were for (`clear`),
 * - their time ends (`hold` takes a lifetime, capped by {@link MAX_HOLD_MS}; the deadline is kept and checked again whenever the
 *   secret would be shown, so a timer a browser delays does not extend it),
 * - the person navigates, including within the same component (the location changes; or, when the screen names a `scope`, the scope
 *   changes),
 * - the session ends or is replaced (the session store's generation changes),
 * - the screen is removed, and
 * - the page is hidden, which is the last thing a page does before the browser may keep it in its back-forward cache and
 *   show it again: the secret is removed from the screen before that, not after.
 *
 * The same events call off the flow that was asking for a secret, so an answer that is still on its way when one of them happens is
 * refused when it arrives (U02 of 23 October 2026). The flow's `signal` is aborted as well, which saves the network; the refusal
 * is what is relied on.
 *
 * A secret is not fetched through a mutation or a query: their results stay in the cache after the call. Fetch it with
 * the client directly (every call goes through the session boundary) and hold it here. A JavaScript string cannot be wiped, so "gone" means no
 * reference is kept, and what the engine frees is the engine's.
 */
export function useTransientSecret<T>(options: TransientSecretOptions = {}): TransientSecret<T> {
  const store = useSessionStore();
  const [state, setState] = useState<Held<T>>(NONE);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const location = useLocation();
  // What the secret is scoped to, as text: the effect below runs again, and lets go, only when this changes.
  const scopeKey = options.scope === undefined ? location.key : options.scope(location);

  /** Which flow may deliver: a number that moves on every event that calls flows off. */
  const epoch = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  /** The flows this hook gave out, and the ones that have already delivered. */
  const issued = useRef(new WeakSet<SecretFlow>());
  const delivered = useRef(new WeakSet<SecretFlow>());
  const seenGeneration = useRef(store.generation);
  /** When what is held ends, for the events that look at the clock (a timer that was delayed does not). */
  const heldUntil = useRef<Deadline | undefined>(undefined);

  const stopTimer = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  /** Calls off the flow in flight and drops what is held. */
  const clear = useCallback(() => {
    epoch.current += 1;
    controller.current?.abort();
    controller.current = undefined;
    heldUntil.current = undefined;
    stopTimer();
    setState(NONE);
  }, [stopTimer]);

  const begin = useCallback((): SecretFlow => {
    controller.current?.abort();
    epoch.current += 1;
    const mine = epoch.current;
    const sessionGeneration = store.generation;
    const own = new AbortController();
    controller.current = own;
    const flow: SecretFlow = {
      signal: own.signal,
      current: () =>
        epoch.current === mine &&
        store.generation === sessionGeneration &&
        !own.signal.aborted &&
        !delivered.current.has(flow),
    };
    issued.current.add(flow);
    return flow;
  }, [store]);

  const hold = useCallback(
    (flow: SecretFlow, secret: T, lifetimeMs: number): boolean => {
      if (!issued.current.has(flow) || !flow.current()) return false;
      delivered.current.add(flow);
      stopTimer();
      // `NaN`, zero and a negative lifetime fail this test; an infinite one is capped like any other.
      const lifetime = Math.min(lifetimeMs, MAX_HOLD_MS);
      if (!(lifetime > 0)) {
        heldUntil.current = undefined;
        setState(EXPIRED);
        return false;
      }
      const deadline = { monotonic: performance.now() + lifetime, wall: Date.now() + lifetime };
      heldUntil.current = deadline;
      setState({ status: 'held', value: secret, deadline });
      timer.current = setTimeout(() => {
        timer.current = undefined;
        heldUntil.current = undefined;
        setState(EXPIRED);
      }, lifetime);
      return true;
    },
    [stopTimer],
  );

  // Its cleanup runs when the scope is a new one (navigation within the component) and when the component is removed,
  // so it is also what stops the timer of a component that has gone and calls off the flow of one.
  useEffect(() => clear, [scopeKey, clear]);

  // The page is going into the back-forward cache, or away: take the secret off the screen now, in this task.
  useEffect(() => {
    const onHide = (): void => {
      flushSync(clear);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
    };
  }, [clear]);

  // The session ended or was replaced: what it asked for and what it was given are not for whoever is here next.
  useEffect(() => {
    seenGeneration.current = store.generation;
    return store.subscribe(() => {
      if (store.generation === seenGeneration.current) return;
      seenGeneration.current = store.generation;
      clear();
    });
  }, [store, clear]);

  // A timer a browser delays (a hidden tab, a machine that slept) must not extend a secret. When the page is seen again the deadline is
  // looked at and a secret past it is dropped on the spot, and a render before then (below) does not show it.
  useEffect(() => {
    const dropIfPast = (): void => {
      const deadline = heldUntil.current;
      if (deadline === undefined || !isPast(deadline)) return;
      heldUntil.current = undefined;
      stopTimer();
      setState(EXPIRED);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') dropIfPast();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', dropIfPast);
    window.addEventListener('focus', dropIfPast);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', dropIfPast);
      window.removeEventListener('focus', dropIfPast);
    };
  }, [stopTimer]);

  // Whatever is rendered, a secret past its deadline is not shown: the state may still hold it until the timer or an event drops it.
  const expiredByDeadline = state.status === 'held' && isPast(state.deadline);

  const live = state.status === 'held' && !expiredByDeadline;
  return {
    status: expiredByDeadline ? 'expired' : state.status,
    value: live ? state.value : undefined,
    begin,
    hold,
    clear,
  };
}
