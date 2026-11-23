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
  EARLY_ORDER_ID,
  NEW_TOKEN,
  orderOf,
  ORDER_ID,
} from '../../../test-support/orders-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { PRICE_DEBOUNCE_MS, SAVE_GUARD_MS } from './use-order-flow';

/**
 * `/orders/{id}/amend` (`previewOrderAmendment` then `amendOrder`; S1.40; AC-SLICE-001-47 to 59): **an order is prepared before it is confirmed.** While its price is not fixed an officer corrects what was written
 * down wrongly, with a reason; the server works the price, the zone and the date out again **beside the form, by itself** (D-S7-2), the officer reads them beside what the order holds now, and **only what was
 * changed** is sent, on the version read and the price on the screen. Each break named below is one these tests catch.
 *
 * The price comes a moment after the last key by design (`PRICE_DEBOUNCE_MS`), so a test that waits for it waits for that moment and a little more: `PRICE_WAIT` is the debounce and two seconds, the one wait of these
 * tests that is longer than a `findBy`'s own.
 */
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const KEYS = ['hub.read', 'hub.intake.itemize', 'pricing.read'];
const READ = `GET /orders/${EARLY_ORDER_ID}`;
const PREVIEW = `POST /orders/${EARLY_ORDER_ID}/amendment-preview`;
const SAVE = `PATCH /orders/${EARLY_ORDER_ID}`;
const CODE = 'ACC-OR-UA7K72';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server|terms_token|token)\b/i;

const previewOf = (total = 3500, token?: string) => {
  const base = captured('amend-preview');
  const price = base.price as { components: unknown[] };
  return {
    ...base,
    ...(token === undefined ? {} : { terms_token: token }),
    price: {
      ...price,
      total: { amount_minor: total, currency: 'GHS' },
      components: [
        { kind: 'SERVICE_AREA_BASE_FEE', amount: { amount_minor: total, currency: 'GHS' } },
      ],
    },
  };
};
const SAVED = () => captured('amend-saved');

const PRICE_WAIT = { timeout: PRICE_DEBOUNCE_MS + 2000 };
/** The one save once its price is on the screen: *Save the change at GH₵35.00*. */
const pricedSave = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: /^Save the change at / }, PRICE_WAIT);
const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

let api: FakeApi;
afterEach(() => {
  vi.useRealTimers();
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handlers: Record<string, Handler> = {},
  keys: readonly string[] = KEYS,
  body: unknown = orderOf('early'),
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [READ]: () => json(200, body, { ETag: '"o1"' }),
      [PREVIEW]: () => json(200, previewOf()),
      ...handlers,
    }),
  );
  return renderApp(`/orders/${EARLY_ORDER_ID}/amend`);
}

const sent = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname.replace('/api/v1', '')}` === route,
  );
const bodyOf = async (request: Request | undefined): Promise<Record<string, unknown>> =>
  request === undefined ? {} : ((await request.clone().json()) as Record<string, unknown>);
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  const matches = (alert: HTMLElement) =>
    typeof text === 'string' ? alert.textContent.includes(text) : text.test(alert.textContent);
  await waitFor(() => {
    expect(screen.getAllByRole('alert').some(matches)).toBe(true);
  });
  const found = screen.getAllByRole('alert').find(matches);
  if (found === undefined) throw new Error('no alert');
  return found;
};

type User = ReturnType<typeof renderApp>['user'];

/** Changes the size to the one asked and gives the reason the amendment needs. */
async function changeSize(
  user: User,
  size = 'Medium',
  reason = 'The parcel is bigger than the photo showed',
): Promise<void> {
  await user.click(await screen.findByRole('radio', { name: size }));
  await user.type(screen.getByLabelText(/Why are you changing this order\?/), reason);
}

describe('the form of a change', () => {
  // Break caught: a form that starts empty (the officer retypes what was right), or one that shows the order's facts under other words.
  it('starts from what the order holds, so only what is wrong is touched', async () => {
    open();
    expect(
      await screen.findByRole('heading', { level: 1, name: `Change order ${CODE}` }),
    ).toBeVisible();
    expect(screen.getByLabelText(/Recipient’s name/)).toHaveValue('Ama Mensah');
    expect(screen.getByLabelText(/Delivery address/)).toHaveValue(
      '12 Madina Estate, near the market',
    );
    expect(screen.getByRole('radio', { name: 'Small' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'To the recipient’s door' })).toBeChecked();
    expect(screen.getByLabelText(/Why are you changing this order\?/)).toHaveValue('');
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  // Break caught: a change sent that changes nothing (the server would say the same, a wasted trip), or a form that goes on without saying so.
  it('says nothing was changed, before anything is sent', async () => {
    const { user } = open();
    await user.type(
      await screen.findByLabelText(/Why are you changing this order\?/),
      'Just checking',
    );
    await user.click(screen.getByRole('button', { name: 'Save the change' }));
    expect(await alertSaying('Nothing was changed. Change something, or go back.')).toBeVisible();
    // Nothing was changed, so there is no price to ask for and nothing is sent.
    expect(sent(PREVIEW)).toHaveLength(0);
    expect(sent(SAVE)).toHaveLength(0);
  });

  // Break caught: an amendment with no reason, which the history would then hold as an unexplained change. The reason is the save's: the price is asked for without it and the save is what asks for it.
  it('asks for the reason, on the field, at the save, and does not go on without one', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('radio', { name: 'Medium' }));
    await user.click(await pricedSave());
    expect(await screen.findByText('Write why you are changing this order.')).toBeVisible();
    expect(screen.getByLabelText(/Why are you changing this order\?/)).toBeInvalid();
    expect(sent(SAVE)).toHaveLength(0);
    expect(await bodyOf(sent(PREVIEW)[0])).toEqual({ size_class: 'MEDIUM' });
  });
});

describe('changing an order, and checking the price first', () => {
  // Break caught: the whole order sent for a one-field change (a member the officer did not touch would be overwritten), a save that is not on the digest of the terms read, no key or no version, a price of the page's own.
  it('sends only what was changed, shows the price beside the one it holds now, and saves on those terms', async () => {
    const { user } = open({
      [SAVE]: () => json(200, SAVED(), { ETag: '"o2"' }),
    });
    await changeSize(user);

    // The price comes by itself, beside the one the order holds now, with nothing pressed, and nothing is saved by looking at it.
    const before = within(await screen.findByRole('region', { name: 'The order now' }, PRICE_WAIT));
    expect(before.getByText('Price it holds now').nextElementSibling).toHaveTextContent('GH₵35.00');
    expect(sent(SAVE)).toHaveLength(0);

    const previewBody = await bodyOf(sent(PREVIEW)[0]);
    expect(previewBody).toEqual({ size_class: 'MEDIUM' });

    await user.click(await pricedSave());
    // The officer lands on the order, told it was changed.
    expect(await screen.findByText(`Order ${CODE} was changed.`)).toBeVisible();
    expect(await screen.findByRole('heading', { level: 1, name: CODE })).toBeVisible();

    const request = sent(SAVE)[0];
    expect(request?.headers.get('If-Match')).toBe('"o1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    const body = await bodyOf(request);
    expect(body).toEqual({
      size_class: 'MEDIUM',
      note: 'The parcel is bigger than the photo showed',
      reviewed_terms: (captured('amend-preview') as { terms_token: string }).terms_token,
    });
    for (const never of ['price', 'total', 'recipient', 'lane', 'zone', 'locked_price']) {
      expect(body).not.toHaveProperty(never);
    }
  });

  // Break caught: a recipient sent as separate members (the contract takes it whole), or a phone sent as it was read and not as typed.
  it('sends the recipient whole when any part of it was changed', async () => {
    const { user } = open({ [SAVE]: () => json(200, SAVED(), { ETag: '"o2"' }) });
    const address = await screen.findByLabelText(/Delivery address/);
    await user.clear(address);
    await user.type(address, '14 Madina Estate, opposite the pharmacy');
    await user.type(
      screen.getByLabelText(/Why are you changing this order\?/),
      'The address was wrong',
    );
    // The button that says the price appears once the answer is for what is entered: the last request is the one for the whole address.
    await pricedSave();
    const previewBody = await bodyOf(sent(PREVIEW).at(-1));
    expect(Object.keys(previewBody)).toEqual(['recipient']);
    expect(previewBody.recipient).toMatchObject({
      name: 'Ama Mensah',
      location: { address: '14 Madina Estate, opposite the pharmacy' },
    });
  });
});

describe('a price that changes while the officer looks', () => {
  /** The save answers that the price moved on the first press, and saves on the second. */
  const movesThenSaves = (): Handler => {
    let saves = 0;
    return () => {
      saves += 1;
      return saves === 1
        ? json(409, {
            code: 'STATE_CONFLICT',
            message: 'Diagnostic text that must never reach a screen.',
            request_id: 'r1',
            details: { rule: 'terms_changed', current_terms: previewOf(4000, NEW_TOKEN) },
          })
        : json(200, SAVED(), { ETag: '"o2"' });
    };
  };

  // Break caught: a change saved on a price the officer did not read; the earlier figure lost; entries lost; the new figure drawn where the focus is not, so that it is pressed unread.
  it('shows the new price beside the old with the focus on it, offers the save again at the new figure, and keeps what was entered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { user } = open({ [SAVE]: movesThenSaves() });
    await changeSize(user);
    await user.click(await pricedSave());

    const warning = await alertSaying('The terms changed while you were looking');
    expect(warning.textContent).toContain('Price: GH₵35.00 before, GH₵40.00 now.');
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    // The new figure is beside the form, the old one with it, and the focus is on them: they are read before the save that says the new figure is pressed.
    const price = screen.getByRole('region', { name: 'The price' });
    expect(price).toContainElement(warning);
    expect(price).toContainElement(document.activeElement as HTMLElement);
    // What was entered is kept.
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked();
    expect(screen.getByLabelText(/Why are you changing this order\?/)).toHaveValue(
      'The parcel is bigger than the photo showed',
    );

    vi.setSystemTime(Date.now() + SAVE_GUARD_MS + 1);
    await user.click(screen.getByRole('button', { name: 'Save at GH₵40.00' }));

    expect(await screen.findByText(`Order ${CODE} was changed.`)).toBeVisible();
    expect(await bodyOf(sent(SAVE)[1])).toMatchObject({
      reviewed_terms: NEW_TOKEN,
      size_class: 'MEDIUM',
    });
    // The price was asked for once: the new one came with the refusal.
    expect(sent(PREVIEW)).toHaveLength(1);
  });

  // Break caught (D-S7-2): the save at the new figure pressed by the second tap of a double-tap meant for the first button, which would save a price nobody read.
  it('ignores a press in the moment after the price changed, and saves when it is pressed again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { user } = open({ [SAVE]: movesThenSaves() });
    await changeSize(user);
    await user.click(await pricedSave());
    const again = await screen.findByRole('button', { name: 'Save at GH₵40.00' });

    // The second tap of the same finger, at once: nothing is sent, and the button is still there for a press that is meant.
    await user.click(again);
    await pause(100);
    expect(sent(SAVE)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save at GH₵40.00' })).toBeVisible();

    vi.setSystemTime(Date.now() + SAVE_GUARD_MS + 1);
    await user.click(screen.getByRole('button', { name: 'Save at GH₵40.00' }));
    expect(await screen.findByText(`Order ${CODE} was changed.`)).toBeVisible();
    expect(sent(SAVE)).toHaveLength(2);
  });

  // Break caught: an order that changed under the officer (someone else confirmed it) overwritten, or shown as a failure that loses the form.
  it('tells an order that changed, reads it again for its version, and checks the price again', async () => {
    let saves = 0;
    let reads = 0;
    let release: (() => void) | undefined;
    const { user } = open({
      [READ]: () => {
        reads += 1;
        return reads === 1
          ? json(200, orderOf('early'), { ETag: '"o1"' })
          : new Promise<Response>((resolve) => {
              release = () => {
                resolve(json(200, orderOf('early'), { ETag: '"o3"' }));
              };
            });
      },
      [SAVE]: () => {
        saves += 1;
        return saves === 1
          ? json(409, {
              code: 'STATE_CONFLICT',
              message: 'Diagnostic text that must never reach a screen.',
              request_id: 'r2',
              details: { rule: 'stale' },
            })
          : json(200, SAVED(), { ETag: '"o4"' });
      },
    });
    await changeSize(user);
    await user.click(await pricedSave());
    await alertSaying('changed while you were working');
    await user.click(screen.getByRole('button', { name: 'Check the price again' }));
    // The price that proved wrong is off the screen while the order is read again: the save says so and cannot be pressed, so nothing is saved on the old version.
    expect(await screen.findByRole('button', { name: 'Checking the price…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Save the change at / })).toBeNull();
    await waitFor(() => {
      expect(release).toBeDefined();
    });
    release?.();

    await user.click(await pricedSave());
    expect(await screen.findByText(`Order ${CODE} was changed.`)).toBeVisible();
    expect(sent(SAVE)[1]?.headers.get('If-Match')).toBe('"o3"');
    // The price was asked for again, of the same entries.
    expect(sent(PREVIEW)).toHaveLength(2);
  });
});

describe('an order that cannot be changed here', () => {
  // Break caught: a form drawn for an order whose price is fixed (the officer would type a reason and be refused at the end).
  it('is told, before any form, when its price is fixed, and is sent to the order and to the correction', async () => {
    open({}, KEYS, { ...orderOf('frozen'), id: EARLY_ORDER_ID });
    expect(
      await screen.findByText(
        'This order is confirmed, so it cannot be changed here. To change who pays, ask for a correction.',
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText(/Recipient’s name/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the orders' })).toHaveAttribute(
      'href',
      `/orders/${EARLY_ORDER_ID}`,
    );
    expect(sent(PREVIEW)).toHaveLength(0);
  });

  it('is told, before any form, when its arrival was taken back', async () => {
    open({}, KEYS, { ...orderOf('reversed'), id: EARLY_ORDER_ID });
    expect(
      await screen.findByText('This order was taken back, so it cannot be changed.'),
    ).toBeVisible();
    expect(screen.queryByLabelText(/Recipient’s name/)).toBeNull();
  });
});

describe('an order that is not there', () => {
  it('is told as one', async () => {
    open({ [READ]: () => refusal(404, 'NOT_FOUND') });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not be found|not found|does not exist/i,
    );
  });

  it('is told as one when the address is not an order’s, and nothing is read', async () => {
    api = installFakeApi(staffApi(sessionWith(KEYS, { authorized_hubs: [ACCRA] }), {}));
    renderApp('/orders/not-an-id/amend');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This order could not be found.' }),
    ).toBeVisible();
    expect(api.requests.some((request) => new URL(request.url).pathname.includes('/orders/'))).toBe(
      false,
    );
  });
});

describeInterfaceStates('the form of a change', {
  loading: {
    test: async () => {
      open({ [READ]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Loading the order…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A form has no list that can be empty: an order that cannot be changed is told in words (the tests above).',
  },
  'validation error': {
    test: async () => {
      const { user } = open();
      await user.click(await screen.findByRole('radio', { name: 'Medium' }));
      await user.click(await pricedSave());
      expect(await screen.findByText('Write why you are changing this order.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open({ [READ]: () => refusal(500, 'INTERNAL_ERROR') });
      expect(await screen.findByRole('alert')).toBeVisible();
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open({
        [READ]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, orderOf('early'), { ETag: '"o1"' });
        },
      });
      await user.click(await screen.findByRole('button', { name: /Try again|Retry/ }));
      expect(await screen.findByLabelText(/Recipient’s name/)).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open({
        [SAVE]: () =>
          json(409, {
            code: 'STATE_CONFLICT',
            message: 'x',
            request_id: 'r5',
            details: { rule: 'stale' },
          }),
      });
      await changeSize(user);
      await user.click(await pricedSave());
      await alertSaying('changed while you were working');
    },
  },
  success: {
    test: async () => {
      const { user } = open({ [SAVE]: () => json(200, SAVED(), { ETag: '"o2"' }) });
      await changeSize(user);
      await user.click(await pricedSave());
      expect(await screen.findByText(`Order ${CODE} was changed.`)).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      // The route lets a session that makes orders in; reading the price is another key, and the API refuses the read.
      open({ [READ]: () => refusal(403, 'PERMISSION_DENIED') }, ['hub.read', 'hub.intake.itemize']);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Your account can’t see the price of an order.',
        );
      });
    },
  },
});

// The captured answers are what the tests above are made of: a test that reaches for one that is not there fails here and not in a page.
describe('the captured answers', () => {
  it('are the API’s: the order amended is the early order the form reads', () => {
    expect(SAVED()).toMatchObject({ id: EARLY_ORDER_ID, code: CODE });
    expect(EARLY_ORDER_ID).not.toBe(ORDER_ID);
  });
});
