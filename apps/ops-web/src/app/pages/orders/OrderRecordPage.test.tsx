import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID } from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  captured,
  capturedRefusal,
  correctionOf,
  EARLY_ORDER_ID,
  ORDER_CODE,
  ORDER_ID,
  orderOf,
} from '../../../test-support/orders-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/orders/{id}` (`getOrder`; S1.40): **the record of one order, read as one snapshot with its history and its version.** It says what the order holds, the price told as what it is (a price calculated and kept
 * until the order is confirmed, or the price fixed), who pays, and what happened to it, each change with who made it and why and never the values. Acts are offered by key and by what the record says: *Change
 * this order* while its price is not fixed, *Change who pays* once it is, *Take back the arrival* for a senior officer.
 */
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const OFFICER = ['hub.read', 'hub.intake.itemize', 'pricing.read', 'pricing.correction.create'];
const SENIOR = [...OFFICER, 'hub.osd.adjudicate'];
const READ = (id: string) => `GET /orders/${id}`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server|terms_token|token)\b/i;

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  body: unknown,
  keys: readonly string[] = OFFICER,
  handlers: Record<string, Handler> = {},
  id = ORDER_ID,
  state?: unknown,
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [READ(id)]: () => json(200, body, { ETag: '"o1"' }),
      ...handlers,
    }),
  );
  return renderApp(state === undefined ? `/orders/${id}` : { pathname: `/orders/${id}`, state });
}

const sent = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname.replace('/api/v1', '')}` === route,
  );
const bodyOf = async (request: Request | undefined): Promise<unknown> =>
  request === undefined ? undefined : ((await request.clone().json()) as unknown);
const dialog = async (): Promise<HTMLElement> => screen.findByRole('alertdialog');

describe('an order whose price is fixed', () => {
  // Break caught: a fixed price drawn as a quote (or the other way), the portions not shown, a phone drawn nowhere, or an act drawn for a key that is not held.
  it('shows the fixed price, who pays, what it holds and what the officer may do', async () => {
    open(orderOf('frozen'));
    expect(await screen.findByRole('heading', { level: 1, name: ORDER_CODE })).toBeVisible();
    expect(screen.getByText('Confirmed: its price is fixed.')).toBeVisible();
    const price = within(screen.getByRole('region', { name: 'The price' }));
    expect(price.getByText('Fixed price').nextElementSibling).toHaveTextContent('GH₵35.00');
    expect(price.queryByText('Calculated price (not fixed)')).toBeNull();
    const payer = within(screen.getByRole('region', { name: 'Who pays' }));
    expect(payer.getByText('The recipient pays').nextElementSibling).toHaveTextContent('GH₵35.00');
    expect(payer.getByText('The sender pays').nextElementSibling).toHaveTextContent('GH₵0.00');
    const holds = within(screen.getByRole('region', { name: 'What it holds' }));
    expect(holds.getByText('Ama Mensah')).toBeVisible();
    expect(holds.getByText('Small')).toBeVisible();
    // The price is fixed: the order is not changed here, who pays is a correction.
    expect(screen.queryByRole('link', { name: 'Change this order' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Change who pays' })).toBeVisible();
    // The officer has no key to take back an arrival, and is told who does.
    expect(screen.queryByRole('button', { name: 'Take back the arrival' })).toBeNull();
    expect(screen.getByText('A senior officer takes back an arrival.')).toBeVisible();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  // Break caught: a take-back that does not say that no more orders can be made for the vendor until a senior officer decides (an officer finds out when the form refuses).
  it('says in the take-back that no more orders can be made for the vendor until a senior officer decides', async () => {
    const { user } = open(orderOf('frozen'), SENIOR);
    await user.click(await screen.findByRole('button', { name: 'Take back the arrival' }));
    expect(
      within(await dialog()).getByText(
        /No more orders can be made for this vendor until a senior officer decides\./,
      ),
    ).toBeVisible();
  });

  it('offers a senior officer the arrival to take back', async () => {
    open(orderOf('frozen'), SENIOR);
    expect(await screen.findByRole('button', { name: 'Take back the arrival' })).toBeVisible();
    expect(screen.queryByText('A senior officer takes back an arrival.')).toBeNull();
  });

  // Break caught: a reversal without a reason, sent without the version of the order, or one that leaves the record as it was.
  it('takes back an arrival with a reason, on the version read, and says what it did', async () => {
    let reads = 0;
    const { user } = open(orderOf('frozen'), SENIOR, {
      [READ(ORDER_ID)]: () => {
        reads += 1;
        // The reload answers for the same order, taken back: the captured reversed order is another order, so it is given this one's identity.
        const body =
          reads === 1
            ? orderOf('frozen')
            : { ...orderOf('reversed'), id: ORDER_ID, code: ORDER_CODE };
        return json(200, body, { ETag: reads === 1 ? '"o1"' : '"o2"' });
      },
      [`POST /orders/${ORDER_ID}/arrival-reversal`]: () =>
        json(200, { ...captured('reversal'), order_id: ORDER_ID }),
    });
    await user.click(await screen.findByRole('button', { name: 'Take back the arrival' }));
    const asked = within(await dialog());
    // The reason is required.
    await user.click(asked.getByRole('button', { name: 'Take back the arrival' }));
    expect(await asked.findByText('Write why the arrival is being taken back.')).toBeVisible();
    expect(sent(`POST /orders/${ORDER_ID}/arrival-reversal`)).toHaveLength(0);
    await user.type(
      asked.getByLabelText(/Why is the arrival being taken back\?/),
      'The parcel was not on the table',
    );
    await user.click(asked.getByRole('button', { name: 'Take back the arrival' }));

    expect(
      await screen.findByText(/The arrival was taken back\. The vendor now counts/),
    ).toBeVisible();
    const request = sent(`POST /orders/${ORDER_ID}/arrival-reversal`)[0];
    expect(request?.headers.get('If-Match')).toBe('"o1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await bodyOf(request)).toEqual({ note: 'The parcel was not on the table' });
    // The record is read again: the order is taken back, and no act is offered on it.
    await waitFor(() => {
      expect(screen.getByText('Taken back')).toBeVisible();
    });
    expect(screen.queryByRole('button', { name: 'Take back the arrival' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change who pays' })).toBeNull();
  });

  // Break caught: a proposal sent as a portion of the price (the page works the money out), no reason, or a split with no way of sharing.
  it('asks to change who pays by intent and reason, on the version read, and leads to the request', async () => {
    const requested = correctionOf();
    const { user } = open(orderOf('frozen'), OFFICER, {
      [`POST /orders/${ORDER_ID}/payer-correction`]: () =>
        json(201, { ...requested, order_id: ORDER_ID }, { ETag: '"c1"' }),
      [READ(ORDER_ID)]: () => json(200, orderOf('frozen'), { ETag: '"o1"' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Change who pays' }));
    const asked = within(await dialog());
    await user.click(asked.getByRole('button', { name: 'Ask for the change' }));
    expect(await asked.findByText('Choose who pays.')).toBeVisible();
    await user.click(asked.getByRole('radio', { name: 'The sender pays all of it' }));
    await user.click(asked.getByRole('button', { name: 'Ask for the change' }));
    expect(await asked.findByText('Write why who pays should change.')).toBeVisible();
    await user.type(
      asked.getByLabelText(/Why should it change\?/),
      'The vendor will pay on the phone',
    );
    await user.click(asked.getByRole('button', { name: 'Ask for the change' }));

    expect(
      await screen.findByText(/The change was asked for\. A senior officer decides it\./),
    ).toBeVisible();
    const request = sent(`POST /orders/${ORDER_ID}/payer-correction`)[0];
    expect(request?.headers.get('If-Match')).toBe('"o1"');
    expect(await bodyOf(request)).toEqual({
      proposed: { payer_intent: 'SENDER_PAYS_FULL' },
      note: 'The vendor will pay on the phone',
    });
    expect(screen.getByRole('link', { name: 'Open the correction' })).toHaveAttribute(
      'href',
      `/payer-corrections/${requested.id as string}`,
    );
  });

  it('asks how a split is shared, and sends the sender’s share as it was typed', async () => {
    const { user } = open(orderOf('frozen'), OFFICER, {
      [`POST /orders/${ORDER_ID}/payer-correction`]: () =>
        json(201, { ...correctionOf(), order_id: ORDER_ID }, { ETag: '"c1"' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Change who pays' }));
    const asked = within(await dialog());
    await user.click(
      asked.getByRole('radio', { name: 'Split between the sender and the recipient' }),
    );
    await user.click(asked.getByRole('radio', { name: 'A fixed amount' }));
    await user.type(asked.getByLabelText(/The sender pays \(GH₵\)/), '10.00');
    await user.type(asked.getByLabelText(/Why should it change\?/), 'Shared as agreed');
    await user.click(asked.getByRole('button', { name: 'Ask for the change' }));
    await screen.findByText(/The change was asked for\./);
    expect(await bodyOf(sent(`POST /orders/${ORDER_ID}/payer-correction`)[0])).toEqual({
      proposed: {
        payer_intent: 'SPLIT',
        split_basis: 'FIXED_AMOUNT',
        split_sender_amount: { amount_minor: 1000, currency: 'GHS' },
      },
      note: 'Shared as agreed',
    });
  });
});

describe('the recipient of a confirmed order, corrected (D-S7-1, Run F)', () => {
  const CORRECT = `POST /orders/${ORDER_ID}/recipient-correction`;
  const held = () => orderOf('frozen').recipient as { name: string; phone: string };
  const refused = (rule: string, code = 'STATE_CONFLICT', status = 409) =>
    json(status, {
      code,
      message: 'Diagnostic text that must never reach a screen.',
      request_id: 'r-correct',
      details: { rule },
    });

  async function openDialog(handlers: Record<string, Handler> = {}) {
    const opened = open(orderOf('frozen'), OFFICER, handlers);
    await opened.user.click(await screen.findByRole('button', { name: 'Correct the recipient' }));
    return { ...opened, asked: within(await dialog()) };
  }

  // Break caught: the act drawn for an order that is not confirmed (it is changed with its own form), for one whose arrival was taken back, or for a session that holds no key to make orders.
  it('is offered for a confirmed order to a session that makes orders', async () => {
    open(orderOf('frozen'));
    expect(await screen.findByRole('button', { name: 'Correct the recipient' })).toBeVisible();
  });

  it('is not offered for an order that is not confirmed, one that was taken back, or to a session that may not make orders', async () => {
    open(orderOf('early'), OFFICER, {}, EARLY_ORDER_ID);
    await screen.findByText(/Made before the parcel was checked in for good\./);
    expect(screen.queryByRole('button', { name: 'Correct the recipient' })).toBeNull();
    api.restore();

    open({ ...orderOf('reversed'), id: ORDER_ID, code: ORDER_CODE });
    await screen.findByText('Taken back');
    expect(screen.queryByRole('button', { name: 'Correct the recipient' })).toBeNull();
    api.restore();

    open(orderOf('frozen'), ['hub.read', 'pricing.read', 'pricing.correction.create']);
    await screen.findByRole('heading', { level: 1, name: ORDER_CODE });
    expect(screen.queryByRole('button', { name: 'Correct the recipient' })).toBeNull();
  });

  // Break caught: a number the API gives as +233241234567 shown to the officer as that (it is not the number they wrote on the parcel), in the dialog and on the page, and a correction of the name that sends a phone the
  // officer never touched because the shown form differs from the held one.
  it('shows the phone as the officer writes it, in the dialog and on the page, and sends no phone that was not corrected', async () => {
    const { user, asked } = await openDialog({
      [CORRECT]: () => json(200, orderOf('frozen'), { ETag: '"o2"' }),
    });
    expect(asked.getByLabelText(/Recipient’s phone/)).toHaveValue('024 123 4567');
    expect(
      within(screen.getByRole('region', { name: 'What it holds' })).getByText('024 123 4567'),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('+233241234567');
    const name = asked.getByLabelText(/Recipient’s name/);
    await user.clear(name);
    await user.type(name, 'Ama Mensah-Boateng');
    await user.type(asked.getByLabelText(/Why are you correcting this\?/), 'The surname was short');
    await user.click(asked.getByRole('button', { name: 'Save the correction' }));
    await screen.findByText(`The recipient of order ${ORDER_CODE} was corrected.`);
    expect(await bodyOf(sent(CORRECT)[0])).toEqual({
      note: 'The surname was short',
      recipient: { name: 'Ama Mensah-Boateng' },
    });
  });

  // Break caught: the same guidance the form gives while a number is typed missing from the dialog (an officer is told nothing until the server refuses it), or given as a rule.
  it('tells the officer, while a phone is typed, when it does not look like a Ghana number, and says nothing of a good one', async () => {
    const { user, asked } = await openDialog();
    const phone = asked.getByLabelText(/Recipient’s phone/);
    await user.clear(phone);
    await user.type(phone, '12345');
    expect(
      asked.getByText('This doesn’t look like a Ghana number. Check it, for example 024 123 4567.'),
    ).toBeVisible();
    await user.clear(phone);
    await user.type(phone, '024 765 4321');
    expect(asked.queryByText(/doesn’t look like a Ghana number/)).toBeNull();
    expect(asked.getByText('As the recipient gave it, for example 024 123 4567.')).toBeVisible();
  });

  // Break caught: a refused phone, name or address told only as "Check the note marked below" with nothing marked, so the officer cannot tell what to change; the field not marked, or not given the focus.
  it('marks a refused phone on the phone and gives it the focus, as the API said it', async () => {
    const answer = capturedRefusal('correction-refused-phone');
    const { user, asked } = await openDialog({
      [CORRECT]: () => json(answer.status, answer.body),
    });
    const phone = asked.getByLabelText(/Recipient’s phone/);
    await user.clear(phone);
    await user.type(phone, 'not a number');
    await user.type(asked.getByLabelText(/Why are you correcting this\?/), 'A typo');
    await user.click(asked.getByRole('button', { name: 'Save the correction' }));
    expect(
      await asked.findByText('That doesn’t look like a phone number. Check the digits.'),
    ).toBeVisible();
    await waitFor(() => {
      expect(phone).toHaveFocus();
    });
    expect(phone).toHaveAttribute('aria-invalid', 'true');
    expect(asked.queryByText(/Check the note marked below/)).toBeNull();
    expect(sent(CORRECT)).toHaveLength(1);
  });

  it.each([['name', 'correction-refused-name', /Recipient’s name/, 'Enter the recipient’s name.']])(
    'marks a refused %s on its own field',
    async (_field, fixture, label, words) => {
      const answer = capturedRefusal(fixture);
      const { user, asked } = await openDialog({
        [CORRECT]: () => json(answer.status, answer.body),
      });
      const name = asked.getByLabelText(label);
      await user.clear(name);
      await user.type(name, 'Ama B');
      await user.type(asked.getByLabelText(/Why are you correcting this\?/), 'A typo');
      await user.click(asked.getByRole('button', { name: 'Save the correction' }));
      expect(await asked.findByText(words)).toBeVisible();
      await waitFor(() => {
        expect(name).toHaveAttribute('aria-invalid', 'true');
      });
    },
  );

  // Break caught: an address refused at the place named by the API marked on no field.
  it('marks a refused address on the address', async () => {
    const { user, asked } = await openDialog({
      [CORRECT]: () =>
        json(400, {
          code: 'VALIDATION_FAILED',
          message: 'The request is not valid',
          request_id: 'r-address',
          details: {
            violations: [{ in: 'body', pointer: '/recipient/location/address', rule: 'required' }],
          },
        }),
    });
    const address = asked.getByLabelText(/Delivery address/);
    await user.clear(address);
    await user.type(address, 'Behind the market');
    await user.type(asked.getByLabelText(/Why are you correcting this\?/), 'A typo');
    await user.click(asked.getByRole('button', { name: 'Save the correction' }));
    expect(await asked.findByText('Enter the delivery address.')).toBeVisible();
    await waitFor(() => {
      expect(address).toHaveAttribute('aria-invalid', 'true');
    });
  });

  // Break caught: a reason that holds a number refused by the audit's screen and told as "Check the note marked below" with no mark, or in words that name a note the officer never wrote; the reason not kept.
  it('says on the reason, in its own words, that a number must be left out, and keeps what was typed', async () => {
    const answer = capturedRefusal('correction-refused-note-number');
    const { user, asked } = await openDialog({
      [CORRECT]: () => json(answer.status, answer.body),
    });
    const name = asked.getByLabelText(/Recipient’s name/);
    await user.clear(name);
    await user.type(name, 'Ama B');
    const reason = asked.getByLabelText(/Why are you correcting this\?/);
    await user.type(reason, 'The vendor said call 0244123456');
    await user.click(asked.getByRole('button', { name: 'Save the correction' }));
    expect(await asked.findByText('Leave the number out of the reason.')).toBeVisible();
    await waitFor(() => {
      expect(reason).toHaveFocus();
    });
    expect(reason).toHaveValue('The vendor said call 0244123456');
    expect(asked.queryByText(/Check the note marked below/)).toBeNull();
  });

  // Break caught: a form that starts empty (the officer retypes what was right), a correction with no reason, or one that changes nothing (a wasted trip, told by the server).
  it('starts from what the order holds, asks for the reason, and says nothing was changed before it sends anything', async () => {
    const { user, asked } = await openDialog();
    expect(asked.getByLabelText(/Recipient’s name/)).toHaveValue(held().name);
    expect(asked.getByLabelText(/Delivery address/)).not.toHaveValue('');
    await user.click(asked.getByRole('button', { name: 'Save the correction' }));
    expect(await asked.findByText('Write why you are correcting this.')).toBeVisible();

    await user.type(asked.getByLabelText(/Why are you correcting this\?/), 'Checking');
    await user.click(asked.getByRole('button', { name: 'Save the correction' }));
    expect(
      await asked.findByText('Nothing was changed. Correct a detail, or cancel.'),
    ).toBeVisible();
    expect(sent(CORRECT)).toHaveLength(0);
  });

  // Break caught: the whole recipient sent for a one-field correction (a member the officer did not touch would be overwritten), a correction not on the version read or with no key, or an order that is not read again.
  it('sends only what was corrected, with the reason, on the version read, and says what it did', async () => {
    let reads = 0;
    const { user, asked } = await openDialog({
      [CORRECT]: () => json(200, orderOf('frozen'), { ETag: '"o2"' }),
      [READ(ORDER_ID)]: () => {
        reads += 1;
        return json(200, orderOf('frozen'), { ETag: reads === 1 ? '"o1"' : '"o2"' });
      },
    });
    const phone = asked.getByLabelText(/Recipient’s phone/);
    await user.clear(phone);
    await user.type(phone, '024 765 4321');
    await user.type(
      asked.getByLabelText(/Why are you correcting this\?/),
      'The phone had a digit wrong',
    );
    await user.click(asked.getByRole('button', { name: 'Save the correction' }));

    expect(
      await screen.findByText(`The recipient of order ${ORDER_CODE} was corrected.`),
    ).toBeVisible();
    const request = sent(CORRECT)[0];
    expect(request?.headers.get('If-Match')).toBe('"o1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await bodyOf(request)).toEqual({
      note: 'The phone had a digit wrong',
      recipient: { phone: '024 765 4321' },
    });
    // The order is read again, as it now stands.
    await waitFor(() => {
      expect(reads).toBe(2);
    });
  });

  // Break caught: the place sent as anything but its text and its landmark together (the contract takes nothing else, and a landmark left out is a landmark removed).
  it('sends the place as its text and its landmark together when either was corrected', async () => {
    const { user, asked } = await openDialog({
      [CORRECT]: () => json(200, orderOf('frozen'), { ETag: '"o2"' }),
    });
    const address = asked.getByLabelText(/Delivery address/);
    await user.clear(address);
    await user.type(address, '14 Madina Estate, opposite the pharmacy');
    const landmark = asked.getByLabelText(/Landmark/);
    await user.clear(landmark);
    await user.type(landmark, 'By the pharmacy');
    await user.type(
      asked.getByLabelText(/Why are you correcting this\?/),
      'The address was mistyped',
    );
    await user.click(asked.getByRole('button', { name: 'Save the correction' }));
    await screen.findByText(`The recipient of order ${ORDER_CODE} was corrected.`);
    expect(await bodyOf(sent(CORRECT)[0])).toEqual({
      note: 'The address was mistyped',
      recipient: {
        location: {
          address: '14 Madina Estate, opposite the pharmacy',
          landmark: 'By the pharmacy',
        },
      },
    });
  });

  // Break caught: the refusal of an address that would move the zone and the price told as "something went wrong" or as a success, or the dialog lost: the officer is told in words that nothing was changed.
  it('says an address in another zone cannot be corrected here, and nothing changes', async () => {
    const { user, asked } = await openDialog({
      [CORRECT]: () => refused('address_changes_zone'),
    });
    const address = asked.getByLabelText(/Delivery address/);
    await user.clear(address);
    await user.type(address, 'Tema Community 1');
    await user.type(asked.getByLabelText(/Why are you correcting this\?/), 'Wrong town');
    await user.click(asked.getByRole('button', { name: 'Save the correction' }));

    expect(
      await asked.findByText(/That address is in another zone, so it would change the price\./),
    ).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    expect(screen.queryByText(/was corrected\./)).toBeNull();
    expect(sent(CORRECT)).toHaveLength(1);
  });

  // Break caught: an order that changed under the officer (someone else corrected it) overwritten, or told as a failure that says nothing of what to do.
  it('tells an order that changed, in the dialog and on the page, and sends nothing again', async () => {
    const { user, asked } = await openDialog({ [CORRECT]: () => refused('stale') });
    const phone = asked.getByLabelText(/Recipient’s phone/);
    await user.clear(phone);
    await user.type(phone, '024 765 4321');
    await user.type(asked.getByLabelText(/Why are you correcting this\?/), 'A digit');
    await user.click(asked.getByRole('button', { name: 'Save the correction' }));

    expect(
      await asked.findByText(/This order changed after you opened it, so nothing was changed\./),
    ).toBeVisible();
    expect(
      screen.getByText('This order changed after you opened it. Reload to see it as it is now.'),
    ).toBeVisible();
    expect(sent(CORRECT)).toHaveLength(1);
  });
});

describe('an order that waits for its parcel', () => {
  // Break caught: a quote drawn as a fixed price, or an order that waits drawn as one that cannot be changed.
  it('shows the price as calculated, not fixed, and offers the change', async () => {
    open(orderOf('early'), OFFICER, {}, EARLY_ORDER_ID);
    expect(
      await screen.findByText(/Made before the parcel was checked in for good\./),
    ).toBeVisible();
    const price = within(screen.getByRole('region', { name: 'The price' }));
    expect(price.getByText('Calculated price (not fixed)').nextElementSibling).toHaveTextContent(
      'GH₵35.00',
    );
    expect(price.queryByText('Fixed price')).toBeNull();
    expect(screen.getByRole('link', { name: 'Change this order' })).toHaveAttribute(
      'href',
      `/orders/${EARLY_ORDER_ID}/amend`,
    );
    // Who pays is worked out when the order is confirmed.
    expect(screen.getByText('Worked out when the order is confirmed.')).toBeVisible();
  });

  it('does not offer the change to a session that may not make orders', async () => {
    open(orderOf('early'), ['hub.read', 'pricing.read'], {}, EARLY_ORDER_ID);
    await screen.findByText(/Made before the parcel was checked in for good\./);
    expect(screen.queryByRole('link', { name: 'Change this order' })).toBeNull();
  });
});

describe('an order the change page has just saved', () => {
  // Break caught: a change saved with no word of it where the officer lands, or a word that is said again on every return to the page.
  it('says the order was changed, where the officer lands, and takes the word off the history', async () => {
    const { router } = open(orderOf('early'), OFFICER, {}, EARLY_ORDER_ID, {
      amended: 'ACC-OR-UA7K72',
    });
    expect(await screen.findByText('Order ACC-OR-UA7K72 was changed.')).toBeVisible();
    await waitFor(() => {
      expect(router.state.location.state).toBeNull();
    });
    // The word is read once: it is on the screen still, and the history no longer holds it.
    expect(screen.getByText('Order ACC-OR-UA7K72 was changed.')).toBeVisible();
  });

  // Break caught: a history state drawn as it is (it is the browser's, and holds whatever put it there).
  it('draws nothing from a history state that is not a code', async () => {
    open(orderOf('early'), OFFICER, {}, EARLY_ORDER_ID, {
      amended: '<b>Order made</b> by someone else',
    });
    expect(await screen.findByRole('heading', { level: 1, name: /ACC-OR-/ })).toBeVisible();
    expect(screen.queryByText(/was changed\./)).toBeNull();
    expect(document.body.textContent).not.toContain('someone else');
  });
});

describe('what happened to an order', () => {
  // Break caught: the values of a change drawn (they hold a person's details), or a history that loses who changed what and why.
  it('says what changed and why, and never the values', async () => {
    open(
      orderOf('early', {
        amendments: [
          {
            id: 'a1111111-2222-4333-8444-555555555555',
            amended_by: 'b1111111-2222-4333-8444-555555555555',
            amended_at: '2026-11-22T09:15:00.000Z',
            note: 'The recipient moved',
            changed: ['recipient', 'size_class'],
          },
        ],
      }),
      OFFICER,
      {},
      EARLY_ORDER_ID,
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'What happened' })).toBeVisible();
    const history = within(screen.getByRole('list', { name: 'What happened of the record' }));
    expect(history.getByText('Changed: the recipient and the size.')).toBeVisible();
    expect(history.getByText(/Reason: The recipient moved/)).toBeVisible();
    expect(history.getByText(/09:15/)).toBeVisible();
  });
});

describe('the parcel’s photo on the order’s page (Run G1, Part 2, item 6; D-S7-14)', () => {
  const WITH_PHOTO = captured('order-with-photo') as {
    id: string;
    intake_parcel_photo_evidence_id: string;
  };
  const AUTHORIZE = `POST /evidence/${WITH_PHOTO.intake_parcel_photo_evidence_id}/retrieval-authorization`;
  const photo: Record<string, Handler> = {
    [AUTHORIZE]: () =>
      json(200, {
        method: 'GET',
        url: 'https://photos.example.test/parcel.jpg',
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
  };

  // Break caught: an order that shows nothing of the parcel it was made for, so that an officer cannot check the order against the parcel; a photo that cannot be opened whole; one opened with no way to close it
  // and get back to the order.
  it('shows the parcel’s photo as a tile that opens it whole, and gives the officer back the order when it is closed', async () => {
    const { user } = open(WITH_PHOTO, OFFICER, photo, WITH_PHOTO.id);
    expect(await screen.findByRole('heading', { level: 1, name: /ACC-OR-/ })).toBeVisible();
    const tile = await screen.findByRole('button', { name: 'Photo of the parcel' });
    await user.click(tile);
    const viewer = await screen.findByRole('dialog', { name: 'Photo of the parcel' });
    expect(await within(viewer).findByRole('img', { name: 'Photo of the parcel' })).toHaveAttribute(
      'src',
      'https://photos.example.test/parcel.jpg',
    );
    await user.click(within(viewer).getByRole('button', { name: /^Close/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Photo of the parcel' })).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Photo of the parcel' })).toHaveFocus();
    // The identifier of the evidence is never drawn.
    expect(document.body.textContent).not.toContain(WITH_PHOTO.intake_parcel_photo_evidence_id);
  });

  // Break caught: the photo asked for before anybody wants it (a tile far from the screen), or not asked for when the officer opens it: the photo is read when it is wanted, and the viewer is what wants it.
  it('asks for nothing while the tile is far from the screen, and for the photo when it is opened', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
        takeRecords = vi.fn(() => []);
      },
    );
    try {
      const { user } = open(WITH_PHOTO, OFFICER, photo, WITH_PHOTO.id);
      const tile = await screen.findByRole('button', { name: 'Photo of the parcel' });
      expect(sent(AUTHORIZE)).toHaveLength(0);
      await user.click(tile);
      const viewer = await screen.findByRole('dialog', { name: 'Photo of the parcel' });
      expect(await within(viewer).findByRole('img', { name: 'Photo of the parcel' })).toBeVisible();
      expect(sent(AUTHORIZE).length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Break caught: a photo tile drawn for a vendor counted without photos (the order has none).
  it('draws no photo for an order that has none', async () => {
    open({ ...WITH_PHOTO, intake_parcel_photo_evidence_id: null }, OFFICER, photo, WITH_PHOTO.id);
    await screen.findByRole('heading', { level: 1, name: /ACC-OR-/ });
    expect(screen.queryByRole('button', { name: 'Photo of the parcel' })).toBeNull();
  });

  // Break caught: a photo tile drawn for an officer who may not read the photo (the tile would be a refusal).
  it('draws no photo for an officer who may not read photos', async () => {
    open(
      WITH_PHOTO,
      OFFICER.filter((key) => key !== 'hub.read'),
      photo,
      WITH_PHOTO.id,
    );
    await screen.findByRole('heading', { level: 1, name: /ACC-OR-/ });
    expect(screen.queryByRole('button', { name: 'Photo of the parcel' })).toBeNull();
    expect(sent(AUTHORIZE)).toHaveLength(0);
  });
});

describeInterfaceStates('the record of an order', {
  loading: {
    test: async () => {
      open(null, OFFICER, { [READ(ORDER_ID)]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Loading the order…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A record is never empty: an order that does not exist is the not-found page, which is tested below.',
  },
  'validation error': {
    test: async () => {
      const { user } = open(orderOf('frozen'));
      await user.click(await screen.findByRole('button', { name: 'Change who pays' }));
      await user.click(within(await dialog()).getByRole('button', { name: 'Ask for the change' }));
      expect(await within(await dialog()).findByText('Choose who pays.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open(null, OFFICER, { [READ(ORDER_ID)]: () => refusal(500, 'INTERNAL_ERROR') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('This order could not be loaded.');
      });
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(null, OFFICER, {
        [READ(ORDER_ID)]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, orderOf('frozen'), { ETag: '"o1"' });
        },
      });
      await user.click(await screen.findByRole('button', { name: /Try again|Retry/ }));
      expect(await screen.findByRole('heading', { level: 1, name: ORDER_CODE })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open(orderOf('frozen'), SENIOR, {
        [`POST /orders/${ORDER_ID}/arrival-reversal`]: () =>
          refusal(409, 'STATE_CONFLICT', { rule: 'stale' }),
      });
      await user.click(await screen.findByRole('button', { name: 'Take back the arrival' }));
      const asked = within(await dialog());
      await user.type(
        asked.getByLabelText(/Why is the arrival being taken back\?/),
        'Not on the table',
      );
      await user.click(asked.getByRole('button', { name: 'Take back the arrival' }));
      expect(
        await asked.findByText(/This order changed after you opened it, so nothing was changed\./),
      ).toBeVisible();
    },
  },
  success: {
    test: async () => {
      open(orderOf('frozen'));
      expect(await screen.findByRole('heading', { level: 1, name: ORDER_CODE })).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      // The route lets the session in (it holds the key the page asks for) and the API refuses the read: the refusal is told as what the account cannot do, in the table's words.
      open(null, OFFICER, { [READ(ORDER_ID)]: () => refusal(403, 'PERMISSION_DENIED') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Your account can’t see the price of an order.',
        );
      });
      expect(screen.queryByRole('heading', { level: 1, name: ORDER_CODE })).toBeNull();
    },
  },
});

describe('a session that may not read a price', () => {
  // Break caught: the order read for a session whose key does not open the page (the route is the screen's half; the server's refusal is the other).
  it('is stopped at the route, and the order is not read', async () => {
    open(orderOf('frozen'), ['hub.read']);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'You do not have access to this page' }),
    ).toBeVisible();
    expect(screen.getByText(/Your account can’t see the price of an order\./)).toBeVisible();
    expect(sent(READ(ORDER_ID))).toHaveLength(0);
  });
});

describe('an order that is not there', () => {
  it('is told as one, with no figure drawn', async () => {
    open(null, OFFICER, { [READ(ORDER_ID)]: () => refusal(404, 'NOT_FOUND') });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This order could not be found.' }),
    ).toBeVisible();
  });
});

describe('where the order page starts (Run F, Part 2, item 16)', () => {
  // Break caught: the breadcrumb of an order starting at Receiving (the check-in's page) when the officer came from Orders to make, the place the work starts.
  it('starts its breadcrumb at Orders to make', async () => {
    open(orderOf('frozen'));
    await screen.findByRole('heading', { level: 1, name: ORDER_CODE });
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(trail.getByRole('link', { name: 'Orders to make' })).toHaveAttribute(
      'href',
      '/orders-to-make',
    );
    expect(trail.queryByRole('link', { name: 'Receiving' })).toBeNull();
  });
});

describe('the order changed after it was opened (Run F, Part 2, item 4)', () => {
  // Break caught: every order page telling every officer that the order changed after they opened it, with a Reload, the moment it opens, when nothing has said so (the page passed its conflict to the template
  // whatever had happened).
  it('is not said when the order has just been read', async () => {
    open(orderOf('frozen'));
    expect(await screen.findByRole('heading', { level: 1, name: ORDER_CODE })).toBeVisible();
    expect(screen.queryByText(/changed after you opened it/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  // Break caught: a refusal as stale that the page behind the dialog never says, so that the officer who closes the dialog is left looking at an order that is not as it is now.
  it('is said once an act of the page is refused as stale', async () => {
    const { user } = open(orderOf('frozen'), SENIOR, {
      [`POST /orders/${ORDER_ID}/arrival-reversal`]: () =>
        refusal(409, 'STATE_CONFLICT', { rule: 'stale' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Take back the arrival' }));
    const asked = within(await dialog());
    await user.type(
      asked.getByLabelText(/Why is the arrival being taken back\?/),
      'Not on the table',
    );
    await user.click(asked.getByRole('button', { name: 'Take back the arrival' }));
    await asked.findByText(/This order changed after you opened it, so nothing was changed\./);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Reload to see it as it is now.');
    });
  });
});
