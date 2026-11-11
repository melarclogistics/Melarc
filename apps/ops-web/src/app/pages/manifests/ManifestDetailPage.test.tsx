import { act, screen, waitFor, within } from '@testing-library/react';
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
import { narrowRoom, restoreRoom } from '../../../test-support/narrow-room';
import { cannotAllText } from '../../../platform/problem/capability-words';

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
  restoreRoom();
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
/** The heavier act, the cancellation, is in the menu of the record's header: it is opened, and the act is chosen. It brings its own question. */
async function chooseAct(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /^More actions for / }));
  await user.click(await screen.findByRole('menuitem', { name }));
}
const ready = async () => {
  await screen.findByRole('heading', { level: 1, name: 'ACC-MF-Q92422' });
  await stopsTable();
};

describe('the manifest: what it shows', () => {
  it('shows where the run stands, in words, with its day, hub and rider', async () => {
    open();
    await ready();

    expect(document.title).toBe('ACC-MF-Q92422 · Melarc Ops Portal');
    // The state is told by the badge and by the tracker (one forward path: draft, dispatched, in progress, completed), and the sentence says what it means.
    expect(screen.getAllByText('Draft').length).toBeGreaterThanOrEqual(2);
    const tracker = screen.getByRole('list', { name: 'Progress of the pickup run' });
    expect(within(tracker).getAllByRole('listitem')).toHaveLength(4);
    expect(within(tracker).getByText('Draft').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
    // The situation only (the Product Owner, 10 November 2026): what comes first is said once, in the line under the acts.
    expect(screen.getByText('It is a draft. Nothing has been sent to a rider.')).toBeVisible();
    const facts = within(screen.getByText('Service date').closest('dl') as HTMLElement);
    expect(facts.getByText('Wed 4 Nov 2026')).toBeVisible();
    expect(facts.getByText('Accra Central')).toBeVisible();
    expect(facts.getByText('No rider assigned yet')).toBeVisible();
    expect(facts.getByText('3 stops')).toBeVisible();
  });

  // Break caught (the Product Owner, 9 November 2026): paragraphs of rules above the content again. A rule lives in the confirmation of the act, where the choice is made (the dialogs hold
  // these three: the assignment's, the dispatch's and the cancellation's); one short muted line under the acts says only what changes whether to act now.
  it('draws no paragraph of rules above the content, and one short line under the acts', async () => {
    const { user } = open(undefined, ALL, {
      'GET /ops/riders': () => json(200, { items: [riderFixture()], next_page_token: null }),
    });
    await ready();

    expect(document.querySelectorAll('.pickup-act__text')).toHaveLength(0);
    for (const rule of [
      /closes the vendor’s own cancellation/,
      /Dispatching shows the stops/,
      /Cancelling asks for a note/,
    ]) {
      expect(screen.queryByText(rule)).toBeNull();
    }
    expect(screen.getByText('Assign a rider before you dispatch.')).toHaveClass(
      'ui-record-header__note',
    );

    // The rules are where the choice is made.
    await user.click(screen.getByRole('button', { name: 'Assign a rider' }));
    expect(
      within(screen.getByRole('alertdialog', { name: 'Assign this rider?' })).getByText(
        /closes the vendor’s own cancellation/,
      ),
    ).toBeVisible();
  });

  // Break caught (the review of f6cf02b, the Product Owner, 10 November 2026): the rule an officer needs before dispatching was gone from the screen: a draft with no rider still offers
  // Dispatch (the page decides nothing and keeps the act, the server refuses), and nothing said that a rider comes first. The one muted line says so when the read shows no rider, and
  // says what the rider sees when there is one; the rule is said once, never in the header's sentence as well.
  it('tells a draft with no rider that a rider comes first, once, and one with a rider what the rider sees', async () => {
    open();
    await ready();

    expect(screen.getByText('Assign a rider before you dispatch.')).toHaveClass(
      'ui-record-header__note',
    );
    expect(screen.queryByText('The rider sees nothing until you dispatch.')).toBeNull();
    // The act is kept: the page decides nothing.
    expect(screen.getByRole('button', { name: 'Dispatch the pickup run' })).toBeVisible();
    // Said once: the header's sentence of a draft is the situation and carries none of it.
    const header = screen.getByText('It is a draft. Nothing has been sent to a rider.');
    expect(header.textContent).not.toMatch(/rider before|give it a rider|dispatch/i);
  });

  it('tells a draft with a rider what the rider sees until it is dispatched', async () => {
    open(() =>
      answer(manifestFixture({ assigned_rider_id: RIDER_ID, assigned_at: '2026-11-03T08:00:00Z' })),
    );
    await ready();

    expect(screen.getByText('The rider sees nothing until you dispatch.')).toHaveClass(
      'ui-record-header__note',
    );
    expect(screen.queryByText('Assign a rider before you dispatch.')).toBeNull();
  });

  // Break caught: the question of the dispatch that does not state the rule (it spoke of "the assigned rider", for a draft that may have none).
  it('states the rule in the question of the dispatch', async () => {
    const { user } = open();
    await ready();

    await user.click(screen.getByRole('button', { name: 'Dispatch the pickup run' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });
    expect(
      within(dialog).getByText(
        /A pickup run needs a rider, and a stop still to be worked, to be dispatched\./,
      ),
    ).toBeVisible();
    expect(within(dialog).queryByText(/the assigned rider/)).toBeNull();
  });

  // Break caught (the review of f6cf02b): a session that holds some of the acts of a run and not others was told of the first it lacked, or of none. The line names every act it cannot do, in one sentence.
  it.each([
    [
      'every key but the one that cancels',
      ALL.filter((key) => key !== 'pickup.manifest.create'),
      'Assign a rider before you dispatch.',
      ['pickup.manifest.create'],
    ],
    [
      'every key but the one that assigns',
      ALL.filter((key) => key !== 'pickup.manifest.assign'),
      'A rider has to be assigned before the pickup run is dispatched.',
      ['pickup.manifest.assign'],
    ],
    [
      'every key but the one that dispatches',
      ALL.filter((key) => key !== 'pickup.manifest.dispatch'),
      'The rider sees nothing until the pickup run is dispatched.',
      ['pickup.manifest.dispatch'],
    ],
    [
      'only the key that assigns',
      ['pickup.read', 'pickup.manifest.assign'],
      'The rider sees nothing until the pickup run is dispatched.',
      ['pickup.manifest.dispatch', 'pickup.manifest.create'],
    ],
  ])('names, in one line, what a session with %s cannot do', async (_name, keys, first, lacks) => {
    open(undefined, keys);
    await ready();

    const line = document.querySelector('.ui-record-header__note');
    expect(line?.textContent).toBe(`${first} ${cannotAllText(lacks)}`);
    expect(document.querySelectorAll('.ui-record-header__note')).toHaveLength(1);
  });

  // Break caught (owner item c of the Product Owner, 9 November 2026): a history that begins with the first thing the record says of the run's progress and says nothing of when the run was made,
  // though the read states it (`created_at`, contract 5.100.0). "Made" is the first entry, a draft has a history at once, and the latest entry is still the one marked.
  it('tells the history of the run from the moment it was made, oldest first', async () => {
    open(() =>
      answer(manifestFixture({ assigned_rider_id: RIDER_ID, assigned_at: '2026-11-03T08:00:00Z' })),
    );
    await ready();

    const history = screen.getByRole('list', { name: 'History of this pickup run, oldest first' });
    const steps = within(history).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      'Made2 Nov, 09:00',
      'Assigned3 Nov, 08:00',
    ]);
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[0]).not.toHaveAttribute('aria-current');
  });

  it('has a history at once for a run that was only made', async () => {
    open();
    await ready();

    const history = screen.getByRole('list', { name: 'History of this pickup run, oldest first' });
    expect(
      within(history)
        .getAllByRole('listitem')
        .map((step) => step.textContent),
    ).toEqual(['Made2 Nov, 09:00']);
  });

  // Break caught (owner item b of the Product Owner, 9 November 2026): the stops of a run in a table that scrolls sideways on a phone, so that the state of a stop is off to the right. The stops are
  // drawn through the data table: a table where the box has room, and under 40rem a list of cards in which every stop says where it is, what it is, its state and what became of it.
  it('draws the stops as cards in a room too narrow for the table, each stop with its place, its state and its act', async () => {
    narrowRoom();
    open(
      () =>
        answer(
          manifestFixture({
            state: 'IN_PROGRESS',
            assigned_rider_id: RIDER_ID,
            started_at: '2026-11-04T07:30:00Z',
            stops: [
              stopFixture({ pickup_summary: summaryFixture('ACC-PR-7KQ2MZ') }),
              stopFixture({
                id: STOP_TWO_ID,
                sequence: 2,
                state: 'SKIPPED',
                skipped: {
                  reason_code: 'REQUEST_CANCELLED',
                  note: 'The vendor called the hub',
                  skipped_at: '2026-11-03T10:00:00Z',
                },
                pickup_summary: summaryFixture('ACC-PR-9WXH4T', {
                  sender_display_name: 'Overdue Bakes',
                }),
              }),
            ],
          }),
        ),
      ALL,
      { 'GET /run-custody-handovers': () => json(200, { items: [], next_page_token: null }) },
    );
    await screen.findByRole('heading', { level: 1, name: 'ACC-MF-Q92422' });

    const cards = within(await screen.findByRole('list', { name: 'Stops' })).getAllByRole(
      'listitem',
    );
    expect(cards).toHaveLength(2);
    expect(screen.queryByRole('table', { name: 'Stops' })).toBeNull();
    const [first, second] = cards;
    expect(
      within(first ?? document.body).getByRole('heading', { level: 3, name: 'Stop 1' }),
    ).toBeVisible();
    expect(
      within(first ?? document.body).getByRole('link', { name: 'ACC-PR-7KQ2MZ' }),
    ).toHaveAttribute('href', `/pickup-requests/${REQUEST_ONE_ID}`);
    expect(within(first ?? document.body).getByText('Demo Fabrics Ltd')).toBeVisible();
    expect(within(first ?? document.body).getByText('14 Demo Lane, Osu')).toBeVisible();
    expect(within(first ?? document.body).getByText('To be worked')).toBeVisible();
    expect(
      within(first ?? document.body).getByRole('link', { name: 'Skip stop 1, ACC-PR-7KQ2MZ' }),
    ).toHaveAttribute('href', `/manifests/${MANIFEST_ID}/stops/${STOP_ONE_ID}/skip`);
    // A stop's state is never hidden: a stop skipped because its request was cancelled says so, with the note, and it has no act.
    expect(within(second ?? document.body).getByText('Cancelled with its request')).toBeVisible();
    expect(
      within(second ?? document.body).getByText('Note: The vendor called the hub'),
    ).toBeVisible();
    expect(within(second ?? document.body).queryByRole('link', { name: /^Skip stop/ })).toBeNull();
  });

  // Break caught (the review of 499399c, over /manifests): the same refusal on the page of one run, which the guard said in the words of pickup requests.
  it('refuses a session without the key in the words of the pickup runs, at the route', async () => {
    open(undefined, ['staff.read']);

    expect(
      await screen.findByText(
        'Your account can’t see pickup runs. Ask an administrator for access.',
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(/pickup requests|pickup.read/);
  });

  it('names the rider by name when the roster can say it', async () => {
    open(() =>
      answer(manifestFixture({ assigned_rider_id: RIDER_ID, assigned_at: '2026-11-03T08:00:00Z' })),
    );
    await ready();

    expect(await screen.findByText('Kwame Mensah')).toBeVisible();
    expect(screen.getByText('Assigned')).toBeVisible();
  });

  // Break caught (run 7, Stage 2.4; the Product Owner's review of 198e5be): a rider's name kept for the session (read once, never stale, and not let go of when the page was), so a rider renamed
  // since the last visit was named as before in the facts and in the question of the dispatch. The name is kept while a page that names the rider is mounted and read again on the next visit.
  it('reads the rider’s name again on the next visit to the page, and once while it stays', async () => {
    let name = 'Kwame Mensah';
    let reads = 0;
    const { router } = open(
      () =>
        answer(
          manifestFixture({ assigned_rider_id: RIDER_ID, assigned_at: '2026-11-03T08:00:00Z' }),
        ),
      ALL,
      {
        [`GET /ops/riders/${RIDER_ID}`]: () => {
          reads += 1;
          return answer({ rider: riderFixture({ full_name: name }), devices: [] }, 'rd1');
        },
      },
    );
    await ready();
    expect(await screen.findByText('Kwame Mensah')).toBeVisible();
    expect(reads).toBe(1);

    await act(async () => {
      await router.navigate('/nowhere');
    });
    name = 'Kwame Asante';
    await act(async () => {
      await router.navigate(PATH);
    });
    await ready();

    expect(await screen.findByText('Kwame Asante')).toBeVisible();
    expect(reads).toBe(2);
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

  // The answer of the act is the run (the whole run and its new version): the page keeps it as its read and does not read the run again (the review of f6cf02b: three to five requests for each act).
  // A second read here would answer the run as it was before, so a page that read again would show the old order and carry the old version.
  it('saves the complete order under the version read and a key, and keeps the answer: the manifest is not read again', async () => {
    let reads = 0;
    const { user } = open(
      () =>
        answer(
          reads++ === 0 ? manifestFixture() : manifestFixture(),
          reads === 1 ? 'v1' : 'v-again',
        ),
      ALL,
      {
        [PUT]: () => answer(newOrder, 'v2'),
        [`POST /pickup-manifests/${MANIFEST_ID}/dispatch`]: () =>
          answer(manifestFixture({ state: 'DISPATCHED', assigned_rider_id: RIDER_ID }), 'v3'),
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
    // The new order is the answer's, drawn at once, and the run was read once, when the page opened.
    expect(sent(READ)).toHaveLength(1);
    const rows = within(await stopsTable()).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('ACC-PR-9WXH4T');
    // The act that follows carries the version of the answer.
    await user.click(screen.getByRole('button', { name: 'Dispatch the pickup run' }));
    const question = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });
    await user.click(within(question).getByRole('button', { name: 'Dispatch the pickup run' }));
    await waitFor(() => {
      expect(sent(`POST /pickup-manifests/${MANIFEST_ID}/dispatch`)).toHaveLength(1);
    });
    expect(sent(`POST /pickup-manifests/${MANIFEST_ID}/dispatch`)[0]?.headers.get('If-Match')).toBe(
      '"v2"',
    );
  });

  // Break caught (the review of f6cf02b): the requests of the stops read again when the order changes, because their key was made of the ids in the order of the stops. The answer is a map by id.
  it('does not read the requests of the stops again when their order is saved', async () => {
    const { user } = open(undefined, ALL, { [PUT]: () => answer(newOrder, 'v2') });
    await startOrdering(user);
    const before = api.requests.filter((request) =>
      request.url.includes('/pickup-requests/'),
    ).length;
    expect(before).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' }));
    await user.click(screen.getByRole('button', { name: 'Save this order' }));
    expect(await screen.findByText('The order of the stops is saved.')).toBeVisible();

    expect(
      api.requests.filter((request) => request.url.includes('/pickup-requests/')),
    ).toHaveLength(before);
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

  // Break caught (the review of 499399c): the focus that was on "Discard the changes" falling to the document when the control leaves the page, or going to a control that has the officer
  // begin again. It goes to the heading of the stops, where they were working, as it did before the redesign.
  it('gives focus to the heading of the stops when the changes are put aside', async () => {
    const { user } = open();
    await startOrdering(user);
    await user.click(screen.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' }));

    await user.click(screen.getByRole('button', { name: 'Discard the changes' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'Stops' })).toHaveFocus();
    });
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
    await user.click(screen.getByRole('button', { name: 'Reload the pickup run' }));

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

    // Each is a button of its own in the record's header, and neither is the other.
    expect(screen.getByRole('button', { name: 'Assign a rider' })).not.toBe(
      screen.getByRole('button', { name: 'Dispatch the pickup run' }),
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
      await screen.findByText(/A rider is assigned\. The pickup run is still a draft/),
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

    expect(await within(dialog).findAllByText(/cannot be given the pickup run/)).not.toHaveLength(
      0,
    );
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
    await user.click(screen.getByRole('button', { name: 'Dispatch the pickup run' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });
    expect(within(dialog).getByText(/does not start the run/)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the pickup run' }));

    await waitFor(() => {
      expect(sent(DISPATCH)).toHaveLength(1);
    });
    expect(sent(DISPATCH)[0]?.headers.get('If-Match')).toBe('"v1"');
    expect(sent(DISPATCH)[0]?.headers.get('Idempotency-Key')).toBeNull();
    expect(await sent(DISPATCH)[0]?.clone().text()).toBe('');
    expect(await screen.findByText(/The pickup run is dispatched/)).toBeVisible();
  });

  // Break caught: a day that has passed told as "this changed, reload", which would send the officer to reload what cannot work.
  it('tells a day that has passed, and what to do next', async () => {
    const { user } = open(undefined, ALL, {
      [DISPATCH]: () =>
        refusal(409, 'STATE_CONFLICT', { rule: 'service_date_passed', service_date: '2026-11-04' }),
    });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Dispatch the pickup run' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });

    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the pickup run' }));

    expect(
      await within(dialog).findByText(/day of this run has passed, so it is never sent out/),
    ).toBeVisible();
    expect(
      within(dialog).getByText(/Cancel the pickup run, then plan its requests again/),
    ).toBeVisible();
    expect(screen.queryByText(/service_date_passed/)).toBeNull();
  });

  it('names the stops of a pickup that is no longer confirmed, in the dialog and on the page', async () => {
    const { user } = open(undefined, ALL, {
      [DISPATCH]: () =>
        refusal(409, 'STATE_CONFLICT', { rule: 'request_not_confirmed', stops: [STOP_TWO_ID] }),
    });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Dispatch the pickup run' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });

    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the pickup run' }));

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
    ['MANIFEST_EMPTY', 422, /Nothing is left to be worked on this pickup run/],
    ['RIDER_UNAVAILABLE', 422, /has no rider, or its rider is no longer active/],
  ])('tells %s in the officer’s words', async (code, status, words) => {
    const { user } = open(undefined, ALL, { [DISPATCH]: () => refusal(status, code) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Dispatch the pickup run' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });

    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the pickup run' }));

    expect(await within(dialog).findByText(words)).toBeVisible();
  });

  it('offers neither act to a session without its key, and says so once, in plain words', async () => {
    open(undefined, ['pickup.read']);
    await ready();

    expect(screen.queryByRole('button', { name: 'Assign a rider' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dispatch the pickup run' })).toBeNull();
    // One line for the draft, naming every act it cannot take (the line named the first of them only).
    expect(
      screen.getByText(
        cannotAllText([
          'pickup.manifest.assign',
          'pickup.manifest.dispatch',
          'pickup.manifest.create',
        ]),
      ),
    ).toHaveClass('ui-record-header__note');
    expect(document.querySelectorAll('.ui-record-header__note')).toHaveLength(1);
  });

  it('says a rider cannot be changed once the pickup run is dispatched, in one line under the acts, and offers neither act', async () => {
    open(() => answer(manifestFixture({ state: 'DISPATCHED', assigned_rider_id: RIDER_ID })));
    await ready();

    expect(
      screen.getByText(/A rider cannot be changed once the pickup run is dispatched/),
    ).toHaveClass('ui-record-header__note');
    expect(screen.queryByRole('button', { name: 'Assign a rider' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dispatch the pickup run' })).toBeNull();
  });

  // Break caught: a line that says there is nothing more to do on a run that cannot change again (the header's sentence says where it stands), or that blames a session that
  // lacks a key it was never going to need.
  for (const [state, keys, who] of [
    ['CANCELLED', ALL, 'a cancelled run'],
    ['COMPLETED', ALL, 'a completed run'],
    ['DISPATCHED', ['pickup.read'], 'a dispatched run, to a session that cannot cancel it'],
  ] as const) {
    it(`draws no line under the acts of ${who}`, async () => {
      open(() => answer(manifestFixture({ state, assigned_rider_id: RIDER_ID })), keys);
      await ready();

      expect(document.querySelectorAll('.ui-record-header__note')).toHaveLength(0);
      expect(document.querySelectorAll('.pickup-act__text')).toHaveLength(0);
    });
  }
});

describe('the manifest: cancelling it', () => {
  const CANCEL = `POST /pickup-manifests/${MANIFEST_ID}/cancel`;
  const cancelled = manifestFixture({ state: 'CANCELLED' });

  it('asks for a note, then cancels on the version read under a key, and says the requests return to the pool', async () => {
    const { user } = open(undefined, ALL, { [CANCEL]: () => answer(cancelled, 'v2') });
    await ready();
    await chooseAct(user, 'Cancel the pickup run');
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup run?' });
    expect(within(dialog).getByText(/return to the pool/)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel the pickup run' }));
    expect(await within(dialog).findByText('Write a note saying why.')).toBeVisible();
    expect(sent(CANCEL)).toHaveLength(0);

    await user.type(
      within(dialog).getByRole('textbox', { name: /Why it is cancelled/ }),
      'Rider unwell',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the pickup run' }));

    await waitFor(() => {
      expect(sent(CANCEL)).toHaveLength(1);
    });
    expect(sent(CANCEL)[0]?.headers.get('If-Match')).toBe('"v1"');
    expect(sent(CANCEL)[0]?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await bodyOf(CANCEL)).toEqual({ note: 'Rider unwell' });
    expect(await screen.findByText(/The pickup run is cancelled\./)).toBeVisible();
  });

  // Break caught: a run that has started told as a general failure, with no way out.
  it('tells a run that has started, and the way out', async () => {
    const { user } = open(undefined, ALL, { [CANCEL]: () => refusal(422, 'RUN_ALREADY_STARTED') });
    await ready();
    await chooseAct(user, 'Cancel the pickup run');
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup run?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why it is cancelled/ }),
      'Too late',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Cancel the pickup run' }));

    expect(await within(dialog).findByText(/skip a stop, or to hand custody over/)).toBeVisible();
  });

  it('is offered for a dispatched pickup run and not for a started one or a finished one', async () => {
    const { user } = open(() =>
      answer(manifestFixture({ state: 'DISPATCHED', assigned_rider_id: RIDER_ID })),
    );
    await ready();
    await user.click(screen.getByRole('button', { name: /^More actions for / }));
    expect(await screen.findByRole('menuitem', { name: 'Cancel the pickup run' })).toBeVisible();
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

    // The cancellation is the menu's only act: a run that has started has no menu at all.
    expect(screen.queryByRole('button', { name: /^More actions for / })).toBeNull();
    expect(screen.getByText(/A run that has started cannot be cancelled/)).toHaveClass(
      'ui-record-header__note',
    );
    // The way out for a rider who cannot go on is the handover, in the custody panel (the line of the old rules, back where an officer looks for it).
    expect(
      screen.getByText(/hand the parcels to another rider or to the hub, in the custody panel/),
    ).toHaveClass('ui-record-header__note');
  });
});

describe('the manifest: a manifest that is not there', () => {
  it('tells a manifest that does not exist as that, with the way back', async () => {
    open(() => refusal(404, 'NOT_FOUND'));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Pickup run not found' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to pickup runs' })).toHaveAttribute(
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
      expect(await screen.findByText('Loading the pickup run…')).toBeVisible();
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
      await chooseAct(user, 'Cancel the pickup run');
      const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup run?' });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel the pickup run' }));
      expect(await within(dialog).findByText('Write a note saying why.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL_ERROR'));
      expect(await screen.findByText('This pickup run could not be loaded.')).toBeVisible();
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
      await user.click(screen.getByRole('button', { name: 'Dispatch the pickup run' }));
      const dialog = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });
      await user.click(within(dialog).getByRole('button', { name: 'Dispatch the pickup run' }));
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
      expect(
        await screen.findByText(
          'Your account can’t see pickup runs. Ask an administrator for access.',
        ),
      ).toBeVisible();
    },
  },
});

describe('the manifest: an act keeps its answer, and the run is not read again', () => {
  const ASSIGN = `POST /pickup-manifests/${MANIFEST_ID}/assign-rider`;
  const DISPATCH = `POST /pickup-manifests/${MANIFEST_ID}/dispatch`;
  const CANCEL = `POST /pickup-manifests/${MANIFEST_ID}/cancel`;
  const RIDERS = 'GET /ops/riders';
  const RIDER_READ = `GET /ops/riders/${RIDER_ID}`;
  const riders = (): Response => json(200, { items: [riderFixture()], next_page_token: null });
  const assigned = manifestFixture({
    assigned_rider_id: RIDER_ID,
    assigned_at: '2026-11-03T08:00:00Z',
  });
  const dispatched = manifestFixture({
    state: 'DISPATCHED',
    assigned_rider_id: RIDER_ID,
    assigned_at: '2026-11-03T08:00:00Z',
    dispatched_at: '2026-11-03T09:00:00Z',
  });

  /**
   * The read of the run, counted. Any read after the first answers the run **as it is not**: cancelled, at a version nobody holds. A page that read the run again after an act would draw that,
   * and send that version in the next.
   */
  function counted(first: ReturnType<typeof manifestFixture>) {
    const state = { reads: 0 };
    const read = () => {
      state.reads += 1;
      return state.reads === 1
        ? answer(first, 'v1')
        : answer(manifestFixture({ state: 'CANCELLED' }), 'v-not-this');
    };
    return { state, read };
  }

  // Break caught (the review of f6cf02b): the run read again after every act, though the answer of the act is the whole run with its new version. Assigning, dispatching, cancelling and saving the
  // order answer so, and the pages made three to five requests for each; the limit of a session is 120 a minute. The answer is the page's read, the next act carries its version, and the
  // rider's name, which the facts and the question of the dispatch both ask for, is read once.
  it('assigning a rider and then dispatching: the answers are the page’s reads, the versions carry on, and the rider is read once', async () => {
    const { state, read } = counted(manifestFixture());
    const { user } = open(read, ALL, {
      [RIDERS]: riders,
      [ASSIGN]: () => answer(assigned, 'v2'),
      [DISPATCH]: () => answer(dispatched, 'v3'),
    });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Assign a rider' }));
    const assignQuestion = screen.getByRole('alertdialog', { name: 'Assign this rider?' });
    await user.click(
      await within(assignQuestion).findByRole('button', { name: 'Choose: Kwame Mensah' }),
    );
    await user.click(within(assignQuestion).getByRole('button', { name: 'Assign the rider' }));

    expect(await screen.findByText(/A rider is assigned\./)).toBeVisible();
    expect(state.reads).toBe(1);
    const facts = within(screen.getByText('Service date').closest('dl') as HTMLElement);
    expect(await facts.findByText('Kwame Mensah')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Dispatch the pickup run' }));
    const question = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });
    expect(
      within(question).getByText(/shown to Kwame Mensah, and to no other rider/),
    ).toBeVisible();
    await user.click(within(question).getByRole('button', { name: 'Dispatch the pickup run' }));

    expect(await screen.findByText(/The pickup run is dispatched\./)).toBeVisible();
    await waitFor(() => {
      expect(sent(DISPATCH)).toHaveLength(1);
    });
    expect(sent(ASSIGN)[0]?.headers.get('If-Match')).toBe('"v1"');
    expect(sent(DISPATCH)[0]?.headers.get('If-Match')).toBe('"v2"');
    expect(state.reads).toBe(1);
    expect(screen.getAllByText('Dispatched').length).toBeGreaterThanOrEqual(1);
    expect(sent(RIDER_READ)).toHaveLength(1);
  });

  it('dispatching: the answer is the page’s read, and the run is not read again', async () => {
    const { state, read } = counted(assigned);
    const { user } = open(read, ALL, { [DISPATCH]: () => answer(dispatched, 'v2') });
    await ready();

    await user.click(screen.getByRole('button', { name: 'Dispatch the pickup run' }));
    const question = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });
    await user.click(within(question).getByRole('button', { name: 'Dispatch the pickup run' }));

    expect(await screen.findByText(/The pickup run is dispatched\./)).toBeVisible();
    expect(state.reads).toBe(1);
    expect(screen.getAllByText('Dispatched').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: 'Dispatch the pickup run' })).toBeNull();
  });

  it('cancelling: the answer is the page’s read, and the run is not read again', async () => {
    const { state, read } = counted(dispatched);
    const { user } = open(read, ALL, {
      [CANCEL]: () =>
        answer(manifestFixture({ state: 'CANCELLED', assigned_rider_id: RIDER_ID }), 'v2'),
    });
    await ready();
    await chooseAct(user, 'Cancel the pickup run');
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup run?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why it is cancelled/ }),
      'Rider unwell',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the pickup run' }));

    expect(await screen.findByText(/The pickup run is cancelled\./)).toBeVisible();
    expect(state.reads).toBe(1);
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThanOrEqual(1);
  });

  // Break caught (run 7, Stage 2.2; the Product Owner's review of 198e5be): the answer of an act written into the page's read while a read of the same run was already on its way. That read was
  // sent before the act and is answered after it, with the run as it was, so it put the version before the act back and the next act was refused with 412. Here the read is the one the person asked
  // for after a conflict, held open across the dispatch that follows it.
  it('keeps the answer of an act when a read of the run that was already on its way is answered after it', async () => {
    let reads = 0;
    let dispatches = 0;
    let answerTheRead: (response: Response) => void = () => undefined;
    const { user } = open(
      () => {
        reads += 1;
        return reads === 2
          ? new Promise<Response>((resolve) => {
              answerTheRead = resolve;
            })
          : answer(assigned, `v${String(reads)}`);
      },
      ALL,
      {
        [DISPATCH]: () => {
          dispatches += 1;
          return dispatches === 1
            ? refusal(409, 'STATE_CONFLICT')
            : answer(dispatched, 'v-dispatched');
        },
      },
    );
    await ready();
    await user.click(screen.getByRole('button', { name: 'Dispatch the pickup run' }));
    const question = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });
    await user.click(within(question).getByRole('button', { name: 'Dispatch the pickup run' }));
    await user.click(
      await within(question).findByRole('button', {
        name: /Reload|Look at the pickup run|Read it again/,
      }),
    );
    await waitFor(() => {
      expect(reads).toBe(2);
    });

    // The run is read again (held), and the person dispatches it while that read is on its way.
    await user.click(await screen.findByRole('button', { name: 'Dispatch the pickup run' }));
    const again = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });
    await user.click(within(again).getByRole('button', { name: 'Dispatch the pickup run' }));
    expect(await screen.findByText(/The pickup run is dispatched\./)).toBeVisible();

    // The read that was sent before the dispatch is answered now, with the run as it was.
    await act(async () => {
      answerTheRead(answer(assigned, 'v2'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getAllByText('Dispatched').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: 'Dispatch the pickup run' })).toBeNull();
  });

  // Break caught: the read after a conflict, or an outcome nobody knows, skipped with the rest: that read is the person's, and it stays.
  it('still reads the run again when the person asks for it after a conflict', async () => {
    let reads = 0;
    const { user } = open(
      () => {
        reads += 1;
        return answer(manifestFixture(), `v${String(reads)}`);
      },
      ALL,
      { [DISPATCH]: () => refusal(409, 'STATE_CONFLICT') },
    );
    await ready();
    await user.click(screen.getByRole('button', { name: 'Dispatch the pickup run' }));
    const question = screen.getByRole('alertdialog', { name: 'Dispatch this pickup run?' });
    await user.click(within(question).getByRole('button', { name: 'Dispatch the pickup run' }));
    await user.click(
      await within(question).findByRole('button', {
        name: /Reload|Look at the pickup run|Read it again/,
      }),
    );

    await waitFor(() => {
      expect(reads).toBe(2);
    });
  });
});
