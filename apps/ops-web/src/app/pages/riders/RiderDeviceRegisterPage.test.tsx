import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { use } from 'react';
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
import { cannotText } from '../../../platform/problem/capability-words';

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
/** What a code that has left the screen is told in: what the page did, and nothing about what the server holds. */
const LAPSED = /The QR code is no longer displayed\./;

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

/** A page that is not drawn for a while (an engine under load, a chunk on its way): the page the person left stays on the screen until it is. */
function NotYet(): null {
  use(new Promise<never>(() => undefined));
  return null;
}

const routes = [
  { path: 'probe', element: <Probe /> },
  { path: 'elsewhere', element: <h1 tabIndex={-1}>Elsewhere</h1> },
  { path: 'not-yet', element: <NotYet /> },
];

/** What follows the focus in the test that is running (`followFocus`), taken off when it ends. */
const followers: (() => void)[] = [];
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
  for (const unfollow of followers.splice(0)) unfollow();
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

/** An element that takes the focus, as the officer would name it: a button by its label, the news and the code by what they are. */
function labelOf(element: HTMLElement): string {
  const text = element.textContent.trim();
  if (element.tagName === 'BUTTON') return text;
  if (text.startsWith('The earlier code is no longer shown')) return 'the notice';
  if (text.startsWith('Scan this code')) return 'the code';
  return element.tagName.toLowerCase();
}

/**
 * The elements that take the focus from now on, in order. Where the focus goes is what an officer who cannot see the page has to go on, and a
 * trail shows what a final `toHaveFocus` cannot: a focus that moves twice, or moves when the officer has put it somewhere else.
 */
function followFocus() {
  const trail: string[] = [];
  const record = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement) trail.push(labelOf(event.target));
  };
  document.addEventListener('focusin', record);
  // Taken off after the test, whatever it ended in, so that a failure here is not a trail in the next test.
  followers.push(() => {
    document.removeEventListener('focusin', record);
  });
  return { trail };
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
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
        name: 'Riders',
      }),
    ).toHaveAttribute('href', '/admin/riders');
    // No picture on the page: the QR code is the only one it ever draws. (The page, not the document: the sidebar around it draws the logo.)
    expect(within(screen.getByRole('main')).queryByRole('img')).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  // Break caught (the PO's decision of 9 November 2026): paragraphs and lists of rules above the content. A task form keeps at most two short sentences under its title.
  it('tells the task in two short sentences, with no list of steps', async () => {
    await open();
    const intro = await screen.findByText(/Do this in person, with the rider and the handset/);

    expect(intro.textContent.split(/(?<=\.)\s+/)).toHaveLength(2);
    expect(screen.queryByText(/Check that this is the rider/)).toBeNull();
    expect(screen.queryByText(/Then come back here/)).toBeNull();
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

    const news = await screen.findByText(LAPSED);
    expect(news).toBeVisible();
    // The page drops the code at its own limit, which is shorter than the grant's life: it may still stand at the server, so the words claim
    // nothing of the kind.
    expect(news).toHaveTextContent(
      'The QR code is no longer displayed. Make a new code when the rider is ready.',
    );
    expect(news.textContent).not.toMatch(/expired|can no longer be used|invalid|cancel/i);
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Make a new code' }));
    expect(await screen.findByRole('img', { name: QR_NAME })).toBeVisible();
    expect(posts()).toHaveLength(2);
    expect(screen.queryByText(LAPSED)).toBeNull();
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

  // Break caught (found in WebKit on 9 November 2026, riders.spec.ts "is gone on navigation, and does not return with the back button"): the code let go of only when the page it was on is
  // replaced. The page a navigation leads to may take a while to be drawn; until it is, the page the person left is still on the screen with the code on it, and a Back in that time shows it
  // again. The code is let go of the moment the router moves.
  it('is gone the moment the router moves, before the next page has been drawn', async () => {
    const { router } = await shown();

    await act(async () => {
      void router.navigate('/not-yet');
      await Promise.resolve();
    });

    expect(router.state.location.pathname).toBe('/not-yet');
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

describe('the first binding: a new code asked for while a code is on the screen', () => {
  const SECOND_URI = `melarc-rider://enrol/v1#token=${'SecondEnrolmentToken'.padEnd(43, 'x')}&challenge=${'SecondEnrolmentChallenge'.padEnd(43, 'y')}`;
  const SECOND_FORMS = [SECOND_URI, encodeURIComponent(SECOND_URI)];
  const lost = () => Promise.reject(new TypeError('Failed to fetch'));
  const second = () => json(200, enrolmentGrantFixture({ enrolment_uri: SECOND_URI }, LIFETIME_MS));

  /** The first ask is answered with the first code; each ask after it with the next of `then`, in order. */
  function firstThen(...then: readonly Handler[]): Handler {
    let asked = 0;
    return (request) => {
      asked += 1;
      if (asked === 1) return json(200, enrolmentGrantFixture({}, LIFETIME_MS));
      const next = then[asked - 2];
      if (next === undefined) throw new Error('The test did not expect another request');
      return next(request);
    };
  }

  /** A request that is on its way until the test lets the answer go or loses it. */
  function waiting() {
    let release: (response: Response) => void = () => undefined;
    let lose: () => void = () => undefined;
    const answer = new Promise<Response>((resolve, reject) => {
      release = resolve;
      lose = () => {
        reject(new TypeError('Failed to fetch'));
      };
    });
    return { answer: () => answer, release, lose };
  }

  const keysOfPosts = () => posts().map((post) => post.headers.get('Idempotency-Key'));
  const oneCodeDrawn = (uri: string) => {
    expect(screen.getAllByRole('img', { name: QR_NAME })).toHaveLength(1);
    expect(
      decodeRenderedSvg(screen.getByRole('img', { name: QR_NAME }) as unknown as SVGSVGElement),
    ).toBe(uri);
  };

  // Break caught: the earlier code left on the screen, with no news and no way out, when the answer to a new code is lost. The new code may have
  // been made and the earlier one ended; the button left behind asks for nothing, because the command is unresolved.
  it('takes the earlier code off the screen, says the outcome is not known and offers the way out, when the answer is lost', async () => {
    const { user } = await shown({ [REGISTER]: firstThen(lost) });

    await user.click(screen.getByRole('button', { name: 'Make a new code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not confirm whether the code was made. Try again: the same attempt is repeated safely, and no second code is made.',
    );
    expect(screen.getByRole('button', { name: 'Check the rider' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make a new code' })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
    expect(posts()).toHaveLength(2);
  });

  // Break caught: the earlier code taken off the screen without a word, or worded as ended: taking it off the screen ends nothing, and the focus
  // (on the button that has gone) falling to the document, where a screen reader says nothing.
  it('says what became of the earlier code without saying it was ended, and keeps the focus on the page', async () => {
    const { user } = await shown({ [REGISTER]: firstThen(lost) });

    await user.click(screen.getByRole('button', { name: 'Make a new code' }));
    await screen.findByRole('alert');

    const news = screen.getByText(/The earlier code is no longer shown\./);
    expect(news).toHaveTextContent(
      'The earlier code is no longer shown. Taking it off the screen does not end it; making a new code does.',
    );
    expect(news.parentElement).toHaveFocus();
  });

  // Break caught: a retry that makes a second code: the retry carries the key of the new code's first attempt, and the earlier code is not drawn again.
  it('repeats the same attempt under the same key, and then draws the new code alone', async () => {
    const { user } = await shown({ [REGISTER]: firstThen(lost, second) });
    await user.click(screen.getByRole('button', { name: 'Make a new code' }));

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    await screen.findByRole('img', { name: QR_NAME });
    oneCodeDrawn(SECOND_URI);
    const keys = keysOfPosts();
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[1]);
    expect(keys[1]).not.toBe(keys[0]);
    expect(whereIs(...ENROLMENT_FORMS, ...SECOND_FORMS)).toEqual([]);
  });

  // Break caught: the earlier code coming back when the officer looks at the rider (it may have been ended by the new one), or the look keeping the
  // key of the attempt it abandoned, so that the next code replays one nobody saw.
  it('does not bring the earlier code back when the officer checks the rider, and the next code is a new command', async () => {
    const { user } = await shown({ [REGISTER]: firstThen(lost, second) });
    await user.click(screen.getByRole('button', { name: 'Make a new code' }));

    await user.click(await screen.findByRole('button', { name: 'Check the rider' }));

    await waitFor(() => {
      expect(reads()).toHaveLength(2);
    });
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
    await user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
    await screen.findByRole('img', { name: QR_NAME });
    oneCodeDrawn(SECOND_URI);
    const keys = keysOfPosts();
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[1]);
  });

  // Break caught: a refusal of the new code that leaves the earlier one on the screen with nothing said, or the officer with no way on.
  it('says why a new code was refused, shows no code, and lets the officer ask again as a new command', async () => {
    const { user } = await shown({
      [REGISTER]: firstThen(() => refusal(400, 'VALIDATION_FAILED'), second),
    });

    await user.click(screen.getByRole('button', { name: 'Make a new code' }));

    expect(
      await screen.findByText('The code could not be made. Nothing was changed.'),
    ).toBeVisible();
    expect(screen.getByText(/^Reference: req-test-1$/)).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(screen.getByText(/The earlier code is no longer shown\./)).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);

    await user.click(screen.getByRole('button', { name: 'Show the QR code' }));

    await screen.findByRole('img', { name: QR_NAME });
    oneCodeDrawn(SECOND_URI);
    const keys = keysOfPosts();
    expect(keys[2]).not.toBe(keys[1]);
  });

  // Break caught: a conflict on the new code (the rider scanned the earlier one meanwhile) shown without the way on, which is to read the rider.
  it('says the rider changed, and reading the rider again is the way on', async () => {
    let read = 0;
    const { user } = await shown({
      [REGISTER]: firstThen(() => refusal(409, 'STATE_CONFLICT')),
      [RECORD]: () => {
        read += 1;
        return json(
          200,
          read === 1 ? riderDetailFixture(unboundRider(), []) : riderDetailFixture(),
          etag('v1'),
        );
      },
    });

    await user.click(screen.getByRole('button', { name: 'Make a new code' }));

    expect(
      await screen.findByText(
        /A first device cannot be registered for this rider\. The rider already has an active device/,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reload the rider' }));

    expect(
      await screen.findByText(/This rider already has a device, or has had one revoked/),
    ).toBeVisible();
    expect(reads()).toHaveLength(2);
    expect(posts()).toHaveLength(2);
  });

  // Break caught: the news of a failed new code lost behind the screen of a lapsed one, which has a button and no place for it.
  it.each([
    ['lost', lost, /We could not confirm whether the code was made/, 'Check the rider'],
    [
      'refused',
      () => refusal(400, 'VALIDATION_FAILED'),
      /The code could not be made\. Nothing was changed\./,
      'Show the QR code',
    ],
  ])(
    'shows the news when the answer to a new code, asked for after the earlier one lapsed, is %s',
    async (_how, answer, news, wayOn) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { user } = await shown({ [REGISTER]: firstThen(answer) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIFETIME_MS);
      });
      await screen.findByText(LAPSED);

      await user.click(screen.getByRole('button', { name: 'Make a new code' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(news);
      expect(screen.getByRole('button', { name: wayOn })).toBeVisible();
      expect(screen.queryByText(LAPSED)).toBeNull();
      expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
      // The lapsed screen has said the code is no longer displayed: it is not said again.
      expect(screen.queryByText(/The earlier code is no longer shown/)).toBeNull();
    },
  );

  // Break caught: the earlier code lapsing while the new one is asked for, which sent the page to the screen of a lapsed code (a button, no news, and
  // no way out of an outcome nobody knows), or the earlier code coming back once the officer has looked.
  it('neither hides the way out nor draws the earlier code again when its time ends while a new one is being made', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = waiting();
    const { user } = await shown({ [REGISTER]: firstThen(pending.answer) });
    await user.click(screen.getByRole('button', { name: 'Make a new code' }));
    await waitFor(() => {
      expect(posts()).toHaveLength(2);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME_MS);
    });

    expect(screen.queryByText(LAPSED)).toBeNull();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();

    pending.lose();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /We could not confirm whether the code was made/,
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Check the rider' }));
    await screen.findByRole('button', { name: 'Show the QR code' });
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(screen.queryByText(LAPSED)).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });

  // Break caught: two clicks making two requests for a new code, of which the second could end the first's; and the earlier code staying on the
  // screen until the request is sent, when it is the click that asks for the new one.
  it('sends one request for two clicks on Make a new code, and the earlier code is off the screen at once', async () => {
    const pending = waiting();
    await shown({ [REGISTER]: firstThen(pending.answer) });
    const renew = screen.getByRole('button', { name: 'Make a new code' });

    act(() => {
      renew.click();
      renew.click();
    });
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    await waitFor(() => {
      expect(posts()).toHaveLength(2);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(posts()).toHaveLength(2);
    pending.release(second());
    await screen.findByRole('img', { name: QR_NAME });
    oneCodeDrawn(SECOND_URI);
  });

  // Break caught: two clicks on Try again repeating the held attempt twice at once.
  it('repeats the held attempt once for two clicks on Try again', async () => {
    const pending = waiting();
    const { user } = await shown({ [REGISTER]: firstThen(lost, pending.answer) });
    await user.click(screen.getByRole('button', { name: 'Make a new code' }));
    const again = await screen.findByRole('button', { name: 'Try again' });

    act(() => {
      again.click();
      again.click();
    });
    await waitFor(() => {
      expect(posts()).toHaveLength(3);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(posts()).toHaveLength(3);
    pending.release(second());
    await screen.findByRole('img', { name: QR_NAME });
    const keys = keysOfPosts();
    expect(keys[2]).toBe(keys[1]);
  });

  // Break caught: the answer to a new code, which arrives late, drawing a code (or leaving one in a cache) on a screen the officer has left, a
  // session that has ended or a page that was hidden.
  it.each([
    [
      'the officer has gone to another page',
      async (view: Awaited<ReturnType<typeof shown>>) => {
        await view.router.navigate('/elsewhere');
      },
    ],
    [
      'the address has changed under the same screen',
      async (view: Awaited<ReturnType<typeof shown>>) => {
        await view.router.navigate(`/admin/riders/${RIDER_ID}/device/register?again=1`);
      },
    ],
    [
      'the session has ended',
      () => {
        captured.store?.end();
      },
    ],
    [
      'the page has been hidden',
      () => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      },
    ],
  ])(
    'shows and keeps no code when the answer to a new one arrives after %s',
    async (_what, happen) => {
      const pending = waiting();
      const view = await shown({ [REGISTER]: firstThen(pending.answer) });
      await view.user.click(screen.getByRole('button', { name: 'Make a new code' }));
      await waitFor(() => {
        expect(posts()).toHaveLength(2);
      });
      await act(async () => {
        await happen(view);
      });

      pending.release(second());
      await act(async () => {
        await pending.answer();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
      expect(whereIs(...ENROLMENT_FORMS, ...SECOND_FORMS)).toEqual([]);
    },
  );

  describe('where the focus goes', () => {
    const OUTCOMES = [
      ['lost', lost, /We could not confirm whether the code was made/],
      ['refused', () => refusal(400, 'VALIDATION_FAILED'), /The code could not be made\./],
      [
        'in conflict',
        () => refusal(409, 'STATE_CONFLICT'),
        /A first device cannot be registered for this rider/,
      ],
    ] as const;

    // Break caught: the focus dropped to the document, or moved a second time, when a new code is asked for with the earlier one on the screen.
    // The notice takes it as the code and its button go, and it stays there: the news is read as it arrives, and the way on is one Tab away.
    it.each(OUTCOMES)(
      'stays on the notice of the earlier code when the answer to a new one is %s',
      async (_how, answer, news) => {
        const { user } = await shown({ [REGISTER]: firstThen(answer) });
        const focus = followFocus();

        await user.click(screen.getByRole('button', { name: 'Make a new code' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(news);
        expect(
          screen.getByText(/The earlier code is no longer shown\./).parentElement,
        ).toHaveFocus();
        expect(focus.trail).toEqual(['Make a new code', 'the notice']);
      },
    );

    // Break caught: the focus left at the top of the document when the button of the lapsed screen goes, during the request and after its answer
    // (the buttons of the page are new ones, and nothing says where the focus is to go). It goes to the control the officer needs next.
    it.each([
      [
        ...OUTCOMES[0],
        'Check the rider',
        ['Make a new code', 'Show the QR code', 'Check the rider'],
      ],
      [...OUTCOMES[1], 'Show the QR code', ['Make a new code', 'Show the QR code']],
      [...OUTCOMES[2], 'Reload the rider', ['Make a new code', 'Show the QR code']],
    ] as const)(
      'puts the focus on the control for what comes next when the answer to a new code, asked for after the earlier one lapsed, is %s',
      async (_how, answer, news, next, trail) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { user } = await shown({ [REGISTER]: firstThen(answer) });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(LIFETIME_MS);
        });
        await screen.findByText(LAPSED);
        const focus = followFocus();

        await user.click(screen.getByRole('button', { name: 'Make a new code' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(news);
        expect(screen.getByRole('button', { name: next })).toHaveFocus();
        expect(focus.trail).toEqual(trail);
      },
    );

    // Break caught: the focus put on a control while the request is on its way, and put there again when the code arrives, or not given to the code.
    it('hands the focus to the code once, when it arrives after the earlier one lapsed', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { user } = await shown({ [REGISTER]: firstThen(second) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIFETIME_MS);
      });
      await screen.findByText(LAPSED);
      const focus = followFocus();

      await user.click(screen.getByRole('button', { name: 'Make a new code' }));

      await screen.findByRole('img', { name: QR_NAME });
      expect(
        screen.getByRole('region', { name: 'Scan this code with the rider’s handset' }),
      ).toHaveFocus();
      expect(focus.trail).toEqual(['Make a new code', 'Show the QR code', 'the code']);
    });

    // Break caught: an engine that does not focus a button when it is clicked (WebKit) leaves the focus on the page's main region, so it is on no
    // control and yet not on the document: it must not stay there when the way out appears (found in WebKit by the browser test).
    it('takes the focus from the region that holds the page, as it does from the document', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const pending = waiting();
      const { user } = await shown({ [REGISTER]: firstThen(pending.answer) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIFETIME_MS);
      });
      await screen.findByText(LAPSED);
      await user.click(screen.getByRole('button', { name: 'Make a new code' }));
      await waitFor(() => {
        expect(posts()).toHaveLength(2);
      });
      act(() => {
        screen.getByRole('main').focus();
      });
      const focus = followFocus();

      pending.lose();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /We could not confirm whether the code was made/,
      );
      // Waited for, not read at once: the fake clock drives the effect that moves the focus, and in a loaded run the alert is found before
      // it has had its turn.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Check the rider' })).toHaveFocus();
      });
      expect(focus.trail).toEqual(['Check the rider']);
    });

    // Break caught: the focus pulled back to the buttons by an answer that arrives after the officer has gone to another part of the page.
    it('leaves the focus where the officer has put it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const pending = waiting();
      const { user } = await shown({ [REGISTER]: firstThen(pending.answer) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIFETIME_MS);
      });
      await screen.findByText(LAPSED);
      await user.click(screen.getByRole('button', { name: 'Make a new code' }));
      await waitFor(() => {
        expect(posts()).toHaveLength(2);
      });
      const back = screen.getByRole('link', { name: 'Back to the rider' });
      act(() => {
        back.focus();
      });
      const focus = followFocus();

      pending.lose();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /We could not confirm whether the code was made/,
      );
      expect(back).toHaveFocus();
      expect(focus.trail).toEqual([]);
    });
  });
});

describe('the first binding: where the focus goes when the button that asked has gone', () => {
  /** The very first code asked for, the answer being whatever the test says; the trail starts with the click that gives the button the focus. */
  async function asked(answer: Handler) {
    const view = await open(REGISTERER, { [REGISTER]: answer });
    const button = await screen.findByRole('button', { name: 'Show the QR code' });
    const focus = followFocus();
    await view.user.click(button);
    return focus;
  }

  // Break caught: the button that asked for the first code replaced by the way out of an outcome nobody knows, and the focus left at the top of
  // the document, where a screen reader says nothing.
  it('moves the focus to the way out when the answer to the first request is lost', async () => {
    const focus = await asked(() => Promise.reject(new TypeError('Failed to fetch')));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /We could not confirm whether the code was made/,
    );

    expect(screen.getByRole('button', { name: 'Check the rider' })).toHaveFocus();
    expect(focus.trail).toEqual(['Show the QR code', 'Check the rider']);
  });

  // Break caught: the focus dropped to the document when Try again goes as the retry starts, and not given to the code that comes of it.
  it('follows the retry of a lost first request: the button that asks, then the code', async () => {
    let asks = 0;
    const view = await open(REGISTERER, {
      [REGISTER]: () => {
        asks += 1;
        return asks === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : json(200, enrolmentGrantFixture({}, LIFETIME_MS));
      },
    });
    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
    const again = await screen.findByRole('button', { name: 'Try again' });
    const focus = followFocus();

    await view.user.click(again);

    await screen.findByRole('img', { name: QR_NAME });
    expect(
      screen.getByRole('region', { name: 'Scan this code with the rider’s handset' }),
    ).toHaveFocus();
    expect(focus.trail).toEqual(['Try again', 'Show the QR code', 'the code']);
  });

  // Break caught: the focus taken from a button that is still there, and has it, when the answer is a refusal or a conflict.
  it.each([
    [
      'refused',
      () => refusal(400, 'VALIDATION_FAILED'),
      /The code could not be made\./,
      'Show the QR code',
    ],
    [
      'in conflict',
      () => refusal(409, 'STATE_CONFLICT'),
      /A first device cannot be registered for this rider/,
      'Reload the rider',
    ],
  ])(
    'leaves the focus on the button that asked when the answer to the first request is %s',
    async (_how, answer, news, label) => {
      const focus = await asked(answer);

      expect(await screen.findByRole('alert')).toHaveTextContent(news);

      expect(screen.getByRole('button', { name: label })).toHaveFocus();
      expect(focus.trail).toEqual(['Show the QR code']);
    },
  );
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

    expect(await screen.findByText(LAPSED)).toBeVisible();
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
    [403, 'PERMISSION_DENIED', /can’t register a rider’s first device/],
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
      expect(await screen.findByText(cannotText('staff.device.register'))).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Show the QR code' })).toBeNull();
    },
  },
});
