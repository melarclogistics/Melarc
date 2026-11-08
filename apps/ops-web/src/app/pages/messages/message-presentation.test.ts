import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_AUDIENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATES,
  OUTCOME_CLASSES,
  parseNotificationEntry,
  SUBJECT_TYPES,
  SUPPRESSION_REASONS,
  type NotificationEntryView,
} from '../../../platform/notifications/notification-shape';
import {
  feedFixture,
  notificationFixture,
  suppressedFixture,
} from '../../../test-support/notification-fixture';
import {
  AUDIENCE_LABELS,
  CHANNEL_LABELS,
  FEED_STATE_MAP,
  MESSAGE_KIND_LABELS,
  messageKindLabel,
  NO_BREAK_SPACE,
  NOTIFICATION_STATE_MAP,
  OUTCOME_LABELS,
  providerWordText,
  stateMapFor,
  SUBJECT_HEADINGS,
  SUBJECT_LABELS,
  SUBJECT_PATHS,
  SUPPRESSION_REASON_LABELS,
  whatHappenedText,
  wordingVersionText,
} from './message-presentation';

/**
 * The words of the message log (S1.12e), which are provisional and the owner's to reword. These tests pin that every value of every enumeration
 * has words, that no value is shown as its raw name, and that the words carry no number, no text and no code.
 */
const entryOf = (body: unknown): NotificationEntryView => {
  const entry = parseNotificationEntry(body);
  if (entry === undefined) throw new Error('not an entry');
  return entry;
};

describe('the words of a state', () => {
  it('say each state in the words the owner will review', () => {
    expect(NOTIFICATION_STATES.map((state) => NOTIFICATION_STATE_MAP[state].label)).toEqual([
      'Waiting to be sent',
      'Being sent',
      'Will try again',
      'Sent, waiting for the network',
      'Delivered',
      'Failed',
      'Held back',
      'Too late to send',
    ]);
  });

  // Break caught: a state with no words (a blank badge), or two states with the same words (which the eye could not tell apart).
  it('are different for every state, and there is a tone for every state', () => {
    const labels = NOTIFICATION_STATES.map((state) => NOTIFICATION_STATE_MAP[state].label);

    expect(new Set(labels).size).toBe(labels.length);
    expect(Object.keys(NOTIFICATION_STATE_MAP).toSorted()).toEqual(
      [...NOTIFICATION_STATES].toSorted(),
    );
    for (const state of NOTIFICATION_STATES) {
      expect(['success', 'warning', 'danger', 'info', 'neutral']).toContain(
        NOTIFICATION_STATE_MAP[state].tone,
      );
    }
  });

  // A feed entry is written and not sent: "delivered" would say a thing that did not happen to it.
  it('tell a feed entry that is delivered as one that is in the feed, and every other state as any other', () => {
    expect(stateMapFor('FEED').DELIVERED.label).toBe('In the feed');
    expect(stateMapFor('SMS').DELIVERED.label).toBe('Delivered');
    for (const state of NOTIFICATION_STATES.filter((each) => each !== 'DELIVERED')) {
      expect(FEED_STATE_MAP[state]).toEqual(NOTIFICATION_STATE_MAP[state]);
    }
  });

  it('give failure the danger tone and success the success tone, as the words say', () => {
    expect(NOTIFICATION_STATE_MAP.FAILED.tone).toBe('danger');
    expect(NOTIFICATION_STATE_MAP.DELIVERED.tone).toBe('success');
  });
});

describe('the words of an audience, a channel, a reason and an outcome', () => {
  it('say who a message is for', () => {
    expect(NOTIFICATION_AUDIENCES.map((audience) => AUDIENCE_LABELS[audience])).toEqual([
      'Ad-hoc sender',
      'Vendor’s registered number',
      'Rider',
      'Recipient',
      'Vendor’s feed',
      'Ops feed',
    ]);
    expect(NOTIFICATION_CHANNELS.map((channel) => CHANNEL_LABELS[channel])).toEqual([
      'Text message',
      'In-app feed',
    ]);
  });

  it('say why a message was held back', () => {
    expect(SUPPRESSION_REASONS.map((reason) => SUPPRESSION_REASON_LABELS[reason])).toEqual([
      'Switched off',
      'This number reached its daily limit',
      'The daily limit for all messages was reached',
      'The test window’s message limit was reached',
      'The number is not on the test window’s list',
      'The provider would not take this number',
      'There was no number to send to',
      'The request changed before this was sent',
      'The wording is not yet approved for real sending',
    ]);
  });

  it('say how a message ended', () => {
    expect(OUTCOME_CLASSES.map((outcome) => OUTCOME_LABELS[outcome])).toEqual([
      'The provider accepted it',
      'The provider gave no clear answer',
      'The provider refused it',
      'The network said it did not arrive',
      'Gave up after every retry',
      'Too old to send',
      'Handed back',
    ]);
  });

  // Break caught: a value drawn as its raw name, or words that carry a number, which a log of this kind must never show.
  it('never show a value as its name, and carry no digit', () => {
    const all = [
      ...Object.entries(AUDIENCE_LABELS),
      ...Object.entries(CHANNEL_LABELS),
      ...Object.entries(SUPPRESSION_REASON_LABELS),
      ...Object.entries(OUTCOME_LABELS),
      ...Object.entries(MESSAGE_KIND_LABELS),
      ...NOTIFICATION_STATES.map((state) => [state, NOTIFICATION_STATE_MAP[state].label] as const),
    ];

    for (const [name, label] of all) {
      expect(label, name).not.toBe(name);
      expect(label, name).not.toMatch(/[A-Z]_[A-Z]|\d/);
    }
  });
});

describe('the words of a message', () => {
  it.each([
    ['PICKUP_CONFIRMED_SENDER', 'Pickup request confirmed'],
    ['PICKUP_CONFIRMED_VENDOR_FEED', 'Pickup request confirmed'],
    ['PICKUP_FAILURE_ESCALATED_OPS_FEED', 'Pickup failure escalated'],
    ['RECIPIENT_HEADS_UP', 'Delivery heads-up'],
    ['RUN_REASSIGNED_RIDER', 'Run reassigned'],
  ])('call %s %j', (kind, label) => {
    expect(messageKindLabel(kind)).toBe(label);
  });

  // Break caught: a message hidden, or shown as its raw name, because the list of this screen is older than the server's.
  it.each([
    ['A_KIND_FROM_THE_FUTURE', 'A kind from the future'],
    ['NEW_KIND_SENDER', 'New kind sender'],
    ['ABC', 'Abc'],
  ])('shows a kind it does not know in sentence case: %s as %j', (kind, label) => {
    expect(messageKindLabel(kind)).toBe(label);
  });

  // Break caught: a lookup that finds the object's own prototype (`constructor`) and hands back a function where a label belongs.
  it.each([
    ['constructor', 'Constructor'],
    ['toString', 'Tostring'],
    ['hasOwnProperty', 'Hasownproperty'],
    ['__proto__', '  proto  '],
  ])('does not take %s from the object’s prototype for a kind', (name, label) => {
    expect(messageKindLabel(name)).toBe(label);
  });

  it('says the version of the wording, and the provider’s word, as supporting text', () => {
    // The number is held to its word by a no-break space, so that a narrow column never leaves it alone on a line; to the eye and to a reader
    // it is a space.
    expect(wordingVersionText(3)).toBe(`Wording version${NO_BREAK_SPACE}3`);
    expect(wordingVersionText(3).replace(NO_BREAK_SPACE, ' ')).toBe('Wording version 3');
    expect(providerWordText('REQUEST_INVALID')).toBe('Provider’s word: REQUEST_INVALID');
  });
});

describe('what happened', () => {
  it('is the reason for a message that was held back, even where it also has an outcome', () => {
    expect(whatHappenedText(entryOf(suppressedFixture('DAY_LIMIT')))).toBe(
      'The daily limit for all messages was reached',
    );
    expect(
      whatHappenedText(entryOf(suppressedFixture('OVERTAKEN', { outcome_class: 'REJECTED' }))),
    ).toBe('The request changed before this was sent');
  });

  it('is how a message ended, for every other message', () => {
    expect(whatHappenedText(entryOf(notificationFixture({ outcome_class: 'ACCEPTED' })))).toBe(
      'The provider accepted it',
    );
    expect(
      whatHappenedText(
        entryOf(notificationFixture({ state: 'FAILED', outcome_class: 'DELIVERY_FAILED' })),
      ),
    ).toBe('The network said it did not arrive');
  });

  it('is nothing for a message that has not ended in any way, and for a feed entry', () => {
    expect(
      whatHappenedText(
        entryOf(notificationFixture({ state: 'QUEUED', outcome_class: null, attempt_count: 0 })),
      ),
    ).toBeUndefined();
    expect(whatHappenedText(entryOf(feedFixture()))).toBeUndefined();
  });
});

describe('the record a log is narrowed to', () => {
  // Break caught: a kind of record without words of its own, so that a run is announced as a request (the Product Owner, 2 November 2026).
  it('has a heading, a label and a path for every kind of record the contract has', () => {
    for (const type of SUBJECT_TYPES) {
      expect(SUBJECT_HEADINGS[type], type).toBeTypeOf('string');
      expect(SUBJECT_LABELS[type], type).toBeTypeOf('string');
      expect(SUBJECT_PATHS[type]('0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d'), type).toMatch(/^\//);
    }
    expect(Object.keys(SUBJECT_HEADINGS).toSorted()).toEqual([...SUBJECT_TYPES].toSorted());
  });

  it('says a request’s messages as it always did and a run’s as the Product Owner asked', () => {
    expect(SUBJECT_HEADINGS.PICKUP_REQUEST).toBe('Messages about one request');
    expect(SUBJECT_HEADINGS.PICKUP_MANIFEST).toBe('Messages about this pickup run');
  });

  // Break caught: the run's link going anywhere the manifest screens, which are not built, would be expected to be.
  it('sends a run to the log narrowed to it, with its kind, and a request to its own page', () => {
    const id = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
    expect(SUBJECT_PATHS.PICKUP_MANIFEST(id)).toBe(
      `/messages?subject=${id}&subject_type=PICKUP_MANIFEST`,
    );
    expect(SUBJECT_PATHS.PICKUP_REQUEST(id)).toBe(`/pickup-requests/${id}`);
  });
});
