import { describe, expect, it } from 'vitest';

import {
  feedFixture,
  HINT,
  NOTIFICATION_HUB_ID,
  NOTIFICATION_REQUEST_ID,
  notificationFixture,
  PLANTED_CODE,
  PLANTED_NUMBER,
  PLANTED_TEXT,
  plantedIn,
  suppressedFixture,
} from '../../test-support/notification-fixture';
import {
  audienceOf,
  channelOf,
  NOTIFICATION_AUDIENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_FIELDS,
  NOTIFICATION_STATES,
  notificationStateOf,
  OUTCOME_CLASSES,
  parseNotificationEntry,
  parseNotificationPage,
  subjectIdOf,
  subjectLogPath,
  subjectTypeOf,
  SUPPRESSION_REASONS,
} from './notification-shape';

/**
 * The guard of the message log (S1.12e): what it keeps of a real answer, and the answers it refuses whole. Each refusal is a way the screen
 * would otherwise draw something the server never said: a number in clear, a state with no words, a message with a reason it was not held
 * back for.
 */
describe('parseNotificationEntry', () => {
  it('keeps the fields the screen reads, and leaves out what is null or absent', () => {
    const body = notificationFixture();
    const entry = parseNotificationEntry(body);

    expect(entry).toEqual({
      id: body.id,
      message_kind: 'PICKUP_CONFIRMED_SENDER',
      template_version: 1,
      audience: 'AD_HOC_SENDER',
      channel: 'SMS',
      state: 'DELIVERED',
      outcome_class: 'ACCEPTED',
      destination_hint: HINT,
      attempt_count: 1,
      subject: { type: 'PICKUP_REQUEST', id: NOTIFICATION_REQUEST_ID },
      created_at: '2026-10-29T08:15:00.000Z',
    });
  });

  it('keeps a feed entry as it is: no number, no outcome, no attempt', () => {
    const entry = parseNotificationEntry(feedFixture());

    expect(entry).toMatchObject({ channel: 'FEED', audience: 'VENDOR_FEED', attempt_count: 0 });
    expect(Object.keys(entry ?? {})).not.toContain('destination_hint');
    expect(Object.keys(entry ?? {})).not.toContain('outcome_class');
  });

  it('keeps the provider’s closed word and the reason a message was held back', () => {
    const refused = parseNotificationEntry(
      notificationFixture({
        state: 'FAILED',
        outcome_class: 'REJECTED',
        provider_outcome_class: 'REQUEST_INVALID',
      }),
    );
    const held = parseNotificationEntry(suppressedFixture('NUMBER_LIMIT'));

    expect(refused).toMatchObject({
      outcome_class: 'REJECTED',
      provider_outcome_class: 'REQUEST_INVALID',
    });
    expect(held).toMatchObject({ state: 'SUPPRESSED', suppression_reason: 'NUMBER_LIMIT' });
  });

  // Break caught: the times, the hub and the retention of an entry carried onto the screen because nothing refused them: the screen draws the
  // time the message was raised and nothing else of its life, so the rest has nowhere to go.
  it('reads the other fields the contract requires, and carries none of them', () => {
    const entry = parseNotificationEntry(notificationFixture());

    for (const name of ['responsible_hub_id', 'expires_at', 'sent_at', 'delivered_at']) {
      expect(Object.keys(entry ?? {}), name).not.toContain(name);
    }
    expect(JSON.stringify(entry)).not.toContain(NOTIFICATION_HUB_ID);
  });

  // Break caught: a field the contract does not name (or a server should never send) carried onto a screen because nothing read it. A number in
  // clear, a message's text and a code have no place in the guard, so they go nowhere.
  it('carries nothing it did not read: no number in clear, no text, no code', () => {
    const entry = parseNotificationEntry(plantedIn(notificationFixture()));

    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {}).toSorted()).toEqual(
      Object.keys(parseNotificationEntry(notificationFixture()) ?? {}).toSorted(),
    );
    const text = JSON.stringify(entry);
    for (const planted of [PLANTED_NUMBER, PLANTED_TEXT, PLANTED_CODE, 'a'.repeat(64)]) {
      expect(text).not.toContain(planted);
    }
  });

  describe('the hint, the one number there is', () => {
    it.each(['+233******111', '+233******567', '+1******234', '+1242*****789', '+233**567'])(
      'takes %s for a masked number',
      (hint) => {
        expect(
          parseNotificationEntry(notificationFixture({ destination_hint: hint })),
        ).toMatchObject({
          destination_hint: hint,
        });
      },
    );

    // Break caught: a number in clear drawn in the column that is for a masked one. The contract promises the country part and the last three
    // digits; a "hint" that is more is not the API's, and the entry (with its page) is refused.
    it.each([
      ['a number in clear', PLANTED_NUMBER],
      ['a number in clear without its plus', '233201234567'],
      ['a hint with the plus and no stars', '+233567'],
      ['a hint that shows four of the last digits', '+233******4567'],
      ['a hint that shows two of the last digits', '+233******67'],
      ['a country part of five digits', '+23320******567'],
      ['a hint spaced out', '+233 ****** 567'],
      ['a hint with a letter', '+233******56a'],
      ['stars alone', '**********'],
      ['an empty hint', ''],
      ['a hint of more than 24 characters', `+233${'*'.repeat(20)}567`],
    ])('refuses %s', (_label, hint) => {
      expect(
        parseNotificationEntry(notificationFixture({ destination_hint: hint })),
      ).toBeUndefined();
    });

    it('refuses a hint that is not text', () => {
      expect(
        parseNotificationEntry({ ...notificationFixture(), destination_hint: 233_201_234_567 }),
      ).toBeUndefined();
    });
  });

  describe('the enumerations', () => {
    // Break caught: a value the contract adds that the guard does not know, drawn as a blank cell or an "undefined": the entry, with its page, is
    // refused, and the screen says the log could not be read. It does not throw.
    it.each([
      ['state', 'CANCELLED'],
      ['audience', 'CARRIER'],
      ['channel', 'EMAIL'],
      ['outcome_class', 'MAYBE'],
    ])('refuses a %s the contract does not have (%s) without throwing', (field, value) => {
      const entry = { ...notificationFixture(), [field]: value };

      expect(() => parseNotificationEntry(entry)).not.toThrow();
      expect(parseNotificationEntry(entry)).toBeUndefined();
    });

    it('refuses a reason for a hold that the contract does not have, without throwing', () => {
      const entry = { ...suppressedFixture('KILL_SWITCH'), suppression_reason: 'TOO_QUIET' };

      expect(() => parseNotificationEntry(entry)).not.toThrow();
      expect(parseNotificationEntry(entry)).toBeUndefined();
    });

    it.each(['queued', 'Delivered', ' DELIVERED', 'constructor', '__proto__', ''])(
      'refuses the state %j',
      (state) => {
        expect(parseNotificationEntry({ ...notificationFixture(), state })).toBeUndefined();
      },
    );

    it.each(NOTIFICATION_STATES.filter((state) => state !== 'SUPPRESSED'))(
      'takes the state %s',
      (state) => {
        expect(parseNotificationEntry(notificationFixture({ state }))).toMatchObject({ state });
      },
    );
    it.each(NOTIFICATION_AUDIENCES)('takes the audience %s', (audience) => {
      expect(parseNotificationEntry(notificationFixture({ audience }))).toMatchObject({ audience });
    });
    it.each(NOTIFICATION_CHANNELS)('takes the channel %s', (channel) => {
      expect(parseNotificationEntry(notificationFixture({ channel }))).toMatchObject({ channel });
    });
    it.each(OUTCOME_CLASSES)('takes the outcome %s', (outcome) => {
      expect(parseNotificationEntry(notificationFixture({ outcome_class: outcome }))).toMatchObject(
        { outcome_class: outcome },
      );
    });
    it.each(SUPPRESSION_REASONS)('takes the reason %s for a message held back', (reason) => {
      expect(parseNotificationEntry(suppressedFixture(reason))).toMatchObject({
        state: 'SUPPRESSED',
        suppression_reason: reason,
      });
    });
  });

  describe('the reason a message was held back', () => {
    // Break caught (the contract: "present exactly when the state is SUPPRESSED"): a held-back message that says nothing of why, or a message
    // that was sent and says it was held back.
    it('is there exactly when the state is SUPPRESSED', () => {
      expect(
        parseNotificationEntry({ ...suppressedFixture('KILL_SWITCH'), suppression_reason: null }),
      ).toBeUndefined();
      expect(
        parseNotificationEntry(notificationFixture({ suppression_reason: 'KILL_SWITCH' })),
      ).toBeUndefined();
      expect(
        parseNotificationEntry(
          notificationFixture({ state: 'FAILED', suppression_reason: 'OVERTAKEN' }),
        ),
      ).toBeUndefined();
    });
  });

  describe('the fields the contract requires', () => {
    // Break caught: an entry with a field missing, drawn with a hole in it, or an answer of another shape taken for a message.
    it.each(NOTIFICATION_FIELDS.NotificationLogEntry.required)(
      'refuses an entry without %s',
      (field) => {
        const rest = Object.fromEntries(
          Object.entries(notificationFixture()).filter(([name]) => name !== field),
        );

        expect(Object.keys(rest)).not.toContain(field);
        expect(parseNotificationEntry(rest)).toBeUndefined();
      },
    );

    it.each([null, undefined, 'a message', 7, [], [notificationFixture()]])(
      'refuses %j for an entry',
      (body) => {
        expect(parseNotificationEntry(body)).toBeUndefined();
      },
    );

    it.each([
      ['an identifier that is not one', { id: 'not-an-id' }],
      ['a hub that is not an identifier', { responsible_hub_id: 'hub' }],
      ['a message kind in lower case', { message_kind: 'pickup_confirmed' }],
      ['a message kind of two characters', { message_kind: 'AB' }],
      ['a message kind with a space', { message_kind: 'PICKUP CONFIRMED' }],
      ['a message kind of a sentence', { message_kind: 'Your pickup is confirmed' }],
      ['a version of 0', { template_version: 0 }],
      ['a version that is text', { template_version: '1' }],
      ['a version that is not whole', { template_version: 1.5 }],
      ['a negative count of tries', { attempt_count: -1 }],
      ['a count of tries that is not whole', { attempt_count: 0.5 }],
      ['a count of tries that is text', { attempt_count: '2' }],
      ['a time that is not one', { created_at: 'yesterday' }],
      ['a time with no zone', { created_at: '2026-10-29T08:15:00' }],
      ['a retention that is not a time', { expires_at: 'soon' }],
      ['a time of sending that is not one', { sent_at: 'earlier' }],
      ['a time of delivery that is not one', { delivered_at: 1_790_000_000 }],
      ['a provider’s word with a space', { provider_outcome_class: 'REQUEST INVALID' }],
      ['a provider’s word in lower case', { provider_outcome_class: 'request_invalid' }],
      [
        'a provider’s word that is a sentence',
        { provider_outcome_class: 'The number is not valid' },
      ],
      ['a provider’s word that is too long', { provider_outcome_class: `A${'B'.repeat(48)}` }],
    ])('refuses %s', (_label, change) => {
      expect(parseNotificationEntry({ ...notificationFixture(), ...change })).toBeUndefined();
    });

    it('takes an offset for a zone, and the longest word a provider may have', () => {
      expect(
        parseNotificationEntry(
          notificationFixture({
            created_at: '2026-10-29T10:15:00+02:00',
            provider_outcome_class: `A${'B'.repeat(47)}`,
          }),
        ),
      ).toMatchObject({ created_at: '2026-10-29T10:15:00+02:00' });
    });

    it('takes a kind it does not know, as long as it has the shape of one', () => {
      expect(
        parseNotificationEntry(notificationFixture({ message_kind: 'A_KIND_FROM_THE_FUTURE' })),
      ).toMatchObject({ message_kind: 'A_KIND_FROM_THE_FUTURE' });
    });
  });

  describe('the record a message is about', () => {
    it.each([
      ['no subject', { subject: undefined }],
      ['a subject that is not an object', { subject: 'PICKUP_REQUEST' }],
      [
        'a subject of a type the contract does not have',
        { subject: { type: 'PARCEL', id: NOTIFICATION_REQUEST_ID } },
      ],
      ['a subject with no type', { subject: { id: NOTIFICATION_REQUEST_ID } }],
      ['a subject with no identifier', { subject: { type: 'PICKUP_REQUEST' } }],
      ['a subject whose identifier is not one', { subject: { type: 'PICKUP_REQUEST', id: '123' } }],
    ])('refuses %s', (_label, change) => {
      expect(parseNotificationEntry({ ...notificationFixture(), ...change })).toBeUndefined();
    });

    it('keeps the type and the identifier of the record, and nothing else in the object', () => {
      const entry = parseNotificationEntry({
        ...notificationFixture(),
        subject: { type: 'PICKUP_REQUEST', id: NOTIFICATION_REQUEST_ID, code: 'ACC-PR-7KQ2MZ' },
      });

      expect(entry?.subject).toEqual({ type: 'PICKUP_REQUEST', id: NOTIFICATION_REQUEST_ID });
    });
  });
});

describe('parseNotificationPage', () => {
  it('keeps the entries in the order sent and the token of the next page', () => {
    const first = notificationFixture({ created_at: '2026-10-29T09:00:00.000Z' });
    const second = feedFixture({ created_at: '2026-10-29T08:00:00.000Z' });

    const page = parseNotificationPage({ items: [first, second], next_page_token: 'next-1' });

    expect(page?.items.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(page?.nextPageToken).toBe('next-1');
  });

  it('takes an empty page, and a last page with no token', () => {
    expect(parseNotificationPage({ items: [], next_page_token: null })).toEqual({
      items: [],
      nextPageToken: null,
    });
  });

  // Break caught: a page that shows part of its entries when one of them is not an entry, or a log built out of an answer of another shape.
  it('refuses the whole page when one entry in it is not a message', () => {
    expect(
      parseNotificationPage({
        items: [notificationFixture(), { ...notificationFixture(), state: 'NOPE' }],
        next_page_token: null,
      }),
    ).toBeUndefined();
  });

  it('refuses the whole page when one entry carries a number in clear for its hint', () => {
    expect(
      parseNotificationPage({
        items: [notificationFixture(), notificationFixture({ destination_hint: PLANTED_NUMBER })],
        next_page_token: null,
      }),
    ).toBeUndefined();
  });

  it('refuses a message listed twice, and more messages than a page holds', () => {
    const entry = notificationFixture();
    expect(parseNotificationPage({ items: [entry, entry], next_page_token: null })).toBeUndefined();
    expect(
      parseNotificationPage({
        items: [entry, { ...entry, id: entry.id.toUpperCase() }],
        next_page_token: null,
      }),
    ).toBeUndefined();
    expect(
      parseNotificationPage({
        items: Array.from({ length: 101 }, () => notificationFixture()),
        next_page_token: null,
      }),
    ).toBeUndefined();
    expect(
      parseNotificationPage({
        items: Array.from({ length: 100 }, () => notificationFixture()),
        next_page_token: null,
      })?.items,
    ).toHaveLength(100);
  });

  it.each([
    ['no token at all', undefined],
    ['an empty token', ''],
    ['a token that is not text', 7],
    ['a token of more than 2048 characters', 'x'.repeat(2049)],
  ])('refuses a page with %s', (_label, token) => {
    expect(parseNotificationPage({ items: [], next_page_token: token })).toBeUndefined();
  });

  it.each([
    ['a body that is not an object', 'a page'],
    ['an array', []],
    ['no items', { next_page_token: null }],
    ['items that are not a list', { items: {}, next_page_token: null }],
  ])('refuses %s', (_label, body) => {
    expect(parseNotificationPage(body)).toBeUndefined();
  });
});

describe('the choices in the address', () => {
  it('takes only a state, an audience and a channel the contract has', () => {
    expect(notificationStateOf('SUPPRESSED')).toBe('SUPPRESSED');
    expect(audienceOf('OPS_FEED')).toBe('OPS_FEED');
    expect(channelOf('FEED')).toBe('FEED');
    for (const text of ['suppressed', 'Everything', '', 'constructor', null]) {
      expect(notificationStateOf(text), String(text)).toBeUndefined();
      expect(audienceOf(text), String(text)).toBeUndefined();
      expect(channelOf(text), String(text)).toBeUndefined();
    }
  });

  // Break caught (the Product Owner, 2 November 2026): the kind of record read from anything but a word of the contract, or case-folded into one.
  it('takes the kind of record from the address only when it is exactly a kind the contract has', () => {
    expect(subjectTypeOf('PICKUP_REQUEST')).toBe('PICKUP_REQUEST');
    expect(subjectTypeOf('PICKUP_MANIFEST')).toBe('PICKUP_MANIFEST');
    for (const text of [
      null,
      '',
      'pickup_manifest',
      'PICKUP_RUN',
      ' PICKUP_MANIFEST',
      'constructor',
      '__proto__',
    ]) {
      expect(subjectTypeOf(text), String(text)).toBeUndefined();
    }
  });

  it('builds the address of the log narrowed to a record from its kind and its identifier', () => {
    expect(subjectLogPath('PICKUP_MANIFEST', NOTIFICATION_REQUEST_ID)).toBe(
      `/messages?subject=${NOTIFICATION_REQUEST_ID}&subject_type=PICKUP_MANIFEST`,
    );
    expect(subjectLogPath('PICKUP_REQUEST', NOTIFICATION_REQUEST_ID)).toBe(
      `/messages?subject=${NOTIFICATION_REQUEST_ID}&subject_type=PICKUP_REQUEST`,
    );
  });

  it('takes a request’s identifier, and nothing else, for the record the messages are about', () => {
    expect(subjectIdOf(NOTIFICATION_REQUEST_ID)).toBe(NOTIFICATION_REQUEST_ID);
    expect(subjectIdOf(NOTIFICATION_REQUEST_ID.toUpperCase())).toBe(
      NOTIFICATION_REQUEST_ID.toUpperCase(),
    );
    for (const text of [
      null,
      '',
      'ACC-PR-7KQ2MZ',
      '123',
      `${NOTIFICATION_REQUEST_ID}x`,
      '+233201234567',
    ]) {
      expect(subjectIdOf(text), String(text)).toBeUndefined();
    }
  });
});
