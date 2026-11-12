import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  errorResponse,
  exceptSummary,
  installFakeApi,
  json,
  requestsTo,
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
 * `/sign-in` (surfaces/ops-portal.md section 7; AC-SLICE-000-01, -02, -04, -77, -81). It is reached with no session and asks the API for none: the
 * only requests it puts on the wire are the sign-in itself. Its one refusal says nothing that is true of one address and not another.
 */

const EMAIL = 'officer@example.test';
const PASSWORD = 'a long enough passphrase';
const CHALLENGE = {
  challenge_id: '0f9c6a52-3d8e-4b71-9a24-6c1e7d5b8f30',
  expires_at: '2026-10-24T09:05:00.000Z',
  trusted_browser_days: 7,
};
const SIGN_IN = 'POST /auth/staff/sign-in';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(handler?: Handler) {
  api = installFakeApi(handler === undefined ? {} : { [SIGN_IN]: handler });
  return renderApp('/sign-in');
}

type User = ReturnType<typeof renderApp>['user'];

async function fillIn(user: User, { email = EMAIL, password = PASSWORD } = {}) {
  await user.type(await screen.findByLabelText('Work email (required)'), email);
  await user.type(screen.getByLabelText('Password (required)'), password);
}

async function signIn(user: User, credentials?: { email?: string; password?: string }) {
  await fillIn(user, credentials);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

const bodyOf = async (index = 0): Promise<unknown> => api.requests[index]?.clone().json();

describe('the sign-in screen', () => {
  it('is a page of its own: a title, one level-one heading, a labelled email and password and one button', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(document.title).toBe('Sign in · Melarc Ops Portal');
    const email = screen.getByLabelText('Work email (required)');
    const password = screen.getByLabelText('Password (required)');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(password).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  // Break caught: the neutral frame gaining a navigation, a user menu, sign-out or session data on the sign-in page.
  it('shows nothing of a signed-in person: no navigation, no sign-out, no session read', async () => {
    open();
    await screen.findByRole('heading', { name: 'Sign in' });

    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(api.requests).toHaveLength(0);
  });

  // Break caught: the email trimmed or changed in the page (the server canonicalises it and the limit is keyed on that form), or the password
  // changed in any way.
  it('sends the email and the password exactly as they were typed, to the sign-in operation alone', async () => {
    const { user } = open(() => json(200, sessionFixture()));

    await signIn(user, { email: ` ${EMAIL} `, password: ` ${PASSWORD}  ` });

    await screen.findByRole('heading', { level: 1, name: 'My work' });
    // The sign-in is the one request of the person's own; the shell then reads the queue summary for the menu (task C1).
    expect(exceptSummary(api.requests)).toHaveLength(1);
    const request = api.requests[0];
    expect(request?.method).toBe('POST');
    expect(new URL(request?.url ?? '').pathname).toBe('/api/v1/auth/staff/sign-in');
    expect(await bodyOf()).toEqual({ email: ` ${EMAIL} `, password: ` ${PASSWORD}  ` });
    expect(request?.headers.has('Authorization')).toBe(false);
  });

  describe('an ordinary employee’s sign-in (200)', () => {
    // Break caught (AC-SLICE-000-01): a session answered and not used, or one that needs a second read to be believed.
    it('signs the person in on the session the API answered, shows the landing and does not ask again who is signed in', async () => {
      const { user, router } = open(() =>
        json(200, sessionFixture({ principal_display_name: 'Ama Mensah' })),
      );

      await signIn(user);

      expect(await within(screen.getByRole('main')).findByText('Ama Mensah')).toBeVisible();
      expect(router.state.location.pathname).toBe('/');
      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeVisible();
      expect(exceptSummary(api.requests)).toHaveLength(1);
      expect(requestsTo(api, '/auth/session')).toHaveLength(0);
    });

    // Break caught: a sign-in that leaves a history entry the Back button returns to, with the form that held the password.
    it('replaces the sign-in entry, so the Back button does not return to the form', async () => {
      const { user, router } = open(() => json(200, sessionFixture()));

      await signIn(user);
      await screen.findByRole('heading', { level: 1, name: 'My work' });

      expect(router.state.historyAction).toBe('REPLACE');
    });

    // Break caught: a body that is not a session being believed and a person signed in on it.
    it.each([
      ['an empty object', {}],
      ['a session of another kind of principal', sessionFixture({ principal_type: 'VENDOR' })],
      ['a session that has ended', sessionFixture({ state: 'TERMINATED' })],
      ['a challenge', CHALLENGE],
    ])('does not sign anyone in on %s, and says it could not finish', async (_name, body) => {
      const { user, router } = open(() => json(200, body));

      await signIn(user);

      expect(
        await screen.findByText(
          'The server could not be reached or could not finish this. Try again.',
        ),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe('/sign-in');
      expect(screen.queryByRole('navigation')).toBeNull();
    });
  });

  describe('a privileged employee on a remembered browser (200)', () => {
    // Break caught (AC-SLICE-000-134): a 200 for a privileged employee refused because only a 202 was expected of them, or a page that goes
    // on to a second step for which there is no challenge.
    it('signs the person in on the session the API answered, with no second step', async () => {
      const { user, router } = open(() =>
        json(
          200,
          sessionFixture({
            principal_display_name: 'Kofi Boateng',
            permissions: ['staff.read', 'staff.session.revoke'],
          }),
        ),
      );

      await signIn(user);

      expect(await within(screen.getByRole('main')).findByText('Kofi Boateng')).toBeVisible();
      expect(router.state.location.pathname).toBe('/');
      expect(exceptSummary(api.requests)).toHaveLength(1);
      expect(requestsTo(api, '/auth/session')).toHaveLength(0);
      expect(screen.queryByRole('heading', { name: 'Enter your code' })).toBeNull();
    });
  });

  describe('a privileged employee’s sign-in (202)', () => {
    // Break caught (AC-SLICE-000-02): the application shell, or any signed-in thing, drawn on a challenge. A challenge is not a session.
    it('goes to the second step and draws no session, navigation or sign-out', async () => {
      const { user, router } = open(() => json(202, CHALLENGE));

      await signIn(user);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Enter your code' }),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe('/sign-in/mfa');
      expect(screen.queryByRole('navigation')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
      expect(screen.queryByRole('heading', { level: 1, name: 'My work' })).toBeNull();
      expect(api.requests).toHaveLength(1);
    });

    // Break caught: a challenge, or the password that earned it, carried in the address, the history state or a storage.
    it('carries the challenge in memory only: not in the address, the history state or a storage', async () => {
      const { user, router } = open(() => json(202, CHALLENGE));

      await signIn(user);
      await screen.findByRole('heading', { name: 'Enter your code' });

      const everywhere = [
        window.location.href,
        JSON.stringify(window.history.state ?? null),
        JSON.stringify(router.state.location),
        JSON.stringify(Object.entries(localStorage)),
        JSON.stringify(Object.entries(sessionStorage)),
        document.cookie,
        document.title,
      ].join('\n');
      expect(everywhere).not.toContain(CHALLENGE.challenge_id);
      expect(everywhere).not.toContain(PASSWORD);
    });

    // Break caught: a malformed challenge taken for one and a person sent to a second step that cannot succeed.
    it.each([
      ['an empty object', {}],
      ['a challenge id that is not a uuid', { ...CHALLENGE, challenge_id: 'abc' }],
      ['a session', sessionFixture()],
    ])('does not go on with %s', async (_name, body) => {
      const { user, router } = open(() => json(202, body));

      await signIn(user);

      expect(
        await screen.findByText(
          'The server could not be reached or could not finish this. Try again.',
        ),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe('/sign-in');
    });
  });

  describe('a refused sign-in', () => {
    // Break caught (AC-SLICE-000-04, -91): a refusal worded by cause. Every cause the API has is one answer, and the page has one sentence for it.
    it('says one thing for a wrong password, an unknown address, an ineligible identity and a locked one, and keeps the email', async () => {
      const words = new Set<string>();
      for (const cause of [
        'WRONG_PASSWORD',
        'UNKNOWN_PRINCIPAL',
        'INELIGIBLE_PRINCIPAL',
        'LOCKED_OUT',
      ]) {
        const { user, unmount } = open(() => errorResponse(401, 'INVALID_CREDENTIALS', { cause }));
        await signIn(user);

        const alert = await screen.findByRole('alert');
        words.add(alert.textContent);
        expect(screen.getByLabelText('Work email (required)')).toHaveValue(EMAIL);
        unmount();
        api.restore();
      }

      expect([...words]).toEqual(['The email or password is not correct.']);
      api = installFakeApi();
    });

    // Break caught: the typed password left in the field after a refusal, to be read from the screen or sent again by accident.
    it('empties the password, keeps the email and puts the cursor in the password', async () => {
      const { user } = open(() => errorResponse(401, 'INVALID_CREDENTIALS'));

      await signIn(user);
      await screen.findByRole('alert');

      expect(screen.getByLabelText('Password (required)')).toHaveValue('');
      expect(screen.getByLabelText('Password (required)')).toHaveFocus();
      expect(document.body.textContent).not.toContain(PASSWORD);
    });

    // Break caught (ops-portal.md section 7: there is no lockout state on this page): a lock announced at the password step, which turns the
    // screen into the account-existence oracle it exists not to be. The API never says it here; if it ever did, the page would not repeat it.
    it('has no locked state: a lock answered at the password step reads as a wrong password', async () => {
      const { user } = open(() => errorResponse(403, 'CREDENTIAL_LOCKED'));

      await signIn(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The email or password is not correct.',
      );
      expect(document.body.textContent).not.toMatch(/lock/i);
    });

    // Break caught: a refusal the page did not expect worded as the thing it was (a missing record, a state conflict, a permission), which
    // says something about the address.
    it.each([
      [404, 'NOT_FOUND'],
      [409, 'STATE_CONFLICT'],
      [403, 'PERMISSION_DENIED'],
      [422, 'RULE_VIOLATION'],
    ])('reads an unexpected %i %s as a wrong password', async (status, code) => {
      const { user } = open(() => errorResponse(status, code));

      await signIn(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The email or password is not correct.',
      );
    });

    // Break caught (AC-SLICE-000-81): a rate limit that says more than to wait: which address, how many attempts, or why.
    it('says only that there were too many attempts and to wait a minute', async () => {
      const { user } = open(() => errorResponse(429, 'RATE_LIMITED'));

      await signIn(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Too many attempts. Wait a minute, then try again.',
      );
    });

    it('says the request could not be verified when the Origin was refused', async () => {
      const { user } = open(() => errorResponse(403, 'CSRF_VALIDATION_FAILED'));

      await signIn(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The request could not be verified. Reload the page and try again.',
      );
    });

    // Break caught: the server's diagnostic text shown to a person who is not signed in.
    it('never shows the server’s message or code', async () => {
      const { user } = open(() => errorResponse(401, 'INVALID_CREDENTIALS'));

      await signIn(user);
      await screen.findByRole('alert');

      expect(document.body.textContent).not.toMatch(/Diagnostic text|INVALID_CREDENTIALS/);
    });
  });

  describe('what the page checks before it asks', () => {
    // Break caught: an empty field sent to the server, or an error that is not tied to its field and moved to.
    it('asks for the email and the password when they are empty, sends nothing and goes to the first', async () => {
      const { user } = open();

      await user.click(await screen.findByRole('button', { name: 'Sign in' }));

      const email = screen.getByLabelText('Work email (required)');
      expect(email).toHaveAccessibleDescription('Enter your work email address.');
      expect(email).toHaveAttribute('aria-invalid', 'true');
      expect(email).toHaveFocus();
      expect(screen.getByLabelText('Password (required)')).toHaveAccessibleDescription(
        'Enter your password.',
      );
      expect(api.requests).toHaveLength(0);
    });

    it('asks for the password alone when only it is empty', async () => {
      const { user } = open();
      await user.type(await screen.findByLabelText('Work email (required)'), EMAIL);

      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(screen.getByLabelText('Password (required)')).toHaveFocus();
      expect(api.requests).toHaveLength(0);
    });

    // Break caught: a password over the schema's bound sent to be hashed.
    it('does not send a password of more than 128 characters, and does not echo it', async () => {
      const { user } = open();
      await fillIn(user, { password: 'x'.repeat(129) });

      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(screen.getByLabelText('Password (required)')).toHaveAccessibleDescription(
        'A password has at most 128 characters.',
      );
      expect(api.requests).toHaveLength(0);
      expect(document.body.textContent).not.toContain('x'.repeat(129));
    });

    it('sends a short password, because it is simply a wrong one and the schema has no minimum', async () => {
      const { user } = open(() => errorResponse(401, 'INVALID_CREDENTIALS'));

      await signIn(user, { password: 'abc' });

      await screen.findByRole('alert');
      expect(api.requests).toHaveLength(1);
    });

    // Break caught: a field error from the server shown as the server's words, or on the wrong field.
    it('shows a refusal of the email field on the email, in its own words', async () => {
      const { user } = open(() =>
        errorResponse(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'body', pointer: '/email', rule: 'format' }],
        }),
      );

      await signIn(user);

      const email = await screen.findByLabelText('Work email (required)');
      await waitFor(() => {
        expect(email).toHaveAccessibleDescription('Enter your work email address.');
      });
      expect(email).toHaveFocus();
    });
  });

  describe('while it is under way and when it did not get through', () => {
    // Break caught (S0.39a): a second submit while the first is under way, which would double-count a wrong password toward the lockout.
    it('sends once however many times it is pressed, and says it is busy', async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const { user } = open(() => gate);
      await fillIn(user);
      const button = screen.getByRole('button', { name: 'Sign in' });

      await user.click(button);
      await user.click(button);
      await user.keyboard('{Enter}');

      expect(api.requests).toHaveLength(1);
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(button.closest('form')).toHaveAttribute('aria-busy', 'true');

      await act(async () => {
        release(json(200, sessionFixture()));
        await gate;
      });
      await screen.findByRole('heading', { level: 1, name: 'My work' });
    });

    // Break caught: a lost answer worded as a refusal of the password, which sends a person to mistrust a password that may be right.
    it('says the server could not be reached, and lets the same form be sent again', async () => {
      let attempts = 0;
      const { user } = open(() => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return json(200, sessionFixture());
      });

      await signIn(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The server could not be reached or could not finish this. Try again.',
      );
      expect(screen.getByLabelText('Work email (required)')).toHaveValue(EMAIL);
      await user.type(screen.getByLabelText('Password (required)'), PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
      expect(attempts).toBe(2);
    });

    it('shows the request id as a reference when the server failed, and only then', async () => {
      const { user } = open(() => errorResponse(500, 'SETTING_MISSING'));

      await signIn(user);

      expect(await screen.findByRole('alert')).toHaveTextContent('Reference: req-test-1');
    });

    it('shows no reference for a refused password', async () => {
      const { user } = open(() => errorResponse(401, 'INVALID_CREDENTIALS'));

      await signIn(user);

      expect(await screen.findByRole('alert')).not.toHaveTextContent('Reference');
    });
  });

  // Break caught: the password anywhere but the field and the one request body.
  it('puts the password in no address, header, storage or cookie', async () => {
    const { user } = open(() => errorResponse(401, 'INVALID_CREDENTIALS'));

    await signIn(user);
    await screen.findByRole('alert');

    const request = api.requests[0];
    expect(request?.url).not.toContain(PASSWORD);
    expect([...(request?.headers.values() ?? [])].join('\n')).not.toContain(PASSWORD);
    expect(window.location.href).not.toContain(PASSWORD);
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(PASSWORD);
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(PASSWORD);
    expect(document.cookie).not.toContain(PASSWORD);
  });
});

describeInterfaceStates('The sign-in screen', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const { user } = open(() => gate);
      await signIn(user);

      expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute('aria-busy', 'true');
      expect(screen.queryByRole('heading', { level: 1, name: 'My work' })).toBeNull();

      await act(async () => {
        release(json(200, sessionFixture()));
        await gate;
      });
      await screen.findByRole('heading', { level: 1, name: 'My work' });
    },
  },
  empty: {
    inapplicable:
      'The sign-in screen lists nothing, so there is no collection that could be empty or filtered to nothing.',
  },
  'validation error': {
    test: async () => {
      const { user } = open();
      await user.click(await screen.findByRole('button', { name: 'Sign in' }));

      expect(screen.getByLabelText('Work email (required)')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      expect(screen.getByLabelText('Work email (required)')).toHaveFocus();
    },
  },
  error: {
    test: async () => {
      const { user } = open(() => errorResponse(401, 'INVALID_CREDENTIALS'));
      await signIn(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The email or password is not correct.',
      );
      expect(document.body.textContent).not.toMatch(/Diagnostic text|INVALID_CREDENTIALS/);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(() => {
        attempts += 1;
        return attempts === 1 ? errorResponse(503, 'SETTING_MISSING') : json(200, sessionFixture());
      });
      await signIn(user);
      await screen.findByRole('alert');

      await user.type(screen.getByLabelText('Password (required)'), PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(await screen.findByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
      expect(attempts).toBe(2);
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'Signing in changes no record and carries no version, so there is nothing to conflict on or go stale.',
  },
  success: {
    test: async () => {
      const { user, router } = open(() => json(200, sessionFixture()));
      await signIn(user);

      expect(await screen.findByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
      expect(router.state.location.pathname).toBe('/');
    },
  },
  'permission-restricted': {
    inapplicable:
      'A person who is not signed in holds no permission, so the screen checks none; the server decides who may sign in.',
  },
});

// Break caught (G05 of the audit of 26 October 2026): an answer whose flow was called off was still accepted. A sign-in whose request is on its
// way when the person leaves (or the page is hidden, or another sign-in begins) must not sign anyone in, navigate or show a word when the
// answer arrives: the flow decides, and the request's own signal is not relied on (the stand-in network here ignores it, as a request that
// loses the race with its cancellation does).
describe('an answer that arrives after its flow was called off', () => {
  const SIGNED_IN = sessionFixture({ principal_display_name: 'Kofi Boateng' });

  async function waiting() {
    let release: (response: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const view = open(() => gate);
    await signIn(view.user);
    await waitFor(() => {
      expect(api.requests).toHaveLength(1);
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

  it('does not sign the person in, or take them to the landing, when they have gone to another page', async () => {
    const { view, gate, answer } = await waiting();
    await act(async () => {
      await view.router.navigate('/no-such-page');
    });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();

    answer(json(200, SIGNED_IN));
    await settle(gate);

    expect(view.router.state.location.pathname).toBe('/no-such-page');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('Kofi Boateng')).toBeNull();
    expect(api.requests).toHaveLength(1);
  });

  it('does not sign the person in when the page was hidden before the answer arrived, and keeps the password out of the form', async () => {
    const { view, gate, answer } = await waiting();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    answer(json(200, SIGNED_IN));
    await settle(gate);

    expect(view.router.state.location.pathname).toBe('/sign-in');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByLabelText('Password (required)')).toHaveValue('');
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });

  // Break caught: a refusal of a request nobody is waiting for being worded on the screen the person is on now.
  it('says nothing about a failure of the flow that was called off', async () => {
    const { gate, answer } = await waiting();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    answer(errorResponse(422, 'INVALID_CREDENTIALS'));
    await settle(gate);

    expect(screen.queryByText('The email or password is not correct.')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Break caught: the answer of an earlier attempt signing in, or replacing the challenge of, a later one. The earlier sign-in is slow; the
  // person leaves, comes back, signs in again and reaches the second step; the earlier success then arrives and must change nothing.
  it('does not let the late success of an earlier sign-in take over a newer one', async () => {
    let release: (response: Response) => void = () => undefined;
    const first = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const view = open(() => {
      attempts += 1;
      return attempts === 1 ? first : json(202, CHALLENGE);
    });
    await signIn(view.user);
    await waitFor(() => {
      expect(api.requests).toHaveLength(1);
    });
    await act(async () => {
      await view.router.navigate('/no-such-page');
    });
    await act(async () => {
      await view.router.navigate('/sign-in');
    });
    await signIn(view.user);
    expect(await screen.findByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();

    release(json(200, SIGNED_IN));
    await settle(first);

    expect(view.router.state.location.pathname).toBe('/sign-in/mfa');
    expect(screen.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('Kofi Boateng')).toBeNull();
  });

  it('still signs the person in when nothing happened in between', async () => {
    const { answer } = await waiting();

    answer(json(200, SIGNED_IN));

    expect(await within(await screen.findByRole('main')).findByText('Kofi Boateng')).toBeVisible();
  });
});
