import {
  NOTIFICATION_AUDIENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_OUTCOME_CLASSES,
  NOTIFICATION_STATES,
  NOTIFICATION_SUBJECT_TYPES,
  SUPPRESSION_REASONS,
} from '../platform/notifications/notification-vocabulary.js';
import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of the Ops message log as the application describes them (S1.12e; `NotificationLogEntry` and the list's envelope of the
 * contract); the conformance check compares them with the contract. The closed sets are the vocabulary's own, the ones the table repeats
 * as a CHECK, so a state added to the lane and not to the contract is a finding of the check and not a surprise to a client.
 *
 * **What the representation never carries:** a destination in clear, a text, a code, the digest the daily limits count on, the
 * provider's reference or the lease. A route test holds the closed list of fields to the contract's, so that none grows in silently.
 */

export const NOTIFICATION_LOG_ENTRY_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'message_kind',
    'template_version',
    'audience',
    'channel',
    'state',
    'subject',
    'responsible_hub_id',
    'attempt_count',
    'expires_at',
    'created_at',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    message_kind: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,63}$' },
    template_version: { type: 'integer', minimum: 1 },
    audience: { type: 'string', enum: [...NOTIFICATION_AUDIENCES] },
    channel: { type: 'string', enum: [...NOTIFICATION_CHANNELS] },
    state: { type: 'string', enum: [...NOTIFICATION_STATES] },
    suppression_reason: { type: ['string', 'null'], enum: [...SUPPRESSION_REASONS, null] },
    outcome_class: { type: ['string', 'null'], enum: [...NOTIFICATION_OUTCOME_CLASSES, null] },
    provider_outcome_class: { type: ['string', 'null'], pattern: '^[A-Z][A-Z0-9_]{0,47}$' },
    destination_hint: { type: ['string', 'null'], maxLength: 24 },
    attempt_count: { type: 'integer', minimum: 0 },
    subject: {
      type: 'object',
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', enum: [...NOTIFICATION_SUBJECT_TYPES] },
        id: { type: 'string', format: 'uuid' },
      },
    },
    responsible_hub_id: { type: 'string', format: 'uuid' },
    sent_at: { type: ['string', 'null'], format: 'date-time' },
    delivered_at: { type: ['string', 'null'], format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
  },
});

export const NOTIFICATION_LOG_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: { type: 'array', items: NOTIFICATION_LOG_ENTRY_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
  },
});

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
