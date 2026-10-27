import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '../../../platform/session/session-context';
import type { SessionStore } from '../../../platform/session/session-store';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { decodeRenderedSvg } from '../../../test-support/qr-decode';
import {
  ENROLMENT_FORMS,
  ENROLMENT_URI,
  enrolmentGrantFixture,
  OTHER_RIDER_ID,
  RIDER_HUB_ID,
  RIDER_ID,
  riderDetailFixture,
  unboundRider,
} from '../../../test-support/rider-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/admin/riders/{id}/device/register` (`registerRiderDevice`; S0.60b; the render clause of AC-SLICE-000-40, and -124). The first binding of a rider's device, in person:
 * the officer asks for a code, the API makes one single-use grant, and the page draws it as a QR code for the rider to scan. **The QR is the
 * credential.** It is drawn as modules and written nowhere (the sentinel tests below plant the code and look in every place it could be left),
 * and it is gone at completion, at expiry, on navigation, when the page is hidden, when the session ends, and when its answer arrives late.
 */
const REGISTER = `POST /ops/riders/${RIDER_ID}/device/register`;
const RECORD = `GET /ops/riders/${RIDER_ID}`;
const REGISTERER = ['dispatch.read', 'staff.device.register'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const QR_NAME = 'QR code for the rider’s handset';
const LIFETIME_MS = 5 * 60 * 1000;

const captured: { client: QueryClient | undefined; store: SessionStore | undefined } = {
  client: undefined,
  store: undefined,
};

/** A page of the test that hands it the query cache and the session store, which the real application keeps for its whole life. */
function Probe() {
  captured.client = useQueryClient();
  captured.store = useSessionStore();
  return <h1 tabIndex={-1}>Probe</h1>;
}

const routes = [
  { path: 'probe', element: <Probe /> },
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
});

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The page, opened as a signed-in session that holds `keys`, the way a person gets there: by an address, from another page. */
async function open(
  keys: readonly string[] = REGISTERER,
  handlers: Record<string, Handler> = {},
  riderId = RIDER_ID,
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, { authorized_hubs: [{ id: RIDER_HUB_ID, display_name: 'Accra Central' }] }),
      {
        [RECORD]: () => json(200, riderDetailFixture(unboundRider(), []), etag('v1')),
        [REGISTER]: () => json(200, enrolmentGrantFixture({}, LIFETIME_MS)),
        ...handlers,
      },
    ),
  );
  const view = renderApp('/probe', routes);
  await screen.findByRole('heading', { name: 'Probe' });
  await act(async () => {
    await view.router.navigate(`/admin/riders/${riderId}/device/register`);
  });
  return view;
}

const posts = () => api.requests.filter((request) => request.method === 'POST');
const reads = () =>
  api.requests.filter((request) => request.url.endsWith(`/ops/riders/${RIDER_ID}`));

/** The code asked for and drawn. */
async function shown(handlers: Record<string, Handler> = {}) {
  const view = await open(REGISTERER, handlers);
  await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
  await screen.findByRole('img', { name: QR_NAME });
  return view;
}

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

describe('the first binding: before a code is asked for', () => {
  it('explains what happens and shows no code, and sends nothing but the read of the rider', async () => {
    await open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Register a first device' }),
    ).toBeVisible();
    expect(document.title).toBe('Register a first device · Melarc Ops Portal');
    expect(await screen.findByText('For Kwame Mensah.')).toBeVisible();
    expect(screen.getByText(/Do this in person, with the rider and the handset/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show the QR code' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to the rider' })).toHaveAttribute(
      'href',
      `/admin/riders/${RIDER_ID}`,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  // Break caught: a code asked for by merely opening the page, which would make a grant for a rider nobody is with.
  it('asks for nothing until the officer presses the button', async () => {
    await open();
    await screen.findByText('For Kwame Mensah.');

    expect(posts()).toHaveLength(0);
  });

  // Break caught: a first binding offered for a rider who already has a device, which the server refuses as STATE_CONFLICT.
  it('offers no code to a rider who already has a device, and points at the replacement for a session that may replace', async () => {
    await open([...REGISTERER, 'staff.device.revoke'], {
      [RECORD]: () => json(200, riderDetailFixture(), etag('v1')),
    });

    expect(
      await screen.findByText(/This rider already has a device, or has had one revoked/),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show the QR code' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Replace the device instead.' })).toHaveAttribute(
      'href',
      `/admin/riders/${RIDER_ID}/device`,
    );
  });

  it('says where the replacement is done, without a link, to a session that may not open that page', async () => {
    await open(REGISTERER, { [RECORD]: () => json(200, riderDetailFixture(), etag('v1')) });

    expect(
      await screen.findByText(
        /Replacing it is done from the device page, which your session cannot open\./,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Replace the device instead.' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show the QR code' })).toBeNull();
  });

  // Break caught: a first binding offered for a rider whose access has ended.
  it.each(['SUSPENDED', 'OFFBOARDED'] as const)(
    'offers no code to a rider who is %s',
    async (status) => {
      await open(REGISTERER, {
        [RECORD]: () => json(200, riderDetailFixture(unboundRider({ status }), []), etag('v1')),
      });

      expect(
        await screen.findByText(
          'A device cannot be registered while this rider’s access has ended.',
        ),
      ).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Show the QR code' })).toBeNull();
    },
  );

  // The roster may be out of reach of a session that is allowed to bind (a grant at every hub with no `dispatch.read` at one): the server decides.
  it('does not depend on the read of the rider, and lets the server decide', async () => {
    await open(REGISTERER, { [RECORD]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });

    expect(await screen.findByRole('button', { name: 'Show the QR code' })).toBeVisible();
    expect(screen.queryByText(/^For .*\.$/)).toBeNull();
  });

  // Break caught: an address that is not a rider's being sent to the API.
  it('is a page of its own, with no request, for an address that is not an id', async () => {
    await open(REGISTERER, {}, 'not-an-id');

    expect(await screen.findByRole('heading', { level: 1, name: 'Rider not found' })).toBeVisible();
    expect(posts()).toHaveLength(0);
    expect(reads()).toHaveLength(0);
  });
});

describe('the first binding: the code', () => {
  // Break caught: a registration sent with a version or without a key, or with a body, which the contract does not take.
  it('asks once, under an Idempotency-Key and with no version and no body', async () => {
    await shown();

    expect(posts()).toHaveLength(1);
    const [sent] = posts();
    expect(sent?.url).toContain(`/ops/riders/${RIDER_ID}/device/register`);
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(sent?.headers.has('If-Match')).toBe(false);
    expect(await sent?.text()).toBe('');
  });

  // Break caught: the picture and the code disagreeing, or a picture that is not a code that scans to the credential.
  it('draws a picture that decodes to the whole code, named for what it is for', async () => {
    await shown();

    const svg = screen.getByRole('img', { name: QR_NAME });

    expect(decodeRenderedSvg(svg as unknown as SVGSVGElement)).toBe(ENROLMENT_URI);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Scan this code with the rider’s handset' }),
    ).toBeVisible();
  });

  // Break caught: the credential anywhere but the picture: the proof that the code is transient (SECURITY_DESIGN §13.6).
  it('is in the picture and nowhere else while it is shown: not in text, an attribute, a cache, storage, the address, the title or the console', async () => {
    await shown();

    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });

  // Break caught: a copy button, a link, a field or a download that turns the credential into text an officer can send.
  it('offers no way to copy, send or open the code: no field, no link, only the two buttons', async () => {
    await shown();
    const region = screen.getByRole('region', { name: 'Scan this code with the rider’s handset' });

    expect(
      within(region)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['The rider has scanned it', 'Make a new code']);
    expect(within(region).queryAllByRole('link')).toEqual([]);
    expect(
      region.querySelectorAll('input, textarea, a, [contenteditable], title, desc'),
    ).toHaveLength(0);
  });

  it('says it works once, until when, that it is shown here only, and that it is not to be photographed or sent', async () => {
    await shown();
    const region = screen.getByRole('region', { name: 'Scan this code with the rider’s handset' });

    expect(within(region).getByText(/The code works once, until /)).toBeVisible();
    expect(within(region).getByText(/shown on this screen only and is not kept/)).toBeVisible();
    expect(within(region).getByText(/Do not photograph it or send it to anyone/)).toBeVisible();
    expect(within(region).getByText(/you never see it/)).toBeVisible();
  });

  // Break caught: focus left on the document when the button that asked for the code has gone, so that a screen reader says nothing of the code
  // that appeared, or of its lapse.
  it('takes focus onto its region when it appears, and onto the news when it has lapsed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await shown();
    expect(
      screen.getByRole('region', { name: 'Scan this code with the rider’s handset' }),
    ).toHaveFocus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME_MS);
    });

    const news = await screen.findByRole('alert');
    expect(news.closest('.rider-code')).toHaveFocus();
  });

  // Break caught: the credential written to a log line by a diagnostic or by the text of a failure.
  it('is in no log line of the whole run', async () => {
    const { user } = await shown();
    await user.click(screen.getByRole('button', { name: 'The rider has scanned it' }));

    for (const form of ENROLMENT_FORMS) {
      expect(consoleOutput.join('\n')).not.toContain(form);
    }
  });

  // Break caught: a code carried to the API in the address or a header of a later request.
  it('is in no request the page sends', async () => {
    const { user } = await shown();
    await user.click(screen.getByRole('button', { name: 'The rider has scanned it' }));

    const sent = api.requests.map(
      (request) => `${request.url}\n${[...request.headers.values()].join('\n')}`,
    );
    for (const form of ENROLMENT_FORMS) {
      expect(sent.join('\n')).not.toContain(form);
    }
  });
});

describe('the first binding: when the code is gone', () => {
  // Break caught: the picture staying on the screen once the rider has scanned it.
  it('is gone at completion, and the officer is taken back to the rider', async () => {
    const { user, router } = await shown({
      [RECORD]: () => json(200, riderDetailFixture(unboundRider(), []), etag('v1')),
    });

    await user.click(screen.getByRole('button', { name: 'The rider has scanned it' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/admin/riders/${RIDER_ID}`);
    });
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });

  // Break caught: a code outliving the lifetime the server gave it, or a lapsed code left on the screen.
  it('is gone at expiry, the officer is told it lapsed, and a new one can be made', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = await shown();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME_MS);
    });

    expect(await screen.findByText(/The code has expired and is no longer shown/)).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Make a new code' }));
    expect(await screen.findByRole('img', { name: QR_NAME })).toBeVisible();
    expect(posts()).toHaveLength(2);
    expect(screen.queryByText(/The code has expired/)).toBeNull();
  });

  // Break caught: the code still there when the officer has gone to another page and comes back with the back button.
  it('is gone on navigation, and does not return with the back button', async () => {
    const { router } = await shown();

    await act(async () => {
      await router.navigate('/elsewhere');
    });
    expect(await screen.findByRole('heading', { name: 'Elsewhere' })).toBeVisible();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);

    await act(async () => {
      await router.navigate(-1);
    });
    await screen.findByRole('heading', { level: 1, name: 'Register a first device' });

    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });

  // Break caught: the page, with the code on it, kept by the browser's back-forward cache and shown again.
  it('is gone when the page is hidden', async () => {
    await shown();

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    await waitFor(() => {
      expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    });
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });

  // Break caught: the code of a person whose session has ended being left on a page that is still open.
  it('is gone when the session ends', async () => {
    await shown();

    act(() => {
      captured.store?.end();
    });

    await waitFor(() => {
      expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    });
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });

  // Break caught: a new code made while the old one was still on the screen, so that two credentials are drawn or the old one stays.
  it('is replaced, and not joined, by a new code, and the old one is nowhere', async () => {
    const second = `melarc-rider://enrol/v1#token=${'SecondEnrolmentToken'.padEnd(43, 'x')}&challenge=${'SecondEnrolmentChallenge'.padEnd(43, 'y')}`;
    expect(second).toHaveLength(127);
    let asked = 0;
    const { user } = await shown({
      [REGISTER]: () => {
        asked += 1;
        return json(
          200,
          enrolmentGrantFixture(
            { enrolment_uri: asked === 1 ? ENROLMENT_URI : second },
            LIFETIME_MS,
          ),
        );
      },
    });

    await user.click(screen.getByRole('button', { name: 'Make a new code' }));
    await waitFor(() => {
      expect(posts()).toHaveLength(2);
    });

    await waitFor(() => {
      const svg = screen.getByRole('img', { name: QR_NAME });
      expect(decodeRenderedSvg(svg as unknown as SVGSVGElement)).toBe(second);
    });
    expect(screen.getAllByRole('img', { name: QR_NAME })).toHaveLength(1);
    expect(whereIs(...ENROLMENT_FORMS, second, encodeURIComponent(second))).toEqual([]);
    // Each new code is a new command: its own key.
    expect(posts()[0]?.headers.get('Idempotency-Key')).not.toBe(
      posts()[1]?.headers.get('Idempotency-Key'),
    );
  });
});

describe('the first binding: a code whose answer arrives late', () => {
  /**
   * The request is sent and the API's answer, which holds the code, is kept on the network until the test lets it go. The test does something
   * first, and the answer then arrives at a screen that has already been left, ended or hidden.
   */
  async function sentAndWaiting() {
    let release: (response: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const view = await open(REGISTERER, { [REGISTER]: () => gate });
    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    const answer = () => {
      release(json(200, enrolmentGrantFixture({}, LIFETIME_MS)));
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
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  };

  // Break caught: a code asked for on one screen appearing on the next, or in a cache, after the officer has gone elsewhere.
  it('is shown and kept nowhere when the officer has gone to another page', async () => {
    const { router, answer, gate } = await sentAndWaiting();
    await act(async () => {
      await router.navigate('/elsewhere');
    });
    expect(await screen.findByRole('heading', { name: 'Elsewhere' })).toBeVisible();

    answer();

    await nothingShown(gate);
    expect(screen.getByRole('heading', { name: 'Elsewhere' })).toBeVisible();
  });

  // Break caught: the screen staying mounted when the address changes under it, so that unmounting is no protection.
  it('is shown and kept nowhere when the address changes under the same screen before it arrives', async () => {
    const { router, answer, gate } = await sentAndWaiting();
    await act(async () => {
      await router.navigate(`/admin/riders/${RIDER_ID}/device/register?again=1`);
    });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Register a first device' }),
    ).toBeVisible();

    answer();

    await nothingShown(gate);
  });

  // Break caught: the code of a person whose session has ended being shown to the next, or held for them.
  it('is shown and kept nowhere when the session ends before it arrives', async () => {
    const { answer, gate } = await sentAndWaiting();
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

    expect(await screen.findByRole('img', { name: QR_NAME })).toBeVisible();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });
});

describe('the first binding: an answer that is lost or is not the API’s', () => {
  const lost = () => Promise.reject(new TypeError('Failed to fetch'));

  // Break caught: a lost answer that is told as a refusal ("nothing was changed") when a grant may have been made.
  it('says the outcome is not known, offers to try again under the same key and to check the rider, and shows no code', async () => {
    const view = await open(REGISTERER, { [REGISTER]: lost });

    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));

    expect(
      await screen.findByText(
        'We could not confirm whether the code was made. Try again: the same attempt is repeated safely, and no second code is made.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check the rider' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });

  // Break caught: a retry that makes a second grant: the retry must carry the key of the first attempt.
  it('repeats the same attempt under the same key, and then shows the code', async () => {
    let attempts = 0;
    const view = await open(REGISTERER, {
      [REGISTER]: () => {
        attempts += 1;
        return attempts === 1
          ? lost()
          : Promise.resolve(json(200, enrolmentGrantFixture({}, LIFETIME_MS)));
      },
    });
    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
    await view.user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('img', { name: QR_NAME })).toBeVisible();
    expect(posts()).toHaveLength(2);
    expect(posts()[1]?.headers.get('Idempotency-Key')).toBe(
      posts()[0]?.headers.get('Idempotency-Key'),
    );
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });

  // Break caught: checking the record leaving the old attempt's key in force, so that the next code replays an unseen one.
  it('reads the rider again to check, and a code asked for after that is a new command with a new key', async () => {
    let attempts = 0;
    const view = await open(REGISTERER, {
      [REGISTER]: () => {
        attempts += 1;
        return attempts === 1
          ? lost()
          : Promise.resolve(json(200, enrolmentGrantFixture({}, LIFETIME_MS)));
      },
    });
    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
    await view.user.click(await screen.findByRole('button', { name: 'Check the rider' }));
    await waitFor(() => {
      expect(reads()).toHaveLength(2);
    });

    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));

    expect(await screen.findByRole('img', { name: QR_NAME })).toBeVisible();
    expect(posts()[1]?.headers.get('Idempotency-Key')).not.toBe(
      posts()[0]?.headers.get('Idempotency-Key'),
    );
  });

  // Break caught: a 200 with something other than the contract's code taken as the code: a wrong form is never drawn.
  it.each([
    ['another version', ENROLMENT_URI.replace('/v1#', '/v2#')],
    ['another host', ENROLMENT_URI.replace('//enrol/', '//evil/')],
    ['a code with a trailing parameter', `${ENROLMENT_URI}&callback=https://evil.example`],
  ])('does not draw a code that is %s, and says the outcome is not known', async (_label, uri) => {
    const view = await open(REGISTERER, {
      [REGISTER]: () => json(200, enrolmentGrantFixture({ enrolment_uri: uri }, LIFETIME_MS)),
    });

    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));

    expect(await screen.findByText(/We could not confirm whether the code was made/)).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(uri)).toEqual([]);
  });

  // Break caught: a code made for another rider being drawn for this one.
  it('does not draw a code that names another rider', async () => {
    const view = await open(REGISTERER, {
      [REGISTER]: () => json(200, enrolmentGrantFixture({ rider_id: OTHER_RIDER_ID }, LIFETIME_MS)),
    });

    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));

    expect(await screen.findByText(/We could not confirm whether the code was made/)).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
  });

  // Break caught: a code that is already past its end being drawn for an instant.
  it('does not draw a code whose time has already passed', async () => {
    const view = await open(REGISTERER, {
      [REGISTER]: () => json(200, enrolmentGrantFixture({}, -1000)),
    });

    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));

    expect(await screen.findByText(/The code has expired and is no longer shown/)).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });
});

describe('the first binding: when the API refuses', () => {
  async function ask(handler: Handler) {
    const view = await open(REGISTERER, { [REGISTER]: handler });
    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
    return view;
  }

  // Break caught: a refusal worded as the operation's general failure, which would hide what the officer can do about it.
  it.each([
    [
      409,
      'STATE_CONFLICT',
      /A first device cannot be registered for this rider\. The rider already has an active device/,
    ],
    [403, 'PERMISSION_DENIED', /staff\.device\.register/],
    [403, 'HUB_SCOPE_VIOLATION', /hub your session does not act in/],
    [404, 'NOT_FOUND', /This rider could not be found\./],
  ])('words a %s %s for what it is', async (status, code, words) => {
    await ask(() => refusal(status, code));

    expect(await screen.findByText(words)).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('words any other refusal as the general failure, with the reference, and never the server’s text', async () => {
    await ask(() => refusal(400, 'VALIDATION_FAILED'));

    expect(
      await screen.findByText('The code could not be made. Nothing was changed.'),
    ).toBeVisible();
    expect(screen.getByText(/^Reference: req-test-1$/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  // Break caught: a fault of the server (which also answers so for a commit it cannot vouch for) told as "nothing was changed".
  it('does not say nothing was changed for a fault of the server: the outcome is not known', async () => {
    await ask(() => refusal(500, 'INTERNAL_ERROR'));

    expect(await screen.findByText(/We could not confirm whether the code was made/)).toBeVisible();
    expect(screen.queryByText(/Nothing was changed/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  // Break caught: a refusal that locks the page: after it the officer asks again, as a new command.
  it('lets the officer ask again after a refusal', async () => {
    let attempts = 0;
    const view = await ask(() => {
      attempts += 1;
      return attempts === 1
        ? refusal(400, 'VALIDATION_FAILED')
        : json(200, enrolmentGrantFixture({}, LIFETIME_MS));
    });
    await screen.findByText('The code could not be made. Nothing was changed.');

    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));

    expect(await screen.findByRole('img', { name: QR_NAME })).toBeVisible();
  });
});

describeInterfaceStates('The first binding', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const view = await open(REGISTERER, { [REGISTER]: () => gate });
      await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
      expect(await screen.findByRole('button', { name: 'Show the QR code' })).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await act(async () => {
        release(json(200, enrolmentGrantFixture({}, LIFETIME_MS)));
        await gate;
      });
      expect(await screen.findByRole('img', { name: QR_NAME })).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'The page lists nothing: before a code is asked for it explains the step, and a rider who cannot be bound is told why (the tests above).',
  },
  'validation error': {
    inapplicable:
      'The page takes no input from the officer: the rider is in the address and the key is the command’s. An address that is not an id is the not-found page.',
  },
  error: {
    test: async () => {
      const view = await open(REGISTERER, { [REGISTER]: () => refusal(400, 'VALIDATION_FAILED') });
      await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
      expect(
        await screen.findByText('The code could not be made. Nothing was changed.'),
      ).toBeVisible();
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = await open(REGISTERER, {
        [REGISTER]: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new TypeError('Failed to fetch'))
            : Promise.resolve(json(200, enrolmentGrantFixture({}, LIFETIME_MS)));
        },
      });
      await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
      await view.user.click(await screen.findByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('img', { name: QR_NAME })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const view = await open(REGISTERER, { [REGISTER]: () => refusal(409, 'STATE_CONFLICT') });
      await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
      expect(
        await screen.findByText(/A first device cannot be registered for this rider/),
      ).toBeVisible();
      expect(screen.getByRole('button', { name: 'Reload the rider' })).toBeVisible();
    },
  },
  success: {
    test: async () => {
      await shown();
      expect(screen.getByRole('img', { name: QR_NAME })).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      await open(['dispatch.read']);
      expect(await screen.findByText(/staff\.device\.register/)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Show the QR code' })).toBeNull();
    },
  },
});
