import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  DECLARED,
  INTAKE_EVIDENCE_ONE,
  INTAKE_HUB_ID,
  INTAKE_ID,
  findingFixture,
  postCountFixture,
  preCountFixture,
  shortCountFixture,
} from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  EVIDENCE_LIMITS,
  KENTE,
  KENTE_INTAKE_CODE,
  KENTE_INTAKE_ID,
  RECEIVER_NAME,
  RUN_CODE,
  RUN_ID,
  arrivedParcel,
  checkInFixture,
  extraParcel,
  parcelFixture,
  photoLinkHandlers,
} from '../../../test-support/receiving-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/intakes/{id}` (`getHubIntake`; S1.35c; D-D1, D-D2, D-D8): **what came of a vendor**, in the floor's words. A vendor checked in against its door photos shows what was checked in and what is missing, extra or
 * damaged (each group as the photos of its parcels), the comparison with the photos, what was found in the order it was made and the door photos; a vendor counted without photos shows the rider's number only
 * once it was counted. The acts are offered by key and by what the record says (*Decide* to a senior officer while the vendor needs a decision, *Record that the vendor was told* after a write-off, *Correct the
 * count* until the orders are listed, *Record damage* once for a vendor with no photos), and the correction is a senior officer's, with a reason, and tells the number before and after.
 */
const READ = (id: string) => `GET /hub-intakes/${id}`;
const CORRECTION = (id: string) => `POST /hub-intakes/${id}/correction`;
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const COUNT_KEYS = ['hub.read', 'hub.intake.count'];
const SENIOR_KEYS = ['hub.read', 'hub.intake.count', 'hub.osd.adjudicate'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|locks?\b(?! is)|the server)\b/i;
const V1 = { ETag: '"v1"' };
const V2 = { ETag: '"v2"' };
const DAMAGE_PHOTO = '0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f';

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

interface Options {
  readonly id?: string;
  readonly body: unknown;
  readonly keys?: readonly string[];
  readonly handlers?: Record<string, Handler>;
  readonly photos?: readonly ReturnType<typeof parcelFixture>[];
  /** The address to open, when it is not the vendor's own page. */
  readonly path?: string;
}

function open({
  id = KENTE_INTAKE_ID,
  body,
  keys = SENIOR_KEYS,
  handlers = {},
  photos = [],
  path,
}: Options) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [READ(id)]: () => json(200, body, V1),
      ...photoLinkHandlers(photos),
      ...handlers,
    }),
  );
  return renderApp(path ?? `/intakes/${id}`);
}

const requestsTo = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname}` ===
      `${route.split(' ')[0] ?? ''} /api/v1${route.split(' ')[1] ?? ''}`,
  );
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
const section = async (name: string): Promise<HTMLElement> => screen.findByRole('region', { name });

/** A finished vendor: three door photos (one damaged, one missing) and one extra on the table. */
const damaged = (n: number) =>
  arrivedParcel(n, {
    condition: {
      condition: 'DAMAGED',
      note: 'Torn corner.',
      evidence_ids: [DAMAGE_PHOTO],
      recorded_by_name: RECEIVER_NAME,
      recorded_at: '2026-11-14T09:20:00Z',
    },
  });
const MIXED = [
  arrivedParcel(1),
  damaged(2),
  parcelFixture(3, { state: 'MISSING', missing_marked_at: '2026-11-14T09:30:00Z' }),
  extraParcel(4),
];
const mixedVendor = (overrides: Record<string, unknown> = {}) =>
  checkInFixture(MIXED, {
    state: 'RECONCILIATION_REQUIRED',
    count_variance: 'SHORT',
    count_difference: -1,
    condition: 'DAMAGED',
    condition_findings: [
      {
        id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        kind: 'CONDITION',
        intake_parcel_id: MIXED[1]?.id,
        condition: 'DAMAGED',
        outcome: null,
        note: 'Torn corner.',
        evidence_ids: [DAMAGE_PHOTO],
        recorded_by_name: RECEIVER_NAME,
        recorded_at: '2026-11-14T09:20:00Z',
      },
    ],
    ...overrides,
  });

describe('a vendor checked in against its door photos', () => {
  it('says what came of it: the counts, the comparison, the parcels that need someone as photos, what was found and the door photos', async () => {
    open({ body: mixedVendor(), photos: MIXED });

    expect(await screen.findByRole('heading', { level: 1, name: KENTE_INTAKE_CODE })).toBeVisible();
    expect(screen.getByText('A senior officer will decide about this vendor.')).toBeVisible();
    const came = within(await section('What came of this vendor'));
    for (const [label, value] of [
      ['Photographed at the door', '3'],
      ['Checked in', '3'],
      ['Missing', '1'],
      ['Extra', '1'],
      ['Damaged', '1'],
      ['Compared with the photos', '1 parcel fewer'],
    ] as const) {
      expect(came.getByText(label).nextElementSibling).toHaveTextContent(value);
    }
    // Each group of parcels that need someone is the photos of its parcels.
    expect(screen.getByRole('list', { name: `Missing parcels of ${KENTE}` })).toBeVisible();
    expect(screen.getByRole('list', { name: `Extra parcels of ${KENTE}` })).toBeVisible();
    expect(screen.getByRole('list', { name: `Damaged parcels of ${KENTE}` })).toBeVisible();
    // What was found, with who and when, and its photos opened one at a time.
    const found = within(await section('What was found'));
    expect(found.getByText('Parcel 2: Damaged')).toBeVisible();
    expect(found.getByText('Torn corner.')).toBeVisible();
    // Who made it and when: a name on a check-in, with the day and the time.
    expect(found.getByText(new RegExp(`${RECEIVER_NAME} at .*09:20`))).toBeVisible();
    expect(found.getByRole('button', { name: 'Open Photo 1' })).toBeVisible();
    // The door photos are all drawn, and nothing of an identifier or an address is on the page.
    expect(screen.getByRole('list', { name: `Photos of ${KENTE}’s parcels` })).toBeVisible();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  // Break caught: a photo of a parcel that needs someone opened as an act, or a tile that decides something.
  it('opens a parcel’s photo among its group’s, with where the parcel stands, and offers no act on it', async () => {
    const { user } = open({ body: mixedVendor(), photos: MIXED });
    const missing = await screen.findByRole('list', { name: `Missing parcels of ${KENTE}` });
    await user.click(within(missing).getByRole('button', { name: /Parcel 3/ }));

    const viewer = await screen.findByRole('dialog');
    expect(within(viewer).getByText(/Missing since 09:30/)).toBeVisible();
    expect(within(viewer).queryByRole('button', { name: 'Open this parcel' })).toBeNull();
  });

  // Break caught: "The same" said of a vendor with a parcel missing and one extra on its record: the totals match and the parcels do not.
  it('does not say a vendor with a parcel missing and one extra is the same on its record either', async () => {
    const parcels = [
      arrivedParcel(1),
      arrivedParcel(2),
      parcelFixture(3, { state: 'MISSING', missing_marked_at: '2026-11-14T09:30:00Z' }),
      extraParcel(4),
    ];
    open({
      body: checkInFixture(parcels, {
        state: 'RECONCILIATION_REQUIRED',
        count_variance: 'MATCH',
        count_difference: 0,
      }),
      photos: parcels,
    });
    const came = within(await section('What came of this vendor'));

    expect(came.getByText('Compared with the photos').nextElementSibling).toHaveTextContent(
      '1 missing, 1 extra',
    );
    expect(came.queryByText('The same')).toBeNull();
  });

  it('says a vendor still waiting is waiting, and offers its run to an officer who may check it in', async () => {
    const parcels = [parcelFixture(1), parcelFixture(2)];
    open({
      body: checkInFixture(parcels, {
        state: 'AWAITING_COUNT',
        received_count: null,
        count_variance: null,
        count_difference: null,
        counted_at: null,
        counted_by_name: null,
      }),
      keys: COUNT_KEYS,
      photos: parcels,
    });

    expect(await screen.findByText('This vendor is waiting to be checked in.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Check in this vendor' })).toHaveAttribute(
      'href',
      `/receiving/${RUN_ID}`,
    );
    expect(screen.queryByRole('heading', { name: 'Missing, extra or damaged parcels' })).toBeNull();
    expect(screen.getByRole('link', { name: RUN_CODE })).toBeVisible();
  });
});

describe('the acts the record offers', () => {
  // Break caught: the decision offered to a session without its key, or told as a lack of access: a senior officer decides it.
  it('offers Decide to a senior officer while the vendor needs a decision, and tells anyone else that a senior officer will decide', async () => {
    open({ body: mixedVendor(), photos: MIXED });
    expect(await screen.findByRole('link', { name: 'Decide' })).toHaveAttribute(
      'href',
      `/intakes/${KENTE_INTAKE_ID}/discrepancy`,
    );
  });

  it('tells an officer without the decision that a senior officer will decide, and gives no way to decide or to correct', async () => {
    open({ body: mixedVendor(), keys: COUNT_KEYS, photos: MIXED });
    expect(await screen.findByText('A senior officer will decide this.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Decide' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Correct the count' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/administrator/i);
  });

  it('does not offer Decide to a vendor that is not in review', async () => {
    open({
      body: mixedVendor({ state: 'READY_FOR_ITEMIZATION' }),
      photos: MIXED,
    });
    expect(await screen.findByRole('heading', { level: 1, name: KENTE_INTAKE_CODE })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Decide' })).toBeNull();
  });

  // Break caught (D-D4): "Vendor told" offered before a write-off, or after it was recorded already.
  it('offers the record that the vendor was told only after a write-off, and only once', async () => {
    const decision = (outcome: string, id: string) => ({
      id,
      kind: 'ADJUDICATION',
      intake_parcel_id: null,
      condition: null,
      outcome,
      note: 'Searched the hub and the rider’s bag.',
      evidence_ids: [],
      recorded_by_name: 'Kojo Mensah',
      recorded_at: '2026-11-14T11:00:00Z',
    });
    open({
      body: mixedVendor({
        state: 'READY_FOR_ITEMIZATION',
        condition_findings: [decision('WRITTEN_OFF', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')],
      }),
      photos: MIXED,
    });
    expect(
      await screen.findByRole('link', { name: 'Record that the vendor was told' }),
    ).toHaveAttribute('href', `/intakes/${KENTE_INTAKE_ID}/discrepancy`);
    expect(screen.getByText('Written off: not found')).toBeVisible();
  });

  it('does not offer the record that the vendor was told once it was recorded', async () => {
    const decision = (outcome: string, id: string) => ({
      id,
      kind: 'ADJUDICATION',
      intake_parcel_id: null,
      condition: null,
      outcome,
      note: 'Told by phone.',
      evidence_ids: [],
      recorded_by_name: 'Kojo Mensah',
      recorded_at: '2026-11-14T11:00:00Z',
    });
    open({
      body: mixedVendor({
        state: 'READY_FOR_ITEMIZATION',
        condition_findings: [
          decision('WRITTEN_OFF', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'),
          decision('VENDOR_NOTIFIED', '2b3c4d5e-6f70-4b8c-9dae-1f2a3b4c5d6e'),
        ],
      }),
      photos: MIXED,
    });
    expect(await screen.findByText('Vendor told')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Record that the vendor was told' })).toBeNull();
  });
});

describe('the correction of a count (D-D8)', () => {
  const corrected = (changes: ReturnType<typeof parcelFixture>[]) =>
    checkInFixture(changes, {
      state: 'RECONCILIATION_REQUIRED',
      count_variance: 'SHORT',
      count_difference: -2,
    });

  // Break caught: a correction sent without a reason, with parcels that did not change, or on a version other than the one read.
  it('asks for a reason and for a change, then sends only the parcels changed, with the reason, on the version read, and tells the number before and after', async () => {
    const after = [
      arrivedParcel(1),
      parcelFixture(2, { state: 'MISSING', missing_marked_at: '2026-11-14T10:00:00Z' }),
      parcelFixture(3, { state: 'MISSING', missing_marked_at: '2026-11-14T09:30:00Z' }),
      extraParcel(4),
    ];
    const { user } = open({
      body: mixedVendor(),
      photos: MIXED,
      handlers: { [CORRECTION(KENTE_INTAKE_ID)]: () => json(200, corrected(after), V2) },
    });
    await user.click(await screen.findByRole('button', { name: 'Correct the count' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: `Correct the count for ${KENTE}?`,
    });

    // Nothing changed, no reason: both are told at their places and nothing is sent.
    await user.click(within(dialog).getByRole('button', { name: 'Record the correction' }));
    expect(
      await within(dialog).findByText('Change at least one parcel before you record a correction.'),
    ).toBeVisible();
    expect(within(dialog).getByText('Write why you are correcting this.')).toBeVisible();
    expect(requestsTo(CORRECTION(KENTE_INTAKE_ID))).toHaveLength(0);

    await user.click(within(dialog).getByRole('checkbox', { name: 'Parcel 2 is here' }));
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why you are correcting this/ }),
      'Parcel 2 was not on the table.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record the correction' }));

    await waitFor(() => {
      expect(requestsTo(CORRECTION(KENTE_INTAKE_ID))).toHaveLength(1);
    });
    const [sent] = requestsTo(CORRECTION(KENTE_INTAKE_ID));
    expect(await sent?.clone().json()).toEqual({
      reason: 'Parcel 2 was not on the table.',
      parcel_changes: [{ parcel_id: MIXED[1]?.id, state: 'MISSING' }],
    });
    expect(sent?.headers.get('If-Match')).toBe('"v1"');
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await screen.findByText('The correction is recorded. It was 3; it is now 2.'),
    ).toBeVisible();
  });

  it('takes back an extra that was added by mistake, as taken back and not as missing', async () => {
    const after = [MIXED[0], MIXED[1], MIXED[2], extraParcel(4, { state: 'VOID' })] as ReturnType<
      typeof parcelFixture
    >[];
    const { user } = open({
      body: mixedVendor(),
      photos: MIXED,
      handlers: { [CORRECTION(KENTE_INTAKE_ID)]: () => json(200, corrected(after), V2) },
    });
    await user.click(await screen.findByRole('button', { name: 'Correct the count' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Extra parcel 4 is here' }));
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why you are correcting this/ }),
      'It was not ours.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record the correction' }));

    await waitFor(() => {
      expect(requestsTo(CORRECTION(KENTE_INTAKE_ID))).toHaveLength(1);
    });
    expect(await requestsTo(CORRECTION(KENTE_INTAKE_ID))[0]?.clone().json()).toEqual({
      reason: 'It was not ours.',
      parcel_changes: [{ parcel_id: MIXED[3]?.id, state: 'VOID' }],
    });
  });

  // Break caught: a correction refused for want of the key told as a lack of access to ask an administrator for.
  it('tells a senior officer’s refusal as a senior officer’s, and never to ask an administrator', async () => {
    const { user } = open({
      body: mixedVendor(),
      photos: MIXED,
      handlers: { [CORRECTION(KENTE_INTAKE_ID)]: () => refusal(403, 'PERMISSION_DENIED') },
    });
    await user.click(await screen.findByRole('button', { name: 'Correct the count' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Parcel 1 is here' }));
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why you are correcting this/ }),
      'A mistake.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record the correction' }));

    const alert = await alertSaying(
      'A senior officer makes corrections. Ask one to open this page.',
    );
    expect(alert).not.toHaveTextContent(/administrator/i);
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });
});

describe('a vendor counted without photos', () => {
  it('says before its count that it is waiting to be counted, shows nothing of the rider’s number, and offers the count', async () => {
    open({ id: INTAKE_ID, body: preCountFixture(), keys: COUNT_KEYS });

    expect(await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeVisible();
    expect(
      (
        await screen.findAllByText(
          /This vendor was not photographed at the door, so its parcels are counted/,
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Count the parcels' })).toHaveAttribute(
      'href',
      `/intakes/${INTAKE_ID}/count`,
    );
    expect(screen.queryByText('The rider said at handover')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Correct the count' })).toBeNull();
  });

  it('shows the rider’s number, the count and the comparison once it was counted, and what was found by who', async () => {
    open({
      id: INTAKE_ID,
      body: shortCountFixture({
        condition: 'DAMAGED',
        condition_findings: [findingFixture()],
        parcel_photo_ids: [INTAKE_EVIDENCE_ONE],
      }),
      keys: SENIOR_KEYS,
    });

    const came = within(await section('What came of this vendor'));
    expect(came.getByText('The rider said at handover').nextElementSibling).toHaveTextContent(
      String(DECLARED),
    );
    expect(came.getByText('Counted at the hub').nextElementSibling).toHaveTextContent(
      String(DECLARED - 2),
    );
    expect(came.getByText('Compared with the rider’s number').nextElementSibling).toHaveTextContent(
      '2 parcels fewer',
    );
    const found = within(await section('What was found'));
    expect(found.getByText('The vendor: Damaged')).toBeVisible();
    expect(found.getByText(/Another member of staff at .*09:20/)).toBeVisible();
    expect(
      within(await section('The door photos')).getByRole('button', { name: 'Open Door photo 1' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Decide' })).toBeVisible();
  });

  // Break caught (D-D7): damage offered for a second time, or before the vendor is counted: it is recorded once, after the count.
  it('offers Record damage after the count, to the count key', async () => {
    open({ id: INTAKE_ID, body: shortCountFixture(), keys: COUNT_KEYS });
    expect(await screen.findByRole('button', { name: 'Record damage' })).toBeVisible();
  });

  it('does not offer Record damage to a session without the count key, nor once a condition is recorded', async () => {
    open({ id: INTAKE_ID, body: shortCountFixture(), keys: ['hub.read'] });
    await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' });
    expect(screen.queryByRole('button', { name: 'Record damage' })).toBeNull();
    api.restore();
  });

  it('does not offer Record damage once a condition is recorded: it is recorded once', async () => {
    open({
      id: INTAKE_ID,
      body: shortCountFixture({ condition: 'DAMAGED', condition_findings: [findingFixture()] }),
      keys: COUNT_KEYS,
    });
    await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' });
    expect(screen.queryByRole('button', { name: 'Record damage' })).toBeNull();
  });

  it('asks for a photo of the damage at its field and sends nothing without one', async () => {
    const { user } = open({
      id: INTAKE_ID,
      body: shortCountFixture(),
      keys: COUNT_KEYS,
      handlers: { 'GET /evidence-limits': () => json(200, EVIDENCE_LIMITS) },
    });
    await user.click(await screen.findByRole('button', { name: 'Record damage' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Record damage for this vendor?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Record the damage' }));

    expect(await within(dialog).findByText('Take a photo of the damage.')).toBeVisible();
    expect(requestsTo(`POST /hub-intakes/${INTAKE_ID}/condition`)).toHaveLength(0);
  });

  // Break caught: a correction of a count that is the number already recorded, sent as a correction.
  it('corrects the count by its number: not the one recorded, a whole number, with a reason', async () => {
    const after = shortCountFixture({ physical_count: 6, count_difference: -1 });
    const { user } = open({
      id: INTAKE_ID,
      body: shortCountFixture(),
      keys: SENIOR_KEYS,
      handlers: { [CORRECTION(INTAKE_ID)]: () => json(200, after, V2) },
    });
    await user.click(await screen.findByRole('button', { name: 'Correct the count' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Correct the count?' });
    const number = within(dialog).getByRole('textbox', {
      name: /The number of parcels on the table/,
    });
    const reason = within(dialog).getByRole('textbox', { name: /Why you are correcting this/ });

    await user.type(number, String(DECLARED - 2));
    await user.type(reason, 'Miscounted.');
    await user.click(within(dialog).getByRole('button', { name: 'Record the correction' }));
    expect(
      await within(dialog).findByText(
        'That is the number already recorded. Enter the number you counted now.',
      ),
    ).toBeVisible();
    await user.clear(number);
    await user.type(number, 'six');
    await user.click(within(dialog).getByRole('button', { name: 'Record the correction' }));
    expect(await within(dialog).findByText('Enter a whole number from 0.')).toBeVisible();
    expect(requestsTo(CORRECTION(INTAKE_ID))).toHaveLength(0);

    await user.clear(number);
    await user.type(number, '6');
    await user.click(within(dialog).getByRole('button', { name: 'Record the correction' }));
    await waitFor(() => {
      expect(requestsTo(CORRECTION(INTAKE_ID))).toHaveLength(1);
    });
    expect(await requestsTo(CORRECTION(INTAKE_ID))[0]?.clone().json()).toEqual({
      reason: 'Miscounted.',
      physical_count: 6,
    });
    expect(
      await screen.findByText('The correction is recorded. It was 5; it is now 6.'),
    ).toBeVisible();
  });
});

describe('a count a page says it is done (the way back from the count and the decision)', () => {
  it('says the count is recorded, once, when it brings the officer here', async () => {
    api = installFakeApi(
      staffApi(sessionWith(COUNT_KEYS, { authorized_hubs: [ACCRA] }), {
        [READ(INTAKE_ID)]: () => json(200, postCountFixture(), V1),
      }),
    );
    const { router } = renderApp(`/intakes/${INTAKE_ID}`);
    await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' });
    await act(async () => {
      await router.navigate(`/intakes/${INTAKE_ID}`, { state: { done: 'counted' } });
    });
    expect(
      await screen.findByText(
        'Your count is recorded. The rider’s number is shown below, with the comparison.',
      ),
    ).toBeVisible();
  });
});

describeInterfaceStates('a vendor’s record', {
  loading: {
    test: async () => {
      api = installFakeApi(
        staffApi(sessionWith(SENIOR_KEYS, { authorized_hubs: [ACCRA] }), {
          [READ(KENTE_INTAKE_ID)]: () => new Promise<Response>(() => undefined),
        }),
      );
      renderApp(`/intakes/${KENTE_INTAKE_ID}`);
      expect(await screen.findByText('Loading the vendor…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A vendor’s record is one record: it is there or it is not found, and what it holds (no finding, nothing missing) is told in its own panels.',
  },
  'validation error': {
    inapplicable:
      'The record takes no input: the only fields on the page are those of the correction and the damage, whose refusals are held above.',
  },
  error: {
    test: async () => {
      open({
        body: undefined,
        handlers: { [READ(KENTE_INTAKE_ID)]: () => refusal(500, 'INTERNAL_ERROR') },
      });
      await alertSaying('This vendor could not be loaded.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open({
        body: undefined,
        handlers: {
          [READ(KENTE_INTAKE_ID)]: () => {
            attempts += 1;
            return attempts === 1
              ? refusal(503, 'SERVICE_UNAVAILABLE')
              : json(200, mixedVendor(), V1);
          },
        },
        photos: MIXED,
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(
        await screen.findByRole('heading', { level: 1, name: KENTE_INTAKE_CODE }),
      ).toBeVisible();
    },
  },
  offline: {
    inapplicable: `${OFFLINE_NOT_APPLICABLE} On the record a lost connection is an error of the read, with Retry; the banner for a lost connection is on the run's page, where the checking in is done.`,
  },
  'stale / conflict': {
    test: async () => {
      const { user } = open({
        body: mixedVendor(),
        photos: MIXED,
        handlers: {
          [CORRECTION(KENTE_INTAKE_ID)]: () => refusal(409, 'STATE_CONFLICT', { rule: 'stale' }),
        },
      });
      await user.click(await screen.findByRole('button', { name: 'Correct the count' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('checkbox', { name: 'Parcel 1 is here' }));
      await user.type(
        within(dialog).getByRole('textbox', { name: /Why you are correcting this/ }),
        'A mistake.',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Record the correction' }));
      await alertSaying(/Refresh the page/);
    },
  },
  success: {
    test: async () => {
      open({ body: mixedVendor(), photos: MIXED });
      expect(
        await screen.findByRole('heading', { level: 1, name: KENTE_INTAKE_CODE }),
      ).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({
        body: undefined,
        handlers: { [READ(KENTE_INTAKE_ID)]: () => refusal(403, 'PERMISSION_DENIED') },
      });
      expect(
        await screen.findByText(
          'Your account can’t see what has been handed over at a hub. Ask an administrator for access.',
        ),
      ).toBeVisible();
    },
  },
});

describe('a record the page cannot show', () => {
  it('tells a vendor that is not there', async () => {
    open({
      body: undefined,
      handlers: { [READ(KENTE_INTAKE_ID)]: () => refusal(404, 'NOT_FOUND') },
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Vendor not found' }),
    ).toBeVisible();
    expect(screen.getByText('This vendor could not be found.')).toBeVisible();
  });

  it('tells a vendor at a hub the account does not work in, in plain words', async () => {
    open({
      body: undefined,
      handlers: { [READ(KENTE_INTAKE_ID)]: () => refusal(403, 'HUB_SCOPE_VIOLATION') },
    });
    expect(
      await screen.findByText(/This record belongs to a hub your account does not work in\./),
    ).toBeVisible();
  });

  it('sends the old page of a vendor’s condition to its record', async () => {
    const { router } = open({
      body: mixedVendor(),
      photos: MIXED,
      path: `/intakes/${KENTE_INTAKE_ID}/condition`,
    });
    expect(await screen.findByRole('heading', { level: 1, name: KENTE_INTAKE_CODE })).toBeVisible();
    expect(router.state.location.pathname).toBe(`/intakes/${KENTE_INTAKE_ID}`);
  });
});
