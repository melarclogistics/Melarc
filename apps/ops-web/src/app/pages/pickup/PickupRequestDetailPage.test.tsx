import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  cancellationReasonFixture,
  EARLIER_REQUEST_ID,
  estimateFixture,
  exceptionFixture,
  exceptionOutcomeFixture,
  LATER_REQUEST_ID,
  melarcReasonFixture,
  OFFICER_ID,
  PICKUP_HUB_ID,
  pickupRequestFixture,
  REQUEST_ID,
  unavailableEstimate,
} from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { cannotText } from '../../../platform/problem/capability-words';

/**
 * `/pickup-requests/{id}` (`getPickupRequest` and the acts on one request; S1.19). Every act sends the version the page read and, where its
 * operation takes one, a fresh `Idempotency-Key`; a concurrent edit is explained and read again; the estimate is an estimate; the charge is a
 * decision the person makes; the attempt chain is read link by link.
 */
const PATH = `/pickup-requests/${REQUEST_ID}`;
const READ = `GET /pickup-requests/${REQUEST_ID}`;
const REASONS = 'GET /reason-definitions';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What an officer of the hub holds: every act on a request but the senior ones. */
const OFFICER = [
  'pickup.read',
  'pickup.request.confirm',
  'pickup.request.cancel',
  'pickup.request.cancel_chargeable',
  'pickup.exception.request',
  'pickup.failure.resolve',
  'settings.reason.read',
];
/** And the senior acts: extending the attempts and waiving a charge. */
const SENIOR = [...OFFICER, 'pickup.attempt.extend', 'pickup.cancellation_charge.waive'];
/** A confirmed request whose run has a rider: its cancellation carries the charge decision. */
const ASSIGNED = { state: 'CONFIRMED', rider_assigned: true } as const;

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const answer = (body: unknown, version = 'v1'): Response => json(200, body, etag(version));

function open(
  read: Handler = () => answer(pickupRequestFixture()),
  keys: readonly string[] = OFFICER,
  handlers: Record<string, Handler> = {},
  path = PATH,
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [READ]: read, ...handlers },
    ),
  );
  return renderApp(path);
}

const sent = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname.replace(/^\/api\/v1/, '')}` === route,
  );
const reads = () => sent(READ);
const acts = () => api.requests.filter((request) => request.method === 'POST');
const bodyOf = async (request: Request | undefined): Promise<unknown> =>
  request === undefined ? undefined : request.clone().json();

/** The record's own page, for what its header and its notices say: the acts are in its header and its menu, and the person is told what stands in the way in words beside them. */
const actions = () => screen.getByRole('main');

/** The heavier acts are in the menu of the record's header: it is opened, and the act is chosen. Each brings its own question or form. */
async function chooseAct(user: UserEvent, name: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /^More actions for / }));
  await user.click(await screen.findByRole('menuitem', { name }));
}

describe('the request: what it shows', () => {
  it('shows the request by its code, its state and its facts', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' })).toBeVisible();
    expect(document.title).toBe('ACC-PR-7KQ2MZ · Melarc Ops Portal');
    expect(screen.getByText('Waiting for confirmation')).toBeVisible();
    expect(screen.getByText('A vendor’s own packages')).toBeVisible();
    expect(screen.getByText('Tue 3 Nov 2026')).toBeVisible();
    expect(screen.getByText('3 packages')).toBeVisible();
    expect(screen.getByText('14 Demo Lane, Osu')).toBeVisible();
    expect(screen.getByText('Landmark: Opposite the demo bakery')).toBeVisible();
    expect(screen.getByText('+233201234567')).toBeVisible();
    expect(screen.getByText('The recipient pays')).toBeVisible();
    // The account card of the menu names the hub too; this is the request's own.
    expect(within(screen.getByRole('main')).getByText('Accra Central')).toBeVisible();
    // 24-hour time in Accra, whatever the machine's zone.
    expect(screen.getByText('29 Oct, 08:15')).toBeVisible();
    expect(document.body.textContent).not.toContain(REQUEST_ID);
  });

  // S1.12e: the message log narrowed to this request, for a session that lists the key of the log.
  it('links to the messages about this request for a holder of notification.read', async () => {
    open(undefined, [...OFFICER, 'notification.read']);

    expect(
      await within(await screen.findByRole('main')).findByRole('link', {
        name: 'Messages about this request',
      }),
    ).toHaveAttribute('href', `/messages?subject=${REQUEST_ID}&subject_type=PICKUP_REQUEST`);
    // The request is named by its code on the page, and by its identifier only in the address of the link.
    expect(document.body.textContent).not.toContain(REQUEST_ID);
  });

  it('offers no link to the messages to a session that does not list notification.read', async () => {
    open();

    await screen.findByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' });
    expect(screen.queryByRole('link', { name: 'Messages about this request' })).toBeNull();
  });

  it('shows what a collection collects, from whom, and under which reference', async () => {
    open(() =>
      answer(
        pickupRequestFixture({
          pickup_intent: 'COLLECT_FOR_VENDOR',
          collection_point: {
            contact_name: 'Demo seller',
            phone: '+233200000001',
            location: { address: '3 Demo Market Road' },
          },
          collection_reference: { reference_name: 'Demo order', seller_order_reference: 'SO-77' },
          collection_item: { description: 'Demo sandals', quantity: 2 },
        }),
      ),
    );

    expect(await screen.findByText('Demo seller, +233200000001')).toBeVisible();
    expect(screen.getByText('3 Demo Market Road')).toBeVisible();
    expect(screen.getByText('Order: SO-77')).toBeVisible();
    expect(screen.getByText('Demo sandals, 2 items')).toBeVisible();
  });

  it('shows a declared value and the liability cap acknowledged, from the snapshot', async () => {
    open(() =>
      answer(
        pickupRequestFixture({
          declared_value_minor: 75_000,
          liability_cap_acknowledged_at: '2026-10-29T08:16:00Z',
          liability_cap_snapshot: {
            amount_minor: 30_000,
            setting_key: 'liability_cap_amount',
            effective_version: '1',
          },
        }),
      ),
    );

    expect(await screen.findByText('GH₵750.00')).toBeVisible();
    expect(screen.getByText('GH₵300.00')).toBeVisible();
    expect(screen.getByText(/acknowledged by the sender on 29 Oct, 08:16/)).toBeVisible();
  });

  // Break caught (MSC-DEC-211): an estimate shown as a price or a total, or a number shown for one the server could not give.
  it('shows an estimate the read carries as an indicative estimate, and never a total', async () => {
    open(() => answer(pickupRequestFixture({ indicative_estimate: estimateFixture() })));

    const estimate = await screen.findByRole('region', {
      name: 'Indicative estimate (provisional)',
    });
    expect(within(estimate).getByText(/^About/)).toHaveTextContent('About GH₵45.00');
    expect(within(estimate).getByText(/It is not a quote/)).toBeVisible();
    expect(within(estimate).getByText(/Service-area base fee × 3/)).toHaveTextContent(
      'Service-area base fee × 3: GH₵45.00',
    );
    expect(estimate.textContent).not.toMatch(/\btotal\b|\bprice:/i);
  });

  it.each([
    ['UNAVAILABLE_OUTSIDE_SERVICE_AREA', /outside the service area/],
    ['UNAVAILABLE_SETTING_MISSING', /no approved fee/],
  ] as const)(
    'says in words why there is no estimate when it is %s, and shows no number',
    async (status, words) => {
      open(() =>
        answer(pickupRequestFixture({ indicative_estimate: unavailableEstimate(status) })),
      );

      const estimate = await screen.findByRole('region', {
        name: 'Indicative estimate (provisional)',
      });
      expect(within(estimate).getByText(words)).toBeVisible();
      expect(estimate.textContent).not.toMatch(/GH₵/);
    },
  );

  it('says how a cancelled request ended, when, why, and the charge as applied', async () => {
    open(() =>
      answer(
        pickupRequestFixture({
          state: 'CANCELLED',
          cancelled_by_actor_type: 'OPS',
          cancelled_at: '2026-10-30T09:00:00Z',
          cancellation_reason: {
            code: 'DEMO_CUSTOMER_CHANGED_MIND',
            label: 'Demo: the customer changed their mind',
          },
          cancellation_charge_outcome: 'WAIVED',
          cancellation_charge_snapshot: {
            amount_minor: 2000,
            setting_key: 'cancellation_charge_amount',
            effective_version: '1',
          },
        }),
      ),
    );

    expect(await screen.findByText('Cancelled by Melarc Ops.')).toBeVisible();
    expect(screen.getByText('On 30 Oct, 09:00.')).toBeVisible();
    expect(screen.getByText('Reason: Demo: the customer changed their mind')).toBeVisible();
    // The code is the server's, and never drawn.
    expect(document.body.textContent).not.toContain('DEMO_CUSTOMER_CHANGED_MIND');
    expect(
      screen.getByText('The cancellation charge was applied and then waived in full.'),
    ).toBeVisible();
    expect(screen.getByText('GH₵20.00')).toBeVisible();
  });

  it('names the sender, and the sender’s part of a shared payment as the booking stated it', async () => {
    open(() =>
      answer(
        pickupRequestFixture({
          default_payer_intent: 'SPLIT',
          split_basis: 'PERCENTAGE',
          split_sender_percentage: 40,
        }),
      ),
    );

    expect(await screen.findByText('Demo Fabrics Ltd')).toBeVisible();
    expect(screen.getByText('Shared between the sender and the recipient')).toBeVisible();
    expect(screen.getByText('The sender pays 40% of it.')).toBeVisible();
  });

  // The exception carries the recipient and its maker; the read names nobody, so the person who asked is "you" or another member of staff.
  it('shows the one-package exception: where it is, who asked and when, the recipient and why', async () => {
    open(() =>
      answer(
        pickupRequestFixture({
          declared_package_count: 1,
          one_package_exception: exceptionFixture(),
        }),
      ),
    );

    const facts = (await screen.findByText('One-package exception')).nextElementSibling;
    if (!(facts instanceof HTMLElement)) throw new Error('no exception facts');
    expect(within(facts).getByText(/Waiting for an approver/)).toHaveTextContent(
      'Waiting for an approver to approve it.',
    );
    // A refusal or a wait names the capability in plain words, never a permission key.
    expect(document.body.textContent).not.toContain('pickup.exception.approve');
    expect(
      within(facts).getByText('Requested by another member of staff on 29 Oct, 08:20.'),
    ).toBeVisible();
    expect(within(facts).getByText('Recipient: Abena Demo, +233240000000')).toBeVisible();
    expect(within(facts).getByText('9 Demo Street, Tema')).toBeVisible();
    expect(within(facts).getByText('Why: Bridal gown, urgent')).toBeVisible();
    expect(facts.textContent).not.toMatch(/GH₵/);
  });

  // The fee is told only as the server snapshotted it on approval: no figure is worked out here.
  it('shows the fee an approved exception made due, as the server gave it, and who approved it', async () => {
    open(() =>
      answer(
        pickupRequestFixture({
          declared_package_count: 1,
          one_package_exception_id: '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d',
          one_package_exception: exceptionFixture({
            state: 'APPROVED',
            approved_by: OFFICER_ID,
            decided_at: '2026-10-29T09:10:00Z',
            single_package_fee: { amount_minor: 2000, currency: 'GHS' },
          }),
        }),
      ),
    );

    const facts = (await screen.findByText('One-package exception')).nextElementSibling;
    if (!(facts instanceof HTMLElement)) throw new Error('no exception facts');
    expect(within(facts).getByText('Approved by you on 29 Oct, 09:10.')).toBeVisible();
    expect(within(facts).getByText(/The single-package fee that became due/)).toHaveTextContent(
      'The single-package fee that became due: GH₵20.00.',
    );
  });
});

describe('the request: when it cannot be had', () => {
  it('is a page of its own for a request that is not there', async () => {
    open(() => refusal(404, 'NOT_FOUND'));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Pickup request not found' }),
    ).toBeVisible();
    expect(screen.getByText('This pickup request could not be found.')).toBeVisible();
  });

  // AC-SLICE-001-79: an existing request outside the session's hubs is told as that, apart from one that does not exist.
  it('is a page of its own for a request outside the session’s hubs', async () => {
    open(() => refusal(403, 'HUB_SCOPE_VIOLATION'));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'This is outside your hubs' }),
    ).toBeVisible();
  });

  it('asks nothing of the server for an address that is not a request’s', async () => {
    open(undefined, OFFICER, {}, '/pickup-requests/not-a-request');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Pickup request not found' }),
    ).toBeVisible();
    expect(reads()).toHaveLength(0);
  });

  // Break caught: an exception drawn without who asked for it (the outcome every other reader gets), beside a page that offers the acts that
  // follow from it. The portal is staff's and draws the staff view only, so the request is refused whole and no act is offered.
  it('does not draw an exception that came without who asked for it, and offers no act on it', async () => {
    open(() =>
      answer(
        pickupRequestFixture({
          declared_package_count: 1,
          one_package_exception: exceptionOutcomeFixture(),
        }),
      ),
    );

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByText(/Requested by/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^More actions for / })).toBeNull();
  });

  // Break caught: a request with no version acted on, which would send an If-Match the server never gave.
  it('does not show a request that came with no version', async () => {
    open(() => json(200, pickupRequestFixture()));

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^More actions for / })).toBeNull();
  });
});

describe('confirming', () => {
  // AC-SLICE-001-01, AC-SLICE-001-10: the version read is sent, the operation takes no key, and the answer's estimate is shown as one.
  it('confirms on the version read, with no key, and shows the estimate the answer carried', async () => {
    let version = 'v1';
    let state: 'PENDING' | 'CONFIRMED' = 'PENDING';
    const { user } = open(() => answer(pickupRequestFixture({ state }), version), OFFICER, {
      [`POST /pickup-requests/${REQUEST_ID}/confirm`]: () => {
        state = 'CONFIRMED';
        version = 'v2';
        return answer(
          pickupRequestFixture({ state: 'CONFIRMED', indicative_estimate: estimateFixture() }),
          'v2',
        );
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Confirm the pickup' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm this pickup?' });
    expect(within(dialog).getByText(/Nothing is charged and no credit is reserved/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm the pickup' }));

    expect(
      await screen.findByText('The request is confirmed. It waits in the pool for a pickup run.'),
    ).toBeVisible();
    const [request] = acts();
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.has('Idempotency-Key')).toBe(false);
    const estimate = screen.getByRole('region', { name: 'Indicative estimate (provisional)' });
    expect(within(estimate).getByText(/^About/)).toHaveTextContent('About GH₵45.00');
    // The request is read again for its new state and version.
    await waitFor(() => {
      expect(reads()).toHaveLength(2);
    });
    expect(await screen.findByText('Confirmed')).toBeVisible();
  });

  // AC-SLICE-001-10: a concurrent confirmation is a STATE_CONFLICT that is explained and read again, never a silent overwrite.
  it('explains a request that changed under the person, and reads it again', async () => {
    const { user } = open(undefined, OFFICER, {
      [`POST /pickup-requests/${REQUEST_ID}/confirm`]: () => refusal(409, 'STATE_CONFLICT'),
    });

    await user.click(await screen.findByRole('button', { name: 'Confirm the pickup' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm this pickup?' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm the pickup' }));

    expect(await within(dialog).findByText(/changed after you opened it/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Reload the record' }));

    await waitFor(() => {
      expect(reads()).toHaveLength(2);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('says the rule when a single package is confirmed before its exception is approved', async () => {
    const { user } = open(undefined, OFFICER, {
      [`POST /pickup-requests/${REQUEST_ID}/confirm`]: () => refusal(422, 'PICKUP_MINIMUM_NOT_MET'),
    });

    await user.click(await screen.findByRole('button', { name: 'Confirm the pickup' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm this pickup?' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm the pickup' }));

    expect(
      await within(dialog).findByText(/once its one-package exception is approved/),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  // A single package waits for its exception: the page offers the exception and not the confirmation (AC-SLICE-001-03).
  it('offers the exception, and not the confirmation, for a single package with no approved exception', async () => {
    open(() => answer(pickupRequestFixture({ declared_package_count: 1 })));

    await screen.findByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' });
    expect(within(actions()).queryByRole('button', { name: 'Confirm the pickup' })).toBeNull();
    expect(within(actions()).getByRole('link', { name: 'Request the exception' })).toHaveAttribute(
      'href',
      `/pickup-requests/${REQUEST_ID}/exception`,
    );
    // What stands in the way is told in words, and names no key.
    expect(within(actions()).getByText(/This request is for a single package/)).toBeVisible();
    expect(actions().textContent).not.toContain('pickup.exception.approve');
  });

  // An exception that was asked for waits for its checker: it is not asked for twice, and the page leads a checker to the queue.
  it('says a requested exception waits for its approver, and leads a holder of the approval to the queue', async () => {
    open(
      () =>
        answer(
          pickupRequestFixture({
            declared_package_count: 1,
            one_package_exception: exceptionFixture(),
          }),
        ),
      [...OFFICER, 'pickup.exception.approve'],
    );

    await screen.findByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' });
    expect(within(actions()).queryByRole('link', { name: 'Request the exception' })).toBeNull();
    expect(within(actions()).queryByRole('button', { name: 'Confirm the pickup' })).toBeNull();
    expect(
      within(actions()).getByText(/The one-package exception is requested and waits/),
    ).toBeVisible();
    expect(
      within(actions()).getByRole('link', { name: 'Go to the exceptions to approve' }),
    ).toHaveAttribute('href', '/approvals');
  });

  it('offers no way to the queue to a session that cannot approve', async () => {
    open(() =>
      answer(
        pickupRequestFixture({
          declared_package_count: 1,
          one_package_exception: exceptionFixture(),
        }),
      ),
    );

    expect(
      await screen.findByText(/The one-package exception is requested and waits/),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Go to the exceptions to approve' })).toBeNull();
  });

  it('offers the confirmation once the exception is approved', async () => {
    open(() =>
      answer(
        pickupRequestFixture({
          declared_package_count: 1,
          one_package_exception_id: '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d',
        }),
      ),
    );

    expect(await screen.findByRole('button', { name: 'Confirm the pickup' })).toBeVisible();
  });
});

describe('the acts the session may not do', () => {
  // Break caught: an act drawn for a session that cannot take it (presentation is the only thing the page does about it), or a refusal worded as a key or a role.
  it('draws no act the session does not hold, and names no key and no role', async () => {
    open(() => answer(pickupRequestFixture({ state: 'CONFIRMED' })), ['pickup.read']);

    await screen.findByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' });
    expect(within(actions()).queryAllByRole('button')).toEqual([]);
    expect(within(actions()).queryByRole('link', { name: 'Request the exception' })).toBeNull();
    for (const key of [
      'pickup.request.cancel',
      'pickup.failure.resolve',
      'pickup.attempt.extend',
      'pickup.request.confirm',
    ]) {
      expect(actions().textContent).not.toContain(key);
    }
    expect(actions().textContent).not.toMatch(/Ops Staff|Senior Ops|Platform Admin/);
  });

  it('draws no confirmation on a pending request for a session without the key', async () => {
    open(undefined, ['pickup.read']);

    await screen.findByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' });
    expect(screen.queryByRole('button', { name: 'Confirm the pickup' })).toBeNull();
    expect(actions().textContent).not.toContain('pickup.request.confirm');
  });

  // S1.18: an extension needs a confirmed request; a pending one is never offered it.
  it('offers no extension and no escalation on a pending request', async () => {
    const { user } = open(undefined, SENIOR);

    await screen.findByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' });
    await user.click(await screen.findByRole('button', { name: /^More actions for / }));
    expect(await screen.findByRole('menuitem', { name: 'Cancel the request' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Extend the attempts' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Escalate the request' })).toBeNull();
  });

  it('offers nothing to change on a declined request', async () => {
    open(() => answer(pickupRequestFixture({ state: 'DECLINED' })));

    expect(await screen.findByText('A declined request is not changed again.')).toBeVisible();
    expect(within(actions()).queryAllByRole('button')).toEqual([]);
  });
});

describe('the late booking', () => {
  it('records the decision and a note, on the version read, with a fresh key', async () => {
    const { user } = open(
      () =>
        answer(
          pickupRequestFixture({
            state: 'CONFIRMED',
            cutoff_exception_state: 'PENDING_OPS_REVIEW',
          }),
        ),
      OFFICER,
      {
        [`POST /pickup-requests/${REQUEST_ID}/cutoff-exception`]: () =>
          answer(
            pickupRequestFixture({
              state: 'CONFIRMED',
              cutoff_exception_state: 'SAME_DAY_APPROVED',
            }),
            'v2',
          ),
      },
    );

    await user.click(await screen.findByRole('button', { name: 'Decide the late booking' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Decide this late booking?' });
    // Nothing is chosen for the person.
    await user.click(within(dialog).getByRole('button', { name: 'Record the decision' }));
    expect(within(dialog).getByText('Choose what happens to the late booking.')).toBeVisible();
    expect(acts()).toHaveLength(0);

    await user.click(within(dialog).getByRole('radio', { name: 'Approve it for the same day' }));
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why/ }),
      'Vendor called before ten',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record the decision' }));

    expect(await screen.findByText('The late booking is approved for the same day.')).toBeVisible();
    const [request] = acts();
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await bodyOf(request)).toEqual({
      decision: 'APPROVE_SAME_DAY',
      note: 'Vendor called before ten',
    });
  });
});

describe('cancelling', () => {
  const reasons = (list: unknown[]) => () => json(200, list);

  // The catalogue's codes are the Product Owner's and are not seeded: an empty catalogue is said plainly, and no code is made up.
  it('says plainly that no cancellation reason is configured, names who adds them, and cannot cancel', async () => {
    const { user } = open(undefined, OFFICER, { [REASONS]: reasons([]) });

    await chooseAct(user, 'Cancel the request');
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup request?' });

    expect(
      await within(dialog).findByText(/No cancellation reason is configured yet/),
    ).toBeVisible();
    expect(
      within(dialog).getByText(/An administrator adds the reasons to the reason catalogue/),
    ).toBeVisible();
    expect(dialog.textContent).not.toContain('settings.reason.manage');
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    const confirm = within(dialog).getByRole('button', { name: 'Cancel the request' });
    expect(confirm).toBeDisabled();
    expect(new URL(sent(REASONS)[0]?.url ?? 'http://x/').searchParams.get('domain')).toBe(
      'PICKUP_CANCELLATION',
    );
  });

  // AC-SLICE-001-05 and the version rule: a reason of the catalogue, the version read and a fresh key.
  it('cancels with a reason of the catalogue, on the version read, with a fresh key', async () => {
    const { user } = open(undefined, OFFICER, {
      [REASONS]: reasons([cancellationReasonFixture()]),
      [`POST /pickup-requests/${REQUEST_ID}/cancel`]: () =>
        answer(pickupRequestFixture({ state: 'CANCELLED', cancelled_by_actor_type: 'OPS' }), 'v2'),
    });

    await chooseAct(user, 'Cancel the request');
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup request?' });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /Reason/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    // A pending request has no rider and no charge: nothing about a charge is asked.
    expect(within(dialog).queryByRole('group', { name: 'Cancellation charge' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the request' }));

    expect(await screen.findByText('The request is cancelled.')).toBeVisible();
    const [request] = acts();
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await bodyOf(request)).toEqual({
      reason_code: 'DEMO_CUSTOMER_CHANGED_MIND',
      create_replacement: false,
    });
  });

  // A request no rider holds records no charge outcome, and a decision offered for it is refused (cancelPickupRequest): none is asked.
  it('asks nothing about a charge before a rider is assigned, even of a session that may charge', async () => {
    const { user } = open(
      () => answer(pickupRequestFixture({ state: 'CONFIRMED', rider_assigned: false })),
      OFFICER,
      {
        [REASONS]: reasons([cancellationReasonFixture()]),
        [`POST /pickup-requests/${REQUEST_ID}/cancel`]: () =>
          answer(pickupRequestFixture({ state: 'CANCELLED' }), 'v2'),
      },
    );

    // The page tells that no rider holds the run; the cancellation then asks nothing about a charge.
    expect(await screen.findByText('Not assigned yet')).toBeVisible();
    await chooseAct(user, 'Cancel the request');
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup request?' });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /^Reason/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    expect(within(dialog).queryByRole('group', { name: /^Cancellation charge/ })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the request' }));

    expect(await screen.findByText('The request is cancelled.')).toBeVisible();
    expect(await bodyOf(acts()[0])).toEqual({
      reason_code: 'DEMO_CUSTOMER_CHANGED_MIND',
      create_replacement: false,
    });
  });

  // After assignment the decision and its reason are required either way (REASON_REQUIRED otherwise): there is no default.
  it('requires the charge decision and its reason once a rider is assigned, and sends nothing without them', async () => {
    const { user } = open(() => answer(pickupRequestFixture(ASSIGNED)), OFFICER, {
      [REASONS]: reasons([cancellationReasonFixture()]),
    });

    // The page tells that a rider holds the run; the cancellation then asks for the charge decision.
    expect(await screen.findByText('Assigned to the pickup run')).toBeVisible();
    await chooseAct(user, 'Cancel the request');
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup request?' });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /^Reason/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the request' }));

    expect(within(dialog).getByText('Decide whether to apply the charge.')).toBeVisible();
    expect(within(dialog).getByText('Choose why the charge was or was not applied.')).toBeVisible();
    expect(acts()).toHaveLength(0);
  });

  // MSC-DEC-197: the charge is a decision the person makes, with nothing chosen for them, and its reason is recorded either way.
  it('asks the charge as a decision with nothing chosen, and sends the decision and its reason', async () => {
    const { user } = open(() => answer(pickupRequestFixture(ASSIGNED)), OFFICER, {
      [REASONS]: reasons([cancellationReasonFixture(), melarcReasonFixture()]),
      [`POST /pickup-requests/${REQUEST_ID}/cancel`]: () =>
        answer(
          pickupRequestFixture({
            state: 'CANCELLED',
            cancellation_charge_outcome: 'APPLIED',
            cancellation_charge: { amount_minor: 2000, currency: 'GHS' },
          }),
          'v2',
        ),
    });

    await chooseAct(user, 'Cancel the request');
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup request?' });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /^Reason/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    const charge = within(dialog).getByRole('group', { name: /^Cancellation charge/ });
    for (const radio of within(charge).getAllByRole('radio')) expect(radio).not.toBeChecked();

    await user.click(within(charge).getByRole('radio', { name: 'Apply the cancellation charge' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the request' }));
    // A decision with no reason for it is neither a decision nor none.
    expect(within(dialog).getByText('Choose why the charge was or was not applied.')).toBeVisible();
    expect(acts()).toHaveLength(0);

    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: /Why the charge/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the request' }));

    expect(
      await screen.findByText('The request is cancelled. The cancellation charge was applied.'),
    ).toBeVisible();
    expect(await bodyOf(acts()[0])).toEqual({
      reason_code: 'DEMO_CUSTOMER_CHANGED_MIND',
      create_replacement: false,
      apply_charge: true,
      charge_reason_code: 'DEMO_CUSTOMER_CHANGED_MIND',
    });
  });

  // MSC-DEC-388: a reason that puts the cause with Melarc permits no charge, so none is offered and the decision sent is "no charge".
  it('offers no charge for a reason attributed to Melarc', async () => {
    const { user } = open(() => answer(pickupRequestFixture(ASSIGNED)), OFFICER, {
      [REASONS]: reasons([cancellationReasonFixture(), melarcReasonFixture()]),
      [`POST /pickup-requests/${REQUEST_ID}/cancel`]: () =>
        answer(
          pickupRequestFixture({ state: 'CANCELLED', cancellation_charge_outcome: 'EXEMPT' }),
          'v2',
        ),
    });

    await chooseAct(user, 'Cancel the request');
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup request?' });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /^Reason/ }),
      'DEMO_NO_RIDER_AVAILABLE',
    );

    expect(
      within(dialog).queryByRole('radio', { name: 'Apply the cancellation charge' }),
    ).toBeNull();
    expect(within(dialog).getByText(/so no charge is permitted/)).toBeVisible();
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: /Why the charge/ }),
      'DEMO_NO_RIDER_AVAILABLE',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the request' }));

    expect(
      await screen.findByText(
        'The request is cancelled. No charge: the reason puts the cause with Melarc, so none is permitted.',
      ),
    ).toBeVisible();
    expect(await bodyOf(acts()[0])).toMatchObject({
      apply_charge: false,
      charge_reason_code: 'DEMO_NO_RIDER_AVAILABLE',
    });
  });

  // Electing a charge needs pickup.request.cancel_chargeable; deciding "no charge" does not, and is still a decision the person makes.
  it('lets a session without pickup.request.cancel_chargeable decide only "no charge", and names the key', async () => {
    const { user } = open(
      () => answer(pickupRequestFixture(ASSIGNED)),
      OFFICER.filter((key) => key !== 'pickup.request.cancel_chargeable'),
      {
        [REASONS]: reasons([cancellationReasonFixture()]),
        [`POST /pickup-requests/${REQUEST_ID}/cancel`]: () =>
          answer(
            pickupRequestFixture({
              state: 'CANCELLED',
              cancellation_charge_outcome: 'NOT_APPLIED',
            }),
            'v2',
          ),
      },
    );

    await chooseAct(user, 'Cancel the request');
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup request?' });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /^Reason/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    const charge = within(dialog).getByRole('group', { name: /^Cancellation charge/ });
    expect(
      within(charge).getByRole('radio', { name: 'Apply the cancellation charge' }),
    ).toBeDisabled();
    expect(within(charge).getByRole('radio', { name: 'Do not apply a charge' })).not.toBeChecked();
    expect(within(charge).getByText(cannotText('pickup.request.cancel_chargeable'))).toBeVisible();

    await user.click(within(charge).getByRole('radio', { name: 'Do not apply a charge' }));
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: /Why the charge/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the request' }));

    expect(
      await screen.findByText('The request is cancelled. No charge: Ops chose not to apply one.'),
    ).toBeVisible();
    expect(await bodyOf(acts()[0])).toEqual({
      reason_code: 'DEMO_CUSTOMER_CHANGED_MIND',
      create_replacement: false,
      apply_charge: false,
      charge_reason_code: 'DEMO_CUSTOMER_CHANGED_MIND',
    });
  });

  // A lost answer: the same command is sent again under the same key, so it is not done twice.
  it('tries a lost cancellation again under the same key', async () => {
    let attempts = 0;
    const { user } = open(undefined, OFFICER, {
      [REASONS]: reasons([cancellationReasonFixture()]),
      [`POST /pickup-requests/${REQUEST_ID}/cancel`]: () => {
        attempts += 1;
        return attempts === 1
          ? refusal(503, 'INTERNAL')
          : answer(pickupRequestFixture({ state: 'CANCELLED' }), 'v2');
      },
    });

    await chooseAct(user, 'Cancel the request');
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup request?' });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /Reason/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the request' }));
    expect(
      await within(dialog).findByText(/We could not confirm whether this was done/),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('The request is cancelled.')).toBeVisible();
    const [first, second] = acts();
    expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
    expect(await bodyOf(second)).toEqual(await bodyOf(first));
  });

  // AC-SLICE-001-06: a reschedule is a cancellation that books the next attempt in the same act, and the page leads to it.
  it('reschedules with create_replacement, and leads to the new attempt', async () => {
    const { user } = open(() => answer(pickupRequestFixture({ state: 'CONFIRMED' })), OFFICER, {
      [REASONS]: reasons([cancellationReasonFixture()]),
      [`POST /pickup-requests/${REQUEST_ID}/cancel`]: () =>
        answer(
          pickupRequestFixture({ state: 'CANCELLED', replacement_request_id: LATER_REQUEST_ID }),
          'v2',
        ),
      [`GET /pickup-requests/${LATER_REQUEST_ID}`]: () =>
        answer(
          pickupRequestFixture({
            id: LATER_REQUEST_ID,
            code: 'ACC-PR-3RTY8N',
            attempt_number: 2,
            replaces_request_id: REQUEST_ID,
          }),
        ),
    });

    await chooseAct(user, 'Reschedule the pickup');
    const dialog = screen.getByRole('alertdialog', { name: 'Reschedule this pickup?' });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /^Reason/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reschedule the pickup' }));

    expect(
      await screen.findByText(
        'The pickup is rescheduled: this request is cancelled and its next attempt is booked.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to the new attempt' })).toHaveAttribute(
      'href',
      `/pickup-requests/${LATER_REQUEST_ID}`,
    );
    expect(await bodyOf(acts()[0])).toMatchObject({ create_replacement: true });
  });

  // S1.18: the next attempt past the cap is refused and nothing is cancelled; the way on is an extension, offered to the person who can make
  // it, and told by its key to the person who cannot, with what else they can do: never a dead end.
  it.each([
    ['cannot extend', OFFICER, /an extension that an approver gives/, /^Extend the attempts/],
    ['can extend', SENIOR, /^Extend the attempts on this page/, /a holder of/],
  ] as const)(
    'says nothing was cancelled when a reschedule passes the limit, to a person who %s',
    async (_label, keys, said, unsaid) => {
      const { user } = open(
        () => answer(pickupRequestFixture({ state: 'CONFIRMED', attempt_number: 3 })),
        keys,
        {
          [REASONS]: reasons([cancellationReasonFixture()]),
          [`POST /pickup-requests/${REQUEST_ID}/cancel`]: () =>
            refusal(422, 'PICKUP_ATTEMPT_LIMIT_REACHED'),
        },
      );

      await chooseAct(user, 'Reschedule the pickup');
      const dialog = screen.getByRole('alertdialog', { name: 'Reschedule this pickup?' });
      await user.selectOptions(
        await within(dialog).findByRole('combobox', { name: /^Reason/ }),
        'DEMO_CUSTOMER_CHANGED_MIND',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Reschedule the pickup' }));

      const alert = await within(dialog).findByRole('alert');
      expect(within(alert).getByText(/^Nothing was cancelled/)).toBeVisible();
      expect(within(alert).getByText(said)).toBeVisible();
      expect(within(alert).queryByText(unsaid)).toBeNull();
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  );
});

describe('the senior acts and the escalation', () => {
  it('extends the attempts with a reason, on the version read, with a fresh key', async () => {
    const { user } = open(
      () => answer(pickupRequestFixture({ state: 'CONFIRMED', attempt_number: 3 })),
      SENIOR,
      {
        [`POST /pickup-requests/${REQUEST_ID}/attempt-extension`]: () =>
          answer(pickupRequestFixture({ state: 'CONFIRMED', attempt_number: 3 }), 'v2'),
      },
    );

    await chooseAct(user, 'Extend the attempts');
    const dialog = screen.getByRole('alertdialog', {
      name: 'Extend the attempts of this request?',
    });
    // S1.18: one further attempt, and no ceiling to set.
    expect(within(dialog).getByText(/one further attempt for this request alone/)).toBeVisible();
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
    // A blank reason is refused here before it is refused by the server.
    await user.click(within(dialog).getByRole('button', { name: 'Allow one further attempt' }));
    expect(within(dialog).getByText('Write a note saying why.')).toBeVisible();
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why the attempts are extended/ }),
      'Vendor away all week',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Allow one further attempt' }));

    expect(
      await screen.findByText(
        'The attempts are extended: this request may have one further attempt. Reschedule it to make that attempt.',
      ),
    ).toBeVisible();
    const [request] = acts();
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await bodyOf(request)).toEqual({ reason: 'Vendor away all week' });
  });

  // S1.18: a state conflict is "nothing to extend" (the request can go on, is already extended, or its hub has no limit) or a change.
  it('says there is nothing to extend when the server finds none, and reads the request again', async () => {
    const { user } = open(() => answer(pickupRequestFixture({ state: 'CONFIRMED' })), SENIOR, {
      [`POST /pickup-requests/${REQUEST_ID}/attempt-extension`]: () =>
        refusal(409, 'STATE_CONFLICT'),
    });

    await chooseAct(user, 'Extend the attempts');
    const dialog = screen.getByRole('alertdialog', {
      name: 'Extend the attempts of this request?',
    });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why the attempts are extended/ }),
      'Vendor away all week',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Allow one further attempt' }));

    expect(await within(dialog).findByText(/^There is nothing to extend/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Reload the record' }));
    await waitFor(() => {
      expect(reads()).toHaveLength(2);
    });
  });

  it('says a request carries an extension', async () => {
    open(() =>
      answer(
        pickupRequestFixture({
          state: 'CONFIRMED',
          attempt_number: 4,
          attempt_extension_id: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
        }),
      ),
    );

    expect(
      await screen.findByText(
        'Extended for this request: one further attempt past the hub’s limit.',
      ),
    ).toBeVisible();
  });

  // S1.18: an escalation is recorded once: once the read says when, the page tells it and offers it no more.
  it('tells an escalation by its date, and offers it no more', async () => {
    const { user } = open(() =>
      answer(pickupRequestFixture({ state: 'CONFIRMED', escalated_at: '2026-10-30T08:00:00Z' })),
    );

    const status = (await screen.findByText(/It is confirmed/)).closest('p');
    expect(status).toHaveTextContent('Escalated on 30 Oct, 08:00.');
    // Nothing else changes: it can still be rescheduled and cancelled, and is offered no escalation.
    await user.click(await screen.findByRole('button', { name: /^More actions for / }));
    expect(await screen.findByRole('menuitem', { name: 'Reschedule the pickup' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Cancel the request' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Escalate the request' })).toBeNull();
  });

  it('escalates with a note, on the version read, with a fresh key', async () => {
    const { user } = open(() => answer(pickupRequestFixture({ state: 'CONFIRMED' })), OFFICER, {
      [`POST /pickup-requests/${REQUEST_ID}/escalate`]: () =>
        answer(pickupRequestFixture({ state: 'CONFIRMED' }), 'v2'),
    });

    await chooseAct(user, 'Escalate the request');
    const dialog = screen.getByRole('alertdialog', { name: 'Escalate this request?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why it is escalated/ }),
      'Refused at the door twice',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Escalate the request' }));

    expect(await screen.findByText('The request is escalated.')).toBeVisible();
    const [request] = acts();
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await bodyOf(request)).toEqual({ note: 'Refused at the door twice' });
  });

  // AC-SLICE-001-62 to 64: only an applied charge is offered for a waiver; the waiver is a note and no amount; it takes the version and no key.
  it('waives an applied charge with a note and no amount, on the version read, with no key', async () => {
    const cancelled = pickupRequestFixture({
      state: 'CANCELLED',
      cancellation_charge_outcome: 'APPLIED',
      cancellation_charge: { amount_minor: 2000, currency: 'GHS' },
    });
    const { user } = open(() => answer(cancelled), SENIOR, {
      [`POST /pickup-requests/${REQUEST_ID}/cancellation-charge/waiver`]: () =>
        answer({ ...cancelled, cancellation_charge_outcome: 'WAIVED' }, 'v2'),
    });

    await user.click(await screen.findByRole('button', { name: 'Waive the charge' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Waive the cancellation charge?' });
    expect(within(dialog).queryByRole('textbox', { name: /amount/i })).toBeNull();
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why the charge is waived/ }),
      'Genuine emergency',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Waive the charge' }));

    expect(await screen.findByText('The cancellation charge is waived in full.')).toBeVisible();
    const [request] = acts();
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.has('Idempotency-Key')).toBe(false);
    expect(await bodyOf(request)).toEqual({ note: 'Genuine emergency' });
  });

  it('says so when there was no charge to waive', async () => {
    const cancelled = pickupRequestFixture({
      state: 'CANCELLED',
      cancellation_charge_outcome: 'APPLIED',
    });
    const { user } = open(() => answer(cancelled), SENIOR, {
      [`POST /pickup-requests/${REQUEST_ID}/cancellation-charge/waiver`]: () =>
        refusal(422, 'NO_CHARGE_APPLIED'),
    });

    await user.click(await screen.findByRole('button', { name: 'Waive the charge' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Waive the cancellation charge?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why the charge is waived/ }),
      'Emergency',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Waive the charge' }));

    expect(
      await within(dialog).findByText(
        'No charge was applied to this cancellation, so there is nothing to waive.',
      ),
    ).toBeVisible();
  });

  it.each(['NOT_APPLIED', 'UNAVAILABLE', 'EXEMPT', 'WAIVED'] as const)(
    'offers no waiver for a cancellation whose charge outcome is %s',
    async (outcome) => {
      open(
        () =>
          answer(
            pickupRequestFixture({ state: 'CANCELLED', cancellation_charge_outcome: outcome }),
          ),
        SENIOR,
      );

      await screen.findByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' });
      expect(screen.queryByRole('button', { name: 'Waive the charge' })).toBeNull();
    },
  );
});

describe('the attempt chain', () => {
  it('reads the attempts before and after, oldest first, and links to each other one', async () => {
    open(
      () =>
        answer(
          pickupRequestFixture({
            state: 'CANCELLED',
            attempt_number: 2,
            replaces_request_id: EARLIER_REQUEST_ID,
            replacement_request_id: LATER_REQUEST_ID,
          }),
        ),
      OFFICER,
      {
        [`GET /pickup-requests/${EARLIER_REQUEST_ID}`]: () =>
          answer(
            pickupRequestFixture({
              id: EARLIER_REQUEST_ID,
              code: 'ACC-PR-9WXH4T',
              state: 'CANCELLED',
              replacement_request_id: REQUEST_ID,
            }),
          ),
        [`GET /pickup-requests/${LATER_REQUEST_ID}`]: () =>
          answer(
            pickupRequestFixture({
              id: LATER_REQUEST_ID,
              code: 'ACC-PR-3RTY8N',
              attempt_number: 3,
              replaces_request_id: REQUEST_ID,
            }),
          ),
      },
    );

    const chain = await screen.findByRole('list', {
      name: 'Attempts of this pickup, oldest first',
    });
    const steps = within(chain).getAllByRole('listitem');
    expect(steps.map((step) => step.querySelector('.ui-timeline__title')?.textContent)).toEqual([
      'Attempt 1: ACC-PR-9WXH4T',
      'Attempt 2: ACC-PR-7KQ2MZ (this request)',
      'Attempt 3: ACC-PR-3RTY8N',
    ]);
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(within(chain).getByRole('link', { name: 'Attempt 1: ACC-PR-9WXH4T' })).toHaveAttribute(
      'href',
      `/pickup-requests/${EARLIER_REQUEST_ID}`,
    );
    expect(within(chain).queryByRole('link', { name: /ACC-PR-7KQ2MZ/ })).toBeNull();
  });

  it('says an attempt the session cannot read is there, without showing it', async () => {
    open(
      () =>
        answer(
          pickupRequestFixture({ attempt_number: 2, replaces_request_id: EARLIER_REQUEST_ID }),
        ),
      OFFICER,
      { [`GET /pickup-requests/${EARLIER_REQUEST_ID}`]: () => refusal(403, 'HUB_SCOPE_VIOLATION') },
    );

    expect(await screen.findByText('An attempt this session cannot read')).toBeVisible();
  });

  it('says there is no other attempt for a request that is alone', async () => {
    open();

    expect(await screen.findByText(/No other attempt is linked to this request/)).toBeVisible();
  });
});

describeInterfaceStates('The pickup request', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      open(() => gate);
      expect(await screen.findByText('Loading the pickup request…')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Pickup request' })).toBeVisible();
      await act(async () => {
        release(answer(pickupRequestFixture()));
        await gate;
      });
      expect(await screen.findByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' })).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A request is a record and is never empty; a request that is not there is the not-found page, and a request alone in its chain says so.',
  },
  'validation error': {
    test: async () => {
      const { user } = open(() => answer(pickupRequestFixture({ state: 'CONFIRMED' })), OFFICER, {
        [`POST /pickup-requests/${REQUEST_ID}/escalate`]: () =>
          refusal(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'body', pointer: '/note', rule: 'pattern' }],
          }),
      });
      await chooseAct(user, 'Escalate the request');
      const dialog = screen.getByRole('alertdialog', { name: 'Escalate this request?' });
      await user.type(
        within(dialog).getByRole('textbox', { name: /Why it is escalated/ }),
        'call 024 000 0000',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Escalate the request' }));
      const note = within(dialog).getByRole('textbox', { name: /Why it is escalated/ });
      await waitFor(() => {
        expect(note).toHaveAttribute('aria-invalid', 'true');
      });
      expect(note).toHaveAccessibleDescription(
        expect.stringContaining('The note was not accepted.'),
      );
      // The refusal says what to change, and never repeats what was written.
      expect(
        within(dialog).getByText('Check the note marked below: it was not accepted as written.'),
      ).toBeVisible();
      expect(dialog.textContent).not.toContain('024 000 0000');
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL'));
      expect(await screen.findByText('This pickup request could not be loaded.')).toBeVisible();
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(() => {
        attempts += 1;
        return attempts === 1 ? refusal(503, 'INTERNAL') : answer(pickupRequestFixture());
      });
      await view.user.click(await screen.findByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open(() => answer(pickupRequestFixture({ state: 'CONFIRMED' })), OFFICER, {
        [`POST /pickup-requests/${REQUEST_ID}/escalate`]: () => refusal(409, 'STATE_CONFLICT'),
      });
      await chooseAct(user, 'Escalate the request');
      const dialog = screen.getByRole('alertdialog', { name: 'Escalate this request?' });
      await user.type(
        within(dialog).getByRole('textbox', { name: /Why it is escalated/ }),
        'Refused twice',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Escalate the request' }));
      expect(await within(dialog).findByText(/changed after you opened it/)).toBeVisible();
      await waitFor(() => {
        expect(within(dialog).getByRole('button', { name: 'Reload the record' })).toHaveFocus();
      });
    },
  },
  success: {
    test: async () => {
      const { user } = open(undefined, OFFICER, {
        [`POST /pickup-requests/${REQUEST_ID}/confirm`]: () =>
          answer(pickupRequestFixture({ state: 'CONFIRMED' }), 'v2'),
      });
      await user.click(await screen.findByRole('button', { name: 'Confirm the pickup' }));
      await user.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm the pickup' }),
      );
      const notice = (await screen.findByText(/The request is confirmed/)).closest(
        '.pickup-notice',
      );
      await waitFor(() => {
        expect(notice).toHaveFocus();
      });
    },
  },
  'permission-restricted': {
    test: async () => {
      open(undefined, ['staff.read']);
      expect(await screen.findByText(cannotText('pickup.read'))).toBeVisible();
      expect(reads()).toHaveLength(0);
    },
  },
});
