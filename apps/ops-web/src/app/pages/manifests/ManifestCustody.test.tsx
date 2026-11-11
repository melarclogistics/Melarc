import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  handoverFixture,
  HANDOVER_ID,
  manifestFixture,
  MANIFEST_ID,
  stopFixture,
  summaryFixture,
} from '../../../test-support/manifest-fixture';
import { PICKUP_HUB_ID } from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { OTHER_RIDER_ID, RIDER_ID, riderFixture } from '../../../test-support/rider-fixture';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { cannotText } from '../../../platform/problem/capability-words';

/**
 * The Ops side of a run's custody handover, on `/manifests/{id}` while the run is in progress (S1.25; the contract of S1.24). The custody
 * operations are written from the contract and answered here by a stand-in, so these tests hold the screens to what the contract says and not to
 * the server (the screens are not yet proved against the real API). Opening one moves nothing; failing one leaves custody where it was; the count an acceptance records is a
 * custody record and is never told as the hub's count.
 */
const PATH = `/manifests/${MANIFEST_ID}`;
const READ = `GET /pickup-manifests/${MANIFEST_ID}`;
const LIST = 'GET /run-custody-handovers';
const GET = `GET /run-custody-handovers/${HANDOVER_ID}`;
const INITIATE = `POST /pickup-manifests/${MANIFEST_ID}/custody-handover`;
const ACCEPT = `POST /pickup-manifests/${MANIFEST_ID}/custody-handover/accept`;
const FAIL = `POST /pickup-manifests/${MANIFEST_ID}/custody-handover/fail`;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYS = [
  'pickup.read',
  'dispatch.read',
  'pickup.stop.skip',
  'fleet.custody.read',
  'fleet.custody.initiate',
  'fleet.custody.accept',
];

const running = (overrides = {}) =>
  manifestFixture({
    state: 'IN_PROGRESS',
    assigned_rider_id: RIDER_ID,
    assigned_at: '2026-11-03T08:00:00Z',
    dispatched_at: '2026-11-03T09:00:00Z',
    started_at: '2026-11-04T07:30:00Z',
    stops: [stopFixture({ pickup_summary: summaryFixture('ACC-PR-7KQ2MZ') })],
    ...overrides,
  });
const none = (): Response => json(200, { items: [], next_page_token: null });
const waiting = (overrides = {}): Response =>
  json(200, { items: [handoverFixture(overrides)], next_page_token: null });

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handlers: Record<string, Handler> = {},
  keys: readonly string[] = KEYS,
  manifest = running(),
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [READ]: () => json(200, manifest, etag('v1')),
        [`GET /ops/riders/${RIDER_ID}`]: () =>
          json(200, { rider: riderFixture(), devices: [] }, etag('rd1')),
        [`GET /ops/riders/${OTHER_RIDER_ID}`]: () =>
          json(
            200,
            { rider: riderFixture({ id: OTHER_RIDER_ID, full_name: 'Esi Owusu' }), devices: [] },
            etag('rd1'),
          ),
        ...handlers,
      },
    ),
  );
  return renderApp(PATH);
}

const sent = (route: string) =>
  api.requests.filter(
    (candidate) =>
      `${candidate.method} ${new URL(candidate.url).pathname.replace(/^\/api\/v1/, '')}` === route,
  );
const bodyOf = async (route: string): Promise<unknown> => sent(route).at(-1)?.clone().json();
const section = () => screen.findByRole('region', { name: 'Custody of the parcels' });

describe('custody: when the section is there', () => {
  // Break caught: the custody read made for a run that is not in progress, or the section drawn for it.
  it.each(['DRAFT', 'DISPATCHED', 'COMPLETED', 'CANCELLED'] as const)(
    'is not drawn, and not asked for, for a %s manifest',
    async (state) => {
      open(
        {},
        KEYS,
        manifestFixture({
          state,
          assigned_rider_id: state === 'DRAFT' ? null : RIDER_ID,
          stops: [stopFixture({ pickup_summary: summaryFixture('ACC-PR-7KQ2MZ') })],
        }),
      );
      await screen.findByRole('heading', { level: 1, name: 'ACC-MF-Q92422' });

      expect(screen.queryByRole('region', { name: 'Custody of the parcels' })).toBeNull();
      expect(api.requests.some((request) => request.url.includes('run-custody-handovers'))).toBe(
        false,
      );
    },
  );

  it('is drawn for a run in progress, and asks for the run’s pending handover only', async () => {
    open({ [LIST]: none });

    await section();
    const query = new URL(sent(LIST)[0]?.url ?? 'http://x/').searchParams;
    expect(query.get('manifest_id')).toBe(MANIFEST_ID);
    expect(query.get('state')).toBe('PENDING');
  });

  it('says what the session lacks, and asks for nothing, without fleet.custody.read', async () => {
    open(
      {},
      KEYS.filter((key) => key !== 'fleet.custody.read'),
    );

    expect(await screen.findByText(cannotText('fleet.custody.read'))).toBeVisible();
    expect(api.requests.some((request) => request.url.includes('run-custody-handovers'))).toBe(
      false,
    );
  });

  // Break caught: the whole page lost, or silent, when the custody operations answer an error while they are not all there yet.
  it('tells a custody read that failed in its own section, and leaves the rest of the page standing', async () => {
    open({ [LIST]: () => refusal(501, 'NOT_IMPLEMENTED') });

    expect(
      await screen.findByText('The custody handover of this run could not be loaded.'),
    ).toBeVisible();
    expect(screen.getByRole('table', { name: 'Stops' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'ACC-MF-Q92422' })).toBeVisible();
  });
});

describe('custody: opening a handover', () => {
  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Open a custody handover' }));
    return screen.getByRole('alertdialog', { name: 'Open a custody handover?' });
  }

  it('says that opening one moves nothing, and chooses no destination', async () => {
    const { user } = open({ [LIST]: none });
    const dialog = await openDialog(user);

    expect(within(dialog).getByText(/Opening a handover moves nothing/)).toBeVisible();
    for (const choice of within(dialog).getAllByRole('radio')) expect(choice).not.toBeChecked();
  });

  // Break caught: the origin or a hub of the page's own sent, where the contract lets the officer name only where custody goes.
  it('opens a handover to the hub on the version of the manifest, with the manifest’s hub and a note, and no key', async () => {
    const { user } = open({
      [LIST]: none,
      [INITIATE]: () => json(200, handoverFixture(), etag('h1')),
    });
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: /To the hub: Accra Central/ }));
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why custody is being handed over/ }),
      'Unsafe roadside',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Open the handover' }));

    await waitFor(() => {
      expect(sent(INITIATE)).toHaveLength(1);
    });
    expect(sent(INITIATE)[0]?.headers.get('If-Match')).toBe('"v1"');
    expect(sent(INITIATE)[0]?.headers.get('Idempotency-Key')).toBeNull();
    expect(await bodyOf(INITIATE)).toEqual({ to_hub_id: PICKUP_HUB_ID, note: 'Unsafe roadside' });
    expect(
      await screen.findByText(/A custody handover is opened\. Custody stays where it is/),
    ).toBeVisible();
  });

  // Break caught (the review of f6cf02b): the handover that was just opened read back (a list and then the handover) to be drawn. The answer is the handover that waits, with the version of its
  // own acts; the run is read again, once.
  it('draws the handover it opened from the answer, and reads neither the list nor the handover again', async () => {
    const { user } = open({
      [LIST]: none,
      [INITIATE]: () => json(200, handoverFixture(), etag('h1')),
    });
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: /To the hub: Accra Central/ }));
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why custody is being handed over/ }),
      'Unsafe roadside',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Open the handover' }));

    expect(await within(await section()).findByText('Waiting for the receiver')).toBeVisible();
    expect(sent(LIST)).toHaveLength(1);
    expect(sent(GET)).toHaveLength(0);
    expect(sent(READ)).toHaveLength(2);
    // Its acts carry the version of the answer.
    expect(screen.getByRole('button', { name: 'Mark the handover as failed' })).toBeVisible();
  });

  it('opens a handover to another rider chosen from the riders of the hub', async () => {
    const { user } = open({
      [LIST]: none,
      'GET /ops/riders': () =>
        json(200, {
          items: [riderFixture({ id: OTHER_RIDER_ID, full_name: 'Esi Owusu' })],
          next_page_token: null,
        }),
      [INITIATE]: () =>
        json(200, handoverFixture({ to_hub_id: null, to_rider_id: OTHER_RIDER_ID }), etag('h1')),
    });
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: 'To another rider' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Choose: Esi Owusu' }));
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why custody is being handed over/ }),
      'Handset destroyed',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Open the handover' }));

    await waitFor(() => {
      expect(sent(INITIATE)).toHaveLength(1);
    });
    expect(await bodyOf(INITIATE)).toEqual({
      to_rider_id: OTHER_RIDER_ID,
      note: 'Handset destroyed',
    });
  });

  it('asks for the destination, the rider and the note before it sends anything', async () => {
    const { user } = open({
      [LIST]: none,
      'GET /ops/riders': () => json(200, { items: [riderFixture()], next_page_token: null }),
    });
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole('button', { name: 'Open the handover' }));
    expect(await within(dialog).findByText('Choose where custody goes.')).toBeVisible();
    expect(within(dialog).getByText('Write a note saying why.')).toBeVisible();

    await user.click(within(dialog).getByRole('radio', { name: 'To another rider' }));
    await user.click(within(dialog).getByRole('button', { name: 'Open the handover' }));
    expect(await within(dialog).findByText('Choose the rider.')).toBeVisible();
    expect(sent(INITIATE)).toHaveLength(0);
  });

  it.each([
    ['STATE_CONFLICT', 409, /A handover cannot be opened now/],
    ['HUB_SCOPE_VIOLATION', 403, /hub your account does not work in/],
    ['PERMISSION_DENIED', 403, /can’t open a custody handover/],
  ])('tells %s in the officer’s words', async (code, status, words) => {
    const { user } = open({ [LIST]: none, [INITIATE]: () => refusal(status, code) });
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: /To the hub/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /Why custody/ }), 'Unsafe');

    await user.click(within(dialog).getByRole('button', { name: 'Open the handover' }));

    expect(await within(dialog).findByText(words)).toBeVisible();
  });

  // Break caught: a handover that is already waiting told as "it changed, reload", with no word of the one that waits.
  it('tells a handover that is already waiting as that, by the rule the server declares', async () => {
    const { user } = open({
      [LIST]: none,
      [INITIATE]: () => refusal(409, 'STATE_CONFLICT', { rule: 'custody_handover_pending' }),
    });
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: /To the hub/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /Why custody/ }), 'Unsafe');

    await user.click(within(dialog).getByRole('button', { name: 'Open the handover' }));

    expect(
      await within(dialog).findByText(/already waiting, and only one can wait at a time/),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Reload the record' })).toBeVisible();
    expect(screen.queryByText(/custody_handover_pending/)).toBeNull();
  });

  it('is not offered without fleet.custody.initiate, and names the key', async () => {
    open(
      { [LIST]: none },
      KEYS.filter((key) => key !== 'fleet.custody.initiate'),
    );

    await section();
    expect(screen.queryByRole('button', { name: 'Open a custody handover' })).toBeNull();
    expect(
      (await screen.findAllByText(cannotText('fleet.custody.initiate'))).length,
    ).toBeGreaterThan(0);
  });
});

describe('custody: the handover that waits', () => {
  const pending = {
    [LIST]: () => waiting(),
    [GET]: () => json(200, handoverFixture(), etag('h1')),
  };

  // Break caught (the review of f6cf02b): the rider read again by every place that names them (the facts, the handover's origin and its destination), each with the devices, and not kept.
  it('names each rider once, however many places name them', async () => {
    open({
      [LIST]: () => waiting({ to_hub_id: null, to_rider_id: OTHER_RIDER_ID }),
      [GET]: () =>
        json(200, handoverFixture({ to_hub_id: null, to_rider_id: OTHER_RIDER_ID }), etag('h1')),
    });

    const handover = await section();
    expect(await within(handover).findByText('Esi Owusu')).toBeVisible();
    expect(await within(handover).findByText('Kwame Mensah')).toBeVisible();
    expect(sent(`GET /ops/riders/${RIDER_ID}`)).toHaveLength(1);
    expect(sent(`GET /ops/riders/${OTHER_RIDER_ID}`)).toHaveLength(1);
  });

  it('shows where custody is to go, who holds it, and that it stays until it is accepted', async () => {
    open(pending);

    const handover = await section();
    expect(await within(handover).findByText('Waiting for the receiver')).toBeVisible();
    expect(within(handover).getByText('the hub: Accra Central')).toBeVisible();
    expect(await within(handover).findByText('Kwame Mensah')).toBeVisible();
    expect(within(handover).getByText(/stays with them until it is accepted/)).toBeVisible();
    // The version of the handover is read for its acts.
    expect(sent(GET)).toHaveLength(1);
  });

  it('marks a handover failed with a note, on the version of the handover, under a key', async () => {
    const { user } = open({
      ...pending,
      [FAIL]: () =>
        json(
          200,
          handoverFixture({ state: 'FAILED', resolved_at: '2026-11-04T10:30:00Z' }),
          etag('h2'),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Mark the handover as failed' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Mark this handover as failed?' });
    expect(within(dialog).getByText(/Custody stays with the rider who holds it/)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Mark the handover as failed' }));
    expect(await within(dialog).findByText('Write a note saying why.')).toBeVisible();
    expect(sent(FAIL)).toHaveLength(0);

    await user.type(
      within(dialog).getByRole('textbox', { name: /Why it did not happen/ }),
      'Receiver never came',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Mark the handover as failed' }));

    await waitFor(() => {
      expect(sent(FAIL)).toHaveLength(1);
    });
    expect(sent(FAIL)[0]?.headers.get('If-Match')).toBe('"h1"');
    expect(sent(FAIL)[0]?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await bodyOf(FAIL)).toEqual({ note: 'Receiver never came' });
    expect(
      await screen.findByText(/The handover is marked as failed\. Custody is where it was\./),
    ).toBeVisible();
  });

  // Break caught (the review of f6cf02b): the pending handover read again after every act (a list and then the handover: two requests), though the act answered what it is now. A handover that
  // has failed is none that waits, and the answer says it. The run is read again, once: the same act may have completed it.
  it('draws no handover from the answer of a failed one, and reads neither the list nor the handover again', async () => {
    const { user } = open({
      ...pending,
      [FAIL]: () =>
        json(
          200,
          handoverFixture({ state: 'FAILED', resolved_at: '2026-11-04T10:30:00Z' }),
          etag('h2'),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Mark the handover as failed' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Mark this handover as failed?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why it did not happen/ }),
      'Receiver never came',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Mark the handover as failed' }));

    expect(await screen.findByText('No handover is waiting')).toBeVisible();
    expect(sent(LIST)).toHaveLength(1);
    expect(sent(GET)).toHaveLength(1);
    expect(sent(READ)).toHaveLength(2);
  });

  // Break caught: a run the system completed in the same act left drawn as in progress, with a custody section that no longer applies.
  it('reads the manifest again after a failed handover, because the system may have completed the run', async () => {
    let reads = 0;
    const { user } = open({
      ...pending,
      [READ]: () => {
        reads += 1;
        return json(
          200,
          reads === 1
            ? running()
            : running({ state: 'COMPLETED', completed_at: '2026-11-04T10:31:00Z' }),
          etag(`v${String(reads)}`),
        );
      },
      [FAIL]: () =>
        json(
          200,
          handoverFixture({ state: 'FAILED', resolved_at: '2026-11-04T10:30:00Z' }),
          etag('h2'),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Mark the handover as failed' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Mark this handover as failed?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why it did not happen/ }),
      'Never came',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Mark the handover as failed' }));

    await waitFor(() => {
      expect(reads).toBe(2);
    });
    expect(await screen.findByText('The run is completed.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Custody of the parcels' })).toBeNull();
  });

  it('accepts a handover to the hub with what was taken, on the version of the handover, under a key', async () => {
    let reads = 0;
    const { user } = open({
      ...pending,
      [READ]: () =>
        json(
          200,
          reads++ === 0
            ? running()
            : running({ state: 'COMPLETED', completed_at: '2026-11-04T10:31:00Z' }),
          etag(`v${String(reads)}`),
        ),
      [ACCEPT]: () =>
        json(
          200,
          handoverFixture({
            state: 'COMPLETED',
            parcel_count_taken: 7,
            resolved_at: '2026-11-04T10:30:00Z',
          }),
          etag('h2'),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Accept the handover' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Accept this handover for the hub?' });
    // The dialog says what the number is, beside the field.
    expect(within(dialog).getByText(/it is not the hub’s count/)).toBeVisible();

    await user.type(within(dialog).getByRole('textbox', { name: /Parcels taken/ }), '7');
    await user.click(within(dialog).getByRole('button', { name: 'Accept the handover' }));

    await waitFor(() => {
      expect(sent(ACCEPT)).toHaveLength(1);
    });
    expect(sent(ACCEPT)[0]?.headers.get('If-Match')).toBe('"h1"');
    expect(sent(ACCEPT)[0]?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await bodyOf(ACCEPT)).toEqual({ parcel_count_taken: 7 });
    // The manifest is read again, because the API may have completed the run in the same act.
    expect(
      await screen.findByText(
        /You recorded 7 parcels taken: a record of custody, not the hub’s count\./,
      ),
    ).toBeVisible();
    await waitFor(() => {
      expect(sent(READ)).toHaveLength(2);
    });
  });

  // Break caught: the count of an acceptance drawn as, or beside, a count of the hub's.
  it('never draws the number taken as a count of the hub’s', async () => {
    const { user } = open({
      ...pending,
      [ACCEPT]: () =>
        json(
          200,
          handoverFixture({
            state: 'COMPLETED',
            parcel_count_taken: 7,
            resolved_at: '2026-11-04T10:30:00Z',
          }),
          etag('h2'),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Accept the handover' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Accept this handover for the hub?' });
    await user.type(within(dialog).getByRole('textbox', { name: /Parcels taken/ }), '7');
    await user.click(within(dialog).getByRole('button', { name: 'Accept the handover' }));
    await screen.findByText(/You recorded 7 parcels taken/);

    expect(document.body.textContent).not.toMatch(/hub[’']s count:? ?7|blind count/i);
    expect(document.body.textContent).not.toMatch(/count of the hub/i);
  });

  it.each([
    ['nothing', ''],
    ['a word', 'seven'],
    ['a negative number', '-1'],
    ['a fraction', '2.5'],
  ])('asks for a whole number of parcels, not %s', async (_name, typed) => {
    const { user } = open(pending);
    await user.click(await screen.findByRole('button', { name: 'Accept the handover' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Accept this handover for the hub?' });
    if (typed !== '')
      await user.type(within(dialog).getByRole('textbox', { name: /Parcels taken/ }), typed);

    await user.click(within(dialog).getByRole('button', { name: 'Accept the handover' }));

    expect(
      await within(dialog).findByText(/Enter how many parcels were taken, as a whole number/),
    ).toBeVisible();
    expect(sent(ACCEPT)).toHaveLength(0);
  });

  it('accepts a count of zero, which is a custody record like any other', async () => {
    const { user } = open({
      ...pending,
      [ACCEPT]: () =>
        json(
          200,
          handoverFixture({
            state: 'COMPLETED',
            parcel_count_taken: 0,
            resolved_at: '2026-11-04T10:30:00Z',
          }),
          etag('h2'),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Accept the handover' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Accept this handover for the hub?' });
    await user.type(within(dialog).getByRole('textbox', { name: /Parcels taken/ }), '0');

    await user.click(within(dialog).getByRole('button', { name: 'Accept the handover' }));

    await waitFor(() => {
      expect(sent(ACCEPT)).toHaveLength(1);
    });
    expect(await bodyOf(ACCEPT)).toEqual({ parcel_count_taken: 0 });
  });

  // Break caught: Ops offered the acceptance of a handover that is a rider's to accept, which the server refuses.
  it('offers Ops no acceptance of a handover to a rider, and says the rider accepts it in the Rider app', async () => {
    open({
      [LIST]: () => waiting({ to_hub_id: null, to_rider_id: OTHER_RIDER_ID }),
      [GET]: () =>
        json(200, handoverFixture({ to_hub_id: null, to_rider_id: OTHER_RIDER_ID }), etag('h1')),
    });

    expect(await screen.findByText('Esi Owusu')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Accept the handover' })).toBeNull();
    expect(screen.getByText(/accepted by that rider, in the Rider app/)).toBeVisible();
  });

  it('tells Ops it may not accept a handover that is not the hub’s', async () => {
    const { user } = open({ ...pending, [ACCEPT]: () => refusal(403, 'PERMISSION_DENIED') });
    await user.click(await screen.findByRole('button', { name: 'Accept the handover' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Accept this handover for the hub?' });
    await user.type(within(dialog).getByRole('textbox', { name: /Parcels taken/ }), '3');

    await user.click(within(dialog).getByRole('button', { name: 'Accept the handover' }));

    expect(
      await within(dialog).findByText(/A handover to a rider is the rider’s to accept/),
    ).toBeVisible();
  });

  it('keeps the same key for a retry after a lost answer', async () => {
    let calls = 0;
    const { user } = open({
      ...pending,
      [ACCEPT]: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : json(
              200,
              handoverFixture({
                state: 'COMPLETED',
                parcel_count_taken: 4,
                resolved_at: '2026-11-04T10:30:00Z',
              }),
              etag('h2'),
            );
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Accept the handover' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Accept this handover for the hub?' });
    await user.type(within(dialog).getByRole('textbox', { name: /Parcels taken/ }), '4');
    await user.click(within(dialog).getByRole('button', { name: 'Accept the handover' }));

    await user.click(await within(dialog).findByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(sent(ACCEPT)).toHaveLength(2);
    });
    expect(sent(ACCEPT)[0]?.headers.get('Idempotency-Key')).toBe(
      sent(ACCEPT)[1]?.headers.get('Idempotency-Key'),
    );
  });

  // Break caught: a list that names two open handovers believed, when one run has at most one.
  it('refuses a list of two pending handovers as an answer that is not the API’s', async () => {
    open({
      [LIST]: () =>
        json(200, {
          items: [
            handoverFixture(),
            handoverFixture({ id: '0f1a2b3c-4d5e-4f6a-8b7c-8d9e0f1a2b3d' }),
          ],
          next_page_token: null,
        }),
    });

    expect(
      await screen.findByText('The custody handover of this run could not be loaded.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Accept the handover' })).toBeNull();
  });
});

describe('custody: the skip of a stop, from the run', () => {
  it('offers the Ops skip for a stop still to be worked of a run in progress, to a holder of pickup.stop.skip', async () => {
    open({ [LIST]: none });

    const link = await screen.findByRole('link', { name: 'Skip stop 1, ACC-PR-7KQ2MZ' });
    expect(link).toHaveAttribute(
      'href',
      `/manifests/${MANIFEST_ID}/stops/${stopFixture().id}/skip`,
    );
  });

  it('offers no skip to a session without the key', async () => {
    open(
      { [LIST]: none },
      KEYS.filter((key) => key !== 'pickup.stop.skip'),
    );
    await section();

    expect(screen.queryByRole('link', { name: /Skip stop/ })).toBeNull();
  });

  it('offers no skip for a stop that is not to be worked, nor for a run that has not started', async () => {
    open(
      { [LIST]: none },
      KEYS,
      running({
        stops: [
          stopFixture({ state: 'COLLECTED', pickup_summary: summaryFixture('ACC-PR-7KQ2MZ') }),
        ],
      }),
    );
    await section();
    expect(screen.queryByRole('link', { name: /Skip stop/ })).toBeNull();
  });
});
