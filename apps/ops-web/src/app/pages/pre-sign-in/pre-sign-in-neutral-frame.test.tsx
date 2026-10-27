import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { errorResponse, installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import { renderApp } from '../../../test-support/render-app';

/**
 * The neutral frame, for each of the five pre-sign-in routes, in every state it can be in (DESIGN_SYSTEM section 13.1; COMPONENT_PATTERNS section
 * 12.4: "the neutral frame must never show, in any state (loading, challenge, error or success), navigation, a user menu, sign-out, session data
 * or anything loaded for a signed-in user; tests assert this for each pre-authentication route as it is built"). The pages' own tests say what each
 * state shows; this says what none of them may.
 */

const GRANT = 'kJ3x9Qm2-Zt7_VbN4wYc8LdR1pHs5GfXaUe6OiTjA0E';
const URI = 'otpauth://totp/Melarc:synthetic.officer?secret=ABCDEFGHIJKLMNOP234567&issuer=Melarc';
const CHALLENGE = {
  challenge_id: '0f9c6a52-3d8e-4b71-9a24-6c1e7d5b8f30',
  expires_at: '2026-10-24T09:05:00.000Z',
  trusted_browser_days: 7,
};
const PRIVILEGED = {
  authentication_ready: false,
  mfa_enrolment_required: true,
  mfa_provisioning: { otpauth_uri: URI },
  mfa_setup_token: 'synthetic-continuation-grant',
};

let api: FakeApi;

afterEach(() => {
  api.restore();
});

/**
 * What a pre-sign-in screen must not have, whatever it is showing. The screens are drawn in the frame's split layout (the Product Owner's
 * decision of 25 October 2026): the banner and the main landmark are the frame's, and the place beside the main content holds decorative
 * imagery and nothing to operate. What the neutral frame forbade is still forbidden: navigation, a user menu, sign-out, a signed-in affordance.
 */
function expectNeutral() {
  expect(document.querySelector('.app-frame')).toHaveClass('app-frame--split');
  expect(screen.getAllByRole('banner')).toHaveLength(1);
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(screen.queryAllByRole('navigation')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
  expect(screen.queryByText('Nothing is waiting.')).toBeNull();
  expect(screen.queryByRole('list', { name: 'Your hubs' })).toBeNull();
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  // The only things beside the main content are the skip link, the banner and the decorative imagery: nothing there is operable or named.
  const side = document.querySelector('.app-chrome');
  expect(side?.querySelector('.ui-auth-art')).toHaveAttribute('aria-hidden', 'true');
  expect(
    side?.querySelectorAll('a, button, nav, input, select, textarea, [tabindex], [role]'),
  ).toHaveLength(0);
}

type Step = (view: ReturnType<typeof renderApp>) => Promise<void>;

const signInSteps: [string, Record<string, () => Response>, Step][] = [
  ['the empty form', {}, () => Promise.resolve()],
  [
    'a refused sign-in',
    { 'POST /auth/staff/sign-in': () => errorResponse(401, 'INVALID_CREDENTIALS') },
    async ({ user }) => {
      await user.type(await screen.findByLabelText('Work email (required)'), 'a@example.test');
      await user.type(screen.getByLabelText('Password (required)'), 'a long enough passphrase');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      await screen.findByRole('alert');
    },
  ],
];

describe('the sign-in screen', () => {
  it.each(signInSteps)('is in the neutral frame: %s', async (_name, handlers, step) => {
    api = installFakeApi(handlers);
    const view = renderApp('/sign-in');
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });

    await step(view);

    expectNeutral();
    expect(api.requests.filter((request) => request.method === 'GET')).toHaveLength(0);
  });
});

describe('the second step of sign-in, which holds a challenge and not a session', () => {
  it('is in the neutral frame, with the challenge and after each refusal', async () => {
    for (const code of [
      undefined,
      'MFA_PROOF_INVALID',
      'CHALLENGE_UNUSABLE',
      'CREDENTIAL_LOCKED',
    ]) {
      api = installFakeApi({
        'POST /auth/staff/sign-in': () => json(202, CHALLENGE),
        ...(code === undefined
          ? {}
          : { 'POST /auth/staff/sign-in/mfa': () => errorResponse(401, code) }),
      });
      const view = renderApp('/sign-in');
      await view.user.type(await screen.findByLabelText('Work email (required)'), 'a@example.test');
      await view.user.type(
        screen.getByLabelText('Password (required)'),
        'a long enough passphrase',
      );
      await view.user.click(screen.getByRole('button', { name: 'Sign in' }));
      await screen.findByRole('heading', { level: 1, name: 'Enter your code' });
      expectNeutral();

      if (code !== undefined) {
        await view.user.type(screen.getByLabelText('Authenticator code (required)'), '123456');
        await view.user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
        await screen.findByRole(code === 'MFA_PROOF_INVALID' ? 'textbox' : 'alert');
        expectNeutral();
      }
      expect(api.requests.filter((request) => request.method === 'GET')).toHaveLength(0);
      view.unmount();
      api.restore();
    }
    api = installFakeApi();
  });
});

describe('the setup screens, which are reached by a grant', () => {
  const entries: [string, string][] = [
    ['the credential form', `/setup/credential#token=${GRANT}`],
    ['a credential link with no grant', '/setup/credential'],
    ['the begin button of a re-enrolment link', `/setup/mfa#token=${GRANT}`],
    ['an authenticator screen with nothing to set up', '/setup/mfa'],
  ];

  it.each(entries)('are in the neutral frame: %s', async (_name, entry) => {
    api = installFakeApi();
    renderApp(entry);
    await screen.findAllByRole('heading', { level: 1 });

    expectNeutral();
    expect(api.requests).toHaveLength(0);
  });

  it('are in the neutral frame with the authenticator and with the confirmation', async () => {
    api = installFakeApi({
      'POST /auth/staff/setup/credential': () => json(200, PRIVILEGED),
      'POST /auth/staff/setup/mfa': () => json(200, { authentication_ready: true }),
    });
    const view = renderApp(`/setup/credential#token=${GRANT}`);
    await view.user.type(
      await screen.findByLabelText('New password (required)'),
      'a long enough passphrase',
    );
    await view.user.click(screen.getByRole('button', { name: 'Set password' }));
    await screen.findByRole('heading', { level: 1, name: 'Set up your authenticator' });
    expectNeutral();

    await view.user.type(screen.getByLabelText('Authenticator code (required)'), '123456');
    await view.user.click(screen.getByRole('button', { name: 'Finish set-up' }));
    await screen.findByRole('heading', { level: 1, name: 'Your authenticator is set up' });
    expectNeutral();
    expect(api.requests.filter((request) => request.method === 'GET')).toHaveLength(0);
  });

  it('and the ordinary employee’s confirmation, are in the neutral frame', async () => {
    api = installFakeApi({
      'POST /auth/staff/setup/credential': () => json(200, { authentication_ready: true }),
    });
    const view = renderApp(`/setup/credential#token=${GRANT}`);
    await view.user.type(
      await screen.findByLabelText('New password (required)'),
      'a long enough passphrase',
    );
    await view.user.click(screen.getByRole('button', { name: 'Set password' }));
    await screen.findByRole('heading', { level: 1, name: 'Your password is set' });

    expectNeutral();
  });
});
