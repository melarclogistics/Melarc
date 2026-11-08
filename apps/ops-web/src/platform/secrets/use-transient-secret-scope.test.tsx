import { act, render } from '@testing-library/react';
import { MemoryRouter, useNavigate, type Location } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionFixture } from '../../test-support/session-fixture';
import { SessionProvider } from '../session/SessionProvider';
import { SessionStore } from '../session/session-store';
import { useTransientSecret, type TransientSecret } from './use-transient-secret';

/**
 * The scope of a held secret (S0.43): which change of address counts as "the person navigated". By default any change of location does, even
 * a new query string on the same page. A screen that spans several routes (the setup pages, where the enrolment material is handed from one
 * route to the next) names the family of addresses that one secret belongs to, and a screen that rewrites its own address (the page that
 * removes a grant from the fragment) names the path alone.
 */

const SECRET = 'otpauth://totp/Melarc:test?secret=SCOPEDSENTINEL2222';

const setupFamily = (location: Location): string =>
  location.pathname.startsWith('/setup/') ? 'setup' : 'elsewhere';
const pathOnly = (location: Location): string => location.pathname;

function Holder({
  scope,
  onReady,
}: {
  readonly scope: (location: Location) => string;
  readonly onReady: (
    secret: TransientSecret<string>,
    go: (to: string, replace?: boolean) => void,
  ) => void;
}) {
  const secret = useTransientSecret<string>({ scope });
  const navigate = useNavigate();
  onReady(secret, (to, replace = false) => {
    void navigate(to, { replace });
  });
  return (
    <p>
      {secret.status}: {secret.value ?? '-'}
    </p>
  );
}

function setup(scope: (location: Location) => string) {
  let current: TransientSecret<string> | undefined;
  let go: (to: string, replace?: boolean) => void = () => undefined;
  const store = new SessionStore();
  store.signedIn(sessionFixture());
  render(
    <SessionProvider store={store}>
      <MemoryRouter initialEntries={['/setup/credential']}>
        <Holder
          scope={scope}
          onReady={(secret, navigate) => {
            current = secret;
            go = navigate;
          }}
        />
      </MemoryRouter>
    </SessionProvider>,
  );
  return {
    secret: () => {
      if (current === undefined) throw new Error('not rendered');
      return current;
    },
    go: (to: string, replace?: boolean) => {
      go(to, replace);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTransientSecret: the scope of a secret', () => {
  // Break caught: a secret handed from one route of a flow to the next being thrown away at the hand-over, so the enrolment screen
  // opens with nothing to show.
  it('keeps a secret while the address changes inside its scope', () => {
    const { secret, go } = setup(setupFamily);
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });

    act(() => {
      go('/setup/mfa');
    });
    act(() => {
      go('/setup/mfa/complete');
    });

    expect(secret().status).toBe('held');
    expect(secret().value).toBe(SECRET);
  });

  // Break caught: a secret that follows the person out of the flow it belongs to, onto a page that has nothing to do with it.
  it('lets go of it when the address leaves its scope', () => {
    const { secret, go } = setup(setupFamily);
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });

    act(() => {
      go('/sign-in');
    });

    expect(secret().status).toBe('none');
    expect(secret().value).toBeUndefined();
  });

  // Break caught: the answer to an ask made inside the scope arriving after the person has left it.
  it('refuses the answer to an ask that was made before the person left its scope', () => {
    const { secret, go } = setup(setupFamily);
    const flow = secret().begin();
    act(() => {
      go('/sign-in');
    });

    let delivered = true;
    act(() => {
      delivered = secret().hold(flow, SECRET, 60_000);
    });

    expect(delivered).toBe(false);
    expect(secret().value).toBeUndefined();
  });

  // Break caught: a page that removes a grant from its own address letting go of the grant it has just read.
  it('does not count a page rewriting its own address as the person navigating, when the scope is the path', () => {
    const { secret, go } = setup(pathOnly);
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });

    act(() => {
      go('/setup/credential', true);
    });
    act(() => {
      go('/setup/credential?step=2#fragment', true);
    });

    expect(secret().status).toBe('held');
    expect(secret().value).toBe(SECRET);
  });

  it('lets go of it when the path changes, when the scope is the path', () => {
    const { secret, go } = setup(pathOnly);
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });

    act(() => {
      go('/setup/mfa');
    });

    expect(secret().status).toBe('none');
  });

  // Break caught: a scope that stops the other ends (time, page hidden) from applying.
  it('still lets go of it when its time is up', () => {
    const { secret } = setup(setupFamily);
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(secret().status).toBe('expired');
    expect(secret().value).toBeUndefined();
  });

  it('still lets go of it when the page is hidden', () => {
    const { secret } = setup(setupFamily);
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    expect(secret().status).toBe('none');
  });
});
