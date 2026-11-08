import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { groupedKey } from '../../../platform/secrets/otpauth';
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
import { decodeRenderedSvg } from '../../../test-support/qr-decode';
import { renderApp } from '../../../test-support/render-app';

/**
 * `/setup/mfa` (`completeMfaEnrolment`, `beginMfaReenrolment`; AC-SLICE-000-92, -94, -126). A privileged employee enrols an authenticator and
 * proves a code. The QR code and the key to type by hand are shown together, once, and are transient credentials (OB-23): in memory only, never
 * a link, never a copy button, and gone when the screen is left, finished, hidden or timed out.
 */

const GRANT = 'kJ3x9Qm2-Zt7_VbN4wYc8LdR1pHs5GfXaUe6OiTjA0E';
const PASSWORD = 'a long enough passphrase';
const SEED = 'SENTINELSEED234567ABCDEFGH';
const URI = `otpauth://totp/Melarc:synthetic.officer?secret=${SEED}&issuer=Melarc&period=30`;
const CONTINUATION = 'synthetic-continuation-grant';
const SETUP = 'POST /auth/staff/setup/credential';
const BEGIN = 'POST /auth/staff/setup/mfa/begin';
const ENROL = 'POST /auth/staff/setup/mfa';
const PRIVILEGED = {
  authentication_ready: false,
  mfa_enrolment_required: true,
  mfa_provisioning: { otpauth_uri: URI },
  mfa_setup_token: CONTINUATION,
};
const BEGUN = { mfa_provisioning: { otpauth_uri: URI }, mfa_setup_token: CONTINUATION };
const CODE = '123456';
const THE_ONE_ERROR =
  'This link cannot be used. It may have expired, or it may already have been used.';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.useRealTimers();
});

type View = ReturnType<typeof renderApp>;

/** The way in for a new privileged employee: the first password, answered with the material of an authenticator. */
async function viaCredential(handlers: Record<string, Handler> = {}): Promise<View> {
  api = installFakeApi({ [SETUP]: () => json(200, PRIVILEGED), ...handlers });
  const view = renderApp(`/setup/credential#token=${GRANT}`);
  await view.user.type(await screen.findByLabelText('New password (required)'), PASSWORD);
  await view.user.click(screen.getByRole('button', { name: 'Set password' }));
  await screen.findByRole('region', { name: 'Authenticator set-up' });
  return view;
}

/** The way in after a reset: a link that carries a re-enrolment grant. Nothing has been sent when this returns. */
function viaLink(handlers: Record<string, Handler> = {}): View {
  api = installFakeApi(handlers);
  return renderApp(`/setup/mfa#token=${GRANT}`);
}

async function finish(view: View, code = CODE) {
  await view.user.type(screen.getByLabelText('Authenticator code (required)'), code);
  await view.user.click(screen.getByRole('button', { name: 'Finish set-up' }));
}

const enrolBody = async (): Promise<unknown> =>
  api.requests
    .find((request) => request.url.endsWith('/setup/mfa'))
    ?.clone()
    .json();

const SEED_FORMS = [SEED, groupedKey(SEED), URI, encodeURIComponent(URI)];

function whereIsTheSeed(): string[] {
  const places: string[] = [];
  const holds = (text: string | null | undefined): boolean =>
    SEED_FORMS.some((form) => (text ?? '').includes(form));
  if (holds(JSON.stringify(Object.entries(localStorage)))) places.push('localStorage');
  if (holds(JSON.stringify(Object.entries(sessionStorage)))) places.push('sessionStorage');
  if (holds(document.cookie)) places.push('cookie');
  if (holds(window.location.href)) places.push('address');
  if (holds(JSON.stringify(window.history.state ?? null))) places.push('history state');
  if (holds(document.title)) places.push('title');
  const live = [...document.querySelectorAll<HTMLInputElement>('input')].some((input) =>
    holds(input.value),
  );
  if (holds(document.documentElement.outerHTML) || live) places.push('page');
  return places;
}

describe('the authenticator screen, reached from the first password', () => {
  it('shows the QR code and the key together, with the field for the code that proves them', async () => {
    await viaCredential();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Set up your authenticator' }),
    ).toBeVisible();
    expect(document.title).toBe('Set up your authenticator · Melarc Ops Portal');
    const region = screen.getByRole('region', { name: 'Authenticator set-up' });
    const picture = within(region).getByRole('img', { name: 'QR code for your authenticator app' });
    expect(decodeRenderedSvg(picture as unknown as SVGSVGElement)).toBe(URI);
    expect(within(region).getByRole('textbox', { name: 'Setup key' })).toHaveValue(
      groupedKey(SEED),
    );
    expect(screen.getByLabelText('Authenticator code (required)')).toHaveAttribute(
      'autocomplete',
      'one-time-code',
    );
  });

  // Break caught (S0.39c, OB-23): the credential offered as a link, a button that copies it, or a form field that would submit it.
  it('offers the key to read and type: no link, no copy button, no field that a form would send', async () => {
    await viaCredential();

    expect(document.querySelector('a[href^="otpauth"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
    const key = screen.getByRole('textbox', { name: 'Setup key' });
    expect(key).toHaveAttribute('readonly');
    expect(key).not.toHaveAttribute('name');
    expect(key).toHaveAttribute('autocomplete', 'off');
  });

  // Break caught (OB-23): the seed anywhere but the screen that shows it.
  it('keeps the seed on the screen and nowhere else: no storage, cookie, address, history state or title', async () => {
    await viaCredential();

    expect(whereIsTheSeed()).toEqual(['page']);
  });

  // Break caught (ops-portal.md section 7: setup pages carry no shell; a grant is not a session).
  it('draws no navigation or sign-out, and asks for no session', async () => {
    await viaCredential();

    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(api.requests.filter((request) => request.method === 'GET')).toHaveLength(0);
  });

  it('says the key is shown once and that the authenticator is not set up until a code is proven', async () => {
    await viaCredential();

    expect(screen.getByText(/shown once/i)).toBeVisible();
    expect(screen.getByText(/not set up until/i)).toBeVisible();
  });
});

describe('the authenticator screen, reached from a re-enrolment link', () => {
  // Break caught (GBT-W16): a page that redeems the re-enrolment grant by being opened.
  it('redeems nothing by being opened, and offers to begin', async () => {
    const { router } = viaLink();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set up your authenticator' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Begin set-up' })).toBeVisible();
    expect(screen.queryByRole('img', { name: 'QR code for your authenticator app' })).toBeNull();
    expect(api.requests).toHaveLength(0);
    expect(router.state.location.hash).toBe('');
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('sends the grant once, in the body, when the person begins, and then shows the material', async () => {
    const view = viaLink({ [BEGIN]: () => json(200, BEGUN) });

    await view.user.click(await screen.findByRole('button', { name: 'Begin set-up' }));

    const region = await screen.findByRole('region', { name: 'Authenticator set-up' });
    expect(
      within(region).getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.url).not.toContain(GRANT);
    expect(await api.requests[0]?.clone().json()).toEqual({ setup_token: GRANT });
    expect(screen.queryByRole('button', { name: 'Begin set-up' })).toBeNull();
  });

  // Break caught: a grant that has done its work kept for another begin.
  it('forgets the re-enrolment grant once it has been exchanged', async () => {
    const view = viaLink({ [BEGIN]: () => json(200, BEGUN) });
    await view.user.click(await screen.findByRole('button', { name: 'Begin set-up' }));
    await screen.findByRole('region', { name: 'Authenticator set-up' });

    expect(document.body.textContent).not.toContain(GRANT);
    expect(window.location.href).not.toContain(GRANT);
  });

  it('sends only one begin however many times it is pressed', async () => {
    let release: (response: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const view = viaLink({ [BEGIN]: () => gate });
    const button = await screen.findByRole('button', { name: 'Begin set-up' });

    await view.user.click(button);
    await view.user.click(button);
    expect(button).toHaveAttribute('aria-busy', 'true');

    expect(api.requests).toHaveLength(1);
    await act(async () => {
      release(json(200, BEGUN));
      await gate;
    });
    await screen.findByRole('region', { name: 'Authenticator set-up' });
  });

  describe('a refusal to begin', () => {
    it('shows the one error for a grant that cannot be used', async () => {
      const view = viaLink({ [BEGIN]: () => errorResponse(401, 'SETUP_GRANT_INVALID') });

      await view.user.click(await screen.findByRole('button', { name: 'Begin set-up' }));

      expect(
        await screen.findByRole('heading', { name: 'This link cannot be used' }),
      ).toBeVisible();
      expect(screen.getByText(THE_ONE_ERROR)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Begin set-up' })).toBeNull();
    });

    it('says only to wait, for a rate limit, and lets the person begin again', async () => {
      let attempts = 0;
      const view = viaLink({
        [BEGIN]: () => {
          attempts += 1;
          return attempts === 1 ? errorResponse(429, 'RATE_LIMITED') : json(200, BEGUN);
        },
      });
      await view.user.click(await screen.findByRole('button', { name: 'Begin set-up' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Too many attempts. Wait a minute, then try again.',
      );
      await view.user.click(screen.getByRole('button', { name: 'Begin set-up' }));
      expect(await screen.findByRole('region', { name: 'Authenticator set-up' })).toBeVisible();
    });

    it('says it could not confirm whether it started, when no answer came', async () => {
      const view = viaLink({
        [BEGIN]: () => {
          throw new TypeError('Failed to fetch');
        },
      });

      await view.user.click(await screen.findByRole('button', { name: 'Begin set-up' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'We could not confirm whether this started. Try again. If the link is then refused, ask for a new one.',
      );
    });

    // Break caught: material the page cannot use being drawn.
    it.each([
      ['an empty object', {}],
      [
        'an address that is not a TOTP one',
        { ...BEGUN, mfa_provisioning: { otpauth_uri: 'https://x.test' } },
      ],
      ['no continuation grant', { mfa_provisioning: { otpauth_uri: URI } }],
    ])('does not draw %s', async (_name, body) => {
      const view = viaLink({ [BEGIN]: () => json(200, body) });

      await view.user.click(await screen.findByRole('button', { name: 'Begin set-up' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'We could not confirm whether this started.',
      );
      expect(screen.queryByRole('region', { name: 'Authenticator set-up' })).toBeNull();
    });
  });

  // Break caught (U02 of 23 October 2026; the late-answer test on the real enrolment screen): the material of an authenticator asked for on
  // this screen appearing after the person has left it, or being kept anywhere.
  describe('an answer that arrives late', () => {
    async function waiting() {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const view = viaLink({ [BEGIN]: () => gate });
      await view.user.click(await screen.findByRole('button', { name: 'Begin set-up' }));
      await waitFor(() => {
        expect(api.requests).toHaveLength(1);
      });
      return {
        view,
        gate,
        answer: () => {
          release(json(200, BEGUN));
        },
      };
    }

    const nothingShown = async (gate: Promise<Response>) => {
      await act(async () => {
        await gate;
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(screen.queryByRole('region', { name: 'Authenticator set-up' })).toBeNull();
      expect(whereIsTheSeed()).toEqual([]);
    };

    it('is shown and kept nowhere when the person has gone to another page', async () => {
      const { view, gate, answer } = await waiting();
      await act(async () => {
        await view.router.navigate('/sign-in');
      });
      expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();

      answer();

      await nothingShown(gate);
    });

    it('is shown and kept nowhere when the page is hidden before it arrives', async () => {
      const { gate, answer } = await waiting();
      act(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      });

      answer();

      await nothingShown(gate);
    });

    it('is shown when nothing happened in between', async () => {
      const { answer } = await waiting();

      answer();

      expect(await screen.findByRole('region', { name: 'Authenticator set-up' })).toBeVisible();
    });
  });
});

describe('a visit that has nothing to set up', () => {
  // Break caught: an enrolment screen with no material to enrol, reached by typing its address.
  it('shows the one error, and no form, when there is neither a link nor material', async () => {
    api = installFakeApi();
    renderApp('/setup/mfa');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'This link cannot be used' }),
    ).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Authenticator set-up' })).toBeNull();
    expect(api.requests).toHaveLength(0);
  });

  // Break caught: a reload bringing the seed back, which was shown once.
  it('shows the one error after a reload, and the seed is not back', async () => {
    const first = await viaCredential();
    const address = first.router.state.location.pathname + first.router.state.location.hash;
    first.unmount();
    api.restore();
    api = installFakeApi();

    renderApp(address);

    expect(await screen.findByRole('heading', { name: 'This link cannot be used' })).toBeVisible();
    expect(whereIsTheSeed()).toEqual([]);
  });
});

describe('proving the code (AC-SLICE-000-92, -94, -126)', () => {
  it('sends the continuation grant and the code, and goes to the confirmation, which is not a sign-in', async () => {
    const view = await viaCredential({ [ENROL]: () => json(200, { authentication_ready: true }) });

    await finish(view);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your authenticator is set up' }),
    ).toBeVisible();
    expect(await enrolBody()).toEqual({ setup_token: CONTINUATION, totp_code: CODE });
    expect(view.router.state.location.pathname).toBe('/setup/mfa/complete');
    expect(view.router.state.historyAction).toBe('REPLACE');
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  // Break caught (G05 of the audit of 26 October 2026): the answer of a proof whose flow was called off taking the person, who has gone to
  // another page, to the confirmation. A navigation started after the screen has gone still happens, so it must not be started. The stand-in
  // network ignores the request's signal, as a request that loses the race with its cancellation does.
  it('does not take the person to the confirmation when they have gone elsewhere before the answer arrives', async () => {
    let release: (response: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const view = await viaCredential({ [ENROL]: () => gate });
    await finish(view);
    await waitFor(() => {
      expect(api.requests.filter((request) => request.url.endsWith('/setup/mfa'))).toHaveLength(1);
    });
    await act(async () => {
      await view.router.navigate('/no-such-page');
    });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();

    release(json(200, { authentication_ready: true }));
    await act(async () => {
      await gate;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(view.router.state.location.pathname).toBe('/no-such-page');
    expect(screen.queryByRole('heading', { name: 'Your authenticator is set up' })).toBeNull();
  });

  // Break caught (OB-23): the seed still on the screen, in memory or in the page, once the person has finished.
  it('lets go of the seed and the grant at completion', async () => {
    const view = await viaCredential({ [ENROL]: () => json(200, { authentication_ready: true }) });

    await finish(view);
    await screen.findByRole('heading', { name: 'Your authenticator is set up' });

    expect(whereIsTheSeed()).toEqual([]);
    expect(document.body.textContent).not.toContain(CONTINUATION);
  });

  // Break caught (AC-SLICE-000-94): a wrong code ending the setup, or presented as done, or taking the picture away so the person must start again.
  it('says a wrong code left the authenticator not set up, keeps the picture and the key, and empties the field', async () => {
    const view = await viaCredential({ [ENROL]: () => errorResponse(401, 'MFA_PROOF_INVALID') });

    await finish(view);

    const field = await screen.findByLabelText('Authenticator code (required)');
    await waitFor(() => {
      expect(field).toHaveAccessibleDescription(
        /That code was not accepted\. Your authenticator is not set up yet\. Try the next code it shows\./,
      );
    });
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Setup key' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Your authenticator is set up' })).toBeNull();
  });

  // Break caught (AC-SLICE-000-92): a grant that cannot be used leaving the picture on the screen.
  it('shows the one error and removes the seed when the grant cannot be used', async () => {
    const view = await viaCredential({ [ENROL]: () => errorResponse(401, 'SETUP_GRANT_INVALID') });

    await finish(view);

    expect(await screen.findByRole('heading', { name: 'This link cannot be used' })).toBeVisible();
    expect(screen.getByText(THE_ONE_ERROR)).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Authenticator set-up' })).toBeNull();
    expect(whereIsTheSeed()).toEqual([]);
  });

  // Break caught: a grant that cannot be used leaving the material in memory, so that visiting the setup pages again shows the picture.
  it('does not bring the picture back when the person visits the page again after a grant was refused', async () => {
    const view = await viaCredential({ [ENROL]: () => errorResponse(401, 'SETUP_GRANT_INVALID') });
    await finish(view);
    await screen.findByRole('heading', { name: 'This link cannot be used' });

    await act(async () => {
      await view.router.navigate('/setup/credential');
    });
    await act(async () => {
      await view.router.navigate('/setup/mfa');
    });

    expect(await screen.findByRole('heading', { name: 'This link cannot be used' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Authenticator set-up' })).toBeNull();
    expect(whereIsTheSeed()).toEqual([]);
  });

  // Break caught: proving the code emptying the material, and the page calling the link bad for the instant before the route changes.
  it('does not say the link cannot be used on its way to the confirmation', async () => {
    const seen: string[] = [];
    const view = await viaCredential({ [ENROL]: () => json(200, { authentication_ready: true }) });
    const observer = new MutationObserver(() => {
      seen.push(view.container.textContent);
    });
    observer.observe(view.container, { childList: true, subtree: true, characterData: true });

    await finish(view);
    await screen.findByRole('heading', { name: 'Your authenticator is set up' });
    observer.disconnect();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((text) => text.includes('This link cannot be used'))).toBe(false);
  });

  // Break caught (AC-SLICE-000-126): a value that is not six digits sent.
  it.each(['', '12345'])('does not send %j, and asks for six digits', async (code) => {
    const view = await viaCredential();
    const before = api.requests.length;

    if (code !== '')
      await view.user.type(screen.getByLabelText('Authenticator code (required)'), code);
    await view.user.click(screen.getByRole('button', { name: 'Finish set-up' }));

    expect(screen.getByLabelText('Authenticator code (required)')).toHaveAccessibleDescription(
      /Enter the six digits shown in your authenticator app\./,
    );
    expect(screen.getByLabelText('Authenticator code (required)')).toHaveFocus();
    expect(api.requests).toHaveLength(before);
  });

  it('says only to wait, for a rate limit, and keeps the picture', async () => {
    const view = await viaCredential({ [ENROL]: () => errorResponse(429, 'RATE_LIMITED') });

    await finish(view);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Wait a minute, then try again.',
    );
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  });

  it('says the request could not be verified when the Origin was refused', async () => {
    const view = await viaCredential({
      [ENROL]: () => errorResponse(403, 'CSRF_VALIDATION_FAILED'),
    });

    await finish(view);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The request could not be verified. Reload the page and try again.',
    );
  });

  // Break caught: a lost answer worded as a wrong code, when the code may have been spent and the factor activated.
  it('says it could not confirm whether the authenticator was set up, and asks for a new code', async () => {
    let attempts = 0;
    const view = await viaCredential({
      [ENROL]: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return json(200, { authentication_ready: true });
      },
    });

    await finish(view);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not confirm whether your authenticator was set up. Try a new code.',
    );
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
    await finish(view, '654321');
    expect(
      await screen.findByRole('heading', { name: 'Your authenticator is set up' }),
    ).toBeVisible();
  });

  // Break caught: an answer that does not say the identity is ready shown as "set up".
  it.each([
    ['not ready', { authentication_ready: false }],
    ['an empty object', {}],
  ])('does not say the authenticator is set up for %s', async (_name, body) => {
    const view = await viaCredential({ [ENROL]: () => json(200, body) });

    await finish(view);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not confirm whether your authenticator was set up.',
    );
    expect(screen.queryByRole('heading', { name: 'Your authenticator is set up' })).toBeNull();
  });

  it('sends once however many times it is pressed', async () => {
    let release: (response: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const view = await viaCredential({ [ENROL]: () => gate });
    await view.user.type(screen.getByLabelText('Authenticator code (required)'), CODE);
    const button = screen.getByRole('button', { name: 'Finish set-up' });

    await view.user.click(button);
    await view.user.click(button);
    await view.user.keyboard('{Enter}');

    expect(api.requests.filter((request) => request.url.endsWith('/setup/mfa'))).toHaveLength(1);
    await act(async () => {
      release(json(200, { authentication_ready: true }));
      await gate;
    });
    await screen.findByRole('heading', { name: 'Your authenticator is set up' });
  });
});

describe('the seed is transient (OB-23)', () => {
  // Break caught: the seed still in memory or on the page after the person has gone elsewhere, or back with the back button.
  it('is gone when the person leaves, and does not return with the back button', async () => {
    const view = await viaCredential();

    await act(async () => {
      await view.router.navigate('/sign-in');
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(whereIsTheSeed()).toEqual([]);

    await act(async () => {
      await view.router.navigate(-1);
    });

    expect(await screen.findByRole('heading', { name: 'This link cannot be used' })).toBeVisible();
    expect(whereIsTheSeed()).toEqual([]);
  });

  it('is gone when the page is hidden', async () => {
    await viaCredential();

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    await waitFor(() => {
      expect(whereIsTheSeed()).toEqual([]);
    });
    expect(screen.queryByRole('region', { name: 'Authenticator set-up' })).toBeNull();
  });

  it('is gone, and the person told, when the time a page may hold a secret is up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await viaCredential();

    act(() => {
      vi.advanceTimersByTime(15 * 60 * 1000);
    });

    expect(await screen.findByRole('heading', { name: 'This link cannot be used' })).toBeVisible();
    expect(whereIsTheSeed()).toEqual([]);
  });

  // Break caught: the seed, the code or the grant written to the console by a diagnostic.
  it('is in no log line of the whole run', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => JSON.stringify(arg)).join(' '));
      });
    }
    const view = await viaCredential({ [ENROL]: () => errorResponse(401, 'MFA_PROOF_INVALID') });
    await finish(view);
    await screen.findByLabelText('Authenticator code (required)');

    for (const secret of [...SEED_FORMS, CONTINUATION, GRANT, PASSWORD, CODE]) {
      expect(lines.join('\n')).not.toContain(secret);
    }
    vi.restoreAllMocks();
  });
});

describeInterfaceStates('The authenticator screen', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const view = await viaCredential({ [ENROL]: () => gate });
      await finish(view);

      expect(screen.getByRole('button', { name: 'Finish set-up' })).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await act(async () => {
        release(json(200, { authentication_ready: true }));
        await gate;
      });
      await screen.findByRole('heading', { name: 'Your authenticator is set up' });
    },
  },
  empty: {
    inapplicable:
      'The screen lists nothing; a visit with nothing to set up is the one error of an unusable link, not an empty list.',
  },
  'validation error': {
    test: async () => {
      const view = await viaCredential();
      await view.user.click(screen.getByRole('button', { name: 'Finish set-up' }));

      expect(screen.getByLabelText('Authenticator code (required)')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      expect(screen.getByLabelText('Authenticator code (required)')).toHaveFocus();
    },
  },
  error: {
    test: async () => {
      const view = await viaCredential({
        [ENROL]: () => errorResponse(401, 'SETUP_GRANT_INVALID'),
      });
      await finish(view);

      expect(await screen.findByText(THE_ONE_ERROR)).toBeVisible();
      expect(document.body.textContent).not.toMatch(/Diagnostic text|SETUP_GRANT_INVALID/);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = await viaCredential({
        [ENROL]: () => {
          attempts += 1;
          return attempts === 1
            ? errorResponse(503, 'SETTING_MISSING')
            : json(200, { authentication_ready: true });
        },
      });
      await finish(view);
      await screen.findByRole('alert');

      await finish(view, '654321');

      expect(
        await screen.findByRole('heading', { name: 'Your authenticator is set up' }),
      ).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'Enrolment carries no version of a record; a grant that was used or replaced is the one error of an unusable link.',
  },
  success: {
    test: async () => {
      const view = await viaCredential({
        [ENROL]: () => json(200, { authentication_ready: true }),
      });
      await finish(view);

      expect(
        await screen.findByRole('heading', { name: 'Your authenticator is set up' }),
      ).toBeVisible();
    },
  },
  'permission-restricted': {
    inapplicable:
      'The screen is reached by a grant and not by a permission; the grant is the whole of the authority and the server judges it.',
  },
});
