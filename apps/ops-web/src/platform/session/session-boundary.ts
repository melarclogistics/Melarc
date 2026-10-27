import { apiErrorFromResponse, type BrowserApiClient } from '@melarc/api-client/browser';

import type { SessionStore } from './session-store';

/**
 * A request was answered after the session it was sent for had ended or been replaced. It carries no server text and no data: what
 * the late answer said was about a session that is gone, and it is neither shown nor kept nor acted on (U03 of 23 October 2026).
 * It is not an {@link ApiError} and does not end a session.
 */
export class StaleSessionError extends Error {
  override name = 'StaleSessionError';

  constructor() {
    super('The session changed while the request was in flight.');
  }
}

export interface SessionBoundaryOptions {
  readonly store: SessionStore;
  /**
   * The API said, to a request sent for the session that is current, that this session has ended (`SESSION_INVALID`, or
   * `SESSION_SUPERSEDED` for a vendor displaced by a colleague), with that code. What the session showed is forgotten here, the store is
   * told, and the person is taken away. It is called once for an ended session: the answers that follow it, to requests sent
   * before it, are stale and do not call it.
   */
  readonly onEnded: (code: string) => void;
}

type Verb = (
  ...args: never[]
) => Promise<{ readonly response: Response; readonly error?: unknown }>;

/**
 * The one place a session's life meets the requests made for it.
 *
 * Every call the page makes to the API goes through a client this boundary has scoped, whether a query, a mutation or a direct call
 * that a screen makes outside any cache (a secret is fetched that way, and must not be cached). The boundary notes which session was
 * current when a request was **dispatched** (`SessionStore.generation`) and judges the answer against it when it arrives:
 *
 * - an answer to a request sent for a session that has since ended or been replaced is thrown away as a {@link StaleSessionError},
 *   whatever it says. A late error from person A's session cannot end person B's, and a late success cannot show, cache or hold
 *   anything for B;
 * - an answer to a request sent for the current session that says the session ended ends it, once, whichever kind of call it was;
 * - every other failure (a refused permission, a refused sign-in, a validation, a fault, a connection that dropped) is the caller's
 *   to handle, and none of them ends a session.
 *
 * Clearing a query cache does not cancel what is in flight (a running mutation cannot be cancelled at all), so nothing here relies on
 * it: a stale answer is refused where it arrives, and cancelling the request is a courtesy to the network. Nothing is judged while
 * nobody is signed in: the read that asks who is, and a sign-in, are sent for no session, and their `401` is the answer they wait for.
 */
export class SessionBoundary {
  readonly #options: SessionBoundaryOptions;

  constructor(options: SessionBoundaryOptions) {
    this.#options = options;
  }

  /**
   * Ends the session that is current, as an answer of `SESSION_INVALID` would: through `onEnded`, once. A sign-out uses it, so that the
   * page ends a session by the very event that the API ends one by. Nothing happens when nobody is signed in, so it can follow an end the
   * boundary has already made (a sign-out answered `SESSION_INVALID`) without ending the next session.
   */
  end(code: string): void {
    if (this.#options.store.getState().status !== 'signed-in') return;
    this.#options.onEnded(code);
  }

  /** The client, with every call it makes judged by this boundary. It has the same verbs and the same types. */
  scope(client: BrowserApiClient): BrowserApiClient {
    const original = client as unknown as Record<string, Verb>;
    const scoped: Record<string, Verb> = {};
    for (const name of Object.keys(original)) {
      const verb = original[name];
      if (verb === undefined) continue;
      scoped[name] = (...args: never[]) => this.#dispatch(() => verb(...args));
    }
    return Object.freeze(scoped) as unknown as BrowserApiClient;
  }

  async #dispatch<R extends { readonly response: Response; readonly error?: unknown }>(
    send: () => Promise<R>,
  ): Promise<R> {
    const { store } = this.#options;
    const generation = store.generation;

    let result: R;
    try {
      result = await send();
    } catch (error) {
      // A failure of a request for a session that is gone is not news about the one that has replaced it.
      if (store.generation !== generation) throw new StaleSessionError();
      throw error;
    }
    if (store.generation !== generation) throw new StaleSessionError();

    if (!result.response.ok && store.getState().status === 'signed-in') {
      const failure = apiErrorFromResponse(result.response, result.error);
      if (failure.endsSession && failure.code !== undefined) this.#options.onEnded(failure.code);
    }
    return result;
  }
}
