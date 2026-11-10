import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { byHand } from '../../../test-support/by-hand';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  feedFixture,
  HINT,
  NOTIFICATION_HUB_ID,
  NOTIFICATION_REQUEST_ID,
  NOTIFICATION_RUN_ID,
  notificationFixture,
  OTHER_REQUEST_ID,
  PLANTED_CODE,
  PLANTED_NUMBER,
  PLANTED_TEXT,
  plantedIn,
  runTextFixture,
  suppressedFixture,
} from '../../../test-support/notification-fixture';
import { narrowRoom, restoreRoom } from '../../../test-support/narrow-room';
import { pagerRegion } from '../../../test-support/queue-pager';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { cannotText } from '../../../platform/problem/capability-words';

/**
 * `/messages` (`listNotifications`; S1.12e). The message log: every message the platform raised about an act, newest first, and what became of
 * it; filtered by status, audience and channel in the address; narrowed to one request from its page; the Ops feed as a view of its own; an empty
 * log told apart from a filter that hides everything. **No number in clear, no text and no code is ever drawn or asked for**: the fixtures plant
 * some in fields the contract does not name, and the page is searched for them.
 */
const LIST = 'GET /notifications';
const READER = ['notification.read'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;

const confirmed = notificationFixture({ created_at: '2026-10-29T08:15:00.000Z' });
const inFeed = feedFixture({ created_at: '2026-10-29T08:14:00.000Z' });

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

/** A server that filters as the contract says: by status, audience, channel and the record, and answers the messages that fit. */
const serverOf =
  (entries: readonly ReturnType<typeof notificationFixture>[]): Handler =>
  (request) => {
    const query = new URL(request.url).searchParams;
    const wanted = (name: string, actual: string): boolean =>
      query.get(name) === null || query.get(name) === actual;
    return page(
      entries.filter(
        (entry) =>
          wanted('state', entry.state) &&
          wanted('audience', entry.audience) &&
          wanted('channel', entry.channel) &&
          wanted('subject_id', entry.subject.id),
      ),
    );
  };

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  restoreRoom();
});

function open(
  handler: Handler = serverOf([confirmed, inFeed]),
  keys: readonly string[] = READER,
  path = '/messages',
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: NOTIFICATION_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: handler },
    ),
  );
  return renderApp(path);
}

const listRequests = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/notifications');
const queryOf = (index = -1) => new URL(listRequests().at(index)?.url ?? 'http://x/').searchParams;
const searchOf = (router: { state: { location: { search: string } } }) =>
  new URLSearchParams(router.state.location.search);

/** The row whose time is this (its row header). */
async function rowAt(time: string): Promise<HTMLElement> {
  const row = (await screen.findByRole('rowheader', { name: time })).closest('tr');
  if (row === null) throw new Error('no row');
  return row;
}

/** One message in a log of its own, and its row. */
async function rowOf(entry: unknown, time = '29 Oct, 08:15'): Promise<HTMLElement> {
  open(() => page([entry]));
  return rowAt(time);
}

/** The log has been read and drawn, whatever it holds. */
const settled = (): Promise<void> =>
  waitFor(() => {
    expect(screen.queryByText('Loading messages')).toBeNull();
  });

/** The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited. */
const logTable = async (): Promise<HTMLElement> => {
  const table = await screen.findByRole('table', { name: /^Messages$/ });
  await waitFor(() => {
    expect(table).not.toHaveAttribute('aria-busy', 'true');
  });
  return table;
};
/** The table's region of failures is in the page before it has anything to say, so it is the words that are awaited, and not the region. */
const alertSaying = async (text: string): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
const viewTab = (name: string) => screen.getByRole('tab', { name });
const removeChip = (label: string) =>
  screen.getByRole('button', { name: `Remove filter: ${label}` });
/** The status, the audience and the channel are chosen in the popover of the filter row, which opens with the Filter button. */
async function openFilters(view: ReturnType<typeof open>): Promise<void> {
  await view.user.click(screen.getByRole('button', { name: 'Filter' }));
  await screen.findByRole('combobox', { name: 'Status' });
}
/** The messages the table draws: a message's row header is its time. The table's own message (nothing yet, a failure) sits in a cell and is not one. */
const messageRows = () => screen.queryAllByRole('rowheader');

describe('the log: what it shows', () => {
  it('shows each message by when, what, to whom and over what, its status with what became of it, and its number', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Messages' })).toBeVisible();
    expect(document.title).toBe('Messages · Melarc Ops Portal');
    const text = await rowAt('29 Oct, 08:15');
    expect(within(text).getByText('Pickup request confirmed')).toBeVisible();
    expect(within(text).getByText('Wording version 1')).toBeVisible();
    expect(within(text).getByText('Ad-hoc sender')).toBeVisible();
    expect(within(text).getByText('Text message')).toBeVisible();
    expect(within(text).getByText('Delivered')).toBeVisible();
    expect(within(text).getByText('The provider accepted it')).toBeVisible();
    expect(within(text).getByText(HINT)).toBeVisible();
    // One try says nothing of tries: "N tries" is for a message that was tried more than once (below).
    expect(within(text).queryByText(/tries/)).toBeNull();
    const feed = await rowAt('29 Oct, 08:14');
    expect(within(feed).getByText('Vendor’s feed')).toBeVisible();
    expect(within(feed).getByText('In-app feed')).toBeVisible();
    // A feed entry is written and not sent: it is "in the feed", not "delivered".
    expect(within(feed).getByText('In the feed')).toBeVisible();
    expect(within(feed).queryByText('Delivered')).toBeNull();
    expect(within(feed).queryByText(/tries/)).toBeNull();
  });

  it('names each column for what it holds, and the table for the log', async () => {
    open();

    const table = await logTable();

    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['When', 'Message', 'To', 'Status', 'Number', 'Record']);
  });

  // Break caught (owner item a of the Product Owner, 9 November 2026): nine columns that do not fit at 1280 px with the menu open. The nine facts are in six, none dropped: the message over
  // the version of its wording, the audience over the channel, the status over what became of it, the provider's word and the number of tries when more than one.
  it('composes the nine facts into six columns, each lesser fact muted under the one it belongs to', async () => {
    open(() =>
      page([
        notificationFixture({
          state: 'FAILED',
          outcome_class: 'REJECTED',
          provider_outcome_class: 'REQUEST_INVALID',
          attempt_count: 3,
        }),
      ]),
    );
    await logTable();

    const cells = within(messageRows()[0]?.closest('tr') ?? document.body).getAllByRole('cell');
    expect(cells).toHaveLength(5);
    const [message, to, status, number, record] = cells;
    expect(message).toHaveTextContent(/^Pickup request confirmedWording version 1$/);
    expect(within(message ?? document.body).getByText('Wording version 1')).toHaveClass(
      'messages-support',
    );
    expect(to).toHaveTextContent(/^Ad-hoc senderText message$/);
    expect(within(to ?? document.body).getByText('Text message')).toHaveClass('messages-support');
    expect(within(status ?? document.body).getByText('Failed')).toBeVisible();
    expect(status).toHaveTextContent(
      /The provider refused itProvider’s word: REQUEST_INVALID3 tries$/,
    );
    expect(within(status ?? document.body).getByText('3 tries')).toHaveClass('messages-support');
    expect(number).toHaveTextContent(HINT);
    expect(
      within(record ?? document.body).getByRole('link', { name: 'Pickup request' }),
    ).toBeVisible();
  });

  // Break caught (the Product Owner, 9 November 2026): the order told as "as the server lists them", which is not what a person asks: it is newest first, and that is all it says.
  it('says the order in plain words: newest first', async () => {
    open();
    await logTable();

    expect(screen.getByText('Newest first')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/as the server lists/);
  });

  it('keeps the server’s order: newest first', async () => {
    open(() =>
      page([
        notificationFixture({ created_at: '2026-10-29T09:00:00.000Z' }),
        notificationFixture({ created_at: '2026-10-29T08:00:00.000Z' }),
      ]),
    );

    await logTable();

    expect(screen.getAllByRole('rowheader').map((header) => header.textContent)).toEqual([
      '29 Oct, 09:00',
      '29 Oct, 08:00',
    ]);
  });

  it('draws a message as a card with the same facts, in a room too narrow for the columns', async () => {
    narrowRoom();
    open(() => page([confirmed, inFeed]));

    const cards = within(await screen.findByRole('list', { name: 'Messages' })).getAllByRole(
      'listitem',
    );
    expect(cards).toHaveLength(2);
    const text = cards[0] ?? document.body;
    const feed = cards[1] ?? document.body;
    expect(
      within(text).getByRole('heading', { level: 2, name: 'Pickup request confirmed' }),
    ).toBeVisible();
    expect(within(text).getByText('29 Oct, 08:15')).toBeVisible();
    expect(within(text).getByText('Wording version 1')).toBeVisible();
    expect(within(text).getByText('Ad-hoc sender')).toBeVisible();
    expect(within(text).getByText('Text message')).toBeVisible();
    expect(within(text).getByText('Delivered')).toBeVisible();
    expect(within(text).getByText('The provider accepted it')).toBeVisible();
    expect(within(text).getByText(HINT)).toBeVisible();
    expect(within(text).getByRole('link', { name: 'Pickup request' })).toHaveAttribute(
      'href',
      `/pickup-requests/${NOTIFICATION_REQUEST_ID}`,
    );
    // A feed entry has no number and nothing to report of a sending: two dashes, each with what it stands for.
    expect(within(feed).getAllByText('—')).toHaveLength(2);
    expect(within(feed).getByText('No number')).toBeInTheDocument();
    expect(within(feed).getByText('Nothing to report')).toBeInTheDocument();
  });

  describe('a message in each state', () => {
    // The words of the brief, written out here and not read from the screen's own table.
    it.each([
      ['QUEUED', { outcome_class: null, attempt_count: 0 }, 'Waiting to be sent'],
      ['LEASED', { outcome_class: null, attempt_count: 1 }, 'Being sent'],
      ['RETRYABLE', { outcome_class: 'UNKNOWN', attempt_count: 2 }, 'Will try again'],
      ['SENT', { outcome_class: 'ACCEPTED', attempt_count: 1 }, 'Sent, waiting for the network'],
      ['DELIVERED', { outcome_class: 'ACCEPTED', attempt_count: 1 }, 'Delivered'],
      ['FAILED', { outcome_class: 'REJECTED', attempt_count: 1 }, 'Failed'],
      ['EXPIRED', { outcome_class: 'EXPIRED', attempt_count: 0 }, 'Too late to send'],
    ] as const)('tells %s in words', async (state, change, words) => {
      const row = await rowOf(notificationFixture({ state, ...change }));

      expect(within(row).getByText(words)).toBeVisible();
    });

    it('tells a message that was held back as held back', async () => {
      const row = await rowOf(suppressedFixture('KILL_SWITCH'));

      expect(within(row).getByText('Held back')).toBeVisible();
    });

    // Break caught: the state told by its colour alone: the words are the badge, and a state that has none would be a blank.
    it('never tells a state by colour alone: every badge has words', async () => {
      open(() =>
        page(
          (
            ['QUEUED', 'LEASED', 'RETRYABLE', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED'] as const
          ).map((state, index) =>
            notificationFixture({
              state,
              outcome_class: null,
              created_at: `2026-10-29T08:0${String(index)}:00.000Z`,
            }),
          ),
        ),
      );

      await logTable();
      const badges = document.querySelectorAll('.ui-status-badge');

      expect(badges).toHaveLength(7);
      for (const badge of badges) expect(badge.textContent.trim()).not.toBe('');
    });
  });

  describe('a message that was held back', () => {
    // The words of the brief, written out here and not read from the screen's own table.
    it.each([
      ['KILL_SWITCH', 'Switched off'],
      ['NUMBER_LIMIT', 'This number reached its daily limit'],
      ['DAY_LIMIT', 'The daily limit for all messages was reached'],
      ['WINDOW_LIMIT', 'The test window’s message limit was reached'],
      ['DESTINATION_NOT_ALLOWED', 'The number is not on the test window’s list'],
      ['DESTINATION_REFUSED', 'The provider would not take this number'],
      ['NO_DESTINATION', 'There was no number to send to'],
      ['OVERTAKEN', 'The request changed before this was sent'],
      ['WORDING_NOT_APPROVED', 'The wording is not yet approved for real sending'],
    ] as const)('says why: %s', async (reason, words) => {
      const row = await rowOf(suppressedFixture(reason));

      expect(within(row).getByText(words)).toBeVisible();
    });

    // Break caught: a held-back message told by how it ended (it never began), or without its reason.
    it('tells the reason and not an outcome, even where the server also gave one', async () => {
      const row = await rowOf(
        suppressedFixture('DESTINATION_REFUSED', {
          outcome_class: 'REJECTED',
          provider_outcome_class: 'REQUEST_INVALID',
        }),
      );

      expect(within(row).getByText('The provider would not take this number')).toBeVisible();
      expect(within(row).queryByText('The provider refused it')).toBeNull();
    });
  });

  describe('a message that ended', () => {
    it.each([
      ['ACCEPTED', 'The provider accepted it'],
      ['UNKNOWN', 'The provider gave no clear answer'],
      ['REJECTED', 'The provider refused it'],
      ['DELIVERY_FAILED', 'The network said it did not arrive'],
      ['SCHEDULE_EXHAUSTED', 'Gave up after every retry'],
      ['EXPIRED', 'Too old to send'],
      ['RELINQUISHED', 'Handed back'],
    ] as const)('says how: %s', async (outcome, words) => {
      const row = await rowOf(notificationFixture({ state: 'FAILED', outcome_class: outcome }));

      expect(within(row).getByText(words)).toBeVisible();
    });

    it('shows the provider’s closed word only as supporting text beside the outcome', async () => {
      const row = await rowOf(
        notificationFixture({
          state: 'FAILED',
          outcome_class: 'REJECTED',
          provider_outcome_class: 'REQUEST_INVALID',
        }),
      );

      expect(within(row).getByText('The provider refused it')).toBeVisible();
      expect(within(row).getByText('Provider’s word: REQUEST_INVALID')).toBeVisible();
    });

    it('says there is nothing to report for a message that has not ended in any way', async () => {
      const row = await rowOf(
        notificationFixture({ state: 'QUEUED', outcome_class: null, attempt_count: 0 }),
      );

      expect(within(row).getByText('Nothing to report')).toBeInTheDocument();
      expect(within(row).queryByText(/Provider’s word/)).toBeNull();
    });
  });

  describe('a message by what it is', () => {
    it('is called by what it is about, with the version of its wording', async () => {
      const row = await rowOf(
        notificationFixture({ message_kind: 'PICKUP_CONFIRMED_SENDER', template_version: 3 }),
      );

      expect(within(row).getByText('Pickup request confirmed')).toBeVisible();
      expect(within(row).getByText('Wording version 3')).toBeVisible();
      expect(within(row).queryByText('PICKUP_CONFIRMED_SENDER')).toBeNull();
    });

    // Break caught: a message hidden, or shown as its raw name, because the screen's list is older than the server's.
    it('shows a kind it has no words for in sentence case, and never hides it', async () => {
      const row = await rowOf(notificationFixture({ message_kind: 'RIDER_BONUS_PAID' }));

      expect(within(row).getByText('Rider bonus paid')).toBeVisible();
      expect(within(row).queryByText('RIDER_BONUS_PAID')).toBeNull();
    });

    it.each([
      ['AD_HOC_SENDER', 'Ad-hoc sender'],
      ['VENDOR_NUMBER', 'Vendor’s registered number'],
      ['RIDER', 'Rider'],
      ['RECIPIENT', 'Recipient'],
      ['VENDOR_FEED', 'Vendor’s feed'],
      ['OPS_FEED', 'Ops feed'],
    ] as const)('says who %s is', async (audience, words) => {
      const row = await rowOf(notificationFixture({ audience }));

      expect(within(row).getByText(words)).toBeVisible();
    });
  });

  describe('the number', () => {
    it('is the hint the server sent, and a dash with its meaning where there is none', async () => {
      open(() => page([confirmed, inFeed]));

      const text = await rowAt('29 Oct, 08:15');
      const feed = await rowAt('29 Oct, 08:14');

      expect(within(text).getByText('+233******567')).toBeVisible();
      expect(within(text).queryByText('No number')).toBeNull();
      // A feed entry has no number: a dash with what it stands for. It has nothing to report of a sending too, which the status cell says in words to assistive technology and not as a
      // second dash under a badge that already says the state.
      expect(within(feed).getAllByText('—')).toHaveLength(1);
      expect(within(feed).getByText('No number')).toBeInTheDocument();
      expect(within(feed).getByText('Nothing to report')).toBeInTheDocument();
      expect(within(feed).getByRole('cell', { name: 'No number' })).toBeInTheDocument();
    });

    // Break caught: a page that draws a number in clear, a text or a code that an entry should never have carried, or asks for one.
    it('is the only number the page draws: a number in clear, a text and a code planted in the answer appear nowhere', async () => {
      open(() =>
        page([
          plantedIn(confirmed),
          plantedIn(suppressedFixture('NUMBER_LIMIT', { created_at: '2026-10-29T08:10:00.000Z' })),
          plantedIn(inFeed),
        ]),
      );

      await logTable();
      const everything = `${document.body.innerHTML}\n${document.body.textContent}`;

      for (const planted of [PLANTED_NUMBER, PLANTED_TEXT, PLANTED_CODE, 'a'.repeat(64)]) {
        expect(everything).not.toContain(planted);
      }
      // No run of figures that could be a number: the hints show three at a time.
      expect(document.body.textContent).not.toMatch(/\d{7,}/);
      expect(document.body.textContent).toContain(HINT);
      for (const request of api.requests) {
        for (const planted of [PLANTED_NUMBER, PLANTED_TEXT, PLANTED_CODE, '233209998877']) {
          expect(decodeURIComponent(request.url)).not.toContain(planted);
        }
      }
    });

    // Break caught: the guard letting a number in clear through as a "hint". The whole page is refused, and the number is on no screen.
    it('refuses a page whose hint is a number in clear, and draws none of it', async () => {
      open(() => page([confirmed, notificationFixture({ destination_hint: PLANTED_NUMBER })]));

      await alertSaying('The messages could not be loaded.');
      expect(messageRows()).toHaveLength(0);
      expect(document.body.innerHTML).not.toContain(PLANTED_NUMBER);
      expect(document.body.innerHTML).not.toContain('233209998877');
    });

    // Break caught: a control that copies, dials or texts a number, or hands one on in a link.
    it('offers nothing to copy, to dial or to send to', async () => {
      open();
      await logTable();

      expect(
        screen.queryByRole('button', { name: /copy|reveal|show (the )?number|full number/i }),
      ).toBeNull();
      for (const link of screen.getAllByRole('link')) {
        expect(link.getAttribute('href') ?? '', link.textContent).not.toMatch(
          /^(tel|sms|mailto|whatsapp):/,
        );
      }
    });
  });

  describe('the record a message is about', () => {
    it('is a link to the pickup request, and never its identifier as text', async () => {
      open();
      const row = await rowAt('29 Oct, 08:15');

      expect(within(row).getByRole('link', { name: 'Pickup request' })).toHaveAttribute(
        'href',
        `/pickup-requests/${NOTIFICATION_REQUEST_ID}`,
      );
      const text = document.body.textContent;
      expect(text).not.toContain(NOTIFICATION_REQUEST_ID);
      expect(text).not.toContain(confirmed.id);
      expect(text).not.toContain(NOTIFICATION_HUB_ID);
    });

    it('goes to the request each message is about', async () => {
      open(() =>
        page([
          confirmed,
          notificationFixture({
            created_at: '2026-10-29T08:12:00.000Z',
            subject: { type: 'PICKUP_REQUEST', id: OTHER_REQUEST_ID },
          }),
        ]),
      );
      await logTable();

      expect(
        screen
          .getAllByRole('link', { name: 'Pickup request' })
          .map((link) => link.getAttribute('href')),
      ).toEqual([
        `/pickup-requests/${NOTIFICATION_REQUEST_ID}`,
        `/pickup-requests/${OTHER_REQUEST_ID}`,
      ]);
    });
  });

  // Break caught: a log that shows part of a page when one message in it is not one.
  it('shows no log at all when one message in it is not a message', async () => {
    open(() => page([confirmed, { ...inFeed, state: 'SOMETHING_NEW' }]));

    await alertSaying('The messages could not be loaded.');
    expect(messageRows()).toHaveLength(0);
  });

  it('shows no log at all when a held-back message does not say why', async () => {
    open(() => page([{ ...suppressedFixture('KILL_SWITCH'), suppression_reason: null }]));

    await alertSaying('The messages could not be loaded.');
    expect(messageRows()).toHaveLength(0);
  });

  it('is in the menu, marked as the page the person is on', async () => {
    open();
    await logTable();

    expect(
      within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', {
        name: 'Message log',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });
});

describe('the log: filtering', () => {
  it('asks for every message by default, and offers each choice the contract has', async () => {
    const view = open();
    await logTable();

    for (const name of ['state', 'audience', 'channel', 'subject_id']) {
      expect(queryOf(0).has(name), name).toBe(false);
    }
    const views = screen.getByRole('tablist', { name: 'Views of the messages' });
    expect(
      within(views)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Every message', 'The Ops feed']);
    expect(viewTab('Every message')).toHaveAttribute('aria-selected', 'true');
    await openFilters(view);
    const optionsOf = (name: string) =>
      within(screen.getByRole('combobox', { name }))
        .getAllByRole('option')
        .map((option) => option.textContent);
    expect(optionsOf('Status')).toEqual([
      'Every status',
      'Waiting to be sent',
      'Being sent',
      'Will try again',
      'Sent, waiting for the network',
      'Delivered',
      'Failed',
      'Held back',
      'Too late to send',
    ]);
    expect(optionsOf('For')).toEqual([
      'Everyone',
      'Ad-hoc sender',
      'Vendor’s registered number',
      'Rider',
      'Recipient',
      'Vendor’s feed',
      'Ops feed',
    ]);
    expect(optionsOf('Channel')).toEqual(['Every channel', 'Text message', 'In-app feed']);
  });

  it.each([
    ['Status', 'state', 'SUPPRESSED'],
    ['For', 'audience', 'RIDER'],
    ['Channel', 'channel', 'FEED'],
  ])('asks for the %s that is chosen, and puts it in the address', async (label, name, value) => {
    const view = open();
    const { user, router } = view;
    await logTable();
    await openFilters(view);

    await user.selectOptions(screen.getByRole('combobox', { name: label }), value);

    await waitFor(() => {
      expect(queryOf().get(name)).toBe(value);
    });
    expect(router.state.location.search).toBe(`?${name}=${value}`);
  });

  it('reads every choice out of the address, so that a view can be linked', async () => {
    const view = open(
      () => page([]),
      READER,
      `/messages?state=SUPPRESSED&audience=AD_HOC_SENDER&channel=SMS&subject=${NOTIFICATION_REQUEST_ID}`,
    );
    await screen.findByRole('heading', { name: 'No messages match' });

    expect(queryOf(0).get('state')).toBe('SUPPRESSED');
    expect(queryOf(0).get('audience')).toBe('AD_HOC_SENDER');
    expect(queryOf(0).get('channel')).toBe('SMS');
    expect(queryOf(0).get('subject_id')).toBe(NOTIFICATION_REQUEST_ID);
    // Each choice is a chip of its own, and a field in the popover of the filter row.
    expect(removeChip('Status: Held back')).toBeVisible();
    expect(removeChip('For: Ad-hoc sender')).toBeVisible();
    expect(removeChip('Channel: Text message')).toBeVisible();
    await openFilters(view);
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('SUPPRESSED');
    expect(screen.getByRole('combobox', { name: 'For' })).toHaveValue('AD_HOC_SENDER');
    expect(screen.getByRole('combobox', { name: 'Channel' })).toHaveValue('SMS');
  });

  // Break caught: a made-up value in the address sent to the server as a made-up filter, or as a record that is not one.
  it.each([
    'state=everything',
    'state=suppressed',
    'state=%20DELIVERED',
    'audience=ops_feed',
    'audience=EVERYONE',
    'channel=EMAIL',
    'channel=sms',
    'subject=ACC-PR-7KQ2MZ',
    'subject=123',
    'subject=%2B233201234567',
    `subject=${NOTIFICATION_REQUEST_ID}x`,
    'subject=',
  ])('takes %s for no filter', async (query) => {
    open(undefined, READER, `/messages?${query}`);

    await logTable();

    for (const name of ['state', 'audience', 'channel', 'subject_id']) {
      expect(queryOf(0).has(name), name).toBe(false);
    }
    expect(screen.queryByText('Messages about one request')).toBeNull();
  });

  it('keeps what is chosen already when another choice is made', async () => {
    const view = open(
      undefined,
      READER,
      `/messages?state=FAILED&subject=${NOTIFICATION_REQUEST_ID}`,
    );
    const { user, router } = view;
    await screen.findByRole('heading', { name: 'No messages match' });
    await openFilters(view);

    await user.selectOptions(screen.getByRole('combobox', { name: 'For' }), 'RIDER');

    await waitFor(() => {
      expect(queryOf().get('audience')).toBe('RIDER');
    });
    const address = searchOf(router);
    expect(address.get('state')).toBe('FAILED');
    expect(address.get('subject')).toBe(NOTIFICATION_REQUEST_ID);
    expect(queryOf().get('subject_id')).toBe(NOTIFICATION_REQUEST_ID);
  });

  // Break caught: a field of the popover that keeps the log as it was when the popover opened, so that the second choice made without closing it drops the first.
  it('keeps the choice made a moment ago when the next is made in the same popover', async () => {
    const view = open();
    const { user, router } = view;
    await logTable();
    await openFilters(view);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'FAILED');
    await waitFor(() => {
      expect(router.state.location.search).toBe('?state=FAILED');
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'For' }), 'RIDER');

    await waitFor(() => {
      expect(queryOf().get('audience')).toBe('RIDER');
    });
    expect(queryOf().get('state')).toBe('FAILED');
    expect(router.state.location.search).toBe('?state=FAILED&audience=RIDER');
  });

  it('takes a choice off by choosing "every" again', async () => {
    const view = open(undefined, READER, '/messages?state=FAILED');
    const { user, router } = view;
    await screen.findByRole('heading', { name: 'No messages match' });
    await openFilters(view);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), '');

    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(queryOf().has('state')).toBe(false);
    expect(await logTable()).toBeVisible();
  });

  it('takes a choice off with its own chip, and keeps the others', async () => {
    const { user, router } = open(undefined, READER, '/messages?state=FAILED&channel=SMS');
    await screen.findByRole('heading', { name: 'No messages match' });

    await user.click(removeChip('Status: Failed'));

    await waitFor(() => {
      expect(router.state.location.search).toBe('?channel=SMS');
    });
    expect(queryOf().has('state')).toBe(false);
    expect(queryOf().get('channel')).toBe('SMS');
  });

  describe('the Ops feed', () => {
    it('is the channel FEED and the audience OPS_FEED, and a status chosen before is not carried into it', async () => {
      const view = open(
        () => page([]),
        READER,
        `/messages?state=FAILED&audience=RIDER&subject=${NOTIFICATION_REQUEST_ID}`,
      );
      const { user, router } = view;
      await screen.findByRole('heading', { name: 'No messages match' });

      await user.click(viewTab('The Ops feed'));

      await waitFor(() => {
        expect(queryOf().get('channel')).toBe('FEED');
      });
      expect(queryOf().get('audience')).toBe('OPS_FEED');
      expect(queryOf().has('state')).toBe(false);
      // The record the person narrowed to is theirs to keep or to take off; the preset does not decide it.
      expect(queryOf().get('subject_id')).toBe(NOTIFICATION_REQUEST_ID);
      const address = searchOf(router);
      expect([address.get('channel'), address.get('audience'), address.has('state')]).toEqual([
        'FEED',
        'OPS_FEED',
        false,
      ]);
      expect(viewTab('The Ops feed')).toHaveAttribute('aria-selected', 'true');
      // The view says what its channel and its audience are: no chip of their own, and no status chosen before.
      expect(screen.queryByRole('button', { name: /^Remove filter: / })).toBeNull();
      await openFilters(view);
      expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('');
    });

    it('is shown as chosen when the address holds exactly its two parts', async () => {
      open(undefined, READER, '/messages?channel=FEED&audience=OPS_FEED');
      await screen.findByRole('heading', { name: 'Nothing in the Ops feed yet' });

      expect(viewTab('The Ops feed')).toHaveAttribute('aria-selected', 'true');
    });

    it.each(['channel=FEED', 'audience=OPS_FEED', 'channel=SMS&audience=OPS_FEED'])(
      'is not shown as chosen for a part of it (%s)',
      async (query) => {
        open(undefined, READER, `/messages?${query}`);
        await settled();

        expect(viewTab('Every message')).toHaveAttribute('aria-selected', 'true');
      },
    );

    it('takes its two parts off and leaves the rest when "every message" is chosen again', async () => {
      const { user, router } = open(
        undefined,
        READER,
        `/messages?channel=FEED&audience=OPS_FEED&state=DELIVERED&subject=${NOTIFICATION_REQUEST_ID}`,
      );
      await screen.findByRole('heading', { name: 'No messages match' });

      await user.click(viewTab('Every message'));

      await waitFor(() => {
        expect(queryOf().has('channel')).toBe(false);
      });
      expect(queryOf().has('audience')).toBe(false);
      const address = searchOf(router);
      expect([address.get('state'), address.get('subject')]).toEqual([
        'DELIVERED',
        NOTIFICATION_REQUEST_ID,
      ]);
    });
  });

  describe('the record the messages are about', () => {
    const ABOUT = `/messages?subject=${NOTIFICATION_REQUEST_ID}`;

    it('is said once, as "messages about one request", and asked for by its identifier', async () => {
      open(undefined, READER, ABOUT);
      await logTable();

      expect(screen.getByText('Messages about one request')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Show every message' })).toBeVisible();
      expect(queryOf(0).get('subject_id')).toBe(NOTIFICATION_REQUEST_ID);
      // The request is named by what it is and not by its identifier.
      expect(document.body.textContent).not.toContain(NOTIFICATION_REQUEST_ID);
    });

    // Break caught (the Product Owner, 2 November 2026; the reviewer's finding): the words about the record decided by the first message the
    // server returns, so that a log still loading, empty or failed said the wrong thing for a run. The address names the kind of record
    // (`subject_type`, the typed mapping of `message-presentation.ts` does the wording) and the page reads nothing else for it: every state of
    // the log says what it is about, for both kinds. The log is asked for by the identifier alone, as it was.
    describe('says what it is about in every state, from the address alone', () => {
      const runText = runTextFixture();
      const RUN_WORDS = 'Messages about this pickup run';
      const REQUEST_WORDS = 'Messages about one request';
      const KINDS = [
        {
          name: 'a pickup run',
          id: NOTIFICATION_RUN_ID,
          type: 'PICKUP_MANIFEST',
          words: RUN_WORDS,
          other: REQUEST_WORDS,
          entry: runText,
          otherType: 'PICKUP_REQUEST',
        },
        {
          name: 'a pickup request',
          id: NOTIFICATION_REQUEST_ID,
          type: 'PICKUP_REQUEST',
          words: REQUEST_WORDS,
          other: RUN_WORDS,
          entry: confirmed,
          otherType: 'PICKUP_MANIFEST',
        },
      ] as const;
      const addressOf = (kind: (typeof KINDS)[number]): string =>
        `/messages?subject=${kind.id}&subject_type=${kind.type}`;

      describe.each(KINDS)('for $name', (kind) => {
        it('while the log is loading, and after it has loaded', async () => {
          let release: (response: Response) => void = () => undefined;
          const gate = new Promise<Response>((resolve) => {
            release = resolve;
          });
          open(() => gate, READER, addressOf(kind));

          expect(await screen.findByText('Loading messages')).toBeInTheDocument();
          expect(screen.getByText(kind.words)).toBeVisible();
          expect(screen.queryByText(kind.other)).toBeNull();

          await act(async () => {
            release(page([kind.entry]));
            await gate;
          });
          await logTable();
          expect(screen.getByText(kind.words)).toBeVisible();
          expect(screen.queryByText(kind.other)).toBeNull();
        });

        it('when the log is empty', async () => {
          open(() => page([]), READER, addressOf(kind));

          expect(await screen.findByRole('heading', { name: 'No messages match' })).toBeVisible();
          expect(screen.getByText(kind.words)).toBeVisible();
          expect(screen.queryByText(kind.other)).toBeNull();
        });

        it('when the read fails', async () => {
          open(() => refusal(500, 'INTERNAL'), READER, addressOf(kind));

          await alertSaying('The messages could not be loaded.');
          expect(screen.getByText(kind.words)).toBeVisible();
          expect(screen.queryByText(kind.other)).toBeNull();
        });

        it('when the log is loaded, asked for by the identifier alone', async () => {
          open(serverOf([runText, confirmed]), READER, addressOf(kind));
          await logTable();

          expect(screen.getByText(kind.words)).toBeVisible();
          expect(screen.queryByText(kind.other)).toBeNull();
          expect(screen.getByRole('button', { name: 'Show every message' })).toBeVisible();
          expect(queryOf(0).get('subject_id')).toBe(kind.id);
          expect(queryOf(0).has('subject_type')).toBe(false);
          // The record is named by what it is and not by its identifier.
          expect(document.body.textContent).not.toContain(kind.id);
        });

        // The first message the server returns is not what the log is about: the address is. (The page refuses an answer about another record, so
        // the message here is about the record asked for and says it is the other kind of one.)
        it('whatever kind the first message returned says it is about', async () => {
          const contradicting = { ...kind.entry, subject: { type: kind.otherType, id: kind.id } };
          open(() => page([contradicting]), READER, addressOf(kind));
          await logTable();

          expect(screen.getByText(kind.words)).toBeVisible();
          expect(screen.queryByText(kind.other)).toBeNull();
        });

        it('keeps the words and the kind in the address while the log is narrowed further', async () => {
          const view = open(serverOf([runText, confirmed]), READER, addressOf(kind));
          const { user, router } = view;
          await logTable();
          await openFilters(view);

          await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'DELIVERED');

          await waitFor(() => {
            expect(queryOf().get('state')).toBe('DELIVERED');
          });
          const address = searchOf(router);
          expect([address.get('subject'), address.get('subject_type')]).toEqual([
            kind.id,
            kind.type,
          ]);
          expect(screen.getByText(kind.words)).toBeVisible();
          expect(screen.queryByText(kind.other)).toBeNull();
        });

        it('is taken off, with its kind, by "show every message"', async () => {
          const { user, router } = open(() => page([kind.entry]), READER, addressOf(kind));
          await logTable();

          await user.click(screen.getByRole('button', { name: 'Show every message' }));

          await waitFor(() => {
            expect(router.state.location.search).toBe('');
          });
          expect(screen.queryByText(kind.words)).toBeNull();
          expect(screen.queryByText(kind.other)).toBeNull();
        });
      });

      // Break caught: a link that was made before the kind was in the address (a bookmark of a request's log) read as something else. An address
      // with a record and no kind is a request's, as it always was, whatever the messages that come back are about.
      it('reads an address with a record and no kind as a request’s, whatever comes back', async () => {
        open(() => page([runText]), READER, `/messages?subject=${NOTIFICATION_RUN_ID}`);
        await logTable();

        expect(screen.getByText(REQUEST_WORDS)).toBeVisible();
        expect(screen.queryByText(RUN_WORDS)).toBeNull();
      });

      // Break caught: a made-up kind in the address worded as a kind, or sent to the server as a filter. A value that is not a choice is no choice.
      it.each(['PICKUP_RUN', 'pickup_manifest', '', 'constructor'])(
        'takes the kind %j for no kind, and asks for nothing more than the record',
        async (kind) => {
          open(
            serverOf([runText, confirmed]),
            READER,
            `/messages?subject=${NOTIFICATION_RUN_ID}&subject_type=${kind}`,
          );
          await logTable();

          expect(screen.getByText(REQUEST_WORDS)).toBeVisible();
          expect(screen.queryByText(RUN_WORDS)).toBeNull();
          expect(queryOf(0).get('subject_id')).toBe(NOTIFICATION_RUN_ID);
          expect(queryOf(0).has('subject_type')).toBe(false);
        },
      );

      // Break caught: a kind with no record narrowing the log or announcing a record that is not there.
      it('says nothing, and narrows nothing, for a kind with no record', async () => {
        const view = open(undefined, READER, '/messages?subject_type=PICKUP_MANIFEST');
        const { user, router } = view;
        await logTable();

        expect(screen.queryByText(RUN_WORDS)).toBeNull();
        expect(screen.queryByText(REQUEST_WORDS)).toBeNull();
        // No banner at all (its button would be there): the log is every message, as it is with nothing in the address.
        expect(screen.queryByRole('button', { name: 'Show every message' })).toBeNull();
        expect(queryOf(0).has('subject_id')).toBe(false);

        // And the first choice made drops it: the address holds what the log is narrowed to and nothing else.
        await openFilters(view);
        await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'DELIVERED');
        await waitFor(() => {
          expect(queryOf().get('state')).toBe('DELIVERED');
        });
        expect(searchOf(router).has('subject_type')).toBe(false);
      });

      // Break caught: the run in a row leading to a log that does not know it is a run's, or to the wrong record.
      it('is reached from the run in a row, narrowed to the run and worded for it from the first moment', async () => {
        const { user, router } = open(serverOf([runText, confirmed]));
        const row = await rowAt('29 Oct, 08:30');

        await user.click(within(row).getByRole('link', { name: 'Pickup run' }));

        expect(await screen.findByText(RUN_WORDS)).toBeVisible();
        await waitFor(() => {
          expect(queryOf().get('subject_id')).toBe(NOTIFICATION_RUN_ID);
        });
        expect(router.state.location.search).toBe(
          `?subject=${NOTIFICATION_RUN_ID}&subject_type=PICKUP_MANIFEST`,
        );
        // Only the run's message is left, and the request's is not.
        expect(await screen.findByRole('rowheader', { name: '29 Oct, 08:30' })).toBeVisible();
        expect(screen.queryByRole('rowheader', { name: '29 Oct, 08:15' })).toBeNull();
      });
    });

    it('is taken off, with every other choice, by "show every message"', async () => {
      const { user, router } = open(
        undefined,
        READER,
        `${ABOUT}&state=DELIVERED&audience=AD_HOC_SENDER`,
      );
      await logTable();

      await user.click(screen.getByRole('button', { name: 'Show every message' }));

      await waitFor(() => {
        expect(router.state.location.search).toBe('');
      });
      await waitFor(() => {
        expect(queryOf().has('subject_id')).toBe(false);
      });
      expect(queryOf().has('state')).toBe(false);
      expect(queryOf().has('audience')).toBe(false);
      expect(screen.queryByText('Messages about one request')).toBeNull();
    });

    it('is the way back from an empty log, as the filtered state’s action is too', async () => {
      const { user, router } = open(() => page([]), READER, ABOUT);
      await screen.findByRole('heading', { name: 'No messages match' });

      const buttons = screen.getAllByRole('button', { name: 'Show every message' });
      expect(buttons).toHaveLength(2);
      await user.click(buttons[1] ?? buttons[0] ?? document.body);

      await waitFor(() => {
        expect(router.state.location.search).toBe('');
      });
    });
  });
});

describe('the log: counting and paging', () => {
  it('counts a page without claiming to know the total', async () => {
    open(() => page([confirmed, inFeed], 'next-1'));
    expect(
      await screen.findByText('Showing 2 messages. More follow on the next page.'),
    ).toBeVisible();
  });

  it('goes to the next page with the token the server gave, and back', async () => {
    const { user } = open(() => page([confirmed], 'next-1'));
    await logTable();

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(queryOf().get('page_token')).toBe('next-1');
    });
    expect(await screen.findByText(/on page 2/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => {
      expect(queryOf().has('page_token')).toBe(false);
    });
  });

  // Break caught (the review of 499399c): a pager taken out of the page while the next page is read and made anew with its words, which most screen readers do not announce: the status
  // region is the same element through the read, empty while the page is read.
  it('keeps the pager’s status region while the next page is read', async () => {
    const reads = byHand();
    let calls = 0;
    const { user } = open((request) => {
      calls += 1;
      return calls === 1 ? page([confirmed], 'next-1') : reads.handler(request);
    });
    await logTable();
    const region = pagerRegion();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(region).toBeEmptyDOMElement();
    });
    expect(pagerRegion()).toBe(region);

    await reads.answer(page([confirmed]));
    await waitFor(() => {
      expect(region).toHaveTextContent(/on page 2/);
    });
    expect(pagerRegion()).toBe(region);
  });

  // Break caught: the next page of one filter asked for under another.
  it('starts again at the first page when a choice changes', async () => {
    const view = open(() => page([confirmed], 'next-1'));
    const { user } = view;
    await logTable();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    await openFilters(view);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Channel' }), 'SMS');

    await waitFor(() => {
      expect(queryOf().get('channel')).toBe('SMS');
    });
    expect(queryOf().has('page_token')).toBe(false);
  });

  it('starts again at the first page when the record changes, too', async () => {
    const { user } = open(
      () => page([confirmed], 'next-1'),
      READER,
      `/messages?subject=${NOTIFICATION_REQUEST_ID}`,
    );
    await logTable();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);

    await user.click(screen.getByRole('button', { name: 'Show every message' }));

    await waitFor(() => {
      expect(queryOf().has('subject_id')).toBe(false);
    });
    expect(queryOf().has('page_token')).toBe(false);
  });
});

describe('the log: nothing to show', () => {
  it('tells a log with no messages as good news', async () => {
    open(() => page([]));

    expect(await screen.findByRole('heading', { name: 'No messages yet' })).toBeVisible();
    expect(
      screen.getByText(
        'Messages appear here when the platform tells someone about an act, for example a confirmed pickup request.',
      ),
    ).toBeVisible();
    expect(messageRows()).toHaveLength(0);
  });

  // Break caught (ops-portal.md section 7): "no messages" and "filtered to nothing" told as one, which sends Ops hunting for a bug.
  it('tells a filter that hides everything differently, and takes every filter off in one move', async () => {
    const { user, router } = open(() => page([]), READER, '/messages?state=FAILED&channel=SMS');
    expect(await screen.findByRole('heading', { name: 'No messages match' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No messages yet' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show every message' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    // No choice is left: no chip of any, and the views are the first.
    expect(screen.queryByRole('button', { name: /^Remove filter: / })).toBeNull();
    expect(viewTab('Every message')).toHaveAttribute('aria-selected', 'true');
  });

  describe('the Ops feed with nothing in it', () => {
    // No operation built so far raises a message for the Ops feed: the view says so plainly and invents no entry.
    it('reads honestly: nothing in the Ops feed yet', async () => {
      open(() => page([]), READER, '/messages?channel=FEED&audience=OPS_FEED');

      expect(
        await screen.findByRole('heading', { name: 'Nothing in the Ops feed yet' }),
      ).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'No messages match' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'No messages yet' })).toBeNull();
      expect(messageRows()).toHaveLength(0);
    });

    it('offers the way back to every message', async () => {
      const { user, router } = open(
        () => page([]),
        READER,
        '/messages?channel=FEED&audience=OPS_FEED',
      );
      await screen.findByRole('heading', { name: 'Nothing in the Ops feed yet' });

      await user.click(screen.getByRole('button', { name: 'Show every message' }));

      await waitFor(() => {
        expect(router.state.location.search).toBe('');
      });
      expect(await screen.findByRole('heading', { name: 'No messages yet' })).toBeVisible();
    });

    it('is told as a filter that hides everything when a status narrows it further', async () => {
      open(() => page([]), READER, '/messages?channel=FEED&audience=OPS_FEED&state=FAILED');

      expect(await screen.findByRole('heading', { name: 'No messages match' })).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'Nothing in the Ops feed yet' })).toBeNull();
    });

    it('asks the server for the feed, and shows what it sends', async () => {
      open(
        () =>
          page([
            feedFixture({
              message_kind: 'PICKUP_FAILURE_ESCALATED_OPS_FEED',
              audience: 'OPS_FEED',
              created_at: '2026-10-29T09:30:00.000Z',
            }),
          ]),
        READER,
        '/messages?channel=FEED&audience=OPS_FEED',
      );

      const row = await rowAt('29 Oct, 09:30');

      expect(within(row).getByText('Pickup failure escalated')).toBeVisible();
      expect(within(row).getByText('Ops feed')).toBeVisible();
      expect(queryOf(0).get('channel')).toBe('FEED');
      expect(queryOf(0).get('audience')).toBe('OPS_FEED');
    });
  });
});

describe('the log: when it cannot be had', () => {
  it('says so in approved words with a retry, and never the server’s text', async () => {
    open(() => refusal(500, 'INTERNAL_ERROR'));

    await alertSaying('The messages could not be loaded.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('names the key a session without it lacks, and no role', async () => {
    open(() => refusal(403, 'PERMISSION_DENIED'));

    await alertSaying(cannotText('notification.read'));
    expect(document.body.textContent).not.toMatch(/Ops Staff|Senior Ops|Platform Admin|Finance/);
  });

  // Break caught: a page that is not the query's shown as if it were, so that a filter is quietly not applied.
  it('shows no log when the answer holds a message the filter should have left out', async () => {
    open(() => page([confirmed]), READER, '/messages?state=FAILED');

    await alertSaying('The messages could not be loaded.');
    expect(messageRows()).toHaveLength(0);
  });

  it('shows no log when the answer holds a message about another request than the one asked for', async () => {
    open(() => page([confirmed]), READER, `/messages?subject=${OTHER_REQUEST_ID}`);

    await alertSaying('The messages could not be loaded.');
    expect(messageRows()).toHaveLength(0);
  });
});

describeInterfaceStates('The message log', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      open(() => gate);
      expect(await screen.findByText('Loading messages')).toBeInTheDocument();
      // A count is never shown while the log loads (ops-portal.md section 8).
      expect(screen.queryByText(/Showing/)).toBeNull();
      await act(async () => {
        release(page([confirmed]));
        await gate;
      });
      await screen.findByRole('rowheader', { name: '29 Oct, 08:15' });
    },
  },
  empty: {
    test: async () => {
      open(() => page([]), READER, '/messages?state=EXPIRED');
      expect(await screen.findByRole('heading', { name: 'No messages match' })).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open(
        () =>
          refusal(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'query', pointer: '/state', rule: 'enum' }],
          }),
        READER,
        '/messages?state=FAILED',
      );
      await alertSaying(
        'That choice of messages was not accepted. Choose from the lists to start again.',
      );
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL'));
      await alertSaying('The messages could not be loaded.');
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(() => {
        attempts += 1;
        return attempts === 1 ? refusal(503, 'SETTING_MISSING') : page([confirmed]);
      });
      await view.user.click(await screen.findByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('rowheader', { name: '29 Oct, 08:15' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The log only reads: it carries no version and changes nothing, so there is nothing to conflict with. A message that moved on is seen the next time the log is read.',
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByText('Showing 2 messages.')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(undefined, ['pickup.read']);
      // The route itself is shut to this session: no page is drawn, so there is no table and no alert of one.
      expect(await screen.findByText(cannotText('notification.read'))).toBeVisible();
      expect(screen.queryByRole('table')).toBeNull();
      expect(listRequests()).toHaveLength(0);
      // No entry in the menu either, although hiding it is not what keeps the page shut.
      expect(
        within(screen.getByRole('navigation', { name: 'Primary' })).queryByRole('link', {
          name: 'Message log',
        }),
      ).toBeNull();
      expect(document.body.textContent).not.toMatch(/Ops Staff|Senior Ops|Platform Admin|Finance/);
    },
  },
});
