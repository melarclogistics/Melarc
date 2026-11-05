import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of `findAdHocSender` as the application describes them (S1.14): the contract's `AdHocSender` with its references followed,
 * and the envelope the operation answers, which holds zero or one (the phone is the identity). The conformance check compares both with
 * the contract.
 */
export const AD_HOC_SENDER_SCHEMA = described({
  type: 'object',
  required: ['id', 'display_name', 'phone', 'state'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    display_name: { type: 'string' },
    phone: { type: 'string' },
    state: { type: 'string', enum: ['PROVISIONAL', 'REUSABLE'] },
    blocked: { type: 'boolean' },
  },
});

export const AD_HOC_SENDER_LIST = described({
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array', maxItems: 1, items: AD_HOC_SENDER_SCHEMA } },
});
