import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  errorResponse,
  installFakeApi,
  type FakeApi,
  type Handler,
} from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { renderApp } from '../../../test-support/render-app';

/**
 * `/recovery/complete` (`completeCredentialRecovery`; AC-SLICE-000-22, -36, -87, -103). A staff member sets a new password from the recovery link
 * a message carries in its fragment. A link is not a session: no shell, no session asked for, and the answer gives none.
 */

const TOKEN = 'Rq7x9Qm2-Zt7_VbN4wYc8LdR1pHs5GfXaUe6OiTjA0E';
const PASSWORD = 'a long enough passphrase';
const COMPLETE = 'POST /auth/recovery/complete';
const THE_ONE_ERROR =
  'This link cannot be used. It may have expired, it may already have been used, or a newer recovery may have replaced it.';
const done = (): Response =>
  new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(entry = `/recovery/complete#token=${TOKEN}`, handler?: Handler) {
  api = installFakeApi(handler === undefined ? {} : { [COMPLETE]: handler });
  return renderApp(entry);
}

type View = ReturnType<typeof open>;

async function setPassword(view: View, password = PASSWORD) {
  await view.user.type(await screen.findByLabelText('New password (required)'), password);
  await view.user.click(screen.getByRole('button', { name: 'Set new password' }));
}

describe('the recovery completion screen', () => {
  it('is a page of its own: a title, one heading, a labelled new password stating the rule, and no session asked for', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set a new password' }),
    ).toBeVisible();
    expect(document.title).toBe('Set a new password · Melarc Ops Portal');
    expect(screen.getByLabelText('New password (required)')).toHaveAccessibleDescription(
      '12 to 128 characters. Spaces are allowed. Nothing else is required.',
    );
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(api.requests).toHaveLength(0);
  });

  // Break caught (GBT-W16): a page that redeems the link by being opened, or keeps the token in the address or sends it anywhere but the body.
  it('redeems nothing by being opened, removes the token from the address, and sends it in the body alone', async () => {
    const view = open(undefined, done);
    await screen.findByRole('heading', { name: 'Set a new password' });
    expect(view.router.state.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    expect(api.requests).toHaveLength(0);

    await setPassword(view);

    await screen.findByRole('heading', { name: 'Your password is changed' });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.url).not.toContain(TOKEN);
    expect(await api.requests[0]?.clone().json()).toEqual({
      token: TOKEN,
      new_credential: PASSWORD,
    });
  });

  // Break caught: a success that does not say every session ended, claims a session, or leaves the password on the screen.
  it('says the password is changed, every session has ended and the next step is to sign in', async () => {
    const view = open(undefined, done);

    await setPassword(view);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your password is changed' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Every session that was signed in with your account has ended, on this browser and on any other.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to sign-in' })).toHaveAttribute('href', '/sign-in');
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(document.body.textContent).not.toContain(PASSWORD);
    const heading = screen.getByRole('heading', { name: 'Your password is changed' });
    await waitFor(() => {
      expect(heading.closest('div[tabindex="-1"]')).toHaveFocus();
    });
  });

  // Break caught (AC-SLICE-000-103): an error that says which way the link was dead, or re-opens the form.
  it('shows the one error for a link the server refuses, without the form, and offers a new link', async () => {
    const view = open(undefined, () => errorResponse(422, 'RECOVERY_TOKEN_INVALID'));

    await setPassword(view);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'This link cannot be used' }),
    ).toBeVisible();
    expect(screen.getByText(THE_ONE_ERROR)).toBeVisible();
    expect(screen.queryByLabelText('New password (required)')).toBeNull();
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute(
      'href',
      '/recovery',
    );
    expect(document.body.textContent).not.toMatch(
      /Diagnostic text|RECOVERY_TOKEN_INVALID|expired\b.*used\b.*which/,
    );
  });

  it.each([
    ['no fragment', '/recovery/complete'],
    ['an empty token', '/recovery/complete#token='],
    ['two tokens', '/recovery/complete#token=a&token=b'],
  ])('shows the same error for a link with %s, and sends nothing', async (_name, entry) => {
    open(entry);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'This link cannot be used' }),
    ).toBeVisible();
    expect(screen.getByText(THE_ONE_ERROR)).toBeVisible();
    expect(api.requests).toHaveLength(0);
  });

  // Break caught (AC-SLICE-000-87): a password outside 12 to 128 sent, or the value echoed.
  it.each([
    ['11 characters', 'a'.repeat(11)],
    ['129 characters', 'a'.repeat(129)],
    ['four ligatures that normalise to twelve', 'ﬃ'.repeat(4)],
  ])('does not send %s, states the rule and does not echo the value', async (_name, password) => {
    const view = open();

    await setPassword(view, password);

    const field = screen.getByLabelText('New password (required)');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(
      /Use 12 to 128 characters\. Spaces are allowed, and nothing else is required\./,
    );
    expect(api.requests).toHaveLength(0);
    expect(document.body.textContent).not.toContain(password);
  });
});

describeInterfaceStates('The recovery completion screen', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const view = open(undefined, () => gate);
      await setPassword(view);

      expect(screen.getByRole('button', { name: 'Set new password' })).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await act(async () => {
        release(done());
        await gate;
      });
      await screen.findByRole('heading', { name: 'Your password is changed' });
    },
  },
  empty: {
    inapplicable:
      'The screen lists nothing, so there is no collection that could be empty; a link with no token is the error state.',
  },
  'validation error': {
    test: async () => {
      const view = open(undefined, () =>
        errorResponse(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'body', pointer: '/new_credential', rule: 'minLength' }],
        }),
      );
      await setPassword(view, 'é'.repeat(6));

      expect(await screen.findByLabelText('New password (required)')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    },
  },
  error: {
    test: async () => {
      const view = open(undefined, () => errorResponse(422, 'RECOVERY_TOKEN_INVALID'));
      await setPassword(view);

      expect(await screen.findByText(THE_ONE_ERROR)).toBeVisible();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(undefined, () => {
        attempts += 1;
        return attempts === 1 ? errorResponse(503, 'SETTING_MISSING') : done();
      });
      await setPassword(view);
      await screen.findByRole('alert');

      await setPassword(view);

      expect(
        await screen.findByRole('heading', { name: 'Your password is changed' }),
      ).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'A recovery link carries no version of a record; a link that was used or replaced is the one error of an unusable link.',
  },
  success: {
    test: async () => {
      const view = open(undefined, done);
      await setPassword(view);

      expect(
        await screen.findByText('The next step is to sign in with your new password.', {
          exact: false,
        }),
      ).toBeVisible();
    },
  },
  'permission-restricted': {
    inapplicable:
      'The screen is reached by a link and not by a permission; the link is the whole of the authority and the server judges it.',
  },
});
