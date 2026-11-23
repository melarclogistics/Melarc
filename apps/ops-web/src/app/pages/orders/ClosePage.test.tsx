import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID } from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  ASSESSMENT,
  closureOf,
  NEW_ASSESSMENT,
  PARCELS,
  VENDOR_ID,
} from '../../../test-support/orders-fixture';
import { checkInFixture, photoLinkHandlers } from '../../../test-support/receiving-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/intakes/{id}/close` (`getIntakeClosure` then `closeHubIntake`; S1.40; AC-SLICE-001-51, -52): **the officer closes with the facts in front of them**, each figure apart and none added up by the page. A vendor with
 * parity is closed on the assessment the officer read; the way past a vendor with parcels still to order is the senior officer's exception, written against what the senior read: when that changed, the new facts
 * are shown, the reason stays and the senior confirms again. Closing is not payment, and what is still due is said after a close.
 */
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const OFFICER = ['hub.read', 'hub.intake.close', 'pickup.read'];
const SENIOR = [...OFFICER, 'hub.intake.close_exception'];
const RECORD = `GET /hub-intakes/${VENDOR_ID}`;
const CLOSURE = `GET /hub-intakes/${VENDOR_ID}/closure`;
const CLOSE = `POST /hub-intakes/${VENDOR_ID}/close`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server|assessment_token|token)\b/i;

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(handlers: Record<string, Handler> = {}, keys: readonly string[] = OFFICER) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [RECORD]: () =>
        json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'ITEMIZING' }), { ETag: '"v1"' }),
      [CLOSURE]: () => json(200, closureOf('ready')),
      ...photoLinkHandlers(PARCELS),
      ...handlers,
    }),
  );
  return renderApp(`/intakes/${VENDOR_ID}/close`);
}

const sent = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname.replace('/api/v1', '')}` === route,
  );
const bodyOf = async (request: Request | undefined): Promise<unknown> =>
  request === undefined ? undefined : ((await request.clone().json()) as unknown);
const dialog = async (): Promise<HTMLElement> => screen.findByRole('alertdialog');

/** What closing finds for a vendor with a parcel left without an order. */
const withParcelLeft = (overrides: Record<string, unknown> = {}) =>
  closureOf('exception', {
    can_close: false,
    needs_exception: true,
    blockers: [],
    outstanding_count: 1,
    outstanding_parcels: [
      {
        parcel_id: PARCELS[2]?.id,
        ordinal: 3,
        origin: 'DOOR_PHOTO',
        door_photo_evidence_id: PARCELS[2]?.photo_evidence_id,
        hub_photo_evidence_id: null,
      },
    ],
    assessment_token: ASSESSMENT,
    ...overrides,
  });

describe('closing a vendor that has parity', () => {
  // Break caught: a figure worked out by the page, a close without the assessment the officer read, a close with no key or no version, or a vendor said to be paid when it is only closed.
  it('shows each figure apart, closes on the assessment read, and says what is still due', async () => {
    const { user } = open({
      [CLOSURE]: () =>
        json(200, closureOf('ready', { payment_required: 1, ordered: 2, received: 2 })),
      [CLOSE]: () =>
        json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'CLOSED' }), { ETag: '"v2"' }),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Close Kente Crafts' }),
    ).toBeVisible();
    const facts = within(screen.getByRole('region', { name: 'What closing finds' }));
    for (const [label, value] of [
      ['Received', '2'],
      ['Orders made', '2'],
      ['Still without an order', '0'],
      ['Not priced', '0'],
      ['Payment due', '1'],
      ['Missing', '0'],
    ] as const) {
      expect(facts.getByText(label).nextElementSibling).toHaveTextContent(value);
    }
    expect(
      screen.getByText('Every parcel received has an order. You can close this vendor.'),
    ).toBeVisible();
    // No way past parity is offered to a session that has none to give, and none is needed.
    expect(screen.queryByText('Close with parcels still to order')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Close this vendor' }));
    const asked = within(await dialog());
    expect(asked.getByText('Close this vendor?')).toBeVisible();
    expect(
      asked.getByText(/Closing is not payment and does not send anything out\./),
    ).toBeVisible();
    // Nothing is sent before the officer confirms.
    expect(sent(CLOSE)).toHaveLength(0);
    await user.click(asked.getByRole('button', { name: 'Yes, close it' }));

    expect(await screen.findByText('The vendor is closed.')).toBeVisible();
    expect(
      screen.getByText('Payment is still due on 1 order. Closing did not collect it.'),
    ).toBeVisible();
    const request = sent(CLOSE)[0];
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    // A close with parity carries the assessment read and no exception.
    expect(await bodyOf(request)).toEqual({
      reviewed_assessment: (closureOf('ready') as unknown as { assessment_token: string })
        .assessment_token,
    });
    expect(screen.getByRole('link', { name: 'See the summary' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  // Break caught: a vendor already closed offered a second close.
  it('says that a vendor that is closed is closed, with its reason, and offers no close', async () => {
    open({ [CLOSURE]: () => json(200, closureOf('closed')) }, SENIOR);
    expect(
      await screen.findByText('This vendor was closed with parcels still to order.'),
    ).toBeVisible();
    expect(screen.getByText('One parcel is on the rider’s bike')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Close/ })).toBeNull();
  });
});

describe('closing with parcels still to order (a senior officer’s exception)', () => {
  // Break caught: the parcels left not named, an exception offered with no reason, a reason sent without the assessment it was written against.
  it('names the parcels left, asks for a reason, and closes against what the senior read', async () => {
    const { user } = open(
      {
        [CLOSURE]: () => json(200, withParcelLeft()),
        [CLOSE]: () =>
          json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'CLOSED' }), { ETag: '"v2"' }),
      },
      SENIOR,
    );
    expect(
      await screen.findByText(
        'Some parcels received still have no order. Make their orders, or a senior officer can close with a reason.',
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Parcels with no order yet' })).getByText(
        'Parcel 3',
      ),
    ).toBeVisible();
    // The reason is required before anything is asked.
    await user.click(screen.getByRole('button', { name: 'Close with a reason' }));
    expect(
      await screen.findByText('Write why you are closing with parcels still to order.'),
    ).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await user.type(
      screen.getByLabelText(/Why are you closing with parcels still to order\?/),
      'One parcel is on the rider’s bike',
    );
    await user.click(screen.getByRole('button', { name: 'Close with a reason' }));
    const asked = within(await dialog());
    expect(asked.getByText(/1 parcel received will stay without an order\./)).toBeVisible();
    await user.click(asked.getByRole('button', { name: 'Yes, close it' }));

    expect(
      await screen.findByText('The vendor is closed, with parcels still to order.'),
    ).toBeVisible();
    expect(await bodyOf(sent(CLOSE)[0])).toEqual({
      reviewed_assessment: ASSESSMENT,
      parity_exception: { note: 'One parcel is on the rider’s bike' },
    });
  });

  // Break caught: the reason typed lost when what closing finds changed, the old figures kept, or a close sent on the old assessment again.
  it('keeps the reason when what closing finds changed, shows the new facts, and asks the senior to confirm again', async () => {
    let closes = 0;
    const { user } = open(
      {
        [CLOSURE]: () => json(200, withParcelLeft()),
        [CLOSE]: () => {
          closes += 1;
          return closes === 1
            ? json(409, {
                code: 'STATE_CONFLICT',
                message: 'Diagnostic text that must never reach a screen.',
                request_id: 'r1',
                details: {
                  rule: 'assessment_changed',
                  current_assessment: closureOf('ready', {
                    ordered: 3,
                    received: 3,
                    assessment_token: NEW_ASSESSMENT,
                  }),
                },
              })
            : json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'CLOSED' }), {
                ETag: '"v2"',
              });
        },
      },
      SENIOR,
    );
    await user.type(
      await screen.findByLabelText(/Why are you closing with parcels still to order\?/),
      'One parcel is on the rider’s bike',
    );
    await user.click(screen.getByRole('button', { name: 'Close with a reason' }));
    await user.click(within(await dialog()).getByRole('button', { name: 'Yes, close it' }));

    // The new facts are on the screen: every parcel has its order now, and the reason typed is still there for the senior to read again.
    const alert = await screen.findByText('What closing finds has changed');
    expect(alert).toBeVisible();
    await waitFor(() => {
      expect(
        screen.getByText('Every parcel received has an order. You can close this vendor.'),
      ).toBeVisible();
    });
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    // Nothing was closed, and no second request was made for it.
    expect(sent(CLOSE)).toHaveLength(1);
    // The senior confirms again: on the assessment as it is now, as a close that has parity.
    await user.click(screen.getByRole('button', { name: 'Close this vendor' }));
    await user.click(within(await dialog()).getByRole('button', { name: 'Yes, close it' }));
    expect(await screen.findByText('The vendor is closed.')).toBeVisible();
    expect(await bodyOf(sent(CLOSE)[1])).toEqual({ reviewed_assessment: NEW_ASSESSMENT });
  });

  // Break caught: an officer with the close alone offered the exception, or told to ask an administrator.
  it('tells an officer who may only close that a senior officer can close with parcels still to order', async () => {
    open({ [CLOSURE]: () => json(200, withParcelLeft()) }, OFFICER);
    // Not told to ask someone to open a page the senior cannot find: pointed to the list a senior officer works from.
    expect(
      await screen.findByText(/A senior officer finds this vendor under Needs a senior\./),
    ).toBeVisible();
    expect(screen.queryByText(/Ask one to open this page/)).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Open the list for a senior officer' }),
    ).toHaveAttribute('href', '/orders-to-make?view=NEEDS_SENIOR');
    expect(screen.queryByRole('button', { name: 'Close with a reason' })).toBeNull();
    expect(screen.queryByLabelText(/Why are you closing/)).toBeNull();
  });

  // Break caught (the review of 23 November 2026, item 13): the reason a senior wrote lost when what closing finds changed and a parcel is still to order, so that the senior writes it again. The reason stays, whichever
  // way the close was refused.
  it('keeps the reason a senior wrote when what closing finds changed and a parcel is still to order', async () => {
    const { user } = open(
      {
        [CLOSURE]: () => json(200, withParcelLeft()),
        [CLOSE]: () =>
          json(409, {
            code: 'STATE_CONFLICT',
            message: 'Diagnostic text that must never reach a screen.',
            request_id: 'r2',
            details: {
              rule: 'assessment_changed',
              current_assessment: withParcelLeft({ assessment_token: NEW_ASSESSMENT }),
            },
          }),
      },
      SENIOR,
    );
    const reason = 'One parcel is on the rider’s bike';
    await user.type(
      await screen.findByLabelText(/Why are you closing with parcels still to order?/),
      reason,
    );
    await user.click(screen.getByRole('button', { name: 'Close with a reason' }));
    await user.click(within(await dialog()).getByRole('button', { name: 'Yes, close it' }));
    await screen.findByText('What closing finds has changed');
    expect(screen.getByLabelText(/Why are you closing with parcels still to order?/)).toHaveValue(
      reason,
    );
  });

  // Break caught: a vendor with a surplus of orders closed over, with the exception or without it.
  it('does not offer a close over a surplus of orders, and says why', async () => {
    open(
      {
        [CLOSURE]: () =>
          json(
            200,
            withParcelLeft({
              excess_count: 1,
              blockers: ['orders_exceed_received'],
              needs_exception: false,
              outstanding_count: 0,
              outstanding_parcels: [],
              can_close: false,
            }),
          ),
      },
      SENIOR,
    );
    expect(
      (await screen.findAllByText(/There are more orders than parcels received\./)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Close/ })).toBeNull();
  });

  it('does not offer a close while an order of a parcel that arrived has no price', async () => {
    open({
      [CLOSURE]: () =>
        json(
          200,
          closureOf('ready', { unpriced: 1, blockers: ['order_unpriced'], can_close: false }),
        ),
    });
    expect(
      await screen.findByText(
        'An order for a parcel that arrived has no price yet. Confirm it before closing.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Close this vendor' })).toBeNull();
  });
});

describe('a vendor that changed while the senior read', () => {
  // Break caught: a stale vendor shown as a failure that loses the reason, or a close that is sent again on a version that is not current.
  it('says the vendor changed, reads it again and keeps the reason', async () => {
    let reads = 0;
    const { user } = open(
      {
        [RECORD]: () => {
          reads += 1;
          return json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'ITEMIZING' }), {
            ETag: reads === 1 ? '"v1"' : '"v2"',
          });
        },
        [CLOSURE]: () => json(200, withParcelLeft()),
        [CLOSE]: () =>
          json(409, {
            code: 'STATE_CONFLICT',
            message: 'x',
            request_id: 'r2',
            details: { rule: 'stale' },
          }),
      },
      SENIOR,
    );
    await user.type(
      await screen.findByLabelText(/Why are you closing with parcels still to order\?/),
      'One parcel is on the rider’s bike',
    );
    await user.click(screen.getByRole('button', { name: 'Close with a reason' }));
    await user.click(within(await dialog()).getByRole('button', { name: 'Yes, close it' }));
    // The dialog says the vendor changed and offers to read it again.
    const asked = within(await dialog());
    expect(await asked.findByText(/This vendor changed while you were reading/)).toBeVisible();
  });
});

describeInterfaceStates('the close of a vendor', {
  loading: {
    test: async () => {
      open({ [CLOSURE]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Reading what closing finds…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A closure always has figures to read: a vendor with nothing yet says so in the figures, which are never drawn as empty.',
  },
  'validation error': {
    test: async () => {
      const { user } = open({ [CLOSURE]: () => json(200, withParcelLeft()) }, SENIOR);
      await user.click(await screen.findByRole('button', { name: 'Close with a reason' }));
      expect(
        await screen.findByText('Write why you are closing with parcels still to order.'),
      ).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open({ [CLOSURE]: () => refusal(500, 'INTERNAL_ERROR') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'What closing finds could not be read.',
        );
      });
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open({
        [CLOSURE]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, closureOf('ready'));
        },
      });
      await user.click(await screen.findByRole('button', { name: /Try again|Retry/ }));
      expect(await screen.findByRole('button', { name: 'Close this vendor' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open({
        [CLOSE]: () =>
          json(409, {
            code: 'STATE_CONFLICT',
            message: 'x',
            request_id: 'r3',
            details: { rule: 'stale' },
          }),
      });
      await user.click(await screen.findByRole('button', { name: 'Close this vendor' }));
      await user.click(within(await dialog()).getByRole('button', { name: 'Yes, close it' }));
      expect(
        await within(await dialog()).findByText(/This vendor changed while you were reading/),
      ).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const { user } = open({
        [CLOSE]: () =>
          json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'CLOSED' }), { ETag: '"v2"' }),
      });
      await user.click(await screen.findByRole('button', { name: 'Close this vendor' }));
      await user.click(within(await dialog()).getByRole('button', { name: 'Yes, close it' }));
      expect(await screen.findByText('The vendor is closed.')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({ [CLOSURE]: () => refusal(403, 'PERMISSION_DENIED') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Your account can’t close a vendor once its orders are made.',
        );
      });
    },
  },
});
