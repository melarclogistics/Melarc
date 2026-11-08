import type { BrowserApiClient } from '@melarc/api-client/browser';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorResponse, installFakeApi, type FakeApi } from '../../test-support/fake-api';
import { sessionFixture } from '../../test-support/session-fixture';
import { ApiClientProvider } from '../api/api-client';
import { SessionBoundary } from './session-boundary';
import { useEndSession } from './session-context';
import { SessionProvider } from './SessionProvider';
import { SessionStore } from './session-store';
import { useSignOut } from './use-sign-out';

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const SIGN_OUT = 'DELETE /auth/session';
const done = () => new Response(null, { status: 204 });

/** A boundary that hands the client back as it is: no answer is judged against the session it was sent for. */
class UnjudgedBoundary extends SessionBoundary {
  override scope(client: BrowserApiClient): BrowserApiClient {
    return client;
  }
}

/**
 * The sign-out hook alone, on a store with somebody signed in. `end` stands for the action that ends the session; `endsItself` says
 * whether the boundary also ends it on a `SESSION_INVALID` answer, as the application's does.
 */
function mount(options: { endsItself?: boolean; judged?: boolean } = {}) {
  const store = new SessionStore();
  store.signedIn(sessionFixture());
  const end = vi.fn();
  const Boundary = options.judged === false ? UnjudgedBoundary : SessionBoundary;
  const boundary = new Boundary({
    store,
    onEnded: () => {
      if (options.endsItself !== false) store.end();
    },
  });
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <ApiClientProvider boundary={boundary}>
      <SessionProvider store={store} end={end}>
        {children}
      </SessionProvider>
    </ApiClientProvider>
  );
  return { store, end, ...renderHook(() => useSignOut(), { wrapper }) };
}

describe('useSignOut', () => {
  it('ends the session once when the API says it is signed out', async () => {
    api.on(SIGN_OUT, done);
    const { result, end } = mount();

    await act(async () => {
      await result.current.signOut();
    });

    expect(end).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('idle');
  });

  // Break caught: "the session had already ended" read as a failure of signing out. It is what the person asked for. Here nothing else ends
  // the session (the application's boundary would, and so hide the difference), so the sign-out must read the answer as done itself.
  it.each(['SESSION_INVALID', 'SESSION_SUPERSEDED'])(
    'reads %s as done, and ends the session, even when nothing else did',
    async (code) => {
      api.on(SIGN_OUT, () => errorResponse(401, code));
      const { result, end } = mount({ endsItself: false });

      await act(async () => {
        await result.current.signOut();
      });

      expect(end).toHaveBeenCalledTimes(1);
      expect(result.current.state).toBe('idle');
    },
  );

  // Break caught: two presses in one moment sending two sign-outs, which a button that is already busy cannot prevent when both arrive
  // before the screen has drawn it busy.
  it('sends one request however many times it is asked in one moment', async () => {
    api.on(SIGN_OUT, done);
    const { result } = mount();

    await act(async () => {
      await Promise.all([
        result.current.signOut(),
        result.current.signOut(),
        result.current.signOut(),
      ]);
    });

    expect(api.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
  });

  it.each([
    ['a fault', () => errorResponse(500, 'INTERNAL_ERROR')],
    ['a refused CSRF check', () => errorResponse(403, 'CSRF_VALIDATION_FAILED')],
    ['no answer', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('leaves the session alone and says it did not finish after %s', async (_label, answer) => {
    api.on(SIGN_OUT, answer);
    const { result, end, store } = mount();

    await act(async () => {
      await result.current.signOut();
    });

    expect(end).not.toHaveBeenCalled();
    expect(result.current.state).toBe('failed');
    expect(store.getState().status).toBe('signed-in');
  });

  it('can be tried again after it failed', async () => {
    let answers = 0;
    api.on(SIGN_OUT, () => {
      answers += 1;
      return answers === 1 ? errorResponse(500, 'INTERNAL_ERROR') : done();
    });
    const { result, end } = mount();
    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.state).toBe('failed');

    await act(async () => {
      await result.current.signOut();
    });

    expect(end).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('idle');
  });

  // Break caught: the defence behind the boundary's. An answer for a session that has been replaced must not end the one that replaced
  // it, even if a client reached the page that does not judge answers. Here the client is not judged, so only the hook can notice.
  it('drops an answer for a session that was replaced, without ending the new one', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.on(SIGN_OUT, async () => {
      await held;
      return done();
    });
    const { result, end, store } = mount({ judged: false });

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.signOut();
    });
    await waitFor(() => {
      expect(result.current.state).toBe('pending');
    });
    act(() => {
      store.end();
      store.signedIn(sessionFixture({ principal_display_name: 'Another Person' }));
    });
    await act(async () => {
      release();
      await pending;
    });

    expect(end).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
    expect(store.getState().status).toBe('signed-in');
  });

  it('is not available without the action that ends a session, and says so', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new SessionStore();
    const boundary = new SessionBoundary({ store, onEnded: () => undefined });
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <ApiClientProvider boundary={boundary}>
        <SessionProvider store={store}>{children}</SessionProvider>
      </ApiClientProvider>
    );

    expect(() => renderHook(() => useEndSession(), { wrapper })).toThrow(/useEndSession/);
    quiet.mockRestore();
  });
});
