import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { groupedKey } from '../../../platform/secrets/otpauth';
import { MAX_HOLD_MS } from '../../../platform/secrets/use-transient-secret';
import { useSessionStore } from '../../../platform/session/session-context';
import type { SessionStore } from '../../../platform/session/session-store';
import { errorResponse, installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import { renderApp } from '../../../test-support/render-app';
import { sessionFixture } from '../../../test-support/session-fixture';
import { PreSignInFlowLayout } from './PreSignInFlowLayout';
import { PRE_SIGN_IN_ROUTES } from './pre-sign-in-routes';

/**
 * The sentinel tests of the real pre-sign-in screens (OB-23; S0.39b's `secret-hygiene.test.tsx` is the pattern, and asked S0.43 to add its
 * screens). The real application is driven through the real router, providers, query client and API client, with only the network replaced, and
 * five values are planted: the password a person types, the grant a link carries, the seed of an authenticator, the continuation grant and the
 * reference of a sign-in challenge. Then every place a value could be left is searched for them: the query and mutation caches, both web
 * storages, the cookies, the address, the history state, the document title, the console, the page and the requests.
 *
 * What these tests pin is *nowhere else*: the page legitimately holds each value for a while (the password in its field until the server has
 * answered; the seed in the picture and the key field while they are shown). The sentinels are first proved findable, because a search that
 * cannot find a thing passes whatever happens.
 */

const PASSWORD = 'Sentinel-Passw0rd-3c7e-Zq';
const GRANT = 'SentinelGrant-kJ3x9Qm2Zt7VbN4wYc8LdR1pHs5Gf';
const SEED = 'SENTINELSEED234567ABCDEFGH';
const URI = `otpauth://totp/Melarc:synthetic.officer?secret=${SEED}&issuer=Melarc&period=30`;
const CONTINUATION = 'SentinelContinuation-Zz9yY8xX7wW6vV5';
const CHALLENGE_ID = '5e1d7a90-2b4c-4f63-8a15-9c0e3d7b6f42';
const CODE = '482916';

const SETUP = 'POST /auth/staff/setup/credential';
const ENROL = 'POST /auth/staff/setup/mfa';
const SIGN_IN = 'POST /auth/staff/sign-in';
const SECOND_STEP = 'POST /auth/staff/sign-in/mfa';

const SEED_FORMS = [SEED, groupedKey(SEED), URI, encodeURIComponent(URI)];
const PRIVILEGED = {
  authentication_ready: false,
  mfa_enrolment_required: true,
  mfa_provisioning: { otpauth_uri: URI },
  mfa_setup_token: CONTINUATION,
};

const captured: { client: QueryClient | undefined; store: SessionStore | undefined } = {
  client: undefined,
  store: undefined,
};

function ClientProbe() {
  captured.client = useQueryClient();
  captured.store = useSessionStore();
  return null;
}

/** The real pre-sign-in routes, with a probe beside them that hands the test the query client. They come first, so they are the ones matched. */
const probed = [
  {
    element: (
      <>
        <ClientProbe />
        <PreSignInFlowLayout />
      </>
    ),
    children: PRE_SIGN_IN_ROUTES[0]?.children ?? [],
  },
];

let api: FakeApi;
let consoleOutput: string[];

beforeEach(() => {
  consoleOutput = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map((arg) => JSON.stringify(arg)).join(' '));
    });
  }
});

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function entriesOf(storage: Storage): [string, string | null][] {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index) ?? '';
    return [key, storage.getItem(key)];
  });
}

/** Every place any of the forms of a value can be found, by name. */
function whereIs(...forms: string[]): string[] {
  const places: string[] = [];
  const holds = (text: string | null | undefined): boolean =>
    forms.some((form) => (text ?? '').includes(form));

  const queries = captured.client?.getQueryCache().getAll() ?? [];
  const mutations = captured.client?.getMutationCache().getAll() ?? [];
  if (holds(JSON.stringify(queries.map((query) => query.state)))) places.push('query cache');
  if (holds(JSON.stringify(mutations.map((mutation) => mutation.state)))) {
    places.push('mutation cache');
  }
  if (holds(JSON.stringify(entriesOf(localStorage)))) places.push('localStorage');
  if (holds(JSON.stringify(entriesOf(sessionStorage)))) places.push('sessionStorage');
  if (holds(document.cookie)) places.push('cookie');
  if (holds(window.location.href)) places.push('address');
  if (holds(JSON.stringify(window.history.state ?? null))) places.push('history state');
  if (holds(document.title)) places.push('title');
  if (consoleOutput.some((line) => holds(line))) places.push('console');
  const live = [...document.querySelectorAll<HTMLInputElement>('input, textarea')].some((field) =>
    holds(field.value),
  );
  if (holds(document.documentElement.outerHTML) || live) places.push('page');
  return places;
}

const bodiesOf = async (): Promise<string[]> =>
  Promise.all(api.requests.map((request) => request.clone().text()));

const requestsWithout = (value: string): boolean =>
  api.requests.every(
    (request) =>
      !request.url.includes(value) && ![...request.headers.values()].some((h) => h.includes(value)),
  );

/** The new employee's whole first part: the link, the password, and the answer that holds the seed. */
async function throughTheFirstPassword(held?: Promise<Response>) {
  api = installFakeApi({ [SETUP]: () => held ?? json(200, PRIVILEGED) });
  const view = renderApp(`/setup/credential#token=${GRANT}`, probed);
  await view.user.type(await screen.findByLabelText('New password (required)'), PASSWORD);
  await view.user.click(screen.getByRole('button', { name: 'Set password' }));
  return view;
}

describe('the sentinels are findable', () => {
  // Break caught: a search that cannot find what it looks for, which passes whatever the page does.
  it('finds a planted value on the page where it legitimately is', async () => {
    api = installFakeApi();
    const { user } = renderApp(`/setup/credential#token=${GRANT}`, probed);
    await user.type(await screen.findByLabelText('New password (required)'), PASSWORD);

    expect(whereIs(PASSWORD)).toEqual(['page']);
  });
});

describe('the grant a link carries', () => {
  // Break caught (GBT-W16): the grant in the address, the history, a storage, a cache or a log after it was read.
  it('is nowhere once it has been read: not the address, the history state, a storage, a cache, the title or the console', async () => {
    api = installFakeApi();
    renderApp(`/setup/credential#token=${GRANT}`, probed);
    await screen.findByRole('heading', { name: 'Set your password' });

    expect(whereIs(GRANT)).toEqual([]);
  });

  // Break caught (GBT-W16): the grant sent anywhere but the body of the one request that redeems it.
  it('is in the body of the one request that redeems it, and in no address or header', async () => {
    await throughTheFirstPassword();
    await screen.findByRole('region', { name: 'Authenticator set-up' });

    const bodies = await bodiesOf();
    expect(bodies.filter((body) => body.includes(GRANT))).toHaveLength(1);
    expect(requestsWithout(GRANT)).toBe(true);
    expect(whereIs(GRANT)).toEqual([]);
  });

  // Break caught (GBT-W16): a link opened and abandoned that has still sent something.
  it('is sent nowhere when the link is only opened', async () => {
    api = installFakeApi();
    renderApp(`/setup/credential#token=${GRANT}`, probed);
    await screen.findByRole('heading', { name: 'Set your password' });

    expect(api.requests).toHaveLength(0);
  });

  it('is gone from memory when the page is hidden, and the form cannot be sent', async () => {
    api = installFakeApi();
    renderApp(`/setup/credential#token=${GRANT}`, probed);
    await screen.findByRole('heading', { name: 'Set your password' });

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    expect(await screen.findByRole('heading', { name: 'This link cannot be used' })).toBeVisible();
    expect(whereIs(GRANT)).toEqual([]);
  });

  it('is gone from memory when the time a page may hold a secret is up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFakeApi();
    renderApp(`/setup/credential#token=${GRANT}`, probed);
    await screen.findByRole('heading', { name: 'Set your password' });

    act(() => {
      vi.advanceTimersByTime(MAX_HOLD_MS);
    });

    expect(await screen.findByRole('heading', { name: 'This link cannot be used' })).toBeVisible();
  });
});

describe('the password a person types', () => {
  // Break caught: a password left in a cache, a storage or the address, or in the field after the server has answered it.
  it('is in the field while typed and in the request body once, and nowhere else, then gone', async () => {
    api = installFakeApi({ [SETUP]: () => json(200, PRIVILEGED) });
    const { user } = renderApp(`/setup/credential#token=${GRANT}`, probed);
    await user.type(await screen.findByLabelText('New password (required)'), PASSWORD);
    expect(whereIs(PASSWORD)).toEqual(['page']);

    await user.click(screen.getByRole('button', { name: 'Set password' }));
    await screen.findByRole('region', { name: 'Authenticator set-up' });

    expect(whereIs(PASSWORD)).toEqual([]);
    expect((await bodiesOf()).filter((body) => body.includes(PASSWORD))).toHaveLength(1);
    expect(requestsWithout(PASSWORD)).toBe(true);
  });

  it('is not echoed or kept when the grant is refused', async () => {
    api = installFakeApi({ [SETUP]: () => errorResponse(401, 'SETUP_GRANT_INVALID') });
    const { user } = renderApp(`/setup/credential#token=${GRANT}`, probed);
    await user.type(await screen.findByLabelText('New password (required)'), PASSWORD);

    await user.click(screen.getByRole('button', { name: 'Set password' }));
    await screen.findByRole('heading', { name: 'This link cannot be used' });

    expect(whereIs(PASSWORD, GRANT)).toEqual([]);
  });

  // Break caught: the password of a refused sign-in left in the field, or in the page.
  it('is emptied from the field of a refused sign-in', async () => {
    api = installFakeApi({ [SIGN_IN]: () => errorResponse(401, 'INVALID_CREDENTIALS') });
    const { user } = renderApp('/sign-in', probed);
    await user.type(await screen.findByLabelText('Work email (required)'), 'officer@example.test');
    await user.type(screen.getByLabelText('Password (required)'), PASSWORD);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');

    expect(whereIs(PASSWORD)).toEqual([]);
    expect((await bodiesOf()).filter((body) => body.includes(PASSWORD))).toHaveLength(1);
  });

  it('is gone from a sign-in that succeeded, and from the page it led to', async () => {
    api = installFakeApi({ [SIGN_IN]: () => json(200, sessionFixture()) });
    const { user } = renderApp('/sign-in', probed);
    await user.type(await screen.findByLabelText('Work email (required)'), 'officer@example.test');
    await user.type(screen.getByLabelText('Password (required)'), PASSWORD);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { level: 1, name: 'My work' });

    expect(whereIs(PASSWORD)).toEqual([]);
  });
});

describe('the seed an authenticator is set up with', () => {
  // Break caught: the seed anywhere but the screen that shows it (OB-23).
  it('is on the screen and nowhere else while it is shown', async () => {
    await throughTheFirstPassword();
    await screen.findByRole('region', { name: 'Authenticator set-up' });

    expect(whereIs(...SEED_FORMS)).toEqual(['page']);
    expect(whereIs(CONTINUATION)).toEqual([]);
  });

  // Break caught: the seed still there at completion.
  it('is gone from the page at completion', async () => {
    api = installFakeApi({
      [SETUP]: () => json(200, PRIVILEGED),
      [ENROL]: () => json(200, { authentication_ready: true }),
    });
    const { user } = renderApp(`/setup/credential#token=${GRANT}`, probed);
    await user.type(await screen.findByLabelText('New password (required)'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    await screen.findByRole('region', { name: 'Authenticator set-up' });
    await user.type(screen.getByLabelText('Authenticator code (required)'), CODE);

    await user.click(screen.getByRole('button', { name: 'Finish set-up' }));
    await screen.findByRole('heading', { name: 'Your authenticator is set up' });

    expect(whereIs(...SEED_FORMS, CONTINUATION, PASSWORD, GRANT)).toEqual([]);
    expect((await bodiesOf()).filter((body) => body.includes(CONTINUATION))).toHaveLength(1);
    expect(requestsWithout(CONTINUATION)).toBe(true);
  });

  it('is gone from the page at expiry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await throughTheFirstPassword();
    await screen.findByRole('region', { name: 'Authenticator set-up' });

    act(() => {
      vi.advanceTimersByTime(MAX_HOLD_MS);
    });

    // The code has gone, and the page says what happened (run 7, Stage 2.4: not that the link cannot be used, which was used) and shows nothing of it.
    expect(
      await screen.findByRole('heading', { name: 'Your authenticator is not set up yet' }),
    ).toBeVisible();
    expect(whereIs(...SEED_FORMS, CONTINUATION)).toEqual([]);
  });

  // Break caught: the secret still there when the person has gone to another page and comes back with the back button.
  it('is gone on navigation, and does not return with the back button', async () => {
    const { router } = await throughTheFirstPassword();
    await screen.findByRole('region', { name: 'Authenticator set-up' });

    await act(async () => {
      await router.navigate('/sign-in');
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(whereIs(...SEED_FORMS, CONTINUATION)).toEqual([]);

    await act(async () => {
      await router.navigate(-1);
    });
    await screen.findByRole('heading', { name: 'Your authenticator is not set up yet' });
    expect(whereIs(...SEED_FORMS, CONTINUATION)).toEqual([]);
  });

  it('is gone when the page is hidden', async () => {
    await throughTheFirstPassword();
    await screen.findByRole('region', { name: 'Authenticator set-up' });

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    await waitFor(() => {
      expect(whereIs(...SEED_FORMS, CONTINUATION)).toEqual([]);
    });
  });

  // Break caught: the seed or the grant written to the console by a diagnostic, or to the text of an error.
  it('is in no log line of the whole run', async () => {
    api = installFakeApi({
      [SETUP]: () => json(200, PRIVILEGED),
      [ENROL]: () => errorResponse(401, 'MFA_PROOF_INVALID'),
    });
    const { user } = renderApp(`/setup/credential#token=${GRANT}`, probed);
    await user.type(await screen.findByLabelText('New password (required)'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    await screen.findByRole('region', { name: 'Authenticator set-up' });
    await user.type(screen.getByLabelText('Authenticator code (required)'), CODE);
    await user.click(screen.getByRole('button', { name: 'Finish set-up' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Authenticator code (required)')).toHaveValue('');
    });

    for (const secret of [...SEED_FORMS, CONTINUATION, GRANT, PASSWORD, CODE]) {
      expect(consoleOutput.join('\n'), secret).not.toContain(secret);
    }
  });
});

describe('a seed whose answer arrives late (U02 of 23 October 2026), on the real screen', () => {
  /** The first password is sent and the API's answer, which holds the seed, is kept on the network until the test lets it go. */
  async function sentAndWaiting() {
    let release: (response: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const view = await throughTheFirstPassword(gate);
    await waitFor(() => {
      expect(api.requests.some((request) => request.method === 'POST')).toBe(true);
    });
    return {
      ...view,
      gate,
      answer: () => {
        release(json(200, PRIVILEGED));
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
    expect(whereIs(...SEED_FORMS, CONTINUATION)).toEqual([]);
  };

  // Break caught: a seed asked for on one screen appearing on the next, or in a cache, after the person has gone elsewhere.
  it('is shown and kept nowhere when the person has gone to another page', async () => {
    const { router, gate, answer } = await sentAndWaiting();
    await act(async () => {
      await router.navigate('/sign-in');
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();

    answer();

    await nothingShown(gate);
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  // Break caught: the seed of a person whose session ended being shown on a page that is still open.
  it('is shown and kept nowhere when the page is hidden before it arrives', async () => {
    const { gate, answer } = await sentAndWaiting();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    answer();

    await nothingShown(gate);
  });

  // Break caught: the seed of an answer that was asked for in one session being shown or held in the next (U02 and U03 of 23 October 2026), on
  // the real screen: a session that begins and ends while the credential response is held.
  it('is shown and kept nowhere when the session changes before it arrives', async () => {
    const { gate, answer } = await sentAndWaiting();
    act(() => {
      captured.store?.signedIn(sessionFixture());
    });
    act(() => {
      captured.store?.end();
    });

    answer();

    await nothingShown(gate);
  });

  // Break caught: the guard refusing the answer it should take.
  it('is shown when nothing happened in between', async () => {
    const { answer } = await sentAndWaiting();

    answer();

    expect(await screen.findByRole('region', { name: 'Authenticator set-up' })).toBeVisible();
    expect(whereIs(...SEED_FORMS)).toEqual(['page']);
  });
});

describe('the reference of a sign-in challenge and the code', () => {
  async function atTheSecondStep(
    second: () => Response = () => errorResponse(401, 'MFA_PROOF_INVALID'),
  ) {
    api = installFakeApi({
      [SIGN_IN]: () =>
        json(202, {
          challenge_id: CHALLENGE_ID,
          expires_at: '2026-10-24T09:05:00.000Z',
          trusted_browser_days: 7,
        }),
      [SECOND_STEP]: second,
    });
    const view = renderApp('/sign-in', probed);
    await view.user.type(
      await screen.findByLabelText('Work email (required)'),
      'admin@example.test',
    );
    await view.user.type(screen.getByLabelText('Password (required)'), PASSWORD);
    await view.user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Enter your code' });
    return view;
  }

  // Break caught: the challenge, which stands for a proved password, in the address, the history or a storage.
  it('keeps the challenge in memory only', async () => {
    await atTheSecondStep();

    expect(whereIs(CHALLENGE_ID, PASSWORD)).toEqual([]);
  });

  it('sends the challenge and the code in the body of the one request, and in no address or header', async () => {
    const view = await atTheSecondStep();
    await view.user.type(screen.getByLabelText('Authenticator code (required)'), CODE);

    await view.user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await screen.findByLabelText('Authenticator code (required)');

    const second = (await bodiesOf()).filter((body) => body.includes(CODE));
    expect(second).toHaveLength(1);
    expect(second[0]).toContain(CHALLENGE_ID);
    expect(requestsWithout(CODE)).toBe(true);
    expect(requestsWithout(CHALLENGE_ID)).toBe(true);
    expect(whereIs(CODE, CHALLENGE_ID)).toEqual([]);
  });

  // Break caught: a finished attempt leaving the challenge in memory, to be used by whoever comes to the page next.
  it('is forgotten when the attempt is finished', async () => {
    const view = await atTheSecondStep(() => errorResponse(401, 'CHALLENGE_UNUSABLE'));
    await view.user.type(screen.getByLabelText('Authenticator code (required)'), CODE);

    await view.user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await screen.findByRole('link', { name: 'Sign in again' });

    expect(whereIs(CODE, CHALLENGE_ID)).toEqual([]);
  });

  it('is gone with the page when it is hidden', async () => {
    await atTheSecondStep();

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});
