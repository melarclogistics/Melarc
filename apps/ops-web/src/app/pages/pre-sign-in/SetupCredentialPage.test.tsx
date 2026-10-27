import { act, screen, waitFor } from '@testing-library/react';
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

/**
 * `/setup/credential` (`completeStaffCredentialSetup`; AC-SLICE-000-87, -88, -92, -33). An employee sets their own first password from the grant a
 * message carries in the fragment of its link. A grant is not a session: no shell, no navigation. Opening the page redeems nothing.
 */

const GRANT = 'kJ3x9Qm2-Zt7_VbN4wYc8LdR1pHs5GfXaUe6OiTjA0E';
const PASSWORD = 'a long enough passphrase';
const SETUP = 'POST /auth/staff/setup/credential';
const URI = 'otpauth://totp/Melarc:synthetic.officer?secret=ABCDEFGHIJKLMNOP234567&issuer=Melarc';
const PRIVILEGED = {
  authentication_ready: false,
  mfa_enrolment_required: true,
  mfa_provisioning: { otpauth_uri: URI },
  mfa_setup_token: 'synthetic-continuation-grant',
};
const THE_ONE_ERROR =
  'This link cannot be used. It may have expired, or it may already have been used.';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.useRealTimers();
});

function open(entry = `/setup/credential#token=${GRANT}`, handler?: Handler) {
  api = installFakeApi(handler === undefined ? {} : { [SETUP]: handler });
  return renderApp(entry);
}

type View = ReturnType<typeof renderApp>;

async function setPassword(view: View, password = PASSWORD) {
  await view.user.type(await screen.findByLabelText('New password (required)'), password);
  await view.user.click(screen.getByRole('button', { name: 'Set password' }));
}

const bodyOf = async (): Promise<unknown> => api.requests[0]?.clone().json();

describe('the credential setup screen', () => {
  it('is a page of its own: a title, one level-one heading, a labelled new password stating the rule, one button', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set your password' }),
    ).toBeVisible();
    expect(document.title).toBe('Set your password · Melarc Ops Portal');
    const field = screen.getByLabelText('New password (required)');
    expect(field).toHaveAttribute('autocomplete', 'new-password');
    expect(field).toHaveAccessibleDescription(
      '12 to 128 characters. Spaces are allowed. Nothing else is required.',
    );
    expect(screen.getByRole('button', { name: 'Show password' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Set password' })).toBeVisible();
  });

  // Break caught (GBT-W16): the page sending the grant to a remote origin or keeping a referrer.
  it('asks the browser to send no referrer while it is open, and not afterwards', async () => {
    const { unmount } = open();
    await screen.findByRole('heading', { name: 'Set your password' });

    expect(document.head.querySelector('meta[name="referrer"]')).toHaveAttribute(
      'content',
      'no-referrer',
    );

    unmount();
    await waitFor(() => {
      expect(document.head.querySelector('meta[name="referrer"]')).toBeNull();
    });
  });

  // Break caught (ops-portal.md section 7: no application shell; a grant is not a session): a shell, a navigation or a session read around a
  // page that is reached by a grant.
  it('draws no navigation or sign-out and asks for no session', async () => {
    open();
    await screen.findByRole('heading', { name: 'Set your password' });

    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(api.requests).toHaveLength(0);
  });

  describe('the link (GBT-W16)', () => {
    // Break caught: a page that redeems the grant by being opened, which a mail scanner or a preview would do for the person.
    it('redeems nothing by being opened: no request is sent until the person acts', async () => {
      open();
      await screen.findByRole('heading', { name: 'Set your password' });

      expect(api.requests).toHaveLength(0);
    });

    // Break caught: the grant left in the address after it was read.
    it('removes the fragment from the address, replacing the entry', async () => {
      const { router } = open();
      await screen.findByRole('heading', { name: 'Set your password' });

      expect(router.state.location.hash).toBe('');
      expect(router.state.historyAction).toBe('REPLACE');
      expect(window.location.href).not.toContain(GRANT);
    });

    // Break caught: the grant carried in the body of one request and nowhere else: not the address, a header or a query.
    it('sends the grant in the body of the one request, and not in its address or headers', async () => {
      const view = open(undefined, () => json(200, { authentication_ready: true }));

      await setPassword(view);

      await screen.findByText('Your password is set');
      expect(api.requests).toHaveLength(1);
      const request = api.requests[0];
      expect(request?.method).toBe('POST');
      expect(request?.url).not.toContain(GRANT);
      expect([...(request?.headers.values() ?? [])].join('\n')).not.toContain(GRANT);
      expect(await bodyOf()).toEqual({ setup_token: GRANT, password: PASSWORD });
    });

    // Break caught: a reload keeping the grant because it was kept for convenience.
    it('finds no grant on a reload, and says the link cannot be used', async () => {
      const first = open();
      await screen.findByRole('heading', { name: 'Set your password' });
      const address = first.router.state.location.pathname + first.router.state.location.hash;
      first.unmount();
      api.restore();

      open(address);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'This link cannot be used' }),
      ).toBeVisible();
      expect(screen.queryByLabelText('New password (required)')).toBeNull();
    });
  });

  describe('a link that carries no usable grant', () => {
    // Break caught: a form shown for a link that has nothing to redeem, or an error that says which way the link failed.
    it.each([
      ['no fragment', '/setup/credential'],
      ['an empty token', '/setup/credential#token='],
      ['another name', '/setup/credential#id=abc'],
      ['two tokens', '/setup/credential#token=a&token=b'],
      ['a token with a control character', '/setup/credential#token=%00'],
    ])('shows the one error for %s, no form, and sends nothing', async (_name, entry) => {
      const { router } = open(entry);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'This link cannot be used' }),
      ).toBeVisible();
      expect(screen.getByText(THE_ONE_ERROR)).toBeVisible();
      expect(screen.queryByLabelText('New password (required)')).toBeNull();
      expect(screen.getByRole('link', { name: 'Go to sign-in' })).toHaveAttribute(
        'href',
        '/sign-in',
      );
      expect(api.requests).toHaveLength(0);
      expect(router.state.location.hash).toBe('');
    });

    // Break caught: the instant before the fragment is taken being drawn as the error.
    it('does not flash the error while a good link is being read', async () => {
      const seen: string[] = [];
      const { container } = open();
      const observer = new MutationObserver(() => {
        seen.push(container.textContent);
      });
      observer.observe(container, { childList: true, subtree: true, characterData: true });

      await screen.findByRole('heading', { name: 'Set your password' });
      observer.disconnect();

      expect(seen.some((text) => text.includes('This link cannot be used'))).toBe(false);
    });

    // Break caught: a grant held longer than a page may hold a secret.
    it('drops the grant when the time a page may hold a secret is up, and shows the one error', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      open();
      await screen.findByRole('heading', { name: 'Set your password' });

      act(() => {
        vi.advanceTimersByTime(MAX_HOLD_MS);
      });

      expect(
        await screen.findByRole('heading', { name: 'This link cannot be used' }),
      ).toBeVisible();
      expect(screen.queryByLabelText('New password (required)')).toBeNull();
    });
  });

  describe('what the page checks before it asks (AC-SLICE-000-87)', () => {
    // Break caught: a password outside 12 to 128 sent to the server, or an error that echoes it.
    it.each([
      ['11 characters', 'a'.repeat(11)],
      ['129 characters', 'a'.repeat(129)],
      ['four ligatures that normalise to twelve', 'ﬃ'.repeat(4)],
    ])('does not send %s, states the rule and does not echo the value', async (_name, password) => {
      const view = open();

      await setPassword(view, password);

      const field = screen.getByLabelText('New password (required)');
      expect(field).toHaveAccessibleDescription(
        /Use 12 to 128 characters\. Spaces are allowed, and nothing else is required\./,
      );
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field).toHaveFocus();
      expect(api.requests).toHaveLength(0);
      expect(document.body.textContent).not.toContain(password);
    });

    it('sends a password of twelve lower-case letters, and one of 128 characters with spaces', async () => {
      for (const password of ['abcdefghijkl', `${'word '.repeat(25)}abc`]) {
        expect(Array.from(password).length).toBeGreaterThanOrEqual(12);
        expect(Array.from(password).length).toBeLessThanOrEqual(128);
        const view = open(undefined, () => json(200, { authentication_ready: true }));
        await setPassword(view, password);
        await screen.findByText('Your password is set');
        expect(await bodyOf()).toEqual({ setup_token: GRANT, password });
        view.unmount();
        api.restore();
      }
      api = installFakeApi();
    });

    // Break caught: a password trimmed or changed by the page.
    it('sends the password exactly as it was typed, spaces included', async () => {
      const view = open(undefined, () => json(200, { authentication_ready: true }));

      await setPassword(view, `  ${PASSWORD}  `);

      await screen.findByText('Your password is set');
      expect(await bodyOf()).toEqual({ setup_token: GRANT, password: `  ${PASSWORD}  ` });
    });
  });

  describe('an ordinary employee (authentication_ready)', () => {
    // Break caught: success claiming a session, or not saying what comes next.
    it('says the password is set and that the next step is to sign in, with no session', async () => {
      const view = open(undefined, () => json(200, { authentication_ready: true }));

      await setPassword(view);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Your password is set' }),
      ).toBeVisible();
      expect(screen.getByText('The next step is to sign in.')).toBeVisible();
      expect(screen.getByRole('link', { name: 'Go to sign-in' })).toHaveAttribute(
        'href',
        '/sign-in',
      );
      expect(screen.queryByLabelText('New password (required)')).toBeNull();
      expect(screen.queryByRole('navigation')).toBeNull();
      expect(document.body.textContent).not.toContain(PASSWORD);
    });

    // Break caught: the form left on the screen with the password in it after the grant has been used.
    it('removes the form and the password with it, and moves focus to the outcome', async () => {
      const view = open(undefined, () => json(200, { authentication_ready: true }));

      await setPassword(view);

      const heading = await screen.findByRole('heading', { name: 'Your password is set' });
      await waitFor(() => {
        expect(heading.closest('div[tabindex="-1"]')).toHaveFocus();
      });
      expect(document.querySelectorAll('input')).toHaveLength(0);
    });

    // Break caught: a used grant kept in memory after it has done its work.
    it('forgets the grant: a second submit is not possible, and the address holds nothing', async () => {
      const view = open(undefined, () => json(200, { authentication_ready: true }));

      await setPassword(view);
      await screen.findByText('Your password is set');

      expect(screen.queryByRole('button', { name: 'Set password' })).toBeNull();
      expect(window.location.href).not.toContain(GRANT);
    });
  });

  describe('a privileged employee', () => {
    // Break caught: success claimed for someone who is not ready, or the authenticator step not reached.
    it('goes on to set up an authenticator, which is not yet done', async () => {
      const view = open(undefined, () => json(200, PRIVILEGED));

      await setPassword(view);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Set up your authenticator' }),
      ).toBeVisible();
      expect(view.router.state.location.pathname).toBe('/setup/mfa');
      expect(view.router.state.historyAction).toBe('REPLACE');
      expect(screen.queryByText('Your password is set')).toBeNull();
      expect(screen.queryByRole('navigation')).toBeNull();
    });

    // Break caught: using the grant up emptying it, and the page calling the link bad for the instant before the route changes.
    it('does not say the link cannot be used on its way to the authenticator', async () => {
      const seen: string[] = [];
      const view = open(undefined, () => json(200, PRIVILEGED));
      const observer = new MutationObserver(() => {
        seen.push(view.container.textContent);
      });
      observer.observe(view.container, { childList: true, subtree: true, characterData: true });

      await setPassword(view);
      await screen.findByRole('heading', { name: 'Set up your authenticator' });
      observer.disconnect();

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((text) => text.includes('This link cannot be used'))).toBe(false);
    });

    // Break caught: an answer that says "not ready" without what is needed to go on being turned into a picture of nothing.
    it.each([
      ['no provisioning', { ...PRIVILEGED, mfa_provisioning: undefined }],
      ['no continuation grant', { ...PRIVILEGED, mfa_setup_token: null }],
      ['not enrolment-required', { ...PRIVILEGED, mfa_enrolment_required: false }],
    ])('does not go on with %s, and says it could not confirm', async (_name, body) => {
      const view = open(undefined, () => json(200, body));

      await setPassword(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'We could not confirm whether your password was set.',
      );
      expect(view.router.state.location.pathname).toBe('/setup/credential');
    });
  });

  describe('a refusal', () => {
    // Break caught (ops-portal.md section 7): a refusal that says which of the ways a grant can be bad, or that re-opens the form.
    it('shows the one error for a grant that cannot be used, removes the form and forgets the grant', async () => {
      const view = open(undefined, () => errorResponse(401, 'SETUP_GRANT_INVALID'));

      await setPassword(view);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'This link cannot be used' }),
      ).toBeVisible();
      expect(screen.getByText(THE_ONE_ERROR)).toBeVisible();
      expect(screen.queryByLabelText('New password (required)')).toBeNull();
      expect(document.body.textContent).not.toContain(PASSWORD);
      expect(document.body.textContent).not.toMatch(/consumed|superseded|unknown|Diagnostic text/i);
    });

    it('moves focus to the error when the form is replaced by it', async () => {
      const view = open(undefined, () => errorResponse(401, 'SETUP_GRANT_INVALID'));

      await setPassword(view);

      const heading = await screen.findByRole('heading', { name: 'This link cannot be used' });
      await waitFor(() => {
        expect(heading.closest('div[tabindex="-1"]')).toHaveFocus();
      });
    });

    // Break caught: a refused password echoed, or left in the field for the next try.
    it('shows a refusal of the password on the password in the rule’s words, and leaves the grant to try again', async () => {
      let attempts = 0;
      const view = open(undefined, () => {
        attempts += 1;
        return attempts === 1
          ? errorResponse(400, 'VALIDATION_FAILED', {
              violations: [{ in: 'body', pointer: '/password', rule: 'minLength' }],
            })
          : json(200, { authentication_ready: true });
      });

      await setPassword(view);

      const field = await screen.findByLabelText('New password (required)');
      await waitFor(() => {
        expect(field).toHaveAccessibleDescription(/Use 12 to 128 characters\./);
      });
      expect(field).toHaveFocus();
      expect(document.body.textContent).not.toContain(PASSWORD);

      await view.user.type(field, PASSWORD);
      await view.user.click(screen.getByRole('button', { name: 'Set password' }));
      expect(await screen.findByText('Your password is set')).toBeVisible();
      expect(attempts).toBe(2);
      expect(await api.requests[1]?.clone().json()).toEqual({
        setup_token: GRANT,
        password: PASSWORD,
      });
    });

    it('says only to wait, for a rate limit, and keeps the form', async () => {
      const view = open(undefined, () => errorResponse(429, 'RATE_LIMITED'));

      await setPassword(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Too many attempts. Wait a minute, then try again.',
      );
      expect(screen.getByLabelText('New password (required)')).toBeVisible();
    });

    it('says the request could not be verified when the Origin was refused', async () => {
      const view = open(undefined, () => errorResponse(403, 'CSRF_VALIDATION_FAILED'));

      await setPassword(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The request could not be verified. Reload the page and try again.',
      );
    });

    // Break caught: a lost answer worded as a failure or as a success, when the single-use grant may have been used.
    it('says it could not confirm whether the password was set, keeps the grant, and the same grant can be sent again', async () => {
      let attempts = 0;
      const view = open(undefined, () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return json(200, { authentication_ready: true });
      });

      await setPassword(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'We could not confirm whether your password was set. Try again. If the link is then refused, try signing in.',
      );
      expect(screen.getByLabelText('New password (required)')).toHaveValue('');
      await view.user.type(screen.getByLabelText('New password (required)'), PASSWORD);
      await view.user.click(screen.getByRole('button', { name: 'Set password' }));
      expect(await screen.findByText('Your password is set')).toBeVisible();
      expect(await api.requests[1]?.clone().json()).toEqual({
        setup_token: GRANT,
        password: PASSWORD,
      });
    });

    // Break caught: a second submit while the first is under way: two completions of one single-use grant.
    it('sends once however many times it is pressed', async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const view = open(undefined, () => gate);
      await view.user.type(await screen.findByLabelText('New password (required)'), PASSWORD);
      const button = screen.getByRole('button', { name: 'Set password' });

      await view.user.click(button);
      await view.user.click(button);
      await view.user.keyboard('{Enter}');

      expect(api.requests).toHaveLength(1);
      await act(async () => {
        release(json(200, { authentication_ready: true }));
        await gate;
      });
      await screen.findByText('Your password is set');
    });

    // Break caught: an unexpected body taken for success.
    it.each([
      ['an empty object', {}],
      ['a session', { id: 'x', principal_type: 'STAFF' }],
    ])('does not say the password is set for %s', async (_name, body) => {
      const view = open(undefined, () => json(200, body));

      await setPassword(view);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'We could not confirm whether your password was set.',
      );
      expect(screen.queryByText('Your password is set')).toBeNull();
    });
  });

  // Break caught: the password or the grant anywhere but the field and the one request body.
  it('puts the password and the grant in no storage, cookie or title, and no log', async () => {
    const consoleOutput: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map((arg) => JSON.stringify(arg)).join(' '));
      });
    }
    const view = open(undefined, () => errorResponse(401, 'SETUP_GRANT_INVALID'));

    await setPassword(view);
    await screen.findByRole('heading', { name: 'This link cannot be used' });

    const everywhere = [
      JSON.stringify(Object.entries(localStorage)),
      JSON.stringify(Object.entries(sessionStorage)),
      document.cookie,
      document.title,
      window.location.href,
      JSON.stringify(window.history.state ?? null),
      consoleOutput.join('\n'),
    ].join('\n');
    expect(everywhere).not.toContain(PASSWORD);
    expect(everywhere).not.toContain(GRANT);
    vi.restoreAllMocks();
  });
});

describeInterfaceStates('The credential setup screen', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const view = open(undefined, () => gate);
      await setPassword(view);

      expect(screen.getByRole('button', { name: 'Set password' })).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await act(async () => {
        release(json(200, { authentication_ready: true }));
        await gate;
      });
      await screen.findByText('Your password is set');
    },
  },
  empty: {
    inapplicable:
      'The screen lists nothing, so there is no collection that could be empty; a link with no grant is the error state.',
  },
  'validation error': {
    test: async () => {
      const view = open();
      await setPassword(view, 'short');

      expect(screen.getByLabelText('New password (required)')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      expect(screen.getByLabelText('New password (required)')).toHaveFocus();
    },
  },
  error: {
    test: async () => {
      const view = open(undefined, () => errorResponse(401, 'SETUP_GRANT_INVALID'));
      await setPassword(view);

      expect(await screen.findByText(THE_ONE_ERROR)).toBeVisible();
      expect(document.body.textContent).not.toMatch(/Diagnostic text|SETUP_GRANT_INVALID/);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(undefined, () => {
        attempts += 1;
        return attempts === 1
          ? errorResponse(503, 'SETTING_MISSING')
          : json(200, { authentication_ready: true });
      });
      await setPassword(view);
      await screen.findByRole('alert');

      await view.user.type(screen.getByLabelText('New password (required)'), PASSWORD);
      await view.user.click(screen.getByRole('button', { name: 'Set password' }));

      expect(await screen.findByText('Your password is set')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'Setting a first password carries no version of a record; a grant that was used or replaced is the one error of an unusable link.',
  },
  success: {
    test: async () => {
      const view = open(undefined, () => json(200, { authentication_ready: true }));
      await setPassword(view);

      expect(await screen.findByText('The next step is to sign in.')).toBeVisible();
    },
  },
  'permission-restricted': {
    inapplicable:
      'The screen is reached by a grant and not by a permission; the grant is the whole of the authority and the server judges it.',
  },
});
