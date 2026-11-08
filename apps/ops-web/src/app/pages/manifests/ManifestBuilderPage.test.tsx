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

function open(handlers: Record<string, Handler> = {}, keys: readonly string[] = KEYS) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
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

const poolTable = () =>
  screen.findByRole('table', { name: 'Confirmed pickups waiting for a manifest' });
const box = async (code: string) =>
  within(await poolTable()).getByRole('checkbox', { name: `Choose ${code}` });

async function typeDate(user: User, digits: string): Promise<void> {
  const group = screen.getByRole('group', { name: /Service date/ });
  const [day] = within(group).getAllByRole('spinbutton');
  if (day === undefined) throw new Error('no day');
  await user.click(day);
  await user.keyboard(digits);
}

const creates = () => api.requests.filter((request) => request.method === 'POST');
const bodyOf = async (index = -1): Promise<unknown> => creates().at(index)?.clone().json();
const review = () => screen.getByRole('region', { name: 'Review' });

describe('the pool', () => {
  // Break caught: a pool read without the filters that make it the pool, which would list requests a manifest cannot take.
  it('asks the server for the confirmed requests no manifest holds, and for nothing else', async () => {
    open();
    await poolTable();

    const query = new URL(
      api.requests.find((request) => new URL(request.url).pathname === '/api/v1/pickup-requests')
        ?.url ?? 'http://x/',
    ).searchParams;
    expect(query.get('state')).toBe('CONFIRMED');
    expect(query.get('manifested')).toBe('false');
    expect([...query.keys()].toSorted()).toEqual(['manifested', 'state']);
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
    expect(within(section).getByRole('heading', { level: 3, name: 'ACC-PR-9WXH4T' })).toBeVisible();
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

  it('says plainly that no carry-over reason is configured, naming the key that adds one', async () => {
    const { user } = open({ [REASONS]: () => json(200, []) });
    await user.click(await box('ACC-PR-9WXH4T'));
    await typeDate(user, '04112026');

    expect(await screen.findByText(/No carry-over reason is configured yet/)).toBeVisible();
    expect(screen.getByText('settings.reason.manage')).toBeVisible();
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

    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));

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
    expect(screen.getByText(/The manifest is made\./)).toBeVisible();
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

    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));

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

    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));

    expect(await screen.findByText('Choose at least one request from the pool.')).toBeVisible();
    expect(screen.getByText('Choose the day the run is worked.')).toBeVisible();
    expect(creates()).toHaveLength(0);
  });

  it('asks for the reason of an overdue request before it sends, and for the note a reason requires', async () => {
    const { user } = open();
    await user.click(await box('ACC-PR-9WXH4T'));
    await typeDate(user, '04112026');
    const select = await screen.findByRole('combobox', { name: /Why it is carried over/ });

    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));
    expect(await screen.findByText('Choose why this request is carried over.')).toBeVisible();

    await user.selectOptions(select, 'DEMO_NOTE_ME');
    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));
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

    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));

    expect(await screen.findByText(/A request you chose is already on a manifest/)).toBeVisible();
    const items = within(review()).getAllByRole('listitem');
    const [untouched, refused] = items;
    if (untouched === undefined || refused === undefined)
      throw new Error('the review lists two requests');
    expect(within(refused).getByText('Already on a manifest.')).toBeVisible();
    expect(within(untouched).queryByText('Already on a manifest.')).toBeNull();
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

    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));

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

    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));

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

    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));
    expect(
      await screen.findByText(/could not confirm whether the manifest was created/i),
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

    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));
    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));

    expect(held.waiting()).toBe(1);
    expect(creates()).toHaveLength(1);
    await act(async () => {
      await held.answer(errorResponse(400, 'VALIDATION_FAILED'));
    });
  });
});

describeInterfaceStates('the manifest builder', {
  loading: {
    test: async () => {
      open({ [POOL]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Loading the pool…')).toBeVisible();
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
      await user.click(screen.getByRole('button', { name: 'Create the manifest' }));
      expect(await screen.findByText('Choose the day the run is worked.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open({ [POOL]: () => refusal(500, 'INTERNAL_ERROR') });
      expect(
        await screen.findByText('The pool of confirmed pickups could not be loaded.'),
      ).toBeVisible();
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
      await user.click(screen.getByRole('button', { name: 'Create the manifest' }));
      expect(await screen.findByText('Already on a manifest.')).toBeVisible();
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
      expect(await screen.findByText(/pickup\.read/)).toBeVisible();
    },
  },
});
