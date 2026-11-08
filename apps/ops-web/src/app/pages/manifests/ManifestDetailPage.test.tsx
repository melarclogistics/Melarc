import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { byHand } from '../../../test-support/by-hand';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
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
  STOP_ONE_ID,
  STOP_THREE_ID,
  STOP_TWO_ID,
  stopFixture,
  summaryFixture,
} from '../../../test-support/manifest-fixture';
import {
  cancellationReasonFixture,
  PICKUP_HUB_ID,
  pickupRequestFixture,
} from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { RIDER_ID, riderFixture } from '../../../test-support/rider-fixture';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/manifests/{id}` (`getPickupManifest` and the acts on one run; S1.25). The record: where the run stands, the rider, the stops in their
 * order each named by its pickup, and the acts the record and the keys allow. Every act sends the version the page read, assigning a rider and
 * dispatching are two separate acts, and a stop skipped because its request was cancelled is told as that and needs nothing.
 */
const PATH = `/manifests/${MANIFEST_ID}`;
const READ = `GET /pickup-manifests/${MANIFEST_ID}`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALL = [
  'pickup.read',
  'pickup.manifest.create',
  'pickup.manifest.assign',
  'pickup.manifest.dispatch',
  'pickup.stop.skip',
  'dispatch.read',
  'settings.reason.read',
  'notification.read',
];

const request = (id: string, code: string, sender: string, address: string) =>
  pickupRequestFixture({
    id,
    code,
    state: 'CONFIRMED',
    sender_name: sender,
    resolved_pickup_location: { address },
  });
const ONE = request(REQUEST_ONE_ID, 'ACC-PR-7KQ2MZ', 'Demo Fabrics Ltd', '14 Demo Lane, Osu');
const TWO = request(REQUEST_TWO_ID, 'ACC-PR-9WXH4T', 'Overdue Bakes', '2 Demo Close, Labone');
const THREE = request(REQUEST_THREE_ID, 'ACC-PR-ZYU26H', 'Third Sender', '5 Demo Road, Tema');

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const answer = (body: unknown, version = 'v1'): Response => json(200, body, etag(version));

function open(
  read: Handler = () => answer(manifestFixture()),
  keys: readonly string[] = ALL,
  handlers: Record<string, Handler> = {},
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [READ]: read,
        [`GET /pickup-requests/${REQUEST_ONE_ID}`]: () => answer(ONE, 'r1'),
        [`GET /pickup-requests/${REQUEST_TWO_ID}`]: () => answer(TWO, 'r1'),
        [`GET /pickup-requests/${REQUEST_THREE_ID}`]: () => answer(THREE, 'r1'),
        [`GET /ops/riders/${RIDER_ID}`]: () =>
          answer({ rider: riderFixture(), devices: [] }, 'rd1'),
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
const bodyOf = async (route: string, index = -1): Promise<unknown> =>
  sent(route).at(index)?.clone().json();
const stopsTable = () => screen.findByRole('table', { name: 'Stops' });
const rowOf = async (text: string): Promise<HTMLElement> => {
  const row = (await within(await stopsTable()).findByText(text)).closest('tr');
  if (row === null) throw new Error(`no row for ${text}`);
  return row;
};
const ready = async () => {
  await screen.findByRole('heading', { level: 1, name: 'ACC-MF-Q92422' });
  await stopsTable();
};

describe('the manifest: what it shows', () => {
  it('shows where the run stands, in words, with its day, hub and rider', async () => {
    open();
    await ready();

    expect(document.title).toBe('ACC-MF-Q92422 · Melarc Ops Portal');
    expect(screen.getByText('Draft')).toBeVisible();
    expect(
      screen.getByText(/It is a draft\. Order its stops, give it a rider and dispatch it/),
    ).toBeVisible();
    const facts = within(screen.getByText('Service date').closest('dl') as HTMLElement);
    expect(facts.getByText('Wed 4 Nov 2026')).toBeVisible();
    expect(facts.getByText('Accra Central')).toBeVisible();
    expect(facts.getByText('No rider assigned yet')).toBeVisible();
    expect(facts.getByText('3 stops')).toBeVisible();
  });

  it('names the rider by name when the roster can say it', async () => {
    open(() =>
      answer(manifestFixture({ assigned_rider_id: RIDER_ID, assigned_at: '2026-11-03T08:00:00Z' })),
    );
    await ready();

    expect(await screen.findByText('Kwame Mensah')).toBeVisible();
    expect(screen.getByText('Assigned')).toBeVisible();
  });

  it('names each stop by the pickup behind it, in the order of the run', async () => {
    open();

    const row = await rowOf('ACC-PR-7KQ2MZ');
    await waitFor(() => {
      expect(within(row).getByText('Demo Fabrics Ltd')).toBeVisible();
    });
    expect(within(row).getByText('14 Demo Lane, Osu')).toBeVisible();
    expect(within(row).getByText('To be worked')).toBeVisible();
    expect(within(row).getByRole('link', { name: 'ACC-PR-7KQ2MZ' })).toHaveAttribute(
      'href',
      `/pickup-requests/${REQUEST_ONE_ID}`,
    );
    const codes = within(await stopsTable())
      .getAllByRole('row')
      .slice(1)
      .map((each) => each.querySelector('th')?.textContent);
    expect(codes).toEqual(['1', '2', '3']);
  });

  // Break caught: a stop whose pickup was read for it when the stop already names its own, or an id shown where a code belongs.
  it('names a dispatched run’s stops by their own summary, and reads no request', async () => {
    open(
      () =>
        answer(
          manifestFixture({
            state: 'DISPATCHED',
            assigned_rider_id: RIDER_ID,
            dispatched_at: '2026-11-03T09:00:00Z',
            stops: [
              stopFixture({ pickup_summary: summaryFixture('ACC-PR-7KQ2MZ') }),
              stopFixture({
                id: STOP_TWO_ID,
                sequence: 2,
                pickup_summary: summaryFixture('ACC-PR-9WXH4T', {
                  sender_display_name: 'Overdue Bakes',
                }),
              }),
            ],
          }),
        ),
      ALL,
      {
        [`GET /pickup-requests/${REQUEST_ONE_ID}`]: () => {
          throw new Error('a request was read for a stop that names its own pickup');
        },
      },
    );
    await ready();

    expect(within(await rowOf('ACC-PR-9WXH4T')).getByText('Overdue Bakes')).toBeVisible();
    expect(document.body.textContent).not.toContain(STOP_ONE_ID);
    expect(document.body.textContent).not.toContain(REQUEST_ONE_ID);
  });

  it('shows a stop skipped because its request was cancelled as cancelled with it, needing nothing', async () => {
    open(() =>
      answer(
        manifestFixture({
          state: 'DISPATCHED',
          assigned_rider_id: RIDER_ID,
          stops: [
            stopFixture({
              state: 'SKIPPED',
              skipped: { reason_code: 'REQUEST_CANCELLED', skipped_at: '2026-11-03T10:00:00Z' },
              pickup_summary: summaryFixture('ACC-PR-7KQ2MZ'),
            }),
            stopFixture({
              id: STOP_TWO_ID,
              pickup_request_id: REQUEST_TWO_ID,
              sequence: 2,
              pickup_summary: summaryFixture('ACC-PR-9WXH4T'),
            }),
          ],
        }),
      ),
    );
    await ready();

    const row = await rowOf('ACC-PR-7KQ2MZ');
    expect(within(row).getByText('Cancelled with its request')).toBeVisible();
    expect(
      within(row).getByText('Its request was cancelled, so the stop was skipped with it.'),
    ).toBeVisible();
    expect(within(row).queryByRole('link', { name: /Skip/ })).toBeNull();
  });

  it('shows a stop an officer skipped with the reason’s label and the officer’s own note', async () => {
    open(
      () =>
        answer(
          manifestFixture({
            state: 'IN_PROGRESS',
            assigned_rider_id: RIDER_ID,
            started_at: '2026-11-04T07:30:00Z',
            stops: [
              stopFixture({
                state: 'SKIPPED',
                skipped: {
                  reason_code: 'LOCATION_INACCESSIBLE',
                  note: 'Gate locked, no answer',
                  skipped_at: '2026-11-04T09:00:00Z',
                },
                arrived_at: '2026-11-04T08:30:00Z',
                pickup_summary: summaryFixture('ACC-PR-7KQ2MZ'),
              }),
            ],
          }),
        ),
      ALL,
      {
        'GET /reason-definitions': () =>
          json(200, [
            cancellationReasonFixture({
              code: 'LOCATION_INACCESSIBLE',
              domain: 'PICKUP_STOP_SKIP',
              label: 'The location could not be reached',
            }),
          ]),
        'GET /run-custody-handovers': () => json(200, { items: [], next_page_token: null }),
      },
    );
    await ready();

    const row = await rowOf('ACC-PR-7KQ2MZ');
    await waitFor(() => {
      expect(
        within(row).getByText('Skipped by Ops: The location could not be reached.'),
      ).toBeVisible();
    });
    expect(within(row).getByText('Note: Gate locked, no answer')).toBeVisible();
    expect(within(row).getByText(/Rider arrived /)).toBeVisible();
    expect(document.body.textContent).not.toContain('LOCATION_INACCESSIBLE');
  });

  it('links to the messages about this run for a session that lists the key of the log', async () => {
    open();
    await ready();

    expect(screen.getByRole('link', { name: 'Messages about this run' })).toHaveAttribute(
      'href',
      `/messages?subject=${MANIFEST_ID}&subject_type=PICKUP_MANIFEST`,
    );
  });
});

describe('the manifest: ordering the stops', () => {
  const newOrder = manifestFixture({
    stops: [
      stopFixture({ id: STOP_TWO_ID, pickup_request_id: REQUEST_TWO_ID, sequence: 1 }),
      stopFixture({ id: STOP_ONE_ID, pickup_request_id: REQUEST_ONE_ID, sequence: 2 }),
      stopFixture({ id: STOP_THREE_ID, pickup_request_id: REQUEST_THREE_ID, sequence: 3 }),
    ],
  });
  const PUT = `PUT /pickup-manifests/${MANIFEST_ID}/stops`;

  async function startOrdering(user: ReturnType<typeof userEvent.setup>) {
    await ready();
    await user.click(screen.getByRole('button', { name: 'Change the order' }));
    return screen.getByRole('list', { name: 'Stops, in order' });
  }

  // Break caught: ordering offered to a run that has gone out, or to a session without the key.
  it('is offered for a draft to a holder of pickup.manifest.create', async () => {
    open();
    await ready();
    expect(screen.getByRole('button', { name: 'Change the order' })).toBeEnabled();
  });

  it.each([
    [
      'a session without the key',
      ALL.filter((key) => key !== 'pickup.manifest.create'),
      manifestFixture(),
    ],
    [
      'a dispatched manifest',
      ALL,
      manifestFixture({ state: 'DISPATCHED', assigned_rider_id: RIDER_ID }),
    ],
  ])('is not offered for %s', async (_name, keys, manifest) => {
    open(() => answer(manifest), keys);
    await ready();
    expect(screen.queryByRole('button', { name: 'Change the order' })).toBeNull();
  });

  // Break caught: a reordering control that works with a pointer alone, or that sends an order before the person saves it.
  it('moves a stop by the keyboard, and sends nothing until the order is saved', async () => {
    const { user } = open();
    await startOrdering(user);

    screen.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' }).focus();
    await user.keyboard('{Enter}');

    const names = within(screen.getByRole('list', { name: 'Stops, in order' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(names[0]).toContain('ACC-PR-9WXH4T');
    expect(names[1]).toContain('ACC-PR-7KQ2MZ');
    expect(sent(PUT)).toHaveLength(0);
  });

  it('saves the complete order under the version read and a key, then reads the manifest again', async () => {
    let reads = 0;
    const { user } = open(
      () => answer(reads++ === 0 ? manifestFixture() : newOrder, reads === 1 ? 'v1' : 'v2'),
      ALL,
      {
        [PUT]: () => answer(newOrder, 'v2'),
      },
    );
    await startOrdering(user);
    await user.click(screen.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' }));

    await user.click(screen.getByRole('button', { name: 'Save this order' }));

    await waitFor(() => {
      expect(sent(PUT)).toHaveLength(1);
    });
    const put = sent(PUT)[0];
    expect(put?.headers.get('If-Match')).toBe('"v1"');
    expect(put?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await bodyOf(PUT)).toEqual({
      ordered_stop_ids: [STOP_TWO_ID, STOP_ONE_ID, STOP_THREE_ID],
    });
    expect(await screen.findByText('The order of the stops is saved.')).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Stops, in order' })).toBeNull();
    expect(sent(READ)).toHaveLength(2);
  });

  it('offers to save only an order that is not the one it has', async () => {
    const { user } = open();
    await startOrdering(user);

    expect(screen.getByRole('button', { name: 'Save this order' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' }));
    expect(screen.getByRole('button', { name: 'Save this order' })).toBeEnabled();
  });

  it('puts the unsaved order aside on Discard, and sends nothing', async () => {
    const { user } = open();
    await startOrdering(user);
    await user.click(screen.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' }));

    await user.click(screen.getByRole('button', { name: 'Discard the changes' }));

    expect(screen.queryByRole('list', { name: 'Stops, in order' })).toBeNull();
    expect(sent(PUT)).toHaveLength(0);
    expect(await stopsTable()).toBeVisible();
  });

  // Break caught: a stop that is no longer to be worked moved by the control, which the server refuses as a stop moved that may not be.
  it('holds a stop that is no longer to be worked in its place', async () => {
    const { user } = open(
      () =>
        answer(
          manifestFixture({
            stops: [
              stopFixture(),
              stopFixture({
                id: STOP_TWO_ID,
                pickup_request_id: REQUEST_TWO_ID,
                sequence: 2,
                state: 'SKIPPED',
                skipped: { reason_code: 'REQUEST_CANCELLED', skipped_at: '2026-11-03T10:00:00Z' },
              }),
              stopFixture({ id: STOP_THREE_ID, pickup_request_id: REQUEST_THREE_ID, sequence: 3 }),
            ],
          }),
        ),
      ALL,
      { [PUT]: () => answer(manifestFixture(), 'v2') },
    );
    await startOrdering(user);

    expect(screen.queryByRole('button', { name: /Move ACC-PR-9WXH4T/ })).toBeNull();
    expect(screen.getByText('Cancelled with its request: it keeps its place.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' }));
    await user.click(screen.getByRole('button', { name: 'Save this order' }));

    await waitFor(() => {
      expect(sent(PUT)).toHaveLength(1);
    });
    // The first stop stepped over the skipped one, which keeps the second place.
    expect(await bodyOf(PUT)).toEqual({
      ordered_stop_ids: [STOP_THREE_ID, STOP_TWO_ID, STOP_ONE_ID],
    });
  });

  it('tells a refused order at the places the server named, and keeps the order', async () => {
    const { user } = open(undefined, ALL, {
      [PUT]: () =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'body', pointer: '/ordered_stop_ids/1', rule: 'resolved_stop_moved' }],
        }),
    });
    await startOrdering(user);
    await user.click(screen.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' }));

    await user.click(screen.getByRole('button', { name: 'Save this order' }));

    expect(await screen.findByText(/That order was not accepted/)).toBeVisible();
    expect(screen.getByText(/did not accept the place numbered 2/)).toBeVisible();
    expect(screen.getByRole('list', { name: 'Stops, in order' })).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  // Break caught: a stale order saved over a manifest that changed, or a conflict told as a failure with no way on.
  it('tells a changed manifest as that, and reads it again from the reload', async () => {
    let reads = 0;
    const { user } = open(
      () => {
        reads += 1;
        return answer(manifestFixture(), `v${String(reads)}`);
      },
      ALL,
      { [PUT]: () => refusal(409, 'STATE_CONFLICT') },
    );
    await startOrdering(user);
    await user.click(screen.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' }));
    await user.click(screen.getByRole('button', { name: 'Save this order' }));

    expect(await screen.findByText(/The stops cannot be ordered now/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reload the manifest' }));

    await waitFor(() => {
      expect(reads).toBe(2);
    });
    expect(screen.queryByRole('list', { name: 'Stops, in order' })).toBeNull();
  });

  it('keeps one key for a retry after a lost answer', async () => {
    let calls = 0;
    const { user } = open(undefined, ALL, {
      [PUT]: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : answer(newOrder, 'v2');
      },
    });
    await startOrdering(user);
    await user.click(screen.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' }));
    await user.click(screen.getByRole('button', { name: 'Save this order' }));

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(sent(PUT)).toHaveLength(2);
    });
    expect(sent(PUT)[0]?.headers.get('Idempotency-Key')).toBe(
      sent(PUT)[1]?.headers.get('Idempotency-Key'),
    );
  });
});

describe('the manifest: assigning a rider and dispatching are separate acts', () => {
  const ASSIGN = `POST /pickup-manifests/${MANIFEST_ID}/assign-rider`;
  const DISPATCH = `POST /pickup-manifests/${MANIFEST_ID}/dispatch`;
  const RIDERS = 'GET /ops/riders';
  const assigned = manifestFixture({
    assigned_rider_id: RIDER_ID,
    assigned_at: '2026-11-03T08:00:00Z',
  });
  const riders = (): Response => json(200, { items: [riderFixture()], next_page_token: null });

  it('offers each as its own act, with its own button', async () => {
    open();
    await ready();

    const acts = screen.getByRole('region', { name: 'What you can do' });
    expect(within(acts).getByRole('heading', { level: 3, name: 'Assign a rider' })).toBeVisible();
    expect(
      within(acts).getByRole('heading', { level: 3, name: 'Dispatch the manifest' }),
    ).toBeVisible();
    expect(within(acts).getByRole('button', { name: 'Assign a rider' })).not.toBe(
      within(acts).getByRole('button', { name: 'Dispatch the manifest' }),
    );
  });

  // Break caught: the roster asked for riders the grant reaches and not those who are active and of this hub; or searched in the browser.
  it('lists the active riders of the manifest’s hub, asked of the server, and offers them to choose', async () => {
    const { user } = open(undefined, ALL, { [RIDERS]: riders });
    await ready();

    await user.click(screen.getByRole('button', { name: 'Assign a rider' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Assign this rider?' });
    expect(await within(dialog).findByText('Kwame Mensah')).toBeVisible();
    const query = new URL(sent(RIDERS)[0]?.url ?? 'http://x/').searchParams;
    expect(query.get('status')).toBe('ACTIVE');
    expect(query.get('hub_id')).toBe(PICKUP_HUB_ID);
    expect(within(dialog).getByText(/closes the vendor’s own cancellation/)).toBeVisible();
  });

  it('assigns the rider chosen on the version read, with no key, and does not dispatch', async () => {
    let reads = 0;
    const { user } = open(
      () => answer(reads++ === 0 ? manifestFixture() : assigned, reads === 1 ? 'v1' : 'v2'),
      ALL,
      {
        [RIDERS]: riders,
        [ASSIGN]: () => answer(assigned, 'v2'),
      },
    );
    await ready();
    await user.click(screen.getByRole('button', { name: 'Assign a rider' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Assign this rider?' });
    await user.click(await within(dialog).findByRole('button', { name: 'Choose: Kwame Mensah' }));

    await user.click(within(dialog).getByRole('button', { name: 'Assign the rider' }));

    await waitFor(() => {
      expect(sent(ASSIGN)).toHaveLength(1);
    });
    expect(sent(ASSIGN)[0]?.headers.get('If-Match')).toBe('"v1"');
    expect(sent(ASSIGN)[0]?.headers.get('Idempotency-Key')).toBeNull();
    expect(await bodyOf(ASSIGN)).toEqual({ rider_id: RIDER_ID });
    expect(
      await screen.findByText(/A rider is assigned\. The manifest is still a draft/),
    ).toBeVisible();
    expect(sent(DISPATCH)).toHaveLength(0);
  });

  it('asks for a rider before it sends anything', async () => {
    const { user } = open(undefined, ALL, { [RIDERS]: riders });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Assign a rider' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Assign this rider?' });
    await within(dialog).findByText('Kwame Mensah');

    await user.click(within(dialog).getByRole('button', { name: 'Assign the rider' }));

    expect(await within(dialog).findByText('Choose a rider.')).toBeVisible();
    expect(sent(ASSIGN)).toHaveLength(0);
  });

  // Break caught: a refused rider kept as the choice, so that the same one is sent again.
  it('tells a rider the server will not take, and sets the choice aside', async () => {
    const { user } = open(undefined, ALL, {
      [RIDERS]: riders,
      [ASSIGN]: () => refusal(422, 'RIDER_UNAVAILABLE'),
    });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Assign a rider' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Assign this rider?' });
    await user.click(await within(dialog).findByRole('button', { name: 'Choose: Kwame Mensah' }));
    await user.click(within(dialog).getByRole('button', { name: 'Assign the rider' }));

    expect(await within(dialog).findAllByText(/cannot be given the manifest/)).not.toHaveLength(0);
    expect(within(dialog).queryByText('Choose another rider')).toBeNull();
    expect(
      await within(dialog).findByRole('button', { name: 'Choose: Kwame Mensah' }),
    ).toBeVisible();
  });

  it('dispatches on the version read, with no key and no body, and says the rider starts the run', async () => {
    const { user } = open(() => answer(assigned), ALL, {
      [DISPATCH]: () =>
        answer(
          manifestFixture({
            state: 'DISPATCHED',
            assigned_rider_id: RIDER_ID,
            dispatched_at: '2026-11-03T09:00:00Z',
          }),
          'v2',
        ),
    });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Dispatch the manifest' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Dispatch this manifest?' });
    expect(within(dialog).getByText(/does not start the run/)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the manifest' }));

    await waitFor(() => {
      expect(sent(DISPATCH)).toHaveLength(1);
    });
    expect(sent(DISPATCH)[0]?.headers.get('If-Match')).toBe('"v1"');
    expect(sent(DISPATCH)[0]?.headers.get('Idempotency-Key')).toBeNull();
    expect(await sent(DISPATCH)[0]?.clone().text()).toBe('');
    expect(await screen.findByText(/The manifest is dispatched/)).toBeVisible();
  });

  // Break caught: a day that has passed told as "this changed, reload", which would send the officer to reload what cannot work.
  it('tells a day that has passed, and what to do next', async () => {
    const { user } = open(undefined, ALL, {
      [DISPATCH]: () =>
        refusal(409, 'STATE_CONFLICT', { rule: 'service_date_passed', service_date: '2026-11-04' }),
    });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Dispatch the manifest' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Dispatch this manifest?' });

    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the manifest' }));

    expect(
      await within(dialog).findByText(/day of this run has passed, so it is never sent out/),
    ).toBeVisible();
    expect(
      within(dialog).getByText(/Cancel the manifest, then plan its requests again/),
    ).toBeVisible();
    expect(screen.queryByText(/service_date_passed/)).toBeNull();
  });

  it('names the stops of a pickup that is no longer confirmed, in the dialog and on the page', async () => {
    const { user } = open(undefined, ALL, {
      [DISPATCH]: () =>
        refusal(409, 'STATE_CONFLICT', { rule: 'request_not_confirmed', stops: [STOP_TWO_ID] }),
    });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Dispatch the manifest' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Dispatch this manifest?' });

    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the manifest' }));

    expect(
      await within(dialog).findByText(/no longer confirmed, so nothing was sent/),
    ).toBeVisible();
    expect(within(dialog).getByText('Concerned: stop 2.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(
      within(await rowOf('ACC-PR-9WXH4T')).getByText(
        'The dispatch was refused because this pickup is no longer confirmed.',
      ),
    ).toBeVisible();
  });

  it.each([
    ['MANIFEST_EMPTY', 422, /Nothing is left to be worked on this manifest/],
    ['RIDER_UNAVAILABLE', 422, /has no rider, or its rider is no longer active/],
  ])('tells %s in the officer’s words', async (code, status, words) => {
    const { user } = open(undefined, ALL, { [DISPATCH]: () => refusal(status, code) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Dispatch the manifest' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Dispatch this manifest?' });

    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the manifest' }));

    expect(await within(dialog).findByText(words)).toBeVisible();
  });

  it('offers neither act to a session without its key, and names the key', async () => {
    open(undefined, ['pickup.read']);
    await ready();

    expect(screen.queryByRole('button', { name: 'Assign a rider' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dispatch the manifest' })).toBeNull();
    expect(screen.getByText('pickup.manifest.assign')).toBeVisible();
    expect(screen.getByText('pickup.manifest.dispatch')).toBeVisible();
  });

  it('says a rider cannot be changed once the manifest is dispatched, and offers neither act', async () => {
    open(() => answer(manifestFixture({ state: 'DISPATCHED', assigned_rider_id: RIDER_ID })));
    await ready();

    expect(
      screen.getByText(/A rider cannot be changed once the manifest is dispatched/),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Assign a rider' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dispatch the manifest' })).toBeNull();
  });
});

describe('the manifest: cancelling it', () => {
  const CANCEL = `POST /pickup-manifests/${MANIFEST_ID}/cancel`;
  const cancelled = manifestFixture({ state: 'CANCELLED' });

  it('asks for a note, then cancels on the version read under a key, and says the requests return to the pool', async () => {
    const { user } = open(undefined, ALL, { [CANCEL]: () => answer(cancelled, 'v2') });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Cancel the manifest' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this manifest?' });
    expect(within(dialog).getByText(/return to the pool/)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel the manifest' }));
    expect(await within(dialog).findByText('Write a note saying why.')).toBeVisible();
    expect(sent(CANCEL)).toHaveLength(0);

    await user.type(
      within(dialog).getByRole('textbox', { name: /Why it is cancelled/ }),
      'Rider unwell',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the manifest' }));

    await waitFor(() => {
      expect(sent(CANCEL)).toHaveLength(1);
    });
    expect(sent(CANCEL)[0]?.headers.get('If-Match')).toBe('"v1"');
    expect(sent(CANCEL)[0]?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await bodyOf(CANCEL)).toEqual({ note: 'Rider unwell' });
    expect(await screen.findByText(/The manifest is cancelled\./)).toBeVisible();
  });

  // Break caught: a run that has started told as a general failure, with no way out.
  it('tells a run that has started, and the way out', async () => {
    const { user } = open(undefined, ALL, { [CANCEL]: () => refusal(422, 'RUN_ALREADY_STARTED') });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Cancel the manifest' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this manifest?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why it is cancelled/ }),
      'Too late',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Cancel the manifest' }));

    expect(await within(dialog).findByText(/skip a stop, or to hand custody over/)).toBeVisible();
  });

  it('is offered for a dispatched manifest and not for a started one or a finished one', async () => {
    open(() => answer(manifestFixture({ state: 'DISPATCHED', assigned_rider_id: RIDER_ID })));
    await ready();
    expect(screen.getByRole('button', { name: 'Cancel the manifest' })).toBeVisible();
  });

  it('is not offered once the run has started, and says why', async () => {
    open(
      () =>
        answer(
          manifestFixture({
            state: 'IN_PROGRESS',
            assigned_rider_id: RIDER_ID,
            started_at: '2026-11-04T07:30:00Z',
          }),
        ),
      ALL,
      { 'GET /run-custody-handovers': () => json(200, { items: [], next_page_token: null }) },
    );
    await ready();

    expect(screen.queryByRole('button', { name: 'Cancel the manifest' })).toBeNull();
    expect(screen.getByText(/A run that has started cannot be cancelled/)).toBeVisible();
  });
});

describe('the manifest: a manifest that is not there', () => {
  it('tells a manifest that does not exist as that, with the way back', async () => {
    open(() => refusal(404, 'NOT_FOUND'));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Manifest not found' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to manifests' })).toHaveAttribute(
      'href',
      '/manifests',
    );
  });

  it('tells a manifest of another hub as that, without drawing anything of it', async () => {
    open(() => refusal(403, 'HUB_SCOPE_VIOLATION'));

    expect(await screen.findByText(/hub your session does not act in/)).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describeInterfaceStates('the manifest page', {
  loading: {
    test: async () => {
      const held = byHand();
      open(held.handler);
      expect(await screen.findByText('Loading the manifest…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A manifest is a record, never empty: a run with no stop to draw is not one the API sends (it holds one to 64), and a list of stops is drawn from what was read.',
  },
  'validation error': {
    test: async () => {
      const { user } = open();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Cancel the manifest' }));
      const dialog = screen.getByRole('alertdialog', { name: 'Cancel this manifest?' });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel the manifest' }));
      expect(await within(dialog).findByText('Write a note saying why.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL_ERROR'));
      expect(await screen.findByText('This manifest could not be loaded.')).toBeVisible();
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let calls = 0;
      const { user } = open(() =>
        calls++ === 0 ? refusal(500, 'INTERNAL_ERROR') : answer(manifestFixture()),
      );
      await user.click(await screen.findByRole('button', { name: /try again|retry/i }));
      await ready();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open(undefined, ALL, {
        [`POST /pickup-manifests/${MANIFEST_ID}/dispatch`]: () => refusal(409, 'STATE_CONFLICT'),
      });
      await ready();
      await user.click(screen.getByRole('button', { name: 'Dispatch the manifest' }));
      const dialog = screen.getByRole('alertdialog', { name: 'Dispatch this manifest?' });
      await user.click(within(dialog).getByRole('button', { name: 'Dispatch the manifest' }));
      expect(await within(dialog).findByText(/changed after you opened it/)).toBeVisible();
      expect(within(dialog).getByRole('button', { name: 'Reload the record' })).toBeVisible();
    },
  },
  success: {
    test: async () => {
      open();
      await ready();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(() => refusal(403, 'PERMISSION_DENIED'));
      expect(await screen.findByText(/pickup\.read/)).toBeVisible();
    },
  },
});
