import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID } from '../../../test-support/hub-intake-fixture';
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
  arrivedParcel,
  checkInFixture,
  extraParcel,
  parcelFixture,
  photoLinkHandlers,
} from '../../../test-support/receiving-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/intakes/{id}/discrepancy` (`adjudicateDiscrepancy`; S1.35c; D-D4): **the senior officer's decision**, a task form behind the key of the decision. The facts come first (the counts, the parcels that are missing, extra
 * or damaged as their photos, what was found), then the outcomes in the order *Still searching*, *Accept what arrived*, *Write off what is missing*; *Vendor told* is a record that follows a write-off and is offered
 * once and then alone. The outcome is chosen and never defaulted, the reason is required, the decision is confirmed before it is sent, and it is sent on the version read and under no key.
 */
const PATH = `/intakes/${KENTE_INTAKE_ID}/discrepancy`;
const READ = `GET /hub-intakes/${KENTE_INTAKE_ID}`;
const DECIDE = `POST /hub-intakes/${KENTE_INTAKE_ID}/discrepancy`;
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const SENIOR_KEYS = ['hub.read', 'hub.intake.count', 'hub.osd.adjudicate'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|locks?\b(?! is)|the server)\b/i;
const V1 = { ETag: '"v1"' };
const V2 = { ETag: '"v2"' };
const REASON = 'Searched the hub and the rider’s bag.';

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const MIXED = [
  arrivedParcel(1),
  arrivedParcel(2, {
    condition: {
      condition: 'DAMAGED',
      note: 'Torn corner.',
      evidence_ids: ['0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f'],
      recorded_by_name: RECEIVER_NAME,
      recorded_at: '2026-11-14T09:20:00Z',
    },
  }),
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
        evidence_ids: ['0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f'],
        recorded_by_name: RECEIVER_NAME,
        recorded_at: '2026-11-14T09:20:00Z',
      },
    ],
    ...overrides,
  });
const decision = (outcome: string, id: string, note = REASON) => ({
  id,
  kind: 'ADJUDICATION',
  intake_parcel_id: null,
  condition: null,
  outcome,
  note,
  evidence_ids: [],
  recorded_by_name: 'Kojo Mensah',
  recorded_at: '2026-11-14T11:00:00Z',
});
const WRITTEN_OFF = decision('WRITTEN_OFF', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d');
const TOLD = decision('VENDOR_NOTIFIED', '2b3c4d5e-6f70-4b8c-9dae-1f2a3b4c5d6e');

function open(
  body: unknown = mixedVendor(),
  keys: readonly string[] = SENIOR_KEYS,
  handlers: Record<string, Handler> = {},
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [READ]: () => json(200, body, V1),
      ...photoLinkHandlers(MIXED),
      'GET /evidence-limits': () => json(200, EVIDENCE_LIMITS),
      ...handlers,
    }),
  );
  return renderApp(PATH);
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
const reason = async (): Promise<HTMLElement> =>
  screen.findByRole('textbox', { name: /Why you decided this/ });
const choose = async (user: ReturnType<typeof open>['user'], name: string | RegExp) => {
  await user.click(await screen.findByRole('radio', { name }));
};
const afterDecision = (outcome: string) =>
  mixedVendor({
    state: 'READY_FOR_ITEMIZATION',
    condition_findings: [decision(outcome, '3c4d5e6f-7081-4c9d-8ebf-2a3b4c5d6e7f')],
  });

describe('the form: the facts first, then the decision', () => {
  it('shows what happened to the vendor before the decision, and offers the outcomes in the order of the floor, none chosen', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Decide' })).toBeVisible();
    expect(
      await screen.findByText(
        `${KENTE}. Say what happens next about what is missing, extra or damaged.`,
      ),
    ).toBeVisible();
    const facts = within(
      await screen.findByRole('region', { name: 'What happened to this vendor' }),
    );
    expect(facts.getByText('Missing', { selector: 'dt' }).nextElementSibling).toHaveTextContent(
      '1',
    );
    expect(facts.getByText('Compared with the photos').nextElementSibling).toHaveTextContent(
      '1 parcel fewer',
    );
    const parcels = within(
      screen.getByRole('region', { name: 'Missing, extra or damaged parcels' }),
    );
    expect(parcels.getByRole('list', { name: `Missing parcels of ${KENTE}` })).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'What was found' })).getByText('Parcel 2: Damaged'),
    ).toBeVisible();

    const outcomes = within(screen.getByRole('group', { name: /What do you decide?/ }))
      .getAllByRole('radio')
      .map((radio) => radio.closest('div')?.textContent ?? '');
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toContain('Still searching');
    expect(outcomes[1]).toContain('Accept what arrived');
    expect(outcomes[2]).toContain('Write off what is missing');
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(screen.queryByRole('radio', { name: /Vendor told/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  // Break caught (the Product Owner's requirement, facts first, at every width): the facts in a rail that follows the fields on a tablet, so that a senior officer is asked to decide before they have read what happened.
  it('puts every fact before the decision in the page: the comparison, the parcels as pictures and each damage with its note come before the outcomes and the button', async () => {
    open();
    const group = await screen.findByRole('group', { name: /What do you decide\?/ });
    for (const name of [
      'What happened to this vendor',
      'Missing, extra or damaged parcels',
      'What was found',
    ]) {
      const fact = screen.getByRole('region', { name });
      expect(
        fact.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
        name,
      ).toBeTruthy();
    }
    const review = screen.getByRole('button', { name: 'Review' });
    expect(group.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Break caught (the pictures' review, defect 7): the three outcome rows drawn at the working height (46px, the circle 20px) on a page of the hub floor, where the whole row is the target at 56px.
  it('draws the outcomes as rows of the hub floor, in the floor’s scope', async () => {
    open();
    const group = await screen.findByRole('group', { name: /What do you decide\?/ });

    expect(group).toHaveClass('ui-radio-group--lg');
    expect(document.querySelector('.ui-hub-floor')).not.toBeNull();
  });

  // Break caught: the heading of the page said twice ("Decide", and "Your decision" under it).
  it('has one heading for the page, and no second one that says the same', async () => {
    open();
    await screen.findByRole('group', { name: /What do you decide\?/ });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Your decision' })).toBeNull();
  });

  // Break caught: a vendor named by its code alone (the record carries its name).
  it('names the vendor by its name, in the description, the breadcrumb and the title, and never by the code alone', async () => {
    open();
    expect(
      await screen.findByText(
        `${KENTE}. Say what happens next about what is missing, extra or damaged.`,
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: KENTE })).toHaveAttribute(
      'href',
      `/intakes/${KENTE_INTAKE_ID}`,
    );
    expect(document.title).toBe(`Decide about ${KENTE} · Melarc Ops Portal`);
    expect(document.body.textContent).not.toContain(KENTE_INTAKE_CODE);
  });

  // Break caught: an outcome or a reason defaulted, so that a decision is made by pressing Review.
  it('asks for an outcome and a reason at their fields, and sends nothing', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Review' }));

    expect(await screen.findByText('Choose what you decide.')).toBeVisible();
    expect(screen.getByText('Write why you decided this.')).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(requestsTo(DECIDE)).toHaveLength(0);
  });

  it('cancels back to the vendor with a button, without sending anything', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { level: 1, name: KENTE_INTAKE_CODE })).toBeVisible();
    expect(requestsTo(DECIDE)).toHaveLength(0);
  });

  // Break caught (the pictures' review, defect 12): "(optional)" typed into the label, as bold as the label while the kit's "(required)" is muted. The photos are optional, which the help says as the product's
  // other forms do ("Optional. …").
  it('has the photos of a decision optional, said in their help and not in their label, and the camera among its fields', async () => {
    open();
    expect(await screen.findByText('Photos for this decision')).toBeVisible();
    expect(
      screen.getByText(
        'Optional. Take a photo with the camera. Each is sent as soon as you take it.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/\(optional\)/)).toBeNull();
  });
});

describe('the comparison is as true as the parcels', () => {
  const sameTotals = (parcels: ReturnType<typeof arrivedParcel>[]) =>
    checkInFixture(parcels, {
      state: 'RECONCILIATION_REQUIRED',
      count_variance: 'MATCH',
      count_difference: 0,
    });

  // Break caught: "The same" said of a vendor with a parcel missing and one that is extra: the totals match and the parcels do not.
  it('does not say a vendor with a parcel missing and one extra is the same, and says what differs', async () => {
    open(
      sameTotals([
        arrivedParcel(1),
        arrivedParcel(2),
        parcelFixture(3, { state: 'MISSING', missing_marked_at: '2026-11-14T09:30:00Z' }),
        extraParcel(4),
      ]),
    );
    const facts = within(
      await screen.findByRole('region', { name: 'What happened to this vendor' }),
    );

    expect(facts.getByText('Compared with the photos').nextElementSibling).toHaveTextContent(
      '1 missing, 1 extra',
    );
    expect(facts.queryByText('The same')).toBeNull();
  });

  it('says the same when every parcel is here and none is extra', async () => {
    open(sameTotals([arrivedParcel(1), arrivedParcel(2), arrivedParcel(3)]));
    const facts = within(
      await screen.findByRole('region', { name: 'What happened to this vendor' }),
    );

    expect(facts.getByText('Compared with the photos').nextElementSibling).toHaveTextContent(
      'The same',
    );
  });
});

describe('the decision', () => {
  // Break caught: a decision sent under a key (the operation takes none), without the version read, with a photo list when there is none, or with a condition (the senior no longer sets one).
  it('confirms the decision in words, then sends the outcome and the reason on the version read and under no key, and brings the officer to the vendor', async () => {
    let reads = 0;
    const { user } = open(undefined, SENIOR_KEYS, {
      [READ]: () => {
        reads += 1;
        return json(
          200,
          reads === 1 ? mixedVendor() : afterDecision('WRITTEN_OFF'),
          reads === 1 ? V1 : V2,
        );
      },
      [DECIDE]: () => json(200, afterDecision('WRITTEN_OFF'), V2),
    });
    await choose(user, /Write off what is missing/);
    await user.type(await reason(), REASON);
    await user.click(screen.getByRole('button', { name: 'Review' }));

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Record this decision: write off what is missing?',
    });
    expect(
      within(dialog).getByText(
        'The search is closed as not found. What was checked in is not changed.',
      ),
    ).toBeVisible();
    expect(requestsTo(DECIDE)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Record the decision' }));

    await waitFor(() => {
      expect(requestsTo(DECIDE)).toHaveLength(1);
    });
    const [sent] = requestsTo(DECIDE);
    expect(await sent?.clone().json()).toEqual({ outcome: 'WRITTEN_OFF', note: REASON });
    expect(sent?.headers.get('If-Match')).toBe('"v1"');
    expect(sent?.headers.get('Idempotency-Key')).toBeNull();
    expect(await screen.findByText('Your decision is recorded.')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: KENTE_INTAKE_CODE })).toBeVisible();
  });

  it.each([
    [
      'Still searching',
      'ESCALATED',
      'The case stays open for a later decision. What was checked in is not changed.',
    ],
    ['Accept what arrived', 'ACCEPTED', 'The case is closed. What was checked in is not changed.'],
  ])('says what %s does before it is sent', async (label, outcome, consequence) => {
    const { user } = open(undefined, SENIOR_KEYS, {
      [DECIDE]: () => json(200, afterDecision(outcome), V2),
    });
    await choose(user, new RegExp(label));
    await user.type(await reason(), REASON);
    await user.click(screen.getByRole('button', { name: 'Review' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(consequence)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requestsTo(DECIDE)).toHaveLength(0);
  });

  // Break caught: the system said to send the vendor something: "Vendor told" is a record that someone told them.
  it('offers “Vendor told” alone after a write-off, says it sends nothing, and sends it as a record', async () => {
    const body = mixedVendor({ state: 'READY_FOR_ITEMIZATION', condition_findings: [WRITTEN_OFF] });
    const { user } = open(body, SENIOR_KEYS, {
      [DECIDE]: () =>
        json(
          200,
          mixedVendor({ state: 'READY_FOR_ITEMIZATION', condition_findings: [WRITTEN_OFF, TOLD] }),
          V2,
        ),
    });
    const radios = await screen.findAllByRole('radio');
    expect(radios).toHaveLength(1);
    expect(
      screen.getByText('Records that someone told the vendor. Nothing is sent from here.'),
    ).toBeVisible();

    const [only] = radios;
    if (only === undefined) throw new Error('no outcome is offered');
    await user.click(only);
    await user.type(await reason(), 'Told by phone at 11:00.');
    await user.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Record this decision: vendor told?',
    });
    expect(
      within(dialog).getByText(
        'This records that someone told the vendor. Nothing is sent from here.',
      ),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Record the decision' }));

    await waitFor(() => {
      expect(requestsTo(DECIDE)).toHaveLength(1);
    });
    expect(await requestsTo(DECIDE)[0]?.clone().json()).toEqual({
      outcome: 'VENDOR_NOTIFIED',
      note: 'Told by phone at 11:00.',
    });
  });
});

describe('a vendor the form is not for', () => {
  it('says a vendor that was decided already is not waiting, and shows no form', async () => {
    open(
      mixedVendor({
        state: 'READY_FOR_ITEMIZATION',
        condition_findings: [decision('ACCEPTED', '4d5e6f70-8192-4dae-9fc0-3b4c5d6e7f80')],
      }),
    );
    expect(
      await screen.findByText(
        /This vendor is not waiting for a decision\. It may have been decided already\./,
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the vendor' })).toHaveAttribute(
      'href',
      `/intakes/${KENTE_INTAKE_ID}`,
    );
    expect(screen.queryByRole('group', { name: /What do you decide?/ })).toBeNull();
  });

  it('says a vendor already recorded as told is not waiting either', async () => {
    open(mixedVendor({ state: 'READY_FOR_ITEMIZATION', condition_findings: [WRITTEN_OFF, TOLD] }));
    expect(await screen.findByText(/This vendor is not waiting for a decision/)).toBeVisible();
    expect(screen.queryByRole('group', { name: /What do you decide?/ })).toBeNull();
  });

  it('says a vendor that was not checked in has nothing to decide, and shows no form', async () => {
    const parcels = [parcelFixture(1)];
    open(
      checkInFixture(parcels, {
        state: 'AWAITING_COUNT',
        received_count: null,
        count_variance: null,
        count_difference: null,
        counted_at: null,
        counted_by_name: null,
      }),
    );
    expect(
      await screen.findByText(
        /This vendor has not been counted yet, so there is nothing to decide\./,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('group', { name: /What do you decide?/ })).toBeNull();
  });

  // Break caught: the form offered to a session without the key of the decision, or the refusal told as a way to ask an administrator for what a senior officer decides: the route admits the read, and the PAGE
  // says that a senior officer decides, in the words of the act, and gives the way back to the vendor.
  it('tells a session without the key of the decision that a senior officer decides, and never to ask an administrator, before it asks the API anything', async () => {
    open(undefined, ['hub.read', 'hub.intake.count']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Decide' })).toBeVisible();
    expect(
      await screen.findByText('A senior officer decides this. Ask one to open this page.'),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(/administrator/i);
    expect(screen.getByRole('link', { name: 'Open the vendor' })).toHaveAttribute(
      'href',
      `/intakes/${KENTE_INTAKE_ID}`,
    );
    expect(screen.queryByRole('group', { name: /What do you decide\?/ })).toBeNull();
    expect(requestsTo(READ)).toHaveLength(0);
    expect(requestsTo(DECIDE)).toHaveLength(0);
  });

  it('gives a session that holds the read alone, at an address that is not a vendor’s, the way back to receiving', async () => {
    api = installFakeApi(staffApi(sessionWith(['hub.read'], { authorized_hubs: [ACCRA] })));
    renderApp('/intakes/not-an-id/discrepancy');
    expect(
      await screen.findByText('A senior officer decides this. Ask one to open this page.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to receiving' })).toHaveAttribute(
      'href',
      '/receiving',
    );
    expect(requestsTo(READ)).toHaveLength(0);
  });
});

describe('what the API says of a decision', () => {
  async function decideWith(response: Response) {
    const { user } = open(undefined, SENIOR_KEYS, { [DECIDE]: () => response });
    await choose(user, /Accept what arrived/);
    await user.type(await reason(), REASON);
    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(
      await within(await screen.findByRole('alertdialog')).findByRole('button', {
        name: 'Record the decision',
      }),
    );
    return user;
  }

  // Break caught: a refusal for want of the key told as a way to ask an administrator for access to what a senior officer decides.
  it('tells a refusal of the decision as a senior officer’s, and never to ask an administrator', async () => {
    await decideWith(refusal(403, 'PERMISSION_DENIED'));
    const alert = await alertSaying('A senior officer decides this. Ask one to open this page.');
    expect(alert).not.toHaveTextContent(/administrator/i);
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it.each([
    ['not_awaiting_resolution', /not waiting for a decision: it may have been decided already/],
    ['not_written_off', /Write them off first/],
    ['vendor_already_told', /already recorded that the vendor was told/],
    ['stale', /changed after you opened it, so the decision was not recorded/],
  ])('words the conflict %s', async (rule, words) => {
    await decideWith(refusal(409, 'STATE_CONFLICT', { rule }));
    await alertSaying(words);
  });

  it('puts a missing reason, told by the API, at the reason', async () => {
    await decideWith(refusal(422, 'REASON_REQUIRED'));
    expect(await screen.findAllByText('Write why you decided this.')).not.toHaveLength(0);
  });

  it('offers only a look at the vendor when the outcome is not known, because the act takes no key', async () => {
    await decideWith(refusal(503, 'SERVICE_UNAVAILABLE'));
    expect(await screen.findByRole('button', { name: 'Check the record' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describeInterfaceStates('the decision', {
  loading: {
    test: async () => {
      open(undefined, SENIOR_KEYS, { [READ]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Loading the vendor…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A decision is made about one vendor: there is no list, and a vendor with nothing to decide is told as such (held above).',
  },
  'validation error': {
    test: async () => {
      const { user } = open();
      await user.click(await screen.findByRole('button', { name: 'Review' }));
      expect(await screen.findByText('Choose what you decide.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open(undefined, SENIOR_KEYS, { [READ]: () => refusal(500, 'INTERNAL_ERROR') });
      await alertSaying('This vendor could not be loaded.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(undefined, SENIOR_KEYS, {
        [READ]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, mixedVendor(), V1);
        },
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('group', { name: /What do you decide?/ })).toBeVisible();
    },
  },
  offline: {
    inapplicable: `${OFFLINE_NOT_APPLICABLE} The decision is not made at the tablet on the floor: a lost answer offers a look at the vendor, held above.`,
  },
  'stale / conflict': {
    test: async () => {
      const { user } = open(undefined, SENIOR_KEYS, {
        [DECIDE]: () => refusal(409, 'STATE_CONFLICT', { rule: 'stale' }),
      });
      await choose(user, /Accept what arrived/);
      await user.type(await reason(), REASON);
      await user.click(screen.getByRole('button', { name: 'Review' }));
      await user.click(
        await within(await screen.findByRole('alertdialog')).findByRole('button', {
          name: 'Record the decision',
        }),
      );
      await alertSaying(/Refresh the page/);
      await act(async () => {
        await Promise.resolve();
      });
    },
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByRole('group', { name: /What do you decide?/ })).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(undefined, SENIOR_KEYS, { [READ]: () => refusal(403, 'PERMISSION_DENIED') });
      expect(
        await screen.findByText(
          'Your account can’t see what has been handed over at a hub. Ask an administrator for access.',
        ),
      ).toBeVisible();
    },
  },
});
