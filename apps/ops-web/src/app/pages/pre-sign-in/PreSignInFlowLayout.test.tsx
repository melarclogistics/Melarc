import { act, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnrolmentMaterial, MfaChallengeView } from '../../../platform/auth/pre-sign-in-shape';
import { SessionProvider } from '../../../platform/session/SessionProvider';
import { SessionStore } from '../../../platform/session/session-store';
import { sessionFixture } from '../../../test-support/session-fixture';
import { PreSignInFlowLayout } from './PreSignInFlowLayout';
import { usePreSignInFlow, type PreSignInFlow } from './pre-sign-in-flow';

const CHALLENGE: MfaChallengeView = {
  challenge_id: '0f9c6a52-3d8e-4b71-9a24-6c1e7d5b8f30',
  expires_at: '2026-10-24T09:05:00.000Z',
  trusted_browser_days: 7,
};
const MATERIAL: EnrolmentMaterial = {
  otpauthUri: 'otpauth://totp/Melarc:x?secret=ABCDEFGHIJKLMNOP',
  setupToken: 'synthetic-continuation-grant',
};

function Probe({
  id,
  onReady,
}: {
  readonly id: string;
  readonly onReady: (flow: PreSignInFlow) => void;
}) {
  const flow = usePreSignInFlow();
  onReady(flow);
  return (
    <p>
      {id}: challenge {flow.challenge.status}, enrolment {flow.enrolment.status}
    </p>
  );
}

function setup(entry = '/sign-in') {
  let current: PreSignInFlow | undefined;
  const store = new SessionStore();
  const router = createMemoryRouter(
    [
      {
        element: <PreSignInFlowLayout />,
        children: [
          'sign-in',
          'sign-in/mfa',
          'setup/credential',
          'setup/mfa',
          'setup/mfa/complete',
        ].map((path) => ({
          path,
          element: (
            <Probe
              id={path}
              onReady={(flow) => {
                current = flow;
              }}
            />
          ),
        })),
      },
      { path: '/', element: <h1>Start</h1> },
    ],
    { initialEntries: [entry] },
  );
  render(
    <SessionProvider store={store}>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return {
    router,
    store,
    flow: () => {
      if (current === undefined) throw new Error('not rendered');
      return current;
    },
    go: async (to: string) => {
      await act(async () => {
        await router.navigate(to);
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the pre-sign-in flow: what two routes hand each other, in memory', () => {
  it('holds nothing until it is given something', async () => {
    const { flow } = setup();
    await screen.findByText('sign-in: challenge none, enrolment none');

    expect(flow().challenge.value).toBeUndefined();
    expect(flow().enrolment.value).toBeUndefined();
  });

  // Break caught: the challenge lost on its way from the password step to the second step, so every privileged sign-in lands on a page
  // that has nothing to complete.
  it('carries a challenge from the sign-in route to the second step', async () => {
    const { flow, go } = setup('/sign-in');
    await screen.findByText('sign-in: challenge none, enrolment none');
    act(() => {
      flow().challenge.hold(flow().challenge.begin(), CHALLENGE, 60_000);
    });

    await go('/sign-in/mfa');

    expect(await screen.findByText('sign-in/mfa: challenge held, enrolment none')).toBeVisible();
    expect(flow().challenge.value).toEqual(CHALLENGE);
  });

  // Break caught: the enrolment material lost on its way from the first password to the authenticator, or from there to the confirmation.
  it('carries the enrolment material from the credential route to the authenticator route', async () => {
    const { flow, go } = setup('/setup/credential');
    await screen.findByText('setup/credential: challenge none, enrolment none');
    act(() => {
      flow().enrolment.hold(flow().enrolment.begin(), MATERIAL, 60_000);
    });

    await go('/setup/mfa');

    expect(await screen.findByText('setup/mfa: challenge none, enrolment held')).toBeVisible();
    expect(flow().enrolment.value).toEqual(MATERIAL);
  });

  // Break caught: an authenticator's seed and a continuation grant that follow the person off the setup pages and stay in memory while
  // they sign in, or leave.
  it('lets go of the enrolment material when the person leaves the setup pages', async () => {
    const { flow, go } = setup('/setup/mfa');
    await screen.findByText('setup/mfa: challenge none, enrolment none');
    act(() => {
      flow().enrolment.hold(flow().enrolment.begin(), MATERIAL, 60_000);
    });
    expect(flow().enrolment.status).toBe('held');

    await go('/sign-in');

    expect(await screen.findByText('sign-in: challenge none, enrolment none')).toBeVisible();
    expect(flow().enrolment.value).toBeUndefined();
    expect(document.body.textContent).not.toContain('ABCDEFGHIJKLMNOP');
  });

  // Break caught: a sign-in challenge that follows the person into the setup pages.
  it('lets go of a challenge when the person leaves the sign-in pages', async () => {
    const { flow, go } = setup('/sign-in/mfa');
    await screen.findByText('sign-in/mfa: challenge none, enrolment none');
    act(() => {
      flow().challenge.hold(flow().challenge.begin(), CHALLENGE, 60_000);
    });

    await go('/setup/credential');

    expect(flow().challenge.value).toBeUndefined();
  });

  // Break caught: the material kept in the layout's memory after the person has gone to a page outside the flow altogether.
  it('lets go of everything when the person leaves for a page outside the flow', async () => {
    const { flow, go } = setup('/setup/mfa');
    await screen.findByText('setup/mfa: challenge none, enrolment none');
    act(() => {
      flow().enrolment.hold(flow().enrolment.begin(), MATERIAL, 60_000);
    });

    await go('/');

    expect(await screen.findByRole('heading', { name: 'Start' })).toBeVisible();
    expect(document.body.textContent).not.toContain('ABCDEFGHIJKLMNOP');
  });

  it('lets go of both when the page is hidden', async () => {
    const { flow } = setup('/setup/mfa');
    await screen.findByText('setup/mfa: challenge none, enrolment none');
    act(() => {
      flow().challenge.hold(flow().challenge.begin(), CHALLENGE, 60_000);
      flow().enrolment.hold(flow().enrolment.begin(), MATERIAL, 60_000);
    });

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    expect(flow().challenge.value).toBeUndefined();
    expect(flow().enrolment.value).toBeUndefined();
  });

  it('lets go of both when the session changes (a sign-in lands)', async () => {
    const { flow, store } = setup('/sign-in/mfa');
    await screen.findByText('sign-in/mfa: challenge none, enrolment none');
    act(() => {
      flow().challenge.hold(flow().challenge.begin(), CHALLENGE, 60_000);
    });

    act(() => {
      store.signedIn(sessionFixture());
    });

    expect(flow().challenge.value).toBeUndefined();
  });

  it('refuses the usage of the context outside the layout', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe id="alone" onReady={() => undefined} />)).toThrow(
      /PreSignInFlowLayout/,
    );
    spy.mockRestore();
  });
});
