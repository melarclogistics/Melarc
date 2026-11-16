import { screen, waitFor, within } from '@testing-library/react';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID } from '../../../test-support/hub-intake-fixture';
import { describeInterfaceStates } from '../../../test-support/interface-states';
import {
  BLIND_INTAKE_ID,
  BLIND_VENDOR,
  KENTE,
  KENTE_INTAKE_ID,
  PARCEL_KIND,
  PHOTO_KIND,
  PLANTED_BLIND_NUMBER,
  RUN_CODE,
  RUN_ID,
  SHEA,
  SHEA_INTAKE_CODE,
  SHEA_INTAKE_ID,
  arrivedParcel,
  blindVendorFixture,
  checkInFixture,
  countsOf,
  extraParcel,
  lockFixture,
  parcelFixture,
  photoLinkHandlers,
  photoVendorFixture,
  runFixture,
  uuid,
} from '../../../test-support/receiving-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/receiving/{run}` (`getReceivingRun`; S1.35c; D-D1, D-D2): **a section for each vendor of the run**, where the officer checks the parcels in against the photos the rider took at the door. The tests hold what
 * the owner asked of it: *All N here* is one confirmation in the owner's words and sends the number the officer was shown; *The count is different* is a tap on each parcel that is on the table and a finish that
 * marks the rest missing; **the lock is taken on the first act and never by opening the page**, and is one plain line; a vendor counted blind says one line and shows nothing of the rider's number; when every vendor
 * is finished the page says what came of the run and *Check the rider's bag before they leave*; and nothing on the page speaks in the voice of the people who built the system.
 */
const READ = `GET /receiving-runs/${RUN_ID}`;
const lockOf = (id: string) => `POST /hub-intakes/${id}/lock`;
const finishOf = (id: string) => `POST /hub-intakes/${id}/check-in`;
const arrivalOf = (parcelId: string) => `PUT /intake-parcels/${parcelId}/arrival`;
const KEYS = ['hub.read', 'hub.intake.count'];
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
/** The words of the people who built the system, which no screen of the floor says. */
const FORBIDDEN = /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server)\b/i;

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const sheaParcels = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    parcelFixture(index + 1, {
      id: uuid(PARCEL_KIND, 100 + index + 1),
      photo_evidence_id: uuid(PHOTO_KIND, 100 + index + 1),
    }),
  );
const sheaVendor = (count = 2, overrides: Parameters<typeof photoVendorFixture>[1] = {}) =>
  photoVendorFixture(
    count,
    {
      intake_id: SHEA_INTAKE_ID,
      intake_code: SHEA_INTAKE_CODE,
      intake_etag: '"shea-1"',
      vendor_name: SHEA,
      ...overrides,
    },
    sheaParcels(count),
  );

type RunFixture = ReturnType<typeof runFixture>;
const photosOf = (run: RunFixture) => photoLinkHandlers(run.vendors.flatMap((v) => v.parcels));

interface Options {
  readonly run?: RunFixture;
  readonly handlers?: Record<string, Handler>;
  readonly keys?: readonly string[];
  readonly path?: string;
  /** The read of the run, when it is not the plain answer of `run`. */
  readonly read?: Handler;
}

function open({
  run = runFixture([photoVendorFixture(3)]),
  handlers = {},
  keys = KEYS,
  path = `/receiving/${RUN_ID}`,
  read,
}: Options = {}) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [READ]: read ?? (() => json(200, run)),
      ...photosOf(run),
      ...handlers,
    }),
  );
  return renderApp(path);
}

const requestsTo = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname}` ===
      `${route.split(' ')[0] ?? ''} /api/v1${route.split(' ')[1] ?? ''}`,
  );
const section = async (name: string): Promise<HTMLElement> => screen.findByRole('region', { name });
const body = () => document.body.textContent;
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) =>
          typeof text === 'string'
            ? alert.textContent.includes(text)
            : text.test(alert.textContent),
        ),
    ).toBe(true);
  });
  const [first] = screen.getAllByRole('alert');
  if (first === undefined) throw new Error('no alert');
  return first;
};
/** The vendor's section, once the run is drawn. */
const kente = () => section(KENTE);

/** The answer of a tap: the parcels as they are after it, the vendor's token and its counts. */
const tapAnswer = (
  parcels: ReturnType<typeof parcelFixture>[],
  at: number,
  version = '"kente-2"',
) =>
  json(200, {
    parcel: parcels[at],
    intake_etag: version,
    counts: { ...countsOf(parcels), received_count: null, count_variance: null },
  });

describe('the run’s page: what it shows', () => {
  it('names the run by its code, says who handed it over, where and when, and has a section for each vendor', async () => {
    open({ run: runFixture([photoVendorFixture(3), sheaVendor(2)]) });

    expect(await screen.findByRole('heading', { level: 1, name: RUN_CODE })).toBeVisible();
    expect(
      screen.getByText('Kofi Boateng handed this run over to Accra hub at 09:00.'),
    ).toBeVisible();
    expect(await screen.findByRole('heading', { level: 2, name: KENTE })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: SHEA })).toBeVisible();
    const first = within(await kente());
    expect(first.getByText('3 parcels photographed')).toBeVisible();
    expect(first.getByText('Waiting to be checked in')).toBeVisible();
    // The breadcrumb and the menu both lead to the queue.
    for (const link of screen.getAllByRole('link', { name: 'Receiving' })) {
      expect(link).toHaveAttribute('href', '/receiving');
    }
  });

  // Break caught: a lock taken by opening the page, so that an officer who only looks at the run is shown to others as checking it in.
  it('takes no lock by being opened, and says nothing of one when nobody has started', async () => {
    open();
    await kente();
    await screen.findByRole('list', { name: `Photos of ${KENTE}’s parcels` });
    expect(requestsTo(lockOf(KENTE_INTAKE_ID))).toHaveLength(0);
    expect(body()).not.toMatch(/opened this check-in/);
  });

  // Break caught: an identifier, an address or a phone number drawn as text, or a photo's link shown.
  it('draws no identifier, no address and no phone number', async () => {
    open({ run: runFixture([photoVendorFixture(3), sheaVendor(2)]) });
    const first = await kente();
    await waitFor(() => {
      expect(first.querySelectorAll('img').length).toBeGreaterThan(0);
    });
    expect(body()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(body()).not.toMatch(/photos\.example\.test|https?:\/\//);
    expect(body()).not.toMatch(/\+?\d[\d\s-]{8,}\d/);
  });

  // Break caught (OB-S1-111): a word of the system's builders on a screen of the floor, in any state of a vendor.
  it('speaks the words of the floor, in every state of a vendor', async () => {
    const missing = parcelFixture(2, {
      state: 'MISSING',
      missing_marked_at: '2026-11-16T09:20:00Z',
    });
    open({
      run: runFixture([
        photoVendorFixture(3),
        sheaVendor(2, { state: 'RECONCILIATION_REQUIRED' }),
        blindVendorFixture({
          state: 'RECONCILIATION_REQUIRED',
          received_count: 12,
          count_variance: 'SHORT',
        }),
        photoVendorFixture(
          2,
          {
            intake_id: uuid(0x77, 1),
            vendor_name: 'Yaw Textiles',
            intake_etag: '"y-1"',
            state: 'RECONCILIATION_REQUIRED',
            missing_count: 1,
            extra_count: 0,
          },
          [
            parcelFixture(21, {
              id: uuid(PARCEL_KIND, 201),
              photo_evidence_id: uuid(PHOTO_KIND, 201),
            }),
            {
              ...missing,
              id: uuid(PARCEL_KIND, 202),
              ordinal: 22,
              photo_evidence_id: uuid(PHOTO_KIND, 202),
            },
          ],
        ),
      ]),
    });
    await kente();
    await screen.findByRole('heading', { level: 2, name: BLIND_VENDOR });
    expect(body()).not.toMatch(FORBIDDEN);
    expect(body()).not.toMatch(DIAGNOSTIC);
  });
});

describe('the lock’s line', () => {
  // Break caught: the lock told in the words of the builders, with its time as a date, or as the officer's when it is someone else's.
  it('says who opened the check-in and when, in one plain line', async () => {
    open({
      run: runFixture([
        photoVendorFixture(3, {
          lock: lockFixture({
            holder_name: 'Ama Owusu',
            held_by_you: false,
            opened_at: '2026-11-16T09:12:00Z',
          }),
        }),
      ]),
    });
    expect(
      await screen.findByText('Ama Owusu opened this check-in at 09:12. It stops nobody.'),
    ).toBeVisible();
  });

  it('says You for the officer’s own lock', async () => {
    open({
      run: runFixture([
        photoVendorFixture(3, {
          lock: lockFixture({
            holder_name: 'Ama Owusu',
            held_by_you: true,
            opened_at: '2026-11-16T09:12:00Z',
          }),
        }),
      ]),
    });
    expect(
      await screen.findByText('You opened this check-in at 09:12. It stops nobody.'),
    ).toBeVisible();
  });

  // Break caught: a lock that could not be checked still told as the officer's: the page says it cannot check, and offers no "ask again".
  it('says it cannot check when the lock could not be taken, and offers no way to ask again', async () => {
    const run = runFixture([photoVendorFixture(3)]);
    const { user } = open({
      run,
      handlers: {
        [lockOf(KENTE_INTAKE_ID)]: () => refusal(500, 'INTERNAL_ERROR'),
        [arrivalOf(parcelFixture(1).id)]: () =>
          tapAnswer([arrivedParcel(1), parcelFixture(2), parcelFixture(3)], 0),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'The count is different' }));
    await user.click(await screen.findByRole('button', { name: 'Parcel 1' }));

    expect(
      await screen.findByText(/The page cannot check who else is checking this in right now/),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /ask again|try again/i })).toBeNull();
    // The tap went on: the lock is advisory.
    expect(await screen.findByRole('button', { name: 'Parcel 1, Checked in' })).toBeVisible();
  });
});

describe('"All N here"', () => {
  const all = [arrivedParcel(1), arrivedParcel(2), arrivedParcel(3)];
  const finished = () => json(200, checkInFixture(all), { ETag: '"kente-2"' });

  // Break caught: the confirmation in other words than the owner's, with another Cancel (a link, a div) or with the number a default and not a statement.
  it('asks in the owner’s words, with the photos beside the question and a real Cancel', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'All 3 here' }));

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Confirm 3 parcels from Kente Crafts?',
    });
    expect(
      within(dialog).getByText('I counted 3 parcels from this vendor on the table.'),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveClass('ui-button');
    expect(within(dialog).getByRole('button', { name: 'Yes, all 3 are here' })).toBeVisible();
    expect(
      within(dialog).getByRole('list', { name: `Photos of ${KENTE}’s parcels` }),
    ).toBeVisible();
    // Nothing is sent by asking.
    expect(requestsTo(finishOf(KENTE_INTAKE_ID))).toHaveLength(0);
  });

  it('sends nothing, and gives the focus back, when the officer cancels', async () => {
    const { user } = open();
    const opener = await screen.findByRole('button', { name: 'All 3 here' });
    await user.click(opener);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(requestsTo(finishOf(KENTE_INTAKE_ID))).toHaveLength(0);
    expect(opener).toHaveFocus();
  });

  // Break caught: the number the officer confirmed not the one sent, a missing key or version, or a lock taken by the question and not by the act.
  it('sends the number the officer confirmed with a key and the vendor’s version, takes the lock, and says where the officer is and what is next', async () => {
    let read = 0;
    const run = runFixture([photoVendorFixture(3), sheaVendor(2)]);
    const afterwards = runFixture([
      photoVendorFixture(
        3,
        {
          state: 'READY_FOR_ITEMIZATION',
          intake_etag: '"kente-2"',
          received_count: 3,
          count_variance: 'MATCH',
        },
        all,
      ),
      sheaVendor(2),
    ]);
    const { user } = open({
      run,
      read: () => {
        read += 1;
        return json(200, read === 1 ? run : afterwards);
      },
      handlers: {
        [lockOf(KENTE_INTAKE_ID)]: () => json(200, checkInFixture(all)),
        [finishOf(KENTE_INTAKE_ID)]: finished,
      },
    });
    await user.click(await screen.findByRole('button', { name: 'All 3 here' }));
    expect(requestsTo(lockOf(KENTE_INTAKE_ID))).toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'Yes, all 3 are here' }));

    expect(await screen.findByText('Kente Crafts is checked in.')).toBeVisible();
    expect(await screen.findByText('Next: Shea Naturals')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Go to Shea Naturals' })).toBeVisible();
    const [sent] = requestsTo(finishOf(KENTE_INTAKE_ID));
    expect(sent?.headers.get('If-Match')).toBe('"kente-1"');
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/\S+/);
    expect(await sent?.clone().json()).toEqual({ all_arrived: true, confirmed_count: 3 });
    expect(requestsTo(lockOf(KENTE_INTAKE_ID)).length).toBeGreaterThanOrEqual(0);
    expect(within(await kente()).getByText('Checked in and cleared')).toBeVisible();
    expect(within(await kente()).queryByRole('button', { name: /All 3 here/ })).toBeNull();
  });

  // Break caught: a vendor with a parcel that is not on the list offered "All N here", which the API refuses: the pile with an extra is finished as tapped.
  it('is not offered for a vendor that has an extra parcel', async () => {
    const parcels = [arrivedParcel(1), parcelFixture(2), parcelFixture(3), extraParcel(4)];
    open({ run: runFixture([photoVendorFixture(3, {}, parcels)]) });
    await kente();
    expect(screen.queryByRole('button', { name: 'All 3 here' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Finish this vendor' })).toBeVisible();
  });
});

describe('"The count is different": a tap on each parcel that is here', () => {
  const taps = (n: number) => arrivalOf(parcelFixture(n).id);

  // Break caught: tiles that do nothing until the officer chooses, or that check a parcel in when the officer only looks.
  it('shows the photos to look at, and makes each tile a toggle only after the officer chooses', async () => {
    const { user } = open();
    await screen.findByRole('list', { name: `Photos of ${KENTE}’s parcels` });
    for (const tile of screen.getAllByRole('button', { name: /^Parcel \d$/ })) {
      expect(tile).not.toHaveAttribute('aria-pressed');
    }
    await user.click(screen.getByRole('button', { name: 'The count is different' }));

    expect(screen.getByRole('button', { name: 'Parcel 1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText(/Tap each parcel that is on the table/)).toBeVisible();
    expect(screen.getByText('0 of 3 checked in')).toBeVisible();
  });

  // Break caught: a tap that is not sent, sent with a key or a version, or drawn without the API's answer; a tally that is not the API's number.
  it('sends the tap with the desired state, takes the lock, and draws what the API answered', async () => {
    const { user } = open({
      handlers: {
        [lockOf(KENTE_INTAKE_ID)]: () => json(200, checkInFixture([parcelFixture(1)])),
        [taps(1)]: () => tapAnswer([arrivedParcel(1), parcelFixture(2), parcelFixture(3)], 0),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'The count is different' }));
    await user.click(screen.getByRole('button', { name: 'Parcel 1' }));

    expect(await screen.findByRole('button', { name: 'Parcel 1, Checked in' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await screen.findByText('1 of 3 checked in')).toBeVisible();
    const [sent] = requestsTo(`PUT /intake-parcels/${parcelFixture(1).id}/arrival`);
    expect(sent?.headers.get('If-Match')).toBeNull();
    expect(sent?.headers.get('Idempotency-Key')).toBeNull();
    expect(await sent?.clone().json()).toEqual({ arrived: true });
    expect(requestsTo(lockOf(KENTE_INTAKE_ID))).toHaveLength(1);
    // The run is not read again for a tap.
    expect(requestsTo(READ)).toHaveLength(1);
  });

  // Break caught: a tap taken back that sends "arrived: true" again.
  it('takes a tap back by tapping the parcel again', async () => {
    let state = 'ARRIVED';
    const { user } = open({
      run: runFixture([
        photoVendorFixture(3, {}, [arrivedParcel(1), parcelFixture(2), parcelFixture(3)]),
      ]),
      handlers: {
        [lockOf(KENTE_INTAKE_ID)]: () => json(200, checkInFixture([parcelFixture(1)])),
        [taps(1)]: () => {
          state = 'EXPECTED';
          return tapAnswer([parcelFixture(1), parcelFixture(2), parcelFixture(3)], 0);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Parcel 1, Checked in' }));

    expect(await screen.findByRole('button', { name: 'Parcel 1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(state).toBe('EXPECTED');
    const [sent] = requestsTo(`PUT /intake-parcels/${parcelFixture(1).id}/arrival`);
    expect(await sent?.clone().json()).toEqual({ arrived: false });
  });

  // Break caught: a vendor finished as tapped without saying what becomes of the parcels that were not tapped, or with a number the page typed.
  it('says how many parcels will be marked missing, and sends the finish with no number', async () => {
    const parcels = [arrivedParcel(1), arrivedParcel(2), parcelFixture(3)];
    const after = [
      arrivedParcel(1),
      arrivedParcel(2),
      parcelFixture(3, { state: 'MISSING', missing_marked_at: '2026-11-16T09:20:00Z' }),
    ];
    let finishedYet = false;
    const run = runFixture([photoVendorFixture(3, {}, parcels)]);
    const { user } = open({
      run,
      read: () =>
        json(
          200,
          finishedYet
            ? runFixture([
                photoVendorFixture(
                  3,
                  {
                    state: 'RECONCILIATION_REQUIRED',
                    intake_etag: '"kente-2"',
                    received_count: 2,
                    count_variance: 'SHORT',
                  },
                  after,
                ),
              ])
            : run,
        ),
      handlers: {
        [lockOf(KENTE_INTAKE_ID)]: () => json(200, checkInFixture(parcels)),
        [finishOf(KENTE_INTAKE_ID)]: () => {
          finishedYet = true;
          return json(
            200,
            checkInFixture(after, {
              state: 'RECONCILIATION_REQUIRED',
              received_count: 2,
              count_variance: 'SHORT',
              count_difference: -1,
            }),
            { ETag: '"kente-2"' },
          );
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Finish this vendor' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Finish Kente Crafts?' });
    expect(
      within(dialog).getByText('1 parcel you did not tap will be marked missing.'),
    ).toBeVisible();
    expect(
      within(dialog).getByText('A senior officer will then decide what happens next.'),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Finish this vendor' }));

    expect(await screen.findByText('Kente Crafts is checked in.')).toBeVisible();
    const [sent] = requestsTo(finishOf(KENTE_INTAKE_ID));
    expect(await sent?.clone().json()).toEqual({ all_arrived: false });
    expect(sent?.headers.get('If-Match')).toBe('"kente-1"');
    expect(
      await within(await kente()).findByText('A senior officer will decide about this vendor.'),
    ).toBeVisible();
    expect(within(await kente()).getByRole('button', { name: 'Parcel 3, Missing' })).toBeVisible();
  });

  // Break caught: a refusal of a tap drawn as success, as a generic failure, or without the words of the table.
  it('says why a tap was refused, where the officer is looking, and leaves the parcel as it was', async () => {
    const { user } = open({
      handlers: {
        [lockOf(KENTE_INTAKE_ID)]: () => json(200, checkInFixture([parcelFixture(1)])),
        [taps(1)]: () => refusal(409, 'STATE_CONFLICT', { rule: 'check_in_finished' }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'The count is different' }));
    await user.click(screen.getByRole('button', { name: 'Parcel 1' }));

    await alertSaying(/was finished already, so nothing was changed/);
    expect(screen.getByRole('button', { name: 'Parcel 1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('the run when every vendor is finished', () => {
  const missing = parcelFixture(3, { state: 'MISSING', missing_marked_at: '2026-11-16T09:20:00Z' });
  const finishedRun = runFixture([
    photoVendorFixture(
      3,
      { state: 'RECONCILIATION_REQUIRED', received_count: 2, count_variance: 'SHORT' },
      [arrivedParcel(1), arrivedParcel(2), missing],
    ),
    sheaVendor(2, { state: 'READY_FOR_ITEMIZATION', received_count: 2, count_variance: 'MATCH' }),
  ]);

  // Break caught: a finished run that leaves the officer to work out what to do next, or that does not show the rider the pictures of what is missing.
  it('says what came of it, shows the photos of what is missing, and leads with the rider’s bag', async () => {
    open({ run: finishedRun });
    const summary = within(await screen.findByRole('region', { name: 'Before the rider leaves' }));

    expect(summary.getByText('Check the rider’s bag before they leave.')).toBeVisible();
    expect(summary.getByText('Kente Crafts: 2 checked in, 1 missing')).toBeVisible();
    expect(
      summary.getByText('These parcels are not here. Show the rider their photos.'),
    ).toBeVisible();
    expect(
      summary.getByRole('list', { name: `Photos of ${KENTE}’s missing parcels` }),
    ).toBeVisible();
    expect(summary.getByText('A senior officer will decide about Kente Crafts.')).toBeVisible();
  });

  // Break caught: the summary shown while a vendor still waits, which would tell the officer the run is done.
  it('is not shown while a vendor still waits to be checked in', async () => {
    open({
      run: runFixture([photoVendorFixture(3), sheaVendor(2, { state: 'READY_FOR_ITEMIZATION' })]),
    });
    await kente();
    expect(screen.queryByRole('region', { name: 'Before the rider leaves' })).toBeNull();
  });

  it('says everything is checked in when nothing is missing, extra or damaged', async () => {
    open({
      run: runFixture([
        sheaVendor(2, {
          state: 'READY_FOR_ITEMIZATION',
          received_count: 2,
          count_variance: 'MATCH',
        }),
      ]),
    });
    expect(
      await screen.findByText('Everything the rider handed over is checked in.'),
    ).toBeVisible();
  });
});

describe('a vendor counted without photos', () => {
  // Break caught (D-D3): the rider's number, or a photo, or a way of checking parcels in, on a vendor whose photos Ops excused.
  it('says one line, offers the count, and shows nothing of the rider’s number', async () => {
    open({ run: runFixture([blindVendorFixture()]) });
    const section_ = within(await section(BLIND_VENDOR));

    expect(section_.getByText('No photos at the door: counted, not checked in')).toBeVisible();
    expect(
      section_.getByText(/The rider’s number is shown only after you have typed yours\./),
    ).toBeVisible();
    expect(section_.getByRole('link', { name: 'Count the parcels' })).toHaveAttribute(
      'href',
      `/intakes/${BLIND_INTAKE_ID}/count`,
    );
    expect(section_.queryByRole('list')).toBeNull();
    expect((await section(BLIND_VENDOR)).querySelectorAll('img')).toHaveLength(0);
    expect(section_.queryByRole('button', { name: /All \d+ here|count is different/ })).toBeNull();
    expect(body()).not.toContain(String(PLANTED_BLIND_NUMBER));
  });

  it('says what the officer counted and how it compares, once it is counted', async () => {
    open({
      run: runFixture([
        blindVendorFixture({
          state: 'RECONCILIATION_REQUIRED',
          received_count: 12,
          count_variance: 'SHORT',
        }),
      ]),
    });
    const section_ = within(await section(BLIND_VENDOR));
    expect(section_.getByText('You counted 12 parcels.')).toBeVisible();
    expect(section_.getByText('That is fewer than the rider’s number.')).toBeVisible();
    expect(section_.getByText('A senior officer will decide about this vendor.')).toBeVisible();
    expect(section_.queryByRole('link', { name: 'Count the parcels' })).toBeNull();
  });
});

describe('one parcel, opened', () => {
  const missing = parcelFixture(3, { state: 'MISSING', missing_marked_at: '2026-11-16T09:20:00Z' });
  const parcels = [
    arrivedParcel(1, { arrived_by_name: 'Ama Owusu', arrived_at: '2026-11-16T09:14:00Z' }),
    arrivedParcel(2),
    missing,
  ];
  const run = runFixture([
    photoVendorFixture(
      3,
      { state: 'RECONCILIATION_REQUIRED', received_count: 2, count_variance: 'SHORT' },
      parcels,
    ),
  ]);

  // Break caught: a condition drawn as fine from a default, when nobody has recorded one.
  it('says who checked the parcel in and when, and that its condition is not checked yet', async () => {
    const { user } = open({ run });
    await user.click(await screen.findByRole('button', { name: 'Parcel 1, Checked in' }));

    const dialog = await screen.findByRole('dialog', { name: 'Parcel 1' });
    expect(within(dialog).getByText('From Kente Crafts.')).toBeVisible();
    expect(within(dialog).getByText('Checked in by Ama Owusu at 09:14.')).toBeVisible();
    expect(within(dialog).getByText('Condition not checked yet.')).toBeVisible();
    expect(within(dialog).queryByText(/Good condition|Looks fine/)).toBeNull();
  });

  // Break caught: "Found it" sent as a toggle that could take the parcel back, or offered for a parcel that is not missing.
  it('offers "Found it" for a missing parcel while the case is open, and checks it in', async () => {
    const found = [arrivedParcel(1), arrivedParcel(2), arrivedParcel(3)];
    const { user } = open({
      run,
      handlers: {
        [lockOf(KENTE_INTAKE_ID)]: () => json(200, checkInFixture(parcels)),
        [arrivalOf(missing.id)]: () => tapAnswer(found, 2, '"kente-2"'),
      },
    });
    // The finished run's summary shows the missing parcel's photo too, so the tile is asked for in the vendor's own section.
    await user.click(within(await kente()).getByRole('button', { name: 'Parcel 3, Missing' }));
    const dialog = await screen.findByRole('dialog', { name: 'Parcel 3' });
    expect(within(dialog).getByText(/Missing since 09:20/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Found it' }));

    expect(await screen.findByText('Parcel 3 is found and checked in.')).toBeVisible();
    const [sent] = requestsTo(arrivalOf(missing.id));
    expect(await sent?.clone().json()).toEqual({ arrived: true });
    expect(await screen.findByRole('button', { name: 'Parcel 3, Checked in' })).toBeVisible();
  });

  it('does not offer "Found it" for a parcel that is checked in', async () => {
    const { user } = open({ run });
    await user.click(await screen.findByRole('button', { name: 'Parcel 2, Checked in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Parcel 2' });
    expect(within(dialog).queryByRole('button', { name: 'Found it' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeVisible();
  });

  // Break caught: an extra taken back by a press on its tile, with no decision of its own.
  it('takes an extra back only from its own dialog, while the vendor is open', async () => {
    const withExtra = [arrivedParcel(1), parcelFixture(2), parcelFixture(3), extraParcel(4)];
    const voided = [
      arrivedParcel(1),
      parcelFixture(2),
      parcelFixture(3),
      extraParcel(4, { state: 'VOID' }),
    ];
    const { user } = open({
      run: runFixture([photoVendorFixture(3, {}, withExtra)]),
      handlers: {
        [lockOf(KENTE_INTAKE_ID)]: () => json(200, checkInFixture(withExtra)),
        [arrivalOf(extraParcel(4).id)]: () => tapAnswer(voided, 3),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Extra parcel 4, Checked in' }));
    // A press only opens it.
    expect(requestsTo(arrivalOf(extraParcel(4).id))).toHaveLength(0);
    const dialog = await screen.findByRole('dialog', { name: 'Extra parcel 4' });
    await user.click(within(dialog).getByRole('button', { name: 'Take this parcel back' }));

    expect(await screen.findByText('Extra parcel 4 was taken back.')).toBeVisible();
    const [sent] = requestsTo(arrivalOf(extraParcel(4).id));
    expect(await sent?.clone().json()).toEqual({ arrived: false });
  });
});

describe('an officer who can look at the run and cannot check parcels in', () => {
  // Break caught: acts offered to an account without the key (which the API would refuse), or an officer told to ask for what is not theirs to ask for.
  it('is told so in plain words and is offered no act', async () => {
    open({ keys: ['hub.read'] });
    await kente();

    expect(
      screen.getByText(
        /You can look at this run\. Your account can’t count the parcels received at a hub\./,
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', {
        name: /All \d+ here|The count is different|Finish this vendor/,
      }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a parcel not on the list' })).toBeNull();
  });
});

describe('a lost connection', () => {
  const WORDS = 'No connection. What you do now is not saved.';
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Break caught: a page that says nothing when the tablet loses its connection, so that the officer goes on checking parcels in and none of it is saved; or one that is blocked by it.
  it('says what the officer does now is not saved while the browser says it is offline, and says nothing when it is back', async () => {
    open();
    await kente();
    expect(screen.queryByText(WORDS)).toBeNull();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(await screen.findByText(WORDS)).toBeVisible();
    // The page is not blocked by it.
    expect(screen.getByRole('button', { name: 'All 3 here' })).toBeEnabled();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(screen.queryByText(WORDS)).toBeNull();
    });
  });

  // Break caught: a tap that did not reach the platform drawn as nothing (the browser may say it is online while the signal carries nothing).
  it('says it too when a tap does not arrive although the browser says it is online, and goes when one gets through', async () => {
    let attempt = 0;
    const { user } = open({
      handlers: {
        [lockOf(KENTE_INTAKE_ID)]: () => json(200, checkInFixture([parcelFixture(1)])),
        [arrivalOf(parcelFixture(1).id)]: () => {
          attempt += 1;
          return attempt === 1
            ? Promise.reject(new TypeError('Failed to fetch'))
            : tapAnswer([arrivedParcel(1), parcelFixture(2), parcelFixture(3)], 0);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'The count is different' }));
    await user.click(screen.getByRole('button', { name: 'Parcel 1' }));

    expect(await screen.findByText(WORDS)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Parcel 1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await user.click(screen.getByRole('button', { name: 'Parcel 1' }));
    await waitFor(() => {
      expect(screen.queryByText(WORDS)).toBeNull();
    });
    expect(await screen.findByRole('button', { name: 'Parcel 1, Checked in' })).toBeVisible();
  });
});

describe('an address that is not a run', () => {
  it('says the run could not be found, and asks for nothing', async () => {
    open({ path: '/receiving/not-a-run' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Run not found' })).toBeVisible();
    expect(screen.getByText('This run could not be found.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to receiving' })).toHaveAttribute(
      'href',
      '/receiving',
    );
    expect(requestsTo(READ)).toHaveLength(0);
  });
});

describeInterfaceStates('the run’s page', {
  loading: {
    test: async () => {
      open({ read: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText(/Loading the run/)).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A run is read by its address and always has a vendor to check in: one that does not exist is the page of a run that could not be found, which is tested above.',
  },
  'validation error': {
    test: async () => {
      open({ path: '/receiving/not-a-run' });
      expect(await screen.findByRole('heading', { name: 'Run not found' })).toBeVisible();
      expect(requestsTo(READ)).toHaveLength(0);
    },
  },
  error: {
    test: async () => {
      open({ read: () => refusal(500, 'INTERNAL_ERROR') });
      await alertSaying('This run could not be loaded.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open({
        read: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, runFixture([photoVendorFixture(3)]));
        },
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('heading', { level: 1, name: RUN_CODE })).toBeVisible();
    },
  },
  offline: {
    test: async () => {
      // A read that never reaches the platform is an error of the read with a way to try again, and says nothing of why in the words of the network.
      open({ read: () => Promise.reject(new TypeError('Failed to fetch')) });
      await alertSaying(/could not be loaded|connection/i);
      expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    },
  },
  'stale / conflict': {
    test: async () => {
      const { user } = open({
        handlers: {
          [lockOf(KENTE_INTAKE_ID)]: () => json(200, checkInFixture([parcelFixture(1)])),
          [finishOf(KENTE_INTAKE_ID)]: () => refusal(409, 'STATE_CONFLICT', { rule: 'stale' }),
        },
      });
      await user.click(await screen.findByRole('button', { name: 'All 3 here' }));
      await user.click(await screen.findByRole('button', { name: 'Yes, all 3 are here' }));

      await alertSaying(/This vendor changed after you opened it, so nothing was recorded/);
      expect(screen.getByRole('button', { name: 'Reload the record' })).toBeVisible();
    },
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByRole('heading', { level: 1, name: RUN_CODE })).toBeVisible();
      expect(await kente()).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({ read: () => refusal(403, 'PERMISSION_DENIED') });
      expect(
        await screen.findByText(/Your account can’t see what has been handed over at a hub/),
      ).toBeVisible();
      expect(screen.queryByRole('button', { name: /All \d+ here/ })).toBeNull();
    },
  },
});
