import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from '../../components/ui/button/Button';
import { Field } from '../../components/ui/field/Field';
import { fieldText, useSubmission } from '../../components/ui/form/use-submission';
import { OneTimeSecret } from '../../components/ui/one-time-secret/OneTimeSecret';
import { PasswordInput } from '../../components/ui/password-input/PasswordInput';
import { QrCode } from '../../components/ui/qr-code/QrCode';
import { errorResponse, installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { decodeRenderedSvg } from '../../test-support/qr-decode';
import { renderApp } from '../../test-support/render-app';
import { sessionFixture } from '../../test-support/session-fixture';
import { useApiClient } from '../api/api-client';
import { answerOf } from '../api/api-response';
import { useSessionStore } from '../session/session-context';
import type { SessionStore } from '../session/session-store';
import { groupedKey, manualKeyOf } from './otpauth';
import { useTransientSecret } from './use-transient-secret';

/**
 * The sentinel tests of S0.39b (plan section 3, Secrets; OB-23). A screen of the kind S0.43 builds is put together from
 * the pieces of this task and driven through the real application (the real router, providers, query client and API client,
 * with only the network replaced), with two planted values: a password a person types, and the seed of an authenticator the
 * API answers with. Then every place a value could be left is searched for them: the query and mutation caches, both web
 * storages, the cookies, the address and history state, the document title, the page, the console, and the requests.
 *
 * The page legitimately holds each value somewhere for a while (the password in its field until the form is sent; the seed
 * in the QR picture and the key field while they are shown). What these tests pin is *nowhere else*, and *gone* at
 * completion, at expiry, on navigation and when the page is hidden.
 */

const PASSWORD = 'Sentinel-Passw0rd-3c7e-Zq';
const SEED = 'SENTINELSEED234567ABCDEFGH';
const URI = `otpauth://totp/Melarc:synthetic.officer?secret=${SEED}&issuer=Melarc&period=30`;
const LIFETIME_MS = 5 * 60 * 1000;

/** Every form the seed can take on a page or in a cache: as sent, as shown in groups, as the whole URI, and as that URI encoded. */
const SEED_FORMS = [SEED, groupedKey(SEED), URI, encodeURIComponent(URI)];

const captured: { client: QueryClient | undefined; store: SessionStore | undefined } = {
  client: undefined,
  store: undefined,
};

function ClientProbe() {
  captured.client = useQueryClient();
  captured.store = useSessionStore();
  return null;
}

/** The screen under test: a new password, and then the enrolment material it is answered with. */
function EnrolmentScreen() {
  const client = useApiClient();
  const secret = useTransientSecret<string>();
  const [problem, setProblem] = useState(false);
  const submission = useSubmission(async (form) => {
    const password = fieldText(form, 'password');
    // The flow is begun before the request is sent and the answer is held only if the flow is still current when it arrives.
    const flow = secret.begin();
    try {
      const answer = answerOf(
        await client.POST('/auth/staff/setup/credential', {
          body: { setup_token: 'synthetic-setup-token', password },
          signal: flow.signal,
        }),
      );
      form.reset();
      setProblem(false);
      const uri = answer.data.mfa_provisioning?.otpauth_uri;
      if (uri === undefined) return 'failed';
      return secret.hold(flow, uri, LIFETIME_MS) ? 'accepted' : 'failed';
    } catch {
      setProblem(true);
      return 'failed';
    }
  });
  const key = secret.value === undefined ? undefined : manualKeyOf(secret.value);

  return (
    <>
      <ClientProbe />
      <h1 tabIndex={-1}>Enrolment</h1>
      {problem ? <p>The password could not be set.</p> : null}
      <form {...submission.formProps} aria-label="Set password">
        <Field label="New password" required>
          <PasswordInput name="password" autoComplete="new-password" />
        </Field>
        <Button type="submit" loading={submission.pending}>
          Set password
        </Button>
      </form>
      {secret.value !== undefined && key !== undefined ? (
        <section aria-label="Authenticator">
          <QrCode payload={secret.value} label="QR code for your authenticator app" />
          <OneTimeSecret label="Setup key" secret={key} />
          <Button
            type="button"
            onClick={() => {
              secret.clear();
            }}
          >
            Done
          </Button>
        </section>
      ) : null}
      {secret.status === 'expired' ? <p>The setup key expired.</p> : null}
      <p>
        <Link to="/elsewhere">Go elsewhere</Link>
      </p>
      <p>
        <Link to="/enrol?step=2">Next step of the same page</Link>
      </p>
    </>
  );
}

const routes = [
  { path: 'enrol', element: <EnrolmentScreen /> },
  { path: 'elsewhere', element: <h1 tabIndex={-1}>Elsewhere</h1> },
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
  api = installFakeApi({
    'POST /auth/staff/setup/credential': () =>
      json(200, {
        authentication_ready: false,
        mfa_enrolment_required: true,
        mfa_provisioning: { otpauth_uri: URI },
        mfa_setup_token: 'synthetic-mfa-token',
      }),
  });
});

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Every key and value of a web storage, as plain data. */
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
  if (holds(location.href)) places.push('address');
  if (holds(JSON.stringify(history.state ?? null))) places.push('history state');
  if (holds(document.title)) places.push('title');
  if (consoleOutput.some((line) => holds(line))) places.push('console');
  const live = [...document.querySelectorAll<HTMLInputElement>('input, textarea')].some((field) =>
    holds(field.value),
  );
  if (holds(document.documentElement.outerHTML) || live) places.push('page');
  return places;
}

async function bodiesOf(): Promise<string[]> {
  return Promise.all(api.requests.map((request) => request.clone().text()));
}

describe('a password the person types', () => {
  // Break caught: a password that a screen leaves behind: in a cache or storage, in the address of the form's submit, or
  // still in the field after it has been sent.
  it('is in the field while typed and the request body once, and nowhere else, then gone', async () => {
    const { user } = renderApp('/enrol', routes);
    const field = await screen.findByLabelText('New password (required)');

    await user.type(field, PASSWORD);
    expect(whereIs(PASSWORD)).toEqual(['page']);

    await user.click(screen.getByRole('button', { name: 'Set password' }));
    await screen.findByRole('region', { name: 'Authenticator' });

    expect(whereIs(PASSWORD)).toEqual([]);
    const bodies = await bodiesOf();
    expect(bodies.filter((body) => body.includes(PASSWORD))).toHaveLength(1);
    expect(api.requests.map((request) => request.url).join('\n')).not.toContain(PASSWORD);
    expect(
      api.requests.flatMap((request) => [...request.headers.values()]).join('\n'),
    ).not.toContain(PASSWORD);
  });

  // Break caught: a rejected password echoed back in the error, or kept for the next try.
  it('is not echoed or kept when the request is refused', async () => {
    api.on('POST /auth/staff/setup/credential', () =>
      errorResponse(400, 'VALIDATION_FAILED', {
        violations: [{ in: 'body', pointer: '/password', rule: 'minLength' }],
      }),
    );
    const { user } = renderApp('/enrol', routes);
    await user.type(await screen.findByLabelText('New password (required)'), PASSWORD);

    await user.click(screen.getByRole('button', { name: 'Set password' }));

    expect(await screen.findByText('The password could not be set.')).toBeVisible();
    // It stays in the field, where the person typed it and can correct it, and in no other place.
    expect(whereIs(PASSWORD)).toEqual(['page']);
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  // Break caught: a password left shown on the screen after the form is sent.
  it('is hidden again after the form is sent, if the person had shown it', async () => {
    const { user } = renderApp('/enrol', routes);
    const field = await screen.findByLabelText<HTMLInputElement>('New password (required)');
    await user.type(field, PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Set password' }));
    await screen.findByRole('region', { name: 'Authenticator' });

    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveValue('');
  });
});

describe('the seed an authenticator is set up with', () => {
  async function shown() {
    const view = renderApp('/enrol', routes);
    await view.user.type(await screen.findByLabelText('New password (required)'), PASSWORD);
    await view.user.click(screen.getByRole('button', { name: 'Set password' }));
    await screen.findByRole('region', { name: 'Authenticator' });
    return view;
  }

  // Break caught: the seed anywhere but the screen that shows it: the proof that the setup is transient (OB-23).
  it('is on the screen and nowhere else while it is shown: not in a cache, storage, the address, the title or the console', async () => {
    await shown();

    expect(whereIs(...SEED_FORMS)).toEqual(['page']);
  });

  // Break caught: the picture and the typed key disagreeing, or the picture not being a code that scans to the credential.
  it('is shown as a picture that decodes to the whole URI and as the same key to type by hand', async () => {
    await shown();
    const region = screen.getByRole('region', { name: 'Authenticator' });

    const svg = within(region).getByRole('img', { name: 'QR code for your authenticator app' });
    expect(decodeRenderedSvg(svg as unknown as SVGSVGElement)).toBe(URI);
    expect(within(region).getByRole('textbox', { name: 'Setup key' })).toHaveValue(
      groupedKey(SEED),
    );
  });

  // Break caught: the seed's picture and key staying on the screen once the person has finished.
  it('is gone from the page at completion', async () => {
    const { user } = await shown();

    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByRole('region', { name: 'Authenticator' })).toBeNull();
    expect(whereIs(...SEED_FORMS)).toEqual([]);
  });

  // Break caught: a secret outliving the lifetime the screen gave it.
  it('is gone from the page at expiry, and the person is told it expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await shown();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME_MS);
    });

    expect(await screen.findByText('The setup key expired.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Authenticator' })).toBeNull();
    expect(whereIs(...SEED_FORMS)).toEqual([]);
  });

  // Break caught: the secret still there when the person has gone to another page and comes back with the back button.
  it('is gone from the page on navigation, and does not return with the back button', async () => {
    const { user, router } = await shown();

    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }));
    expect(await screen.findByRole('heading', { name: 'Elsewhere' })).toBeVisible();
    expect(whereIs(...SEED_FORMS)).toEqual([]);

    await act(async () => {
      await router.navigate(-1);
    });
    await screen.findByRole('heading', { name: 'Enrolment' });

    expect(screen.queryByRole('region', { name: 'Authenticator' })).toBeNull();
    expect(whereIs(...SEED_FORMS)).toEqual([]);
  });

  // Break caught: the page, with the seed on it, kept by the browser's back-forward cache and shown again.
  it('is gone from the page when the page is hidden', async () => {
    await shown();

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    await waitFor(() => {
      expect(whereIs(...SEED_FORMS)).toEqual([]);
    });
    expect(screen.queryByRole('region', { name: 'Authenticator' })).toBeNull();
  });

  // Break caught: the seed written to the console by a diagnostic, or to the error text of a failure.
  it('is in no log line of the whole run', async () => {
    const { user } = await shown();
    await user.click(screen.getByRole('button', { name: 'Done' }));

    for (const form of [...SEED_FORMS, PASSWORD]) {
      expect(consoleOutput.join('\n')).not.toContain(form);
    }
  });
});

describe('a seed whose answer arrives late (U02 of 23 October 2026)', () => {
  /**
   * The password is sent and the API's answer, which holds the seed, is kept on the network until the test lets it go. The test
   * does something first, and the answer then arrives at a screen that has already been left, ended or hidden.
   */
  async function sentAndWaiting() {
    let release: (response: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    api.on('POST /auth/staff/setup/credential', () => gate);
    const view = renderApp('/enrol', routes);
    await view.user.type(await screen.findByLabelText('New password (required)'), PASSWORD);
    await view.user.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() => {
      expect(api.requests.some((request) => request.method === 'POST')).toBe(true);
    });
    const answer = () => {
      release(
        json(200, {
          authentication_ready: false,
          mfa_enrolment_required: true,
          mfa_provisioning: { otpauth_uri: URI },
          mfa_setup_token: 'synthetic-mfa-token',
        }),
      );
    };
    return { ...view, answer, gate };
  }

  const nothingShown = async (gate: Promise<Response>) => {
    await act(async () => {
      await gate;
    });
    // Let the screen finish with the answer, whatever it does with it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole('region', { name: 'Authenticator' })).toBeNull();
    expect(whereIs(...SEED_FORMS)).toEqual([]);
  };

  // Break caught: a seed asked for on one screen appearing on the next, or in a cache, after the person has gone elsewhere.
  it('is shown and kept nowhere when the person has gone to another page', async () => {
    const { user, answer, gate } = await sentAndWaiting();
    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }));
    expect(await screen.findByRole('heading', { name: 'Elsewhere' })).toBeVisible();

    answer();

    await nothingShown(gate);
    expect(screen.getByRole('heading', { name: 'Elsewhere' })).toBeVisible();
  });

  // Break caught: the screen staying mounted when the address changes under it (a step, a query string), so that unmounting is no
  // protection and only the flow's own check stands between the late answer and the screen.
  it('is shown and kept nowhere when the address changes under the same screen before it arrives', async () => {
    const { user, answer, gate } = await sentAndWaiting();
    await user.click(screen.getByRole('link', { name: 'Next step of the same page' }));
    expect(screen.getByRole('heading', { name: 'Enrolment' })).toBeVisible();

    answer();

    await nothingShown(gate);
  });

  // Break caught: the seed of a person whose session has ended being shown on a page that is still open, or held for the next person.
  it('is shown and kept nowhere when the session ends before it arrives', async () => {
    const { answer, gate } = await sentAndWaiting();
    act(() => {
      captured.store?.signedIn(sessionFixture());
    });
    act(() => {
      captured.store?.end();
    });

    answer();

    await nothingShown(gate);
  });

  it('is shown and kept nowhere when the page is hidden before it arrives', async () => {
    const { answer, gate } = await sentAndWaiting();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    answer();

    await nothingShown(gate);
  });

  // Break caught: the guard refusing the answer it should take: the same screen, left alone, still shows what it asked for.
  it('is shown when nothing happened in between', async () => {
    const { answer } = await sentAndWaiting();

    answer();

    expect(await screen.findByRole('region', { name: 'Authenticator' })).toBeVisible();
    expect(whereIs(...SEED_FORMS)).toEqual(['page']);
  });
});
