import {
  DEVICE_STATUSES,
  VENDOR_ACCOUNT_STATUSES,
} from '../platform/auth/vendor/vendor-vocabulary.js';
import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of the vendor reads as the application describes them (`VendorAccountSummary`, `VendorAccountDetail`, `RegisteredDevice` and
 * the list's envelope of the contract); the conformance check compares them with the contract. **No credential property, ever**: not the
 * secret's hash, its generation, the lockout, a browser credential's hash, and never a recovery address or number (the summary says
 * *whether* one exists).
 */
export const VENDOR_ACCOUNT_SUMMARY_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'account_identifier',
    'vendor_organization_id',
    'legal_name',
    'responsible_hub_id',
    'status',
    'credential_established',
    'active_device_count',
    'has_recovery_email',
    'has_recovery_phone',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    account_identifier: { type: 'string' },
    vendor_organization_id: { type: 'string', format: 'uuid' },
    legal_name: { type: 'string' },
    responsible_hub_id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: [...VENDOR_ACCOUNT_STATUSES] },
    credential_established: { type: 'boolean' },
    active_device_count: { type: 'integer', minimum: 0 },
    has_recovery_email: { type: 'boolean' },
    has_recovery_phone: { type: 'boolean' },
    delivery_channel: { type: ['string', 'null'], enum: ['PHONE', 'EMAIL', null], readOnly: true },
  },
});

/** A registered browser. The contract's closed sets name the rider's kind and principal too; a vendor read returns only its own. */
export const REGISTERED_DEVICE_SCHEMA = described({
  type: 'object',
  required: ['id', 'principal_type', 'principal_id', 'device_kind', 'status'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    principal_type: { type: 'string', enum: ['RIDER', 'VENDOR'] },
    principal_id: { type: 'string', format: 'uuid' },
    device_kind: { type: 'string', enum: ['RIDER_ANDROID_KEYPAIR', 'VENDOR_BROWSER_CREDENTIAL'] },
    status: { type: 'string', enum: [...DEVICE_STATUSES] },
    registered_at: { type: 'string', format: 'date-time' },
    registered_by: { type: ['string', 'null'], format: 'uuid' },
  },
});

export const VENDOR_ACCOUNT_DETAIL_SCHEMA = described({
  type: 'object',
  required: ['account', 'devices'],
  properties: {
    account: VENDOR_ACCOUNT_SUMMARY_SCHEMA,
    devices: { type: 'array', items: REGISTERED_DEVICE_SCHEMA },
  },
});

export const VENDOR_ACCOUNT_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: { type: 'array', items: VENDOR_ACCOUNT_SUMMARY_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
  },
});
