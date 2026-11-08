import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import { renderApp } from '../../../test-support/render-app';

/**
 * `/setup/mfa/complete` (no operation: it renders the result of the one before; ops-portal.md section 7). It says plainly that the next step is
 * ordinary sign-in, and issues and shows no session.
 */

const GRANT = 'kJ3x9Qm2-Zt7_VbN4wYc8LdR1pHs5GfXaUe6OiTjA0E';
const URI = 'otpauth://totp/Melarc:x?secret=ABCDEFGHIJKLMNOP234567&issuer=Melarc';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

/** The whole way a new privileged employee takes: the first password, the authenticator, the code. */
async function allTheWay() {
  api = installFakeApi({
    'POST /auth/staff/setup/credential': () =>
      json(200, {
        authentication_ready: false,
        mfa_enrolment_required: true,
        mfa_provisioning: { otpauth_uri: URI },
        mfa_setup_token: 'synthetic-continuation-grant',
      }),
    'POST /auth/staff/setup/mfa': () => json(200, { authentication_ready: true }),
  });
  const view = renderApp(`/setup/credential#token=${GRANT}`);
  await view.user.type(
    await screen.findByLabelText('New password (required)'),
    'a long enough passphrase',
  );
  await view.user.click(screen.getByRole('button', { name: 'Set password' }));
  await screen.findByRole('region', { name: 'Authenticator set-up' });
  await view.user.type(screen.getByLabelText('Authenticator code (required)'), '123456');
  await view.user.click(screen.getByRole('button', { name: 'Finish set-up' }));
  await screen.findByRole('heading', { name: 'Your authenticator is set up' });
  return view;
}

describe('the confirmation screen', () => {
  it('states plainly that the next step is ordinary sign-in and that nobody is signed in', async () => {
    await allTheWay();

    expect(document.title).toBe('Authenticator set up · Melarc Ops Portal');
    expect(
      screen.getByText(
        'The next step is to sign in with your email, your password and a code from your authenticator.',
      ),
    ).toBeVisible();
    expect(screen.getByText('You are not signed in yet.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to sign-in' })).toHaveAttribute('href', '/sign-in');
  });

  // Break caught (ops-portal.md section 7: no session is issued here): a shell, a navigation or a session read around a confirmation.
  it('draws no navigation or sign-out and asks for no session', async () => {
    await allTheWay();

    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(api.requests.filter((request) => request.method === 'GET')).toHaveLength(0);
  });

  // Break caught: a confirmation that says "set up" to someone who proved nothing, such as a person who typed the address.
  it('goes to the sign-in, replacing its entry, when it is opened without a proven code', async () => {
    api = installFakeApi();
    const { router } = renderApp('/setup/mfa/complete');

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(screen.queryByText('Your authenticator is set up')).toBeNull();
    expect(api.requests).toHaveLength(0);
  });

  // Break caught: any history state taken for a proven code.
  it.each([null, 'enrolled', { enrolled: 'yes' }, { other: true }])(
    'does not take %j for a proven code',
    async (state) => {
      api = installFakeApi();
      const { router } = renderApp('/sign-in');
      await screen.findByRole('heading', { name: 'Sign in' });

      await import('@testing-library/react').then(({ act }) =>
        act(async () => {
          await router.navigate('/setup/mfa/complete', { state });
        }),
      );

      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      expect(router.state.location.pathname).toBe('/sign-in');
    },
  );
});

describeInterfaceStates('The confirmation screen', {
  loading: {
    inapplicable:
      'The confirmation reads nothing from the API, so there is nothing for it to wait on.',
  },
  empty: {
    inapplicable: 'The confirmation lists nothing, so there is no collection that could be empty.',
  },
  'validation error': {
    inapplicable: 'The confirmation has no form or input, so there is nothing for it to validate.',
  },
  error: {
    inapplicable:
      'The confirmation makes no call that could fail; a visit with nothing to confirm goes to the sign-in.',
  },
  retry: { inapplicable: 'The confirmation makes no call, so there is nothing to retry.' },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The confirmation changes and reads no record, so it has no version to conflict on.',
  },
  success: {
    test: async () => {
      await allTheWay();

      expect(screen.getByText('You are not signed in yet.')).toBeVisible();
    },
  },
  'permission-restricted': {
    inapplicable:
      'The confirmation is reached after a grant and holds no permission; it shows the same words to everyone.',
  },
});
