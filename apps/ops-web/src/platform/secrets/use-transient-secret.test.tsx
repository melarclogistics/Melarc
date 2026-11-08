import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionFixture } from '../../test-support/session-fixture';
import { SessionProvider } from '../session/SessionProvider';
import { SessionStore } from '../session/session-store';
import {
  lifetimeFromExpiry,
  MAX_HOLD_MS,
  useTransientSecret,
  type SecretFlow,
  type TransientSecret,
} from './use-transient-secret';

const SECRET = 'otpauth://totp/Melarc:test?secret=SENTINELSENTINEL22';

/** Begins a flow and delivers the secret to it at once: the answer that arrives while its flow is current. */
function put(secret: TransientSecret<string>, value: string, lifetimeMs: number): boolean {
  return secret.hold(secret.begin(), value, lifetimeMs);
}

/** Begins a flow inside act() and hands it back. */
function beginFlow(secret: () => TransientSecret<string>): SecretFlow {
  const box: { flow?: SecretFlow } = {};
  act(() => {
    box.flow = secret().begin();
  });
  if (box.flow === undefined) throw new Error('no flow was begun');
  return box.flow;
}

/** Shows what the hook holds, and hands the test its controls. */
function Holder({
  onReady,
}: {
  readonly onReady: (secret: TransientSecret<string>, go: (to: string) => void) => void;
}) {
  const secret = useTransientSecret<string>();
  const navigate = useNavigate();
  onReady(secret, (to) => {
    void navigate(to);
  });
  return (
    <p>
      {secret.status}: {secret.value ?? '-'}
    </p>
  );
}

function setup() {
  let current: TransientSecret<string> | undefined;
  let go: (to: string) => void = () => undefined;
  const store = new SessionStore();
  store.signedIn(sessionFixture());
  const tree = () => (
    <SessionProvider store={store}>
      <MemoryRouter initialEntries={['/setup/mfa']}>
        <Holder
          onReady={(secret, navigate) => {
            current = secret;
            go = navigate;
          }}
        />
      </MemoryRouter>
    </SessionProvider>
  );
  const view = render(tree());
  return {
    ...view,
    store,
    /** Renders the same tree again, as any render does: a component that is shown again reads the clock again. */
    again: () => {
      view.rerender(tree());
    },
    secret: () => {
      if (current === undefined) throw new Error('not rendered');
      return current;
    },
    go: (to: string) => {
      go(to);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTransientSecret: holding', () => {
  it('holds nothing until it is given something', () => {
    const { secret } = setup();

    expect(secret().status).toBe('none');
    expect(secret().value).toBeUndefined();
  });

  it('holds what it is given, for as long as it was told', () => {
    const { secret } = setup();

    act(() => {
      put(secret(), SECRET, 60_000);
    });
    expect(secret().status).toBe('held');
    expect(secret().value).toBe(SECRET);
    expect(screen.getByText(`held: ${SECRET}`)).toBeVisible();

    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(secret().value).toBe(SECRET);
  });

  // Break caught: a secret that outlives its time, so an expired enrolment is still on the screen and in memory.
  it('lets go of it when its time is up, and says that it expired', () => {
    const { secret } = setup();
    act(() => {
      put(secret(), SECRET, 60_000);
    });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(secret().status).toBe('expired');
    expect(secret().value).toBeUndefined();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  // Break caught: a time from the server that is longer than any page should keep a secret, or too long for a timer
  // (a delay over about 24.8 days fires at once in a browser, which would hide the secret before it was shown).
  it('never holds a secret longer than the cap, however long the server says it lives', () => {
    const { secret } = setup();

    act(() => {
      put(secret(), SECRET, 7 * 24 * 60 * 60 * 1000);
    });
    expect(secret().status).toBe('held');
    act(() => {
      vi.advanceTimersByTime(MAX_HOLD_MS - 1);
    });
    expect(secret().status).toBe('held');
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(secret().status).toBe('expired');
    expect(secret().value).toBeUndefined();
  });

  // Break caught: a secret that was already out of time when it arrived being shown for a moment, or an infinite
  // lifetime being a way to keep it for ever.
  it.each([0, -1, Number.NaN, Number.NEGATIVE_INFINITY])(
    'is expired at once, and never shown, for a lifetime of %s',
    (lifetime) => {
      const { secret } = setup();

      act(() => {
        put(secret(), SECRET, lifetime);
      });

      expect(secret().status).toBe('expired');
      expect(secret().value).toBeUndefined();
      expect(document.body.textContent).not.toContain(SECRET);
    },
  );

  it('caps an infinite lifetime like any other', () => {
    const { secret } = setup();

    act(() => {
      put(secret(), SECRET, Number.POSITIVE_INFINITY);
      vi.advanceTimersByTime(MAX_HOLD_MS);
    });

    expect(secret().status).toBe('expired');
  });

  // Break caught: the timer of an earlier secret ending a later one early, or keeping it too long.
  it('starts the time again when another secret is held', () => {
    const { secret } = setup();
    act(() => {
      put(secret(), 'first', 60_000);
      vi.advanceTimersByTime(50_000);
      put(secret(), 'second', 60_000);
      vi.advanceTimersByTime(50_000);
    });
    expect(secret().value).toBe('second');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(secret().status).toBe('expired');
  });
});

describe('useTransientSecret: letting go', () => {
  // Break caught: a secret kept after the person has done what it was for.
  it('lets go of it at once on completion', () => {
    const { secret } = setup();
    act(() => {
      put(secret(), SECRET, 60_000);
    });

    act(() => {
      secret().clear();
    });

    expect(secret().status).toBe('none');
    expect(secret().value).toBeUndefined();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('does not come back when the time it had would have ended', () => {
    const { secret } = setup();
    act(() => {
      put(secret(), SECRET, 60_000);
      secret().clear();
      vi.advanceTimersByTime(120_000);
    });

    expect(secret().status).toBe('none');
  });

  // Break caught: a secret still in memory, and on the screen, after the person moved to another page in the same
  // component (a query string or a hash changed), where the component stays mounted.
  it('lets go of it when the person navigates, even if the component stays mounted', () => {
    const { secret, go } = setup();
    act(() => {
      put(secret(), SECRET, 60_000);
    });
    expect(secret().value).toBe(SECRET);

    act(() => {
      go('/setup/mfa?step=2');
    });

    expect(secret().status).toBe('none');
    expect(secret().value).toBeUndefined();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  // Break caught: the back-forward cache keeping the page, with the secret on it, and showing it again when the person
  // comes back to it. `pagehide` is the last thing a page that is about to be kept in it runs.
  it.each([true, false])('lets go of it when the page is hidden (persisted: %s)', (persisted) => {
    const { secret } = setup();
    act(() => {
      put(secret(), SECRET, 60_000);
    });

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted }));
    });

    expect(secret().status).toBe('none');
    expect(document.body.textContent).not.toContain(SECRET);
  });

  // Break caught: a timer that fires after the component has gone and sets state on it, or a secret held by a timer's
  // closure after the page is gone.
  it('stops its timer and holds nothing when the component is removed', () => {
    const { secret, unmount } = setup();
    act(() => {
      put(secret(), SECRET, 60_000);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    unmount();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(SECRET);
    error.mockRestore();
  });

  it('removes its page listener when the component is removed', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = setup();

    unmount();

    expect(remove.mock.calls.map(([type]) => type)).toContain('pagehide');
    remove.mockRestore();
  });
});

describe('useTransientSecret: nowhere else', () => {
  // Break caught: the hook "helpfully" persisting a secret so it survives a reload: storage, a cookie, the address or
  // the history entry.
  it('puts the secret in no storage, cookie, address or history state', () => {
    const { secret } = setup();

    act(() => {
      put(secret(), SECRET, 60_000);
    });

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(location.href).not.toContain('SENTINEL');
    expect(JSON.stringify(history.state ?? null)).not.toContain('SENTINEL');
    expect(document.title).not.toContain('SENTINEL');
  });
});

describe('useTransientSecret: an answer that arrives late (U02 of 23 October 2026)', () => {
  /**
   * A flow is begun, something happens, and only then does the answer reach `hold`: the request was in flight when the person acted.
   * The answer is delivered whether or not the flow's signal was heard, as a request that ignores its signal would.
   */
  function lateAfter(event: (view: ReturnType<typeof setup>) => void) {
    const view = setup();
    const flow = beginFlow(view.secret);
    expect(flow.current()).toBe(true);

    act(() => {
      event(view);
    });
    let taken = true;
    act(() => {
      taken = view.secret().hold(flow, SECRET, 60_000);
    });
    return { ...view, flow, taken };
  }

  // Break caught: `hold` taking whatever it is given, so that a secret asked for before the person left is shown after they have left.
  it.each<[string, (view: ReturnType<typeof setup>) => void]>([
    [
      'the person navigated',
      (view) => {
        view.go('/setup/mfa?step=2');
      },
    ],
    [
      'the person finished',
      (view) => {
        view.secret().clear();
      },
    ],
    [
      'the session ended',
      (view) => {
        view.store.end();
      },
    ],
    [
      'another person signed in',
      (view) => {
        view.store.signedIn(sessionFixture({ principal_display_name: 'Someone Else' }));
      },
    ],
    [
      'the page was hidden',
      () => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      },
    ],
    [
      'another flow began',
      (view) => {
        view.secret().begin();
      },
    ],
  ])(
    'refuses the secret, and shows and keeps nothing, when %s while the request was in flight',
    (_label, event) => {
      const { secret, taken, flow } = lateAfter(event);

      expect(taken).toBe(false);
      expect(flow.current()).toBe(false);
      expect(secret().status).toBe('none');
      expect(secret().value).toBeUndefined();
      expect(document.body.textContent).not.toContain(SECRET);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  // Break caught: the request left running on the network after the flow was called off.
  it.each<[string, (view: ReturnType<typeof setup>) => void]>([
    [
      'the person navigated',
      (view) => {
        view.go('/setup/mfa?step=2');
      },
    ],
    [
      'the person finished',
      (view) => {
        view.secret().clear();
      },
    ],
    [
      'the session ended',
      (view) => {
        view.store.end();
      },
    ],
    [
      'the page was hidden',
      () => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      },
    ],
    [
      'another flow began',
      (view) => {
        view.secret().begin();
      },
    ],
  ])('aborts the signal of the flow in flight when %s', (_label, event) => {
    const { flow } = lateAfter(event);

    expect(flow.signal.aborted).toBe(true);
  });

  // Break caught: a screen that is gone being given a secret, or setting state on itself when the late answer reaches it.
  it('refuses the secret of a screen that has been removed, and says nothing', () => {
    const view = setup();
    const flow = beginFlow(view.secret);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = view.secret();
    view.unmount();

    const taken = secret.hold(flow, SECRET, 60_000);

    expect(taken).toBe(false);
    expect(flow.signal.aborted).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    error.mockRestore();
  });

  // Break caught: the earlier of two asks winning, so that the secret shown is the answer to a question the person has since replaced.
  it('delivers only the answer to the latest ask', () => {
    const { secret } = setup();
    const first = beginFlow(secret);
    const second = beginFlow(secret);

    let tookFirst = true;
    let tookSecond = false;
    act(() => {
      tookFirst = secret().hold(first, 'first', 60_000);
      tookSecond = secret().hold(second, 'second', 60_000);
    });

    expect(tookFirst).toBe(false);
    expect(tookSecond).toBe(true);
    expect(secret().value).toBe('second');
  });

  // Break caught: one request's answer taken twice, which would restart the time a secret may be held.
  it('delivers once for a flow', () => {
    const { secret } = setup();
    const flow = beginFlow(secret);

    let again = true;
    act(() => {
      secret().hold(flow, 'once', 60_000);
      again = secret().hold(flow, 'twice', 60_000);
    });

    expect(again).toBe(false);
    expect(secret().value).toBe('once');
  });

  // Break caught: a ticket that anyone can make, so that the check is a formality: a flow that this hook did not begin is refused.
  it('refuses a flow it did not begin', () => {
    const { secret } = setup();
    const forged: SecretFlow = { signal: new AbortController().signal, current: () => true };

    let taken = true;
    act(() => {
      taken = secret().hold(forged, SECRET, 60_000);
    });

    expect(taken).toBe(false);
    expect(secret().status).toBe('none');
  });

  // Break caught: a secret shown after its deadline because the timer that ends it did not run on time (a hidden tab, a machine that
  // slept): the deadline is checked again when the secret would be shown.
  it('does not show a secret past its deadline even when its timer has not fired', () => {
    const view = setup();
    act(() => {
      put(view.secret(), SECRET, 60_000);
    });
    expect(view.secret().value).toBe(SECRET);

    // The clock moves on; the timer, as a browser may do with a hidden tab, has not run.
    vi.setSystemTime(Date.now() + 61_000);
    act(() => {
      view.again();
    });

    expect(view.secret().status).toBe('expired');
    expect(view.secret().value).toBeUndefined();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  // Break caught: the delayed timer being the only thing that drops a secret: the page is seen again past the deadline, nothing renders it,
  // and the secret stays in memory until a timer that a browser has deferred runs.
  it.each([
    [
      'the window is focused',
      () => {
        window.dispatchEvent(new Event('focus'));
      },
    ],
    [
      'the page is shown',
      () => {
        window.dispatchEvent(new Event('pageshow'));
      },
    ],
    [
      'the tab becomes visible',
      () => {
        document.dispatchEvent(new Event('visibilitychange'));
      },
    ],
  ])('drops a secret past its deadline, and stops its timer, when %s', (_label, event) => {
    const view = setup();
    act(() => {
      put(view.secret(), SECRET, 60_000);
    });
    vi.setSystemTime(Date.now() + 61_000);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      event();
    });

    expect(view.secret().status).toBe('expired');
    expect(view.secret().value).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  // Break caught: the same events dropping a secret that still has time.
  it('keeps a secret that still has time when the page is seen again', () => {
    const view = setup();
    act(() => {
      put(view.secret(), SECRET, 60_000);
    });
    vi.setSystemTime(Date.now() + 30_000);

    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(view.secret().value).toBe(SECRET);
  });

  // Break caught: the monotonic clock ignored, so that setting the wall clock back extends a secret beyond its time.
  it('ends a secret when the monotonic clock says its time is up, whatever the wall clock says', () => {
    const view = setup();
    act(() => {
      put(view.secret(), SECRET, 60_000);
    });
    const now = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 61_000);

    act(() => {
      view.again();
    });

    expect(view.secret().status).toBe('expired');
    expect(view.secret().value).toBeUndefined();
    now.mockRestore();
  });
});

describe('lifetimeFromExpiry and the lifetime that is held', () => {
  const NOW = Date.parse('2026-10-23T10:00:00.000Z');

  it('is the time left until the expiry the server gave', () => {
    expect(lifetimeFromExpiry('2026-10-23T10:02:00.000Z', NOW)).toBe(120_000);
    expect(lifetimeFromExpiry('2026-10-23T10:00:00+00:00', NOW)).toBe(0);
    expect(lifetimeFromExpiry('2026-10-23T09:59:00Z', NOW)).toBe(-60_000);
  });

  // Break caught: an expiry that is not an instant read as a long lifetime, which would hold a secret for the cap.
  it.each([undefined, null, '', 'tomorrow', '2026-10-23', '10:00'])(
    'is NaN, which is expired at once, for %s',
    (value) => {
      expect(lifetimeFromExpiry(value, NOW)).toBeNaN();
    },
  );

  // Break caught: the cap replacing the server's lifetime when the server's is shorter, or the server's lifetime replacing the cap when
  // it is longer. A secret is held for the lesser of the two.
  it('holds a secret for the lesser of what the server has left and the cap', () => {
    const { secret } = setup();
    act(() => {
      put(secret(), SECRET, lifetimeFromExpiry(new Date(Date.now() + 120_000).toISOString()));
    });
    act(() => {
      vi.advanceTimersByTime(119_999);
    });
    expect(secret().status).toBe('held');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(secret().status).toBe('expired');

    act(() => {
      put(secret(), SECRET, lifetimeFromExpiry(new Date(Date.now() + 3_600_000).toISOString()));
    });
    act(() => {
      vi.advanceTimersByTime(MAX_HOLD_MS - 1);
    });
    expect(secret().status).toBe('held');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(secret().status).toBe('expired');
  });
});

describe('useTransientSecret: the session (U02 and U03 of 23 October 2026)', () => {
  // Break caught: a secret that stays on the screen when its session ends, so that the person who comes next sees the previous
  // person's authenticator setup.
  it.each<[string, (view: ReturnType<typeof setup>) => void]>([
    [
      'the session ends',
      (view) => {
        view.store.end();
      },
    ],
    [
      'another person signs in',
      (view) => {
        view.store.signedIn(sessionFixture({ principal_display_name: 'Someone Else' }));
      },
    ],
  ])('lets go of a secret that is held when %s', (_label, event) => {
    const view = setup();
    act(() => {
      put(view.secret(), SECRET, 60_000);
    });
    expect(view.secret().value).toBe(SECRET);

    act(() => {
      event(view);
    });

    expect(view.secret().status).toBe('none');
    expect(view.secret().value).toBeUndefined();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Break caught: the flow judged only by what the store announces. A session that is ended again, with nobody signed in, moves the
  // store's generation and changes no state, so nobody is told; the flow itself must notice that its session is not the current one.
  it('refuses an answer for a session that was ended again, though the store had nothing to announce', () => {
    const view = setup();
    act(() => {
      view.store.end();
    });
    const flow = beginFlow(view.secret);
    const listener = vi.fn();
    const unsubscribe = view.store.subscribe(listener);

    act(() => {
      view.store.end();
    });

    expect(listener).not.toHaveBeenCalled();
    expect(flow.current()).toBe(false);
    let taken = true;
    act(() => {
      taken = view.secret().hold(flow, SECRET, 60_000);
    });
    expect(taken).toBe(false);
    expect(view.secret().status).toBe('none');
    expect(document.body.textContent).not.toContain(SECRET);
    unsubscribe();
  });

  // Break caught: the secret dropped for any change of the store, and not only for a change of session, which would take an enrolment
  // away from a person because a read of the session began.
  it('keeps a secret through a change of the store that is not a change of session', () => {
    const view = setup();
    // Nobody is signed in on this page (the pre-sign-in screens hold secrets too); the generation will not move from here.
    act(() => {
      view.store.end();
    });
    act(() => {
      put(view.secret(), SECRET, 60_000);
    });
    const generation = view.store.generation;

    act(() => {
      void view.store.load(() => new Promise(() => undefined));
    });

    expect(view.store.getState().status).toBe('loading');
    expect(view.store.generation).toBe(generation);
    expect(view.secret().value).toBe(SECRET);
  });
});
