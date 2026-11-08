import {
  ENROLMENT_URI_LENGTH,
  ENROLMENT_URI_PATTERN,
} from '../platform/auth/rider/enrolment-uri.js';
import { RIDER_STATUSES } from '../platform/auth/rider/rider-vocabulary.js';
import { REGISTERED_DEVICE_SCHEMA } from '../platform/auth/vendor/vendor-setup-schemas.js';
import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of the rider reads as the application describes them (`RiderSummary`, `RiderDetail` and the list's envelope of the contract);
 * the conformance check compares them with the contract. **No credential property, ever** (domain-model.md section 6.8; AC-SLICE-000-113):
 * not the PIN, its hash, its generation, the failed-attempt count, the lock, a device's key or an attestation. A rider is **identity and
 * readiness** (`pin_established`, `has_active_device`).
 */
export const RIDER_SUMMARY_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'full_name',
    'phone',
    'status',
    'primary_hub_id',
    'pin_established',
    'has_active_device',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    full_name: { type: 'string' },
    phone: { type: 'string' },
    status: { type: 'string', enum: [...RIDER_STATUSES] },
    primary_hub_id: { type: 'string', format: 'uuid' },
    pin_established: { type: 'boolean' },
    has_active_device: { type: 'boolean' },
  },
});

export const RIDER_DETAIL_SCHEMA = described({
  type: 'object',
  required: ['rider', 'devices'],
  properties: {
    rider: RIDER_SUMMARY_SCHEMA,
    devices: { type: 'array', items: REGISTERED_DEVICE_SCHEMA },
  },
});

export const RIDER_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: { type: 'array', items: RIDER_SUMMARY_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
  },
});

/**
 * `DeviceEnrolmentGrant`: what `registerRiderDevice` and `reregisterRiderDevice` answer. The URI is the one place the grant's token and the
 * attestation challenge appear (served `no-store`, never logged or audited); there is no PIN, no key and no session in it.
 */
export const DEVICE_ENROLMENT_GRANT_SCHEMA = described({
  type: 'object',
  required: ['enrolment_uri', 'expires_at'],
  additionalProperties: false,
  properties: {
    enrolment_uri: {
      type: 'string',
      pattern: ENROLMENT_URI_PATTERN,
      minLength: ENROLMENT_URI_LENGTH,
      maxLength: ENROLMENT_URI_LENGTH,
    },
    expires_at: { type: 'string', format: 'date-time' },
    rider_id: { type: 'string', format: 'uuid' },
  },
});

/** `DeviceRevocation`: a reason of the catalogue's revocation domain and nothing else; no identifier of a device, and no replacement. */
export const DEVICE_REVOCATION_BODY = described({
  type: 'object',
  required: ['reason_code'],
  additionalProperties: false,
  properties: {
    reason_code: { type: 'string' },
  },
});

/** `RiderDeviceReregistration`: a reason of the catalogue and how the rider's identity was verified in person; no identifier of a device. */
export const RIDER_DEVICE_REREGISTRATION_BODY = described({
  type: 'object',
  required: ['reason_code', 'verification_note'],
  additionalProperties: false,
  properties: {
    reason_code: { type: 'string' },
    verification_note: { type: 'string', minLength: 1 },
  },
});
