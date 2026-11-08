import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_HOLD_MS } from '../../../platform/secrets/use-transient-secret';
import {
  errorResponse,
  installFakeApi,
  json,
  type FakeApi,
  type Handler,
} from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { renderApp } from '../../../test-support/render-app';
import { sessionFixture } from '../../../test-support/session-fixture';

/**
 * `/sign-in/mfa` (`completeStaffMfaSignIn`; AC-SLICE-000-02, -03, -79, -80, -123, -126). It holds a challenge and not a session, so it looks like
 * a sign-in page and never like the application. Four refusals, four states, not merged; the lock is told here and nowhere earlier.
 */

const CHALLENGE = {
  challenge_id: '0f9c6a52-3d8e-4b71-9a24-6c1e7d5b8f30',
  expires_at: '2026-10-24T09:05:00.000Z',
  trusted_browser_days: 7,
};
const SIGN_IN = 'POST /auth/staff/sign-in';
const SECOND_STEP = 'POST /auth/staff/sign-in/mfa';
const CODE = '123456';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.useRealTimers();
});

type View = ReturnType<typeof renderApp>;

/** Signs in as a privileged employee and arrives at the second step, with the challenge in memory as it would be. */
async function atTheSecondStep(
  second?: Handler,
  extra: Record<string, Handler> = {},
): Promise<View> {
  api = installFakeApi({
    [SIGN_IN]: () => json(202, CHALLENGE),
    ...(second === undefined ? {} : { [SECOND_STEP]: second }),
    ...extra,
  });
  const view = renderApp('/sign-in');
  await view.user.type(await screen.findByLabelText('Work email (required)'), 'admin@example.test');
  await view.user.type(screen.getByLabelText('Password (required)'), 'a long enough passphrase');
  await view.user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { level: 1, name: 'Enter your code' });
  return view;
}

async function enter(view: View, code = CODE) {
  await view.user.type(screen.getByLabelText('Authenticator code (required)'), code);
  await view.user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
}

const lastBody = async (): Promise<unknown> => api.requests.at(-1)?.clone().json();

describe('the second step of sign-in', () => {
  it('is a page of its own with a labelled code field, a title and one button', async () => {
    await atTheSecondStep();

    expect(document.title).toBe('Enter your code · Melarc Ops Portal');
    const field = screen.getByLabelText('Authenticator code (required)');
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(screen.getByRole('button', { name: 'Verify and sign in' })).toBeVisible();
  });

  // Break caught (ops-portal.md section 7: this page must not render a signed-in shell; no navigation, no user menu, no data): the application
  // shell drawn once the password is accepted, with a code prompt over it. A challenge is not a session.
  it('draws no navigation, no sign-out and nothing of a session', async () => {
    await atTheSecondStep();

    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
    expect(api.requests.filter((request) => request.method === 'GET')).toHaveLength(0);
  });

  // Break caught: a second step that can be opened with nothing to complete, or that keeps a challenge across a reload or a direct visit.
  it('goes back to the first step, replacing its entry, when it is opened without a challenge', async () => {
    api = installFakeApi();
    const { router } = renderApp('/sign-in/mfa');

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(api.requests).toHaveLength(0);
  });

  describe('a code that is accepted (200)', () => {
    // Break caught (AC-SLICE-000-02): a privileged session not established by the second step, or one that needs another read to be believed.
    it('signs the person in on the session the API answered and shows the landing', async () => {
      const view = await atTheSecondStep(() =>
        json(200, sessionFixture({ principal_display_name: 'Kofi Boateng' })),
      );

      await enter(view);

      expect(await within(screen.getByRole('main')).findByText('Kofi Boateng')).toBeVisible();
      expect(view.router.state.location.pathname).toBe('/');
      expect(view.router.state.historyAction).toBe('REPLACE');
      expect(await lastBody()).toEqual({ challenge_id: CHALLENGE.challenge_id, code: CODE });
      expect(api.requests).toHaveLength(2);
    });

    // Break caught: signing in clearing the challenge, and the page, finding none, sending the person back to the first step on their way to the
    // landing (a race that is won or lost by the order of two updates).
    it('goes straight to the landing: it never visits the first step on the way', async () => {
      const view = await atTheSecondStep(() => json(200, sessionFixture()));
      const visited: string[] = [];
      const unsubscribe = view.router.subscribe((state) => {
        visited.push(state.location.pathname);
      });

      await enter(view);
      await screen.findByText('Nothing is waiting.');
      unsubscribe();

      expect(visited).not.toContain('/sign-in');
      expect(visited.at(-1)).toBe('/');
    });

    // Break caught: a body that is not a session being believed.
    it('does not sign anyone in on a body that is not a session', async () => {
      const view = await atTheSecondStep(() => json(200, {}));

      await enter(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'We could not confirm whether the code was accepted.',
      );
      expect(view.router.state.location.pathname).toBe('/sign-in/mfa');
      expect(screen.queryByRole('navigation')).toBeNull();
    });
  });

  describe('four refusals, four states (AC-SLICE-000-79, -80)', () => {
    // Break caught: a wrong code treated as the end of the attempt, or the attempts left shown.
    it('MFA_PROOF_INVALID: says the code was not accepted, empties the field and keeps the attempt open', async () => {
      const view = await atTheSecondStep(() => errorResponse(401, 'MFA_PROOF_INVALID'));

      await enter(view);

      const field = await screen.findByLabelText('Authenticator code (required)');
      await waitFor(() => {
        expect(field).toHaveAccessibleDescription(/That code was not accepted\./);
      });
      expect(field).toHaveValue('');
      expect(field).toHaveFocus();
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: 'Verify and sign in' })).toBeVisible();
      expect(document.body.textContent).not.toMatch(/attempt|left|remain/i);
    });

    // Break caught: a finished attempt that still offers a field, so the person keeps typing codes at a challenge that accepts nothing.
    it('CHALLENGE_UNUSABLE: says the attempt is finished and offers only signing in again', async () => {
      const view = await atTheSecondStep(() => errorResponse(401, 'CHALLENGE_UNUSABLE'));

      await enter(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This attempt is finished. Sign in again.',
      );
      expect(screen.queryByLabelText('Authenticator code (required)')).toBeNull();
      expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
        'href',
        '/sign-in',
      );
    });

    it('CHALLENGE_EXPIRED: says it took too long and offers only signing in again', async () => {
      const view = await atTheSecondStep(() => errorResponse(401, 'CHALLENGE_EXPIRED'));

      await enter(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'That took too long. Sign in again.',
      );
      expect(screen.queryByLabelText('Authenticator code (required)')).toBeNull();
      expect(screen.getByRole('link', { name: 'Sign in again' })).toBeVisible();
    });

    // Break caught (AC-SLICE-000-80): the lock not told to a person who proved the password, or told in words that do not say how long it lasts
    // and what clears it.
    it('CREDENTIAL_LOCKED: says the account is locked for fifteen minutes and that recovering the password clears it', async () => {
      const view = await atTheSecondStep(() => errorResponse(403, 'CREDENTIAL_LOCKED'));

      await enter(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This account is locked for fifteen minutes. Recovering the password clears it.',
      );
      expect(screen.queryByLabelText('Authenticator code (required)')).toBeNull();
    });

    // Break caught (AC-SLICE-000-123): a privileged employee with no authenticator told they typed a wrong code.
    it('MFA_ENROLMENT_REQUIRED: says the authenticator is not set up and where to find the link', async () => {
      const view = await atTheSecondStep(() => errorResponse(403, 'MFA_ENROLMENT_REQUIRED'));

      await enter(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'You cannot sign in until your authenticator is set up. Use the set-up link you were sent.',
      );
      expect(screen.queryByLabelText('Authenticator code (required)')).toBeNull();
      expect(document.body.textContent).not.toMatch(/not accepted/i);
    });

    // Break caught: a refusal that is finished leaving the challenge in memory, so that Back then Forward shows the form again.
    it('forgets the challenge when the attempt is finished: the second step cannot be opened again', async () => {
      const view = await atTheSecondStep(() => errorResponse(401, 'CHALLENGE_UNUSABLE'));
      await enter(view);
      await screen.findByRole('link', { name: 'Sign in again' });

      await view.user.click(screen.getByRole('link', { name: 'Sign in again' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      await act(async () => {
        await view.router.navigate('/sign-in/mfa');
      });

      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      expect(view.router.state.location.pathname).toBe('/sign-in');
    });

    // Break caught: focus left on a button that has gone, so a keyboard user is dropped at the top of the document.
    it('moves focus to the outcome when the form is replaced by it', async () => {
      const view = await atTheSecondStep(() => errorResponse(401, 'CHALLENGE_UNUSABLE'));

      await enter(view);

      const alert = await screen.findByRole('alert');
      await waitFor(() => {
        expect(alert.closest('[tabindex="-1"]')).toHaveFocus();
      });
    });
  });

  describe('what the page checks before it asks', () => {
    // Break caught (AC-SLICE-000-126): a value that is not six digits sent to the server.
    it.each(['', '12345', '123'])('does not send %j, and asks for six digits', async (code) => {
      const view = await atTheSecondStep();

      if (code !== '')
        await view.user.type(screen.getByLabelText('Authenticator code (required)'), code);
      await view.user.click(screen.getByRole('button', { name: 'Verify and sign in' }));

      expect(screen.getByLabelText('Authenticator code (required)')).toHaveAccessibleDescription(
        /Enter the six digits shown in your authenticator app\./,
      );
      expect(screen.getByLabelText('Authenticator code (required)')).toHaveFocus();
      expect(api.requests).toHaveLength(1);
    });

    it('keeps only digits, at most six', async () => {
      const view = await atTheSecondStep();

      await view.user.type(screen.getByLabelText('Authenticator code (required)'), '12 34a56789');

      expect(screen.getByLabelText('Authenticator code (required)')).toHaveValue('123456');
    });
  });

  describe('when it did not get through', () => {
    it('says only to wait, for a rate limit', async () => {
      const view = await atTheSecondStep(() => errorResponse(429, 'RATE_LIMITED'));

      await enter(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Too many attempts. Wait a minute, then try again.',
      );
      expect(screen.getByLabelText('Authenticator code (required)')).toBeVisible();
    });

    it('says the request could not be verified when the Origin was refused', async () => {
      const view = await atTheSecondStep(() => errorResponse(403, 'CSRF_VALIDATION_FAILED'));

      await enter(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The request could not be verified. Reload the page and try again.',
      );
    });

    // Break caught: a lost answer worded as a refused code, when the code may have been used and the session issued.
    it('says it could not confirm whether the code was accepted, and asks for a new code', async () => {
      let attempts = 0;
      const view = await atTheSecondStep(() => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return json(200, sessionFixture());
      });

      await enter(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'We could not confirm whether the code was accepted. Try a new code.',
      );
      expect(screen.getByLabelText('Authenticator code (required)')).toHaveValue('');
      await enter(view, '654321');
      expect(await screen.findByText('Nothing is waiting.')).toBeVisible();
      expect(attempts).toBe(2);
    });

    // Break caught: a second submit while the first is under way: it would count against the challenge's three attempts.
    it('sends once however many times it is pressed', async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const view = await atTheSecondStep(() => gate);
      await view.user.type(screen.getByLabelText('Authenticator code (required)'), CODE);
      const button = screen.getByRole('button', { name: 'Verify and sign in' });

      await view.user.click(button);
      await view.user.click(button);
      await view.user.keyboard('{Enter}');

      expect(api.requests.filter((request) => request.url.endsWith('/mfa'))).toHaveLength(1);
      await act(async () => {
        release(json(200, sessionFixture()));
        await gate;
      });
      await screen.findByText('Nothing is waiting.');
    });
  });

  // Break caught: a challenge kept past the longest a page holds a secret, still offering a form that can only be refused.
  it('treats a challenge held for too long as one that took too long', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await atTheSecondStep();

    act(() => {
      vi.advanceTimersByTime(MAX_HOLD_MS);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That took too long. Sign in again.',
    );
    expect(screen.queryByLabelText('Authenticator code (required)')).toBeNull();
  });

  // Break caught: the challenge or the code in the address, the history state or a storage.
  it('puts the code and the challenge in no address, storage or title', async () => {
    const view = await atTheSecondStep(() => errorResponse(401, 'MFA_PROOF_INVALID'));
    await enter(view);
    await screen.findByLabelText('Authenticator code (required)');

    const everywhere = [
      window.location.href,
      JSON.stringify(window.history.state ?? null),
      JSON.stringify(Object.entries(localStorage)),
      JSON.stringify(Object.entries(sessionStorage)),
      document.cookie,
      document.title,
      api.requests.at(-1)?.url ?? '',
    ].join('\n');
    expect(everywhere).not.toContain(CODE);
    expect(everywhere).not.toContain(CHALLENGE.challenge_id);
  });
});

describeInterfaceStates('The second step of sign-in', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const view = await atTheSecondStep(() => gate);
      await enter(view);

      expect(screen.getByRole('button', { name: 'Verify and sign in' })).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await act(async () => {
        release(json(200, sessionFixture()));
        await gate;
      });
      await screen.findByText('Nothing is waiting.');
    },
  },
  empty: {
    inapplicable:
      'The second step lists nothing, so there is no collection that could be empty or filtered to nothing.',
  },
  'validation error': {
    test: async () => {
      const view = await atTheSecondStep();
      await view.user.click(screen.getByRole('button', { name: 'Verify and sign in' }));

      expect(screen.getByLabelText('Authenticator code (required)')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      expect(screen.getByLabelText('Authenticator code (required)')).toHaveFocus();
    },
  },
  error: {
    test: async () => {
      const view = await atTheSecondStep(() => errorResponse(401, 'CHALLENGE_UNUSABLE'));
      await enter(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This attempt is finished. Sign in again.',
      );
      expect(document.body.textContent).not.toMatch(/Diagnostic text|CHALLENGE_UNUSABLE/);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = await atTheSecondStep(() => {
        attempts += 1;
        return attempts === 1 ? errorResponse(503, 'SETTING_MISSING') : json(200, sessionFixture());
      });
      await enter(view);
      await screen.findByRole('alert');

      await enter(view, '654321');

      expect(await screen.findByText('Nothing is waiting.')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'Completing a sign-in changes no record and carries no version; a challenge that is no longer usable is the finished-attempt state.',
  },
  success: {
    test: async () => {
      const view = await atTheSecondStep(() => json(200, sessionFixture()));
      await enter(view);

      expect(await screen.findByText('Nothing is waiting.')).toBeVisible();
    },
  },
  'permission-restricted': {
    inapplicable:
      'A person holding a challenge holds no permission, so the screen checks none; the server decides whether a session is issued.',
  },
});

describe('the choice to remember the browser (staff-authentication.md section 5.8, AC-SLICE-000-138)', () => {
  const withDays = (days: number): Record<string, Handler> => ({
    [SIGN_IN]: () => json(202, { ...CHALLENGE, trusted_browser_days: days }),
  });

  // Break caught: the choice missing, ticked for the person, or worded with a number of the page's own.
  it('is offered off, with the number of days the challenge carries', async () => {
    await atTheSecondStep(undefined, withDays(3));

    const box = screen.getByRole('checkbox', { name: 'Remember this browser for 3 days' });
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription(/Your password is still asked every time/);
    expect(box).toHaveAccessibleDescription(/Leave this off on a shared computer/);
  });

  it('says one day in the singular, and never a number the challenge did not carry', async () => {
    await atTheSecondStep(undefined, withDays(1));

    expect(screen.getByRole('checkbox', { name: 'Remember this browser for 1 day' })).toBeVisible();
    expect(screen.queryByText(/7 days/)).toBeNull();
  });

  // Break caught: a body that says `false` or carries the field when the person did not choose it, or that drops it when they did.
  it('sends trust_browser only when the person ticked it, and nothing extra otherwise', async () => {
    const view = await atTheSecondStep(() => json(200, sessionFixture()));
    await view.user.click(screen.getByRole('checkbox', { name: /Remember this browser/ }));

    await enter(view);

    expect(await lastBody()).toEqual({
      challenge_id: CHALLENGE.challenge_id,
      code: CODE,
      trust_browser: true,
    });
  });

  it('is left alone by a refused code: the attempt stays open and the choice stays as the person made it', async () => {
    let attempts = 0;
    const view = await atTheSecondStep(() => {
      attempts += 1;
      return attempts === 1 ? errorResponse(422, 'MFA_PROOF_INVALID') : json(200, sessionFixture());
    });
    await view.user.click(screen.getByRole('checkbox', { name: /Remember this browser/ }));
    await enter(view);
    await screen.findByText('That code was not accepted.');

    expect(screen.getByRole('checkbox', { name: /Remember this browser/ })).toBeChecked();
    await enter(view, '654321');
    expect(await lastBody()).toMatchObject({ code: '654321', trust_browser: true });
  });

  // Break caught: a page that shows, stores or sends anywhere the credential it asked for — the cookie is HttpOnly and the page cannot read it.
  it('never reads a credential from the answer (AC-SLICE-000-139): a body that carries one is not drawn or kept', async () => {
    const view = await atTheSecondStep(() =>
      json(
        200,
        { ...sessionFixture(), trusted_browser_token: 'SENTINEL-TRUSTED-CREDENTIAL' },
        { 'Set-Cookie': 'melarc_trusted_browser=SENTINEL-TRUSTED-COOKIE; HttpOnly' },
      ),
    );
    await view.user.click(screen.getByRole('checkbox', { name: /Remember this browser/ }));
    await enter(view);

    await screen.findByText('Nothing is waiting.');
    expect(document.body.innerHTML).not.toContain('SENTINEL');
  });
});

// Break caught (G05 of the audit of 26 October 2026): the second step accepting the answer of a flow that was called off. The person leaves
// while the code is being checked, signs in again and reaches a new second step; the earlier answer then arrives, a success or a refusal that
// ends the attempt, and must neither sign anyone in nor end the challenge that the new step holds. The stand-in network ignores the request's
// signal, as a request that loses the race with its cancellation does.
describe('an answer that arrives after its flow was called off', () => {
  async function checking() {
    let release: (response: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const view = await atTheSecondStep(() => gate);
    await enter(view);
    await waitFor(() => {
      expect(api.requests.filter((request) => request.url.endsWith('/sign-in/mfa'))).toHaveLength(
        1,
      );
    });
    return {
      view,
      gate,
      answer: (response: Response) => {
        release(response);
      },
    };
  }

  const settle = async (gate: Promise<Response>) => {
    await act(async () => {
      await gate;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };

  /** The person leaves while the code is checked and comes back through the first step to a second step of a new challenge. */
  async function backAtANewSecondStep(view: View) {
    await act(async () => {
      await view.router.navigate('/sign-in');
    });
    await view.user.type(
      await screen.findByLabelText('Work email (required)'),
      'admin@example.test',
    );
    await view.user.type(screen.getByLabelText('Password (required)'), 'a long enough passphrase');
    await view.user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { level: 1, name: 'Enter your code' });
  }

  it('does not sign the person in when they have gone to another page', async () => {
    const { view, gate, answer } = await checking();
    await act(async () => {
      await view.router.navigate('/no-such-page');
    });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();

    answer(json(200, sessionFixture({ principal_display_name: 'Kofi Boateng' })));
    await settle(gate);

    expect(view.router.state.location.pathname).toBe('/no-such-page');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('Kofi Boateng')).toBeNull();
  });

  it('does not sign the person in over a newer second step', async () => {
    const { view, gate, answer } = await checking();
    await backAtANewSecondStep(view);

    answer(json(200, sessionFixture({ principal_display_name: 'Kofi Boateng' })));
    await settle(gate);

    expect(view.router.state.location.pathname).toBe('/sign-in/mfa');
    expect(screen.getByLabelText('Authenticator code (required)')).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('Kofi Boateng')).toBeNull();
  });

  // Break caught: a late refusal that ends the attempt clearing the challenge the newer step holds, and the newer step finding none and sending
  // the person back to the first step, or saying that its attempt is over.
  it('does not end the challenge of a newer second step with a late refusal that ends an attempt', async () => {
    const { view, gate, answer } = await checking();
    await backAtANewSecondStep(view);

    answer(errorResponse(422, 'CHALLENGE_UNUSABLE'));
    await settle(gate);

    expect(view.router.state.location.pathname).toBe('/sign-in/mfa');
    expect(screen.getByLabelText('Authenticator code (required)')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says nothing about a wrong code that arrives after the page was hidden', async () => {
    const { gate, answer } = await checking();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    answer(errorResponse(422, 'MFA_PROOF_INVALID'));
    await settle(gate);

    expect(screen.queryByText('That code was not accepted.')).toBeNull();
  });
});
