import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { byHand } from '../../../test-support/by-hand';
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
import {
  manifestFixture,
  MANIFEST_ID,
  REQUEST_ONE_ID,
  REQUEST_THREE_ID,
  REQUEST_TWO_ID,
  stopFixture,
  STOP_TWO_ID,
} from '../../../test-support/manifest-fixture';
import {
  cancellationReasonFixture,
  PICKUP_HUB_ID,
  pickupRequestFixture,
} from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/manifests/new` (`listPickupRequests` for the pool, `listReasonDefinitions` for the carry-over reasons, `createPickupManifest`; S1.25). The
 * pool of confirmed pickups no manifest holds, chosen from across its pages, the day of the run, the reason of each carried-over request, and a
 * review before the manifest is made. The server decides eligibility: every refusal comes back at the place of the request or the day.
 */
const POOL = 'GET /pickup-requests';
const REASONS = 'GET /reason-definitions';
const CREATE = 'POST /pickup-manifests';
const KEYS = ['pickup.read', 'pickup.manifest.create', 'settings.reason.read'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
type User = ReturnType<typeof userEvent.setup>;

const one = pickupRequestFixture({
  id: REQUEST_ONE_ID,
  code: 'ACC-PR-7KQ2MZ',
  state: 'CONFIRMED',
  scheduled_service_date: '2026-11-04',
  sender_name: 'Demo Fabrics Ltd',
});
const two = pickupRequestFixture({
  id: REQUEST_TWO_ID,
  code: 'ACC-PR-9WXH4T',
  state: 'CONFIRMED',
  scheduled_service_date: '2026-11-02',
  sender_name: 'Overdue Bakes',
  resolved_pickup_location: { address: '2 Demo Close, Labone' },
});
const three = pickupRequestFixture({
  id: REQUEST_THREE_ID,
  code: 'ACC-PR-ZYU26H',
  state: 'CONFIRMED',
  scheduled_service_date: '2026-11-04',
  sender_name: 'Third Sender',
});

/** The characters an operational code is made of, without those that are confused when read aloud. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

const carryReason = (overrides = {}) =>
  cancellationReasonFixture({
    code: 'DEMO_RIDER_LATE',
    domain: 'PICKUP_CARRYOVER',
    label: 'Demo: the run was full yesterday',
    attribution: 'MELARC',
    ...overrides,
  });

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const ACCRA_CENTRAL = { id: PICKUP_HUB_ID, display_name: 'Accra Central' };
const KUMASI = { id: '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e', display_name: 'Kumasi Hub' };

function open(
  handlers: Record<string, Handler> = {},
  keys: readonly string[] = KEYS,
  hubs: readonly { id: string; display_name: string }[] = [ACCRA_CENTRAL],
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [...hubs],
      }),
      {
        [POOL]: () => page([one, two, three]),
        // The manifest that follows a creation names its stops by reading their requests.
        [`GET /pickup-requests/${REQUEST_ONE_ID}`]: () => json(200, one, etag('r1')),
        [`GET /pickup-requests/${REQUEST_TWO_ID}`]: () => json(200, two, etag('r1')),
        [`GET /pickup-requests/${REQUEST_THREE_ID}`]: () => json(200, three, etag('r1')),
        [REASONS]: () =>
          json(200, [
            carryReason(),
            carryReason({ code: 'DEMO_NOTE_ME', label: 'Demo: needs a note', requiresNote: true }),
          ]),
        ...handlers,
      },
    ),
  );
  return renderApp('/manifests/new');
}

const poolTable = async (): Promise<HTMLElement> => {
  const table = await screen.findByRole('table', {
    name: 'Confirmed pickups waiting for a pickup run',
  });
  // The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited.
  await waitFor(() => {
    expect(table).not.toHaveAttribute('aria-busy', 'true');
  });
  return table;
};
const box = async (code: string) =>
  within(await poolTable()).getByRole('checkbox', { name: `Choose ${code}` });

async function typeDate(user: User, digits: string): Promise<void> {
  const group = screen.getByRole('group', { name: /Service date/ });
  await user.click(within(group).getByRole('textbox'));
  await user.keyboard(digits);
}

const creates = () => api.requests.filter((request) => request.method === 'POST');
const bodyOf = async (index = -1): Promise<unknown> => creates().at(index)?.clone().json();
const review = () => screen.getByRole('region', { name: 'Review' });

describe('the pool', () => {
  // Break caught: a pool read without the filters that make it the pool, which would list requests a manifest cannot take; or one without the hub
  // of the run (a run is for one hub, so the pool is that hub's, also for a session that reaches only one).
  it('asks the server for the confirmed requests of the run’s hub that no manifest holds, and for nothing else', async () => {
    open();
    await poolTable();

    const query = new URL(
      api.requests.find((request) => new URL(request.url).pathname === '/api/v1/pickup-requests')
        ?.url ?? 'http://x/',
    ).searchParams;
    expect(query.get('state')).toBe('CONFIRMED');
    expect(query.get('manifested')).toBe('false');
    expect(query.get('hub_id')).toBe(PICKUP_HUB_ID);
    expect([...query.keys()].toSorted()).toEqual(['hub_id', 'manifested', 'state']);
  });

  // Break caught (the Product Owner, 9 November 2026): the pool described as "as the server lists them": it says what is in it, in the officer's words.
  it('says what the pool holds in plain words, with no word of who lists it', async () => {
    open();
    await poolTable();

    const pool = screen.getByRole('region', { name: 'The pool of confirmed pickups' });
    expect(within(pool).getByText(/that no pickup run holds./)).toBeVisible();
    expect(pool.textContent).not.toMatch(/as the server lists/);
  });

  it('shows each request by its code, sender, promised day, place and packages, with a box to choose it', async () => {
    open();

    const table = await poolTable();
    const row = within(table).getByText('ACC-PR-9WXH4T').closest('tr') as HTMLElement;
    expect(within(row).getByText('Overdue Bakes')).toBeVisible();
    expect(within(row).getByText('Mon 2 Nov 2026')).toBeVisible();
    expect(within(row).getByText('2 Demo Close, Labone')).toBeVisible();
    expect(within(row).getByText('Accra Central')).toBeVisible();
    expect(within(row).getByText('3 packages')).toBeVisible();
    expect(within(row).getByRole('checkbox', { name: 'Choose ACC-PR-9WXH4T' })).not.toBeChecked();
  });

  it('says what the pool is when it is empty', async () => {
    open({ [POOL]: () => page([]) });

    expect(await screen.findByRole('heading', { name: 'The pool is empty' })).toBeVisible();
  });

  // Break caught: a choice lost when the person moves to another page of the pool.
  it('keeps what was chosen when the pool moves to its next page', async () => {
    const { user } = open({
      [POOL]: (request) =>
        new URL(request.url).searchParams.get('page_token') === 'second'
          ? page([three])
          : page([one, two], 'second'),
    });
    await user.click(await box('ACC-PR-7KQ2MZ'));
    expect(within(review()).getByText(/ACC-PR-7KQ2MZ/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Next page/ }));
    await user.click(await box('ACC-PR-ZYU26H'));

    expect(
      within(review())
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining('ACC-PR-7KQ2MZ'), expect.stringContaining('ACC-PR-ZYU26H')]);
    expect(within(review()).getByText(/2 requests chosen/)).toBeVisible();
  });

  it('removes a request from the choice from the review', async () => {
    const { user } = open();
    await user.click(await box('ACC-PR-7KQ2MZ'));
    await user.click(await box('ACC-PR-ZYU26H'));

    await user.click(
      within(review()).getByRole('button', { name: 'Remove ACC-PR-7KQ2MZ from the choice' }),
    );

    expect(within(review()).getByText(/1 request chosen/)).toBeVisible();
    expect(await box('ACC-PR-7KQ2MZ')).not.toBeChecked();
  });
});

describe('the day and the carried-over requests', () => {
  // Break caught: a carry-over reason asked for the wrong requests (those on their own day), or not asked for an overdue one.
  it('asks for a reason for each request promised for an earlier day than the run’s, and for no other', async () => {
    const { user } = open();
    await user.click(await box('ACC-PR-7KQ2MZ'));
    await user.click(await box('ACC-PR-9WXH4T'));
    expect(screen.queryByRole('heading', { name: 'Carried over from an earlier day' })).toBeNull();

    await typeDate(user, '04112026');

    const section = await screen.findByRole('region', { name: 'Carried over from an earlier day' });
    expect(within(section).getByRole('heading', { level: 4, name: 'ACC-PR-9WXH4T' })).toBeVisible();
    expect(within(section).queryByRole('heading', { name: 'ACC-PR-7KQ2MZ' })).toBeNull();
    expect(within(section).getByRole('combobox', { name: /Why it is carried over/ })).toBeVisible();
    // The pool also says which of its rows are carried over.
    expect(screen.getAllByText(/Carried over: promised for an earlier day/).length).toBeGreaterThan(
      0,
    );
  });

  it('offers the reasons the catalogue gives, asks for the carry-over domain, and writes no code', async () => {
    const { user } = open();
    await user.click(await box('ACC-PR-9WXH4T'));
    await typeDate(user, '04112026');

    const select = await screen.findByRole('combobox', { name: /Why it is carried over/ });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose a reason', 'Demo: the run was full yesterday', 'Demo: needs a note']);
    const reasonRequest = api.requests.find(
      (request) => new URL(request.url).pathname === '/api/v1/reason-definitions',
    );
    expect(new URL(reasonRequest?.url ?? 'http://x/').searchParams.get('domain')).toBe(
      'PICKUP_CARRYOVER',
    );
  });

  // Break caught: the note a reason requires read from a list of codes instead of from the catalogue's own answer.
  it('asks for a note exactly where the reason’s requires_note says', async () => {
    const { user } = open();
    await user.click(await box('ACC-PR-9WXH4T'));
    await typeDate(user, '04112026');
    const select = await screen.findByRole('combobox', { name: /Why it is carried over/ });

    await user.selectOptions(select, 'DEMO_RIDER_LATE');
    expect(screen.getByRole('textbox', { name: 'Note' })).not.toBeRequired();
    await user.selectOptions(select, 'DEMO_NOTE_ME');

    expect(screen.getByRole('textbox', { name: /Note/ })).toBeRequired();
  });

  it('says plainly that no carry-over reason is configured, and who adds one, naming no key', async () => {
    const { user } = open({ [REASONS]: () => json(200, []) });
    await user.click(await box('ACC-PR-9WXH4T'));
    await typeDate(user, '04112026');

    expect(await screen.findByText(/No carry-over reason is configured yet/)).toBeVisible();
    expect(screen.getByText(/added to the reason catalogue by an administrator/)).toBeVisible();
    expect(document.body.textContent).not.toContain('settings.reason.manage');
  });
});

describe('making the manifest', () => {
  // Break caught: a creation that sends a sequence, a rider, a state or a hub of the page's own; or one that drops the reason of an overdue request.
  it('sends the requests in the order chosen, the day, and the reason of each carried-over one, under a key and no version', async () => {
    const { user } = open({
      [CREATE]: () =>
        json(
          201,
          manifestFixture({
            stops: [
              stopFixture({ pickup_request_id: REQUEST_TWO_ID }),
              stopFixture({ id: STOP_TWO_ID, pickup_request_id: REQUEST_ONE_ID, sequence: 2 }),
            ],
          }),
          etag('v1'),
        ),
      [`GET /pickup-manifests/${MANIFEST_ID}`]: () => json(200, manifestFixture(), etag('v1')),
    });
    await user.click(await box('ACC-PR-9WXH4T'));
    await user.click(await box('ACC-PR-7KQ2MZ'));
    await typeDate(user, '04112026');
    await user.selectOptions(
      await screen.findByRole('combobox', { name: /Why it is carried over/ }),
      'DEMO_RIDER_LATE',
    );
    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'Full yesterday');

    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));

    await waitFor(() => {
      expect(creates()).toHaveLength(1);
    });
    expect(creates()[0]?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(creates()[0]?.headers.get('If-Match')).toBeNull();
    expect(await bodyOf()).toEqual({
      pickup_request_ids: [REQUEST_TWO_ID, REQUEST_ONE_ID],
      service_date: '2026-11-04',
      carryover: [
        {
          pickup_request_id: REQUEST_TWO_ID,
          reason_code: 'DEMO_RIDER_LATE',
          note: 'Full yesterday',
        },
      ],
    });
    // The new manifest is the page that follows, and it says it was made.
    expect(await screen.findByRole('heading', { level: 1, name: 'ACC-MF-Q92422' })).toBeVisible();
    expect(screen.getByText(/The pickup run is made\./)).toBeVisible();
  });

  it('sends no carry-over when nothing is carried over', async () => {
    const { user } = open({
      [CREATE]: () =>
        json(
          201,
          manifestFixture({ stops: [stopFixture({ pickup_request_id: REQUEST_ONE_ID })] }),
          etag('v1'),
        ),
      [`GET /pickup-manifests/${MANIFEST_ID}`]: () => json(200, manifestFixture(), etag('v1')),
    });
    await user.click(await box('ACC-PR-7KQ2MZ'));
    await typeDate(user, '04112026');

    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));

    await waitFor(() => {
      expect(creates()).toHaveLength(1);
    });
    expect(await bodyOf()).toEqual({
      pickup_request_ids: [REQUEST_ONE_ID],
      service_date: '2026-11-04',
    });
  });

  // Break caught: a manifest sent with nothing chosen, no day, or an overdue request with no reason: the person is told, and nothing is sent.
  it('asks for what is missing before it sends anything', async () => {
    const { user } = open();
    await poolTable();

    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));

    expect(await screen.findByText('Choose at least one request from the pool.')).toBeVisible();
    expect(screen.getByText('Choose the day the run is worked.')).toBeVisible();
    expect(creates()).toHaveLength(0);
  });

  it('asks for the reason of an overdue request before it sends, and for the note a reason requires', async () => {
    const { user } = open();
    await user.click(await box('ACC-PR-9WXH4T'));
    await typeDate(user, '04112026');
    const select = await screen.findByRole('combobox', { name: /Why it is carried over/ });

    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));
    expect(await screen.findByText('Choose why this request is carried over.')).toBeVisible();

    await user.selectOptions(select, 'DEMO_NOTE_ME');
    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));
    expect(await screen.findByText('This reason needs a note.')).toBeVisible();
    expect(creates()).toHaveLength(0);
  });

  it('stops the 65th request being chosen, as the contract allows 64', async () => {
    const many = Array.from({ length: 64 }, (_, index) =>
      pickupRequestFixture({
        id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
        code: `ACC-PR-22${ALPHABET[index % 23] ?? '2'}${ALPHABET[Math.floor(index / 23)] ?? '2'}22`,
        state: 'CONFIRMED',
      }),
    );
    open({ [POOL]: () => page([...many, one]) });
    // Sixty-four ticks by a click each: the pointer's own events are not what is under test, so the clicks are plain.
    const boxes = within(await poolTable()).getAllByRole('checkbox');
    for (const each of boxes.slice(0, 64)) fireEvent.click(each);

    expect(await box('ACC-PR-7KQ2MZ')).toBeDisabled();
    expect(within(review()).getByText(/64 requests chosen/)).toBeVisible();
    expect(within(review()).getByText(/at most 64 requests/)).toBeVisible();
  }, 60_000);

  // Break caught: a refusal for a request told as a general failure, so the officer cannot tell which of the chosen requests to drop.
  it('tells each refused request at its place, with nothing made', async () => {
    const { user } = open({
      [CREATE]: () =>
        refusal(409, 'ALREADY_MANIFESTED', {
          violations: [
            { in: 'body', pointer: '/pickup_request_ids/1', rule: 'already_manifested' },
          ],
        }),
    });
    await user.click(await box('ACC-PR-7KQ2MZ'));
    await user.click(await box('ACC-PR-ZYU26H'));
    await typeDate(user, '04112026');

    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));

    expect(await screen.findByText(/A request you chose is already on a pickup run/)).toBeVisible();
    const items = within(review()).getAllByRole('listitem');
    const [untouched, refused] = items;
    if (untouched === undefined || refused === undefined)
      throw new Error('the review lists two requests');
    expect(within(refused).getByText('Already on a pickup run.')).toBeVisible();
    expect(within(untouched).queryByText('Already on a pickup run.')).toBeNull();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it('tells a refused day at the day', async () => {
    const { user } = open({
      [CREATE]: () =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'body', pointer: '/service_date', rule: 'past_day' }],
        }),
    });
    await user.click(await box('ACC-PR-7KQ2MZ'));
    await typeDate(user, '04112026');

    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));

    expect(
      await screen.findByText('That day has passed. Choose today or a later day.'),
    ).toBeVisible();
  });

  it('tells a refused carry-over reason at its request', async () => {
    const { user } = open({
      [CREATE]: () =>
        refusal(422, 'REASON_NOT_ACTIVE', {
          violations: [{ in: 'body', pointer: '/carryover/0', rule: 'reason' }],
        }),
    });
    await user.click(await box('ACC-PR-9WXH4T'));
    await typeDate(user, '04112026');
    await user.selectOptions(
      await screen.findByRole('combobox', { name: /Why it is carried over/ }),
      'DEMO_RIDER_LATE',
    );

    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));

    expect(await screen.findByText('The carry-over reason was not accepted.')).toBeVisible();
  });

  // Break caught: a lost answer that offers a fresh creation (a second manifest) instead of the same one under the same key.
  it('keeps the same key for a retry after an answer that was lost, and makes one manifest', async () => {
    let calls = 0;
    const { user } = open({
      [CREATE]: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : json(
              201,
              manifestFixture({ stops: [stopFixture({ pickup_request_id: REQUEST_ONE_ID })] }),
              etag('v1'),
            );
      },
      [`GET /pickup-manifests/${MANIFEST_ID}`]: () => json(200, manifestFixture(), etag('v1')),
    });
    await user.click(await box('ACC-PR-7KQ2MZ'));
    await typeDate(user, '04112026');

    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));
    expect(
      await screen.findByText(/could not confirm whether the pickup run was created/i),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'ACC-MF-Q92422' })).toBeVisible();
    const keys = creates().map((request) => request.headers.get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('sends nothing twice while a creation is on its way', async () => {
    const held = byHand();
    const { user } = open({ [CREATE]: held.handler });
    await user.click(await box('ACC-PR-7KQ2MZ'));
    await typeDate(user, '04112026');

    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));
    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));

    expect(held.waiting()).toBe(1);
    expect(creates()).toHaveLength(1);
    await act(async () => {
      await held.answer(errorResponse(400, 'VALIDATION_FAILED'));
    });
  });
});

describe('a run is for one hub (task C3, audit R4-12; AC-HUBF-09)', () => {
  const atKumasi = pickupRequestFixture({
    id: REQUEST_THREE_ID,
    code: 'KUM-PR-4XN8RD',
    state: 'CONFIRMED',
    scheduled_service_date: '2026-11-04',
    sender_name: 'Kumasi Sender',
    responsible_hub_id: KUMASI.id,
  });
  const TWO_HUBS = [ACCRA_CENTRAL, KUMASI];
  /** The pool of the hub asked for: Accra's request, or Kumasi's (and both only if a screen asked for no hub, which the builder must never do). */
  const poolByHub = (request: Request): Response => {
    const hub = new URL(request.url).searchParams.get('hub_id');
    return page(hub === PICKUP_HUB_ID ? [one] : hub === KUMASI.id ? [atKumasi] : [one, atKumasi]);
  };
  const created = {
    [CREATE]: () => json(201, manifestFixture(), etag('v1')),
    [`GET /pickup-manifests/${MANIFEST_ID}`]: () => json(200, manifestFixture(), etag('v1')),
  };
  const pools = () =>
    api.requests
      .filter(
        (request) =>
          request.method === 'GET' && new URL(request.url).pathname === '/api/v1/pickup-requests',
      )
      .map((request) => new URL(request.url).searchParams);
  /** The switcher of the top bar, and the choice of the page: two doors to the hub of the run. */
  // Found on the screen and not inside "the" banner: until the session is read the frame draws its neutral header, which is a banner too.
  const switcher = (name: string) => screen.findByRole('button', { name: `Hub: ${name}` });
  const chooseHub = async (user: User, from: string, to: string) => {
    await user.click(await switcher(from));
    await user.click(await screen.findByRole('menuitemradio', { name: to }));
  };
  const runHub = () => screen.getByRole('combobox', { name: /^Hub/ });
  const runFor = (name: string) => screen.findByText(new RegExp(`^Run for ${name}\\.`));
  const askedToChange = (to: string) =>
    screen.findByRole('alertdialog', { name: `Make the run for ${to}?` });

  // Break caught: a pool of every hub shown to a person who has not said which hub the run is for, so that a run of two hubs' requests can be
  // chosen from it; or the question lost, and the page showing nothing at all.
  it('asks which hub the run is for before it shows a pool, when the switcher is on All hubs', async () => {
    const { user } = open({ [POOL]: poolByHub }, KEYS, TWO_HUBS);

    expect(await screen.findByRole('heading', { name: 'The hub of the run' })).toBeVisible();
    expect(runHub()).toHaveValue('');
    expect(screen.getByText(/^Choose the hub of the run first/)).toBeVisible();
    expect(
      screen.getByText(
        'Choose the hub first: the pool, the review and the pickup run are that hub’s.',
      ),
    ).toBeVisible();
    // Nothing of the pool is drawn or asked for, and the rest of the form waits for the answer.
    expect(
      screen.queryByRole('table', { name: 'Confirmed pickups waiting for a pickup run' }),
    ).toBeNull();
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create the pickup run' })).toBeNull();
    expect(pools()).toHaveLength(0);

    await user.selectOptions(runHub(), KUMASI.id);

    // The header says whose run it is, and the pool is that hub's alone.
    expect(await runFor('Kumasi Hub')).toBeVisible();
    expect(await box('KUM-PR-4XN8RD')).toBeVisible();
    expect(screen.queryByText('ACC-PR-7KQ2MZ')).toBeNull();
    expect(pools().map((search) => search.get('hub_id'))).toEqual([KUMASI.id]);
    expect(screen.queryByText(/^Choose the hub first/)).toBeNull();
  });

  // Break caught: a page that opens on the question although the switcher has a hub (the person is asked what they already said), or one that
  // ignores the switcher and keeps asking.
  it('makes the run for the hub of the switcher when the page is opened, without asking', async () => {
    const { user, router } = open(
      { [POOL]: poolByHub, 'GET /pickup-manifests': () => page([]) },
      KEYS,
      TWO_HUBS,
    );
    await chooseHub(user, 'All hubs', 'Kumasi Hub');
    expect(await runFor('Kumasi Hub')).toBeVisible();

    await act(async () => {
      await router.navigate('/manifests');
    });
    await screen.findByRole('heading', { level: 1, name: 'Pickup runs' });
    await act(async () => {
      await router.navigate('/manifests/new');
    });

    expect(await runFor('Kumasi Hub')).toBeVisible();
    expect(runHub()).toHaveValue(KUMASI.id);
    expect(await box('KUM-PR-4XN8RD')).toBeVisible();
  });

  // Break caught: the pool read for every hub while the switcher names one, or its first page not read again when the hub changes, or the hub of
  // the run lost when the switcher goes back to All hubs.
  it('carries the run to the hub of the switcher while nothing is chosen, from the first page of its pool', async () => {
    const { user } = open(
      {
        [POOL]: (request) =>
          new URL(request.url).searchParams.has('page_token') ? page([]) : page([one], 'second'),
      },
      KEYS,
      TWO_HUBS,
    );
    await user.selectOptions(await screen.findByRole('combobox', { name: /^Hub/ }), PICKUP_HUB_ID);
    await user.click(await screen.findByRole('button', { name: /Next page/ }));
    await waitFor(() => {
      expect(pools().some((search) => search.get('page_token') === 'second')).toBe(true);
    });

    await chooseHub(user, 'All hubs', 'Kumasi Hub');

    await waitFor(() => {
      expect(pools().some((search) => search.get('hub_id') === KUMASI.id)).toBe(true);
    });
    const forKumasi = pools().filter((search) => search.get('hub_id') === KUMASI.id);
    expect(forKumasi.every((search) => !search.has('page_token'))).toBe(true);
    expect(forKumasi.every((search) => search.get('manifested') === 'false')).toBe(true);
    expect(runHub()).toHaveValue(KUMASI.id);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // All hubs is a view and not a hub for a run: the run stays Kumasi Hub's, and nothing is read for every hub.
    await chooseHub(user, 'Kumasi Hub', 'All hubs');
    expect(runHub()).toHaveValue(KUMASI.id);
    expect(await runFor('Kumasi Hub')).toBeVisible();
    expect(pools().every((search) => search.has('hub_id'))).toBe(true);
  });

  // Break caught: a run made of the requests of two hubs by a change of the hub (the requests chosen at the hub that was left kept, shown, counted
  // or sent for the next), or the choice cleared without asking, or cleared although the person said to keep it.
  it('asks before it clears the choice when the run changes hub, and sends nothing of the hub that was left', async () => {
    const { user } = open({ [POOL]: poolByHub, ...created }, KEYS, TWO_HUBS);
    await user.selectOptions(await screen.findByRole('combobox', { name: /^Hub/ }), PICKUP_HUB_ID);
    await user.click(await box('ACC-PR-7KQ2MZ'));
    expect(within(review()).getByText(/1 request chosen/)).toBeVisible();

    await user.selectOptions(runHub(), KUMASI.id);

    // The question says what would be lost, and nothing is lost by it.
    const question = await askedToChange('Kumasi Hub');
    expect(question).toHaveTextContent(
      'The request chosen for Accra Central is taken out of the choice, with anything written for it, and the pool becomes Kumasi Hub’s.',
    );
    await user.click(within(question).getByRole('button', { name: 'Keep Accra Central' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(runHub()).toHaveValue(PICKUP_HUB_ID);
    expect(await runFor('Accra Central')).toBeVisible();
    expect(within(review()).getByText(/1 request chosen/)).toBeVisible();
    expect(await box('ACC-PR-7KQ2MZ')).toBeChecked();

    await user.selectOptions(runHub(), KUMASI.id);
    await user.click(
      within(await askedToChange('Kumasi Hub')).getByRole('button', {
        name: 'Make the run for Kumasi Hub',
      }),
    );

    // The choice is cleared with the hub, and the pool is Kumasi's.
    expect(await runFor('Kumasi Hub')).toBeVisible();
    expect(runHub()).toHaveValue(KUMASI.id);
    expect(within(review()).getByText('No request is chosen yet.')).toBeVisible();
    await user.click(await box('KUM-PR-4XN8RD'));
    await typeDate(user, '04112026');
    await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));

    await waitFor(() => {
      expect(creates()).toHaveLength(1);
    });
    // Break caught: the request chosen at Accra sent with a run made for Kumasi.
    expect(await bodyOf()).toEqual({
      pickup_request_ids: [REQUEST_THREE_ID],
      service_date: '2026-11-04',
    });
  });

  // Break caught: the run flipped to the hub of the switcher under a choice (the requests chosen lost, or kept for the wrong hub), or a switcher
  // that moves the run without asking.
  it('keeps the run for its hub, and asks, when the switcher moves under a choice', async () => {
    const { user } = open({ [POOL]: poolByHub, ...created }, KEYS, TWO_HUBS);
    await chooseHub(user, 'All hubs', 'Accra Central');
    expect(await runFor('Accra Central')).toBeVisible();
    await user.click(await box('ACC-PR-7KQ2MZ'));

    await chooseHub(user, 'Accra Central', 'Kumasi Hub');

    const question = await askedToChange('Kumasi Hub');
    await user.click(within(question).getByRole('button', { name: 'Keep Accra Central' }));
    // The top bar says Kumasi Hub, the run says Accra Central, and the choice is as it was.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await switcher('Kumasi Hub')).toBeVisible();
    expect(await runFor('Accra Central')).toBeVisible();
    expect(runHub()).toHaveValue(PICKUP_HUB_ID);
    expect(within(review()).getByText(/1 request chosen/)).toBeVisible();
    expect(pools().every((search) => search.get('hub_id') === PICKUP_HUB_ID)).toBe(true);

    // All hubs asks nothing, and a move to a hub asks again.
    await chooseHub(user, 'Kumasi Hub', 'All hubs');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await chooseHub(user, 'All hubs', 'Kumasi Hub');
    await user.click(
      within(await askedToChange('Kumasi Hub')).getByRole('button', {
        name: 'Make the run for Kumasi Hub',
      }),
    );

    expect(await runFor('Kumasi Hub')).toBeVisible();
    expect(runHub()).toHaveValue(KUMASI.id);
    expect(within(review()).getByText('No request is chosen yet.')).toBeVisible();
    expect(await box('KUM-PR-4XN8RD')).not.toBeChecked();
  });

  // Break caught: a question asked of a session that has no choice to make, or a pool read that names no hub (a run for every hub the session
  // reaches, which is what a run is not).
  it('is for the only hub of a session that reaches one, with no question', async () => {
    open();

    await poolTable();
    expect(await runFor('Accra Central')).toBeVisible();
    expect(screen.queryByRole('combobox', { name: /^Hub/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'The hub of the run' })).toBeNull();
    expect(pools().map((search) => search.get('hub_id'))).toEqual([PICKUP_HUB_ID]);
  });

  // Break caught: a request of another hub chosen from a pool that held one (a stale answer, a foreign row), so that a mixed run could be sent.
  it('never chooses a request of another hub than the run’s', async () => {
    const { user } = open({ [POOL]: () => page([one, atKumasi]) });

    await user.click(await box('KUM-PR-4XN8RD'));
    await user.click(await box('ACC-PR-7KQ2MZ'));

    expect(await box('KUM-PR-4XN8RD')).not.toBeChecked();
    expect(within(review()).getByText(/1 request chosen/)).toBeVisible();
    expect(within(review()).queryByText(/KUM-PR-4XN8RD/)).toBeNull();
  });

  // Break caught: the pool of the hub of the run empty and nothing said of the hub (as if no pool existed anywhere), or a way back to All hubs,
  // which a run has no use for.
  it('says Nothing at the hub of the run, and offers another hub and never All hubs', async () => {
    const { user } = open({ [POOL]: () => page([]) }, KEYS, TWO_HUBS);
    await user.selectOptions(await screen.findByRole('combobox', { name: /^Hub/ }), PICKUP_HUB_ID);

    expect(await screen.findByRole('heading', { name: 'Nothing at Accra Central' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'The pool is empty' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show all hubs' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Choose another hub' }));

    expect(runHub()).toHaveFocus();
  });
});

describeInterfaceStates('the manifest builder', {
  loading: {
    test: async () => {
      open({ [POOL]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Loading the pool')).toBeInTheDocument();
    },
  },
  empty: {
    test: async () => {
      open({ [POOL]: () => page([]) });
      expect(await screen.findByRole('heading', { name: 'The pool is empty' })).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      const { user } = open();
      await poolTable();
      await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));
      expect(await screen.findByText('Choose the day the run is worked.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open({ [POOL]: () => refusal(500, 'INTERNAL_ERROR') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'The pool of confirmed pickups could not be loaded.',
        );
      });
    },
  },
  retry: {
    test: async () => {
      let calls = 0;
      const { user } = open({
        [POOL]: () => (calls++ === 0 ? refusal(500, 'INTERNAL_ERROR') : page([one])),
      });
      await user.click(await screen.findByRole('button', { name: /try again|retry/i }));
      await box('ACC-PR-7KQ2MZ');
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open({
        [CREATE]: () =>
          refusal(409, 'ALREADY_MANIFESTED', {
            violations: [
              { in: 'body', pointer: '/pickup_request_ids/0', rule: 'already_manifested' },
            ],
          }),
      });
      await user.click(await box('ACC-PR-7KQ2MZ'));
      await typeDate(user, '04112026');
      await user.click(screen.getByRole('button', { name: 'Create the pickup run' }));
      expect(await screen.findByText('Already on a pickup run.')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Refresh the pool' })).toBeEnabled();
    },
  },
  success: {
    test: async () => {
      open();
      await box('ACC-PR-7KQ2MZ');
    },
  },
  'permission-restricted': {
    test: async () => {
      open({ [POOL]: () => refusal(403, 'PERMISSION_DENIED') }, KEYS);
      // The refusal is told as what the person lacks, in plain words, and names no key.
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Your account can’t see pickup requests. Ask an administrator for access.',
        );
      });
      expect(document.body.textContent).not.toContain('pickup.read');
    },
  },
});

// Task R5.2, H1: Enter in the date field must not send the run with the day the page still holds while the person has taken a part of it out.
describe('Enter in the date field', () => {
  // Break caught: the form sent by Enter from the field with the old day (the page keeps the day until the person leaves the field).
  it('does not make the manifest while the day is half cleared, and says why', async () => {
    const { user } = open({
      [CREATE]: () => json(201, manifestFixture(), etag('v1')),
      [`GET /pickup-manifests/${MANIFEST_ID}`]: () => json(200, manifestFixture(), etag('v1')),
    });
    await user.click(await box('ACC-PR-7KQ2MZ'));
    await typeDate(user, '04112026');

    await user.keyboard('{Backspace}{Enter}');

    expect(creates()).toHaveLength(0);
    expect(await screen.findByText('Enter the year in full, for example 2026')).toBeVisible();

    // The control: the day typed in full is sent by Enter, as any field in a form sends it.
    await user.keyboard('6{Enter}');
    await waitFor(() => {
      expect(creates()).toHaveLength(1);
    });
    expect(await bodyOf()).toEqual({
      pickup_request_ids: [REQUEST_ONE_ID],
      service_date: '2026-11-04',
    });
  });
});

// Task R5.2, M15b: a session that lists no hub at all is told so, in plain words, and not to choose a hub it has none of.
describe('a session that lists no hub', () => {
  // Break caught: "Choose the hub first" shown to a person with no hub to choose, and nothing of the run drawn or asked for.
  it('is told there is nothing to build a run from, and is not told to choose a hub', async () => {
    open({}, KEYS, []);

    expect(
      await screen.findByText(
        'Your session lists no hub, so there is nothing to build a run from: a pickup run is made for one hub.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'A run is for one hub, and your session lists none, so there is nothing to build here.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Choose the hub/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'The hub of the run' })).toBeNull();
    expect(screen.queryByRole('group', { name: /Service date/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create the pickup run' })).toBeNull();
    expect(
      screen.queryByRole('table', { name: 'Confirmed pickups waiting for a pickup run' }),
    ).toBeNull();
    // No role and no permission key is named.
    expect(document.body.textContent).not.toMatch(/manifest\.|staff\.|pickup\.|role/i);
  });
});

/**
 * The builder is drawn by the builder template (redesign step R6): the pool and the run in two panes, and a guard against leaving a run that holds a choice that was not sent. The
 * builder's own rules are the tests above; these hold the frame.
 */
describe('the builder: leaving', () => {
  // Break caught: a choice lost to a link, without a word.
  it('asks before the application leaves a run that holds a choice, and the safe answer is to stay', async () => {
    const { user, router } = open();
    await user.click(await box('ACC-PR-7KQ2MZ'));

    await act(async () => {
      await router.navigate('/');
    });

    const question = await screen.findByRole('alertdialog', { name: 'Leave this page?' });
    expect(within(question).getByRole('button', { name: 'Stay here' })).toHaveFocus();
    expect(router.state.location.pathname).toBe('/manifests/new');
    await user.click(within(question).getByRole('button', { name: 'Stay here' }));
    expect(await box('ACC-PR-7KQ2MZ')).toBeChecked();
  });

  it('asks nothing of a run that holds nothing', async () => {
    const { router } = open();
    await box('ACC-PR-7KQ2MZ');

    await act(async () => {
      await router.navigate('/');
    });

    expect(screen.queryByRole('alertdialog', { name: 'Leave this page?' })).toBeNull();
    expect(router.state.location.pathname).toBe('/');
  });
});
