import type { components } from '@melarc/api-client';

/**
 * Real-shaped answers of the message log, for tests (S1.12e). Every field the contract requires is present and each value is synthetic. The
 * types are the contract's: nothing here describes the wire a second time. **No entry holds a number in clear, a text or a code**, as the
 * contract says; `plantedIn` adds some in fields the contract does not name, so that a test can prove a screen never draws them.
 */
type NotificationBody = components['schemas']['NotificationLogEntry'];

export const NOTIFICATION_HUB_ID = '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d';
export const NOTIFICATION_REQUEST_ID = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
export const OTHER_REQUEST_ID = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';
/** A pickup run (a manifest): the record the rider's run text is about. */
export const NOTIFICATION_RUN_ID = '2c3d4e5f-6a7b-4c8d-8e9f-0a1b2c3d4e5f';

/** The hint the server makes of `+233201234567`: the country part, stars, the last three digits. */
export const HINT = '+233******567';

/** A full number, a text and a code that no entry carries. If any is ever drawn or sent, a screen showed or asked for what it must not. */
export const PLANTED_NUMBER = '+233209998877';
export const PLANTED_TEXT = 'Planted words of a message: your pickup is confirmed';
export const PLANTED_CODE = 'PLANTED-CODE-4821';

let counter = 0;

/** A fresh, valid identifier: version 4, variant 8. */
export function notificationId(): string {
  counter += 1;
  return `c0a8d4e2-71b3-4f5a-8c60-${counter.toString(16).padStart(12, '0')}`;
}

/**
 * A confirmation texted to an ad-hoc sender, delivered and received: the resting value of an entry the lane wrote. `created_at` is a time in
 * Accra's day, so the screen's 24-hour time is the same in any zone.
 */
export function notificationFixture(overrides: Partial<NotificationBody> = {}): NotificationBody {
  return {
    id: notificationId(),
    message_kind: 'PICKUP_CONFIRMED_SENDER',
    template_version: 1,
    audience: 'AD_HOC_SENDER',
    channel: 'SMS',
    state: 'DELIVERED',
    suppression_reason: null,
    outcome_class: 'ACCEPTED',
    provider_outcome_class: null,
    destination_hint: HINT,
    attempt_count: 1,
    subject: { type: 'PICKUP_REQUEST', id: NOTIFICATION_REQUEST_ID },
    responsible_hub_id: NOTIFICATION_HUB_ID,
    sent_at: '2026-10-29T08:16:00.000Z',
    delivered_at: '2026-10-29T08:16:30.000Z',
    expires_at: '2026-10-29T14:15:00.000Z',
    created_at: '2026-10-29T08:15:00.000Z',
    ...overrides,
  };
}

/** The text to a rider that their pickup run is ready (S1.21): about a run and not about a request, sent and delivered. */
export function runTextFixture(overrides: Partial<NotificationBody> = {}): NotificationBody {
  return notificationFixture({
    message_kind: 'RUN_DISPATCHED_RIDER',
    audience: 'RIDER',
    subject: { type: 'PICKUP_MANIFEST', id: NOTIFICATION_RUN_ID },
    created_at: '2026-10-29T08:30:00.000Z',
    sent_at: '2026-10-29T08:31:00.000Z',
    delivered_at: '2026-10-29T08:31:30.000Z',
    ...overrides,
  });
}

/** The confirmation written to a registered vendor's feed: no number, nothing sent, delivered when written. */
export function feedFixture(overrides: Partial<NotificationBody> = {}): NotificationBody {
  return notificationFixture({
    message_kind: 'PICKUP_CONFIRMED_VENDOR_FEED',
    audience: 'VENDOR_FEED',
    channel: 'FEED',
    outcome_class: null,
    destination_hint: null,
    attempt_count: 0,
    sent_at: null,
    delivered_at: null,
    expires_at: '2027-01-27T08:15:00.000Z',
    ...overrides,
  });
}

/** A message held back, with the reason it was held back for: never sent, so with no attempt and no word of a provider's. */
export function suppressedFixture(
  reason: NonNullable<NotificationBody['suppression_reason']>,
  overrides: Partial<NotificationBody> = {},
): NotificationBody {
  return notificationFixture({
    state: 'SUPPRESSED',
    suppression_reason: reason,
    outcome_class: null,
    attempt_count: 0,
    sent_at: null,
    delivered_at: null,
    ...overrides,
  });
}

/**
 * The entry with a number in clear, a text and a code in fields the contract does not name, as an answer that is not the API's (or an API with
 * a defect) might carry them. The screen must show none of them and ask for none of them.
 */
export function plantedIn(entry: NotificationBody): unknown {
  return {
    ...entry,
    destination: PLANTED_NUMBER,
    destination_digest: 'a'.repeat(64),
    recipient_phone: PLANTED_NUMBER,
    text: PLANTED_TEXT,
    body: PLANTED_TEXT,
    code: PLANTED_CODE,
    handshake_code: PLANTED_CODE,
    provider_message_ref: PLANTED_CODE,
  };
}
