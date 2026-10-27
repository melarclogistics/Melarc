import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it, vi } from 'vitest';

import { OperationFailure } from '../api/api-response';
import { sessionFixture } from '../../test-support/session-fixture';
import { SessionStore } from './session-store';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const notSignedIn = () =>
  new OperationFailure(new ApiError({ kind: 'http', status: 401, code: 'SESSION_INVALID' }), []);

describe('the session store', () => {
  // Break caught: a page deciding what to show before it knows whether anyone is signed in, which flashes either the
  // signed-in landing or the sign-in redirect at a person who is the other.
  it('starts loading, with nobody signed in', () => {
    expect(new SessionStore().getState()).toEqual({ status: 'loading' });
  });

  it('is signed in once the read answers, with what the session says', async () => {
    const store = new SessionStore();
    const session = sessionFixture();

    await store.load(() => Promise.resolve(session));

    expect(store.getState()).toEqual({ status: 'signed-in', session });
  });

  // Break caught: any failure taken for "signed out" (the network dropped and the person is sent to sign in again), or a
  // "not signed in" taken for a fault (the person is told to retry, for ever).
  it('is signed out when the API says the person is not signed in', async () => {
    const store = new SessionStore();

    await store.load(() => Promise.reject(notSignedIn()));

    expect(store.getState()).toEqual({ status: 'signed-out' });
  });

  it.each([
    ['no answer', new ApiError({ kind: 'network' })],
    ['a fault', new ApiError({ kind: 'http', status: 503 })],
    ['a refusal that is not about the session', new ApiError({ kind: 'http', status: 403 })],
    ['an error that is not the API’s', new Error('boom')],
  ])('is unavailable, not signed out, after %s', async (_label, error) => {
    const store = new SessionStore();

    await store.load(() => Promise.reject(error));

    expect(store.getState()).toEqual({ status: 'unavailable' });
  });

  it('can be read again after it was unavailable, and shows loading meanwhile', async () => {
    const store = new SessionStore();
    await store.load(() => Promise.reject(new ApiError({ kind: 'network' })));
    const second = deferred<ReturnType<typeof sessionFixture>>();

    const loading = store.load(() => second.promise);
    expect(store.getState()).toEqual({ status: 'loading' });
    second.resolve(sessionFixture());
    await loading;

    expect(store.getState().status).toBe('signed-in');
  });

  // Break caught: React's StrictMode (and a page that renders twice) reading the session twice at start, which doubles
  // the first request of every visit and counts as activity twice.
  it('reads once while a read is under way', async () => {
    const store = new SessionStore();
    const pending = deferred<ReturnType<typeof sessionFixture>>();
    const read = vi.fn(() => pending.promise);

    const first = store.load(read);
    const second = store.load(read);
    pending.resolve(sessionFixture());
    await Promise.all([first, second]);

    expect(read).toHaveBeenCalledOnce();
  });

  it('does not read again once somebody is signed in', async () => {
    const store = new SessionStore();
    const read = vi.fn(() => Promise.resolve(sessionFixture()));

    await store.load(read);
    await store.load(read);

    expect(read).toHaveBeenCalledOnce();
  });

  // Break caught: an answer from before the session ended signing somebody in afterwards. The page asked who is signed
  // in, the session was ended (sign-out, another page's 401), and the old answer arrived: the person would be shown
  // the landing of a session that does not exist.
  it('ignores a read that was answered after the session ended', async () => {
    const store = new SessionStore();
    const pending = deferred<ReturnType<typeof sessionFixture>>();
    const loading = store.load(() => pending.promise);

    store.end();
    pending.resolve(sessionFixture());
    await loading;

    expect(store.getState()).toEqual({ status: 'signed-out' });
  });

  it('ignores a failure answered after the session ended', async () => {
    const store = new SessionStore();
    const pending = deferred<never>();
    const loading = store.load(() => pending.promise);

    store.end();
    pending.reject(new ApiError({ kind: 'network' }));
    await loading;

    expect(store.getState()).toEqual({ status: 'signed-out' });
  });

  // Break caught: the next person on a browser tab finding the previous person's name, hubs or permissions.
  it('forgets who was signed in when the session ends', async () => {
    const store = new SessionStore();
    await store.load(() =>
      Promise.resolve(sessionFixture({ principal_display_name: 'Ama Mensah' })),
    );

    store.end();

    expect(store.getState()).toEqual({ status: 'signed-out' });
    expect(JSON.stringify(store.getState())).not.toContain('Ama Mensah');
  });

  it('takes the session of a sign-in as signed in', () => {
    const store = new SessionStore();
    const session = sessionFixture();

    store.end();
    store.signedIn(session);

    expect(store.getState()).toEqual({ status: 'signed-in', session });
  });

  it('can read again after it ended, for the next person who signs in', async () => {
    const store = new SessionStore();
    await store.load(() => Promise.resolve(sessionFixture()));
    store.end();
    const read = vi.fn(() => Promise.resolve(sessionFixture({ principal_display_name: 'Next' })));

    await store.load(read);

    expect(read).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      status: 'signed-in',
      session: { principal_display_name: 'Next' },
    });
  });

  describe('as an external store', () => {
    // Break caught: a snapshot that is a new object on every read, which makes React render without end.
    it('returns the same state object until something changes', async () => {
      const store = new SessionStore();
      await store.load(() => Promise.resolve(sessionFixture()));

      expect(store.getState()).toBe(store.getState());
    });

    it('tells its listeners of a change, once each, and not after they unsubscribe', async () => {
      const store = new SessionStore();
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);

      await store.load(() => Promise.resolve(sessionFixture()));
      expect(listener).toHaveBeenCalledTimes(1);

      store.end();
      expect(listener).toHaveBeenCalledTimes(2);

      unsubscribe();
      store.signedIn(sessionFixture());
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('says nothing when the session ends and was not there', () => {
      const store = new SessionStore();
      store.end();
      const listener = vi.fn();
      store.subscribe(listener);

      store.end();

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
