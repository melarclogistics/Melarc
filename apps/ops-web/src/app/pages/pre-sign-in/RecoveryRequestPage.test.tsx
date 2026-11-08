import { act, screen } from '@testing-library/react';
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
 * `/recovery` (`requestCredentialRecovery`; AC-SLICE-000-20, -21, -104). A staff member asks for a recovery link to the work email their profile
 * holds. The page has no destination field and one success, whatever the address; it is reached with no session and asks for none.
 */

const REQUEST = 'POST /auth/recovery/request';
const EMAIL = 'ama.mensah@melarc.test';
const accepted = (): Response => new Response(null, { status: 202 });

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(handler?: Handler) {
  api = installFakeApi(handler === undefined ? {} : { [REQUEST]: handler });
  return renderApp('/recovery');
}

type View = ReturnType<typeof open>;

async function ask(view: View, email = EMAIL) {
  await view.user.type(await screen.findByLabelText('Work email (required)'), email);
  await view.user.click(screen.getByRole('button', { name: 'Send recovery link' }));
}

describe('the recovery request screen', () => {
  it('is a page of its own: a title, one heading, one labelled work email and one button, and no other field', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Recover your password' }),
    ).toBeVisible();
    expect(document.title).toBe('Recover your password · Melarc Ops Portal');
    expect(screen.getByLabelText('Work email (required)')).toHaveAttribute(
      'autocomplete',
      'username',
    );
    // Break caught (AC-SLICE-000-20): a field that could name a destination.
    expect(document.querySelectorAll('input')).toHaveLength(1);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(api.requests).toHaveLength(0);
  });

  // Break caught: the request naming a destination, another principal type, or carrying more than the identifier.
  it('sends the work email as a staff identifier, and nothing else', async () => {
    const view = open(accepted);

    await ask(view);

    await screen.findByRole('heading', { name: 'Check your email' });
    expect(api.requests).toHaveLength(1);
    expect(await api.requests[0]?.clone().json()).toEqual({
      principal_type: 'STAFF',
      identifier: EMAIL,
    });
  });

  // Break caught (§37.7): a success that differs for an address that belongs to nobody, or an "account not found" state.
  it('shows one success whatever the address, in words true either way, and keeps nothing it was told', async () => {
    const view = open(accepted);

    await ask(view);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Check your email' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        'If that address belongs to a staff account that can be recovered, a link to set a new password is on its way to it.',
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain(EMAIL);
    expect(document.body.textContent).not.toMatch(/not found|no account|unknown/i);
    expect(screen.getByRole('link', { name: 'Go to sign-in' })).toHaveAttribute('href', '/sign-in');
  });

  it('offers the way back to sign-in, and the sign-in page offers this one', async () => {
    open();
    expect(await screen.findByRole('link', { name: 'Back to sign-in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    api.restore();
    api = installFakeApi({});
    renderApp('/sign-in');
    expect(await screen.findByRole('link', { name: 'Forgot your password?' })).toHaveAttribute(
      'href',
      '/recovery',
    );
  });

  // Break caught (AC-SLICE-000-104): a too-fast request worded as anything but the plain wait, or as a sign that the address is real.
  it('words a too-fast request as the plain wait of sign-in', async () => {
    const view = open(() => errorResponse(429, 'RATE_LIMITED'));

    await ask(view);

    expect(
      await screen.findByText('Too many attempts. Wait a minute, then try again.'),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Check your email' })).toBeNull();
  });
});

describeInterfaceStates('The recovery request screen', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const view = open(() => gate);
      await ask(view);

      expect(screen.getByRole('button', { name: 'Send recovery link' })).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await act(async () => {
        release(accepted());
        await gate;
      });
      await screen.findByRole('heading', { name: 'Check your email' });
    },
  },
  empty: {
    inapplicable: 'The screen lists nothing, so there is no collection that could be empty.',
  },
  'validation error': {
    test: async () => {
      const view = open(() =>
        errorResponse(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'body', pointer: '/identifier', rule: 'format' }],
        }),
      );
      await ask(view, 'not an address');

      const field = screen.getByLabelText('Work email (required)');
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field).toHaveAccessibleDescription(/Enter your work email address\./);
      expect(document.body.textContent).not.toContain('Diagnostic text');
    },
  },
  error: {
    test: async () => {
      const view = open(() => errorResponse(403, 'CSRF_VALIDATION_FAILED'));
      await ask(view);

      expect(
        await screen.findByText(
          'The request could not be verified. Reload the page and try again.',
        ),
      ).toBeVisible();
      expect(document.body.textContent).not.toMatch(/Diagnostic text|CSRF_VALIDATION_FAILED/);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(() => {
        attempts += 1;
        return attempts === 1 ? errorResponse(503, 'SETTING_MISSING') : accepted();
      });
      await ask(view);
      expect(
        await screen.findByText(
          'We could not confirm whether your request was received. Try again.',
        ),
      ).toBeVisible();

      await view.user.click(screen.getByRole('button', { name: 'Send recovery link' }));

      expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'A request for a link names no record and carries no version; there is nothing that could have changed.',
  },
  success: {
    test: async () => {
      const view = open(accepted);
      await ask(view);

      expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeVisible();
    },
  },
  'permission-restricted': {
    inapplicable:
      'The screen is for a person with no session, and no permission applies to asking for a link.',
  },
});
