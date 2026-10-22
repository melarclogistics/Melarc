import { described } from '../platform/openapi/described-schema.js';
import { STAFF_STATUSES } from './staff-identity.schema.js';

/**
 * The shapes of the staff reads as the application describes them (`StaffIdentity` and the list's envelope of the contract); the
 * conformance check compares them with the contract. **No credential property, ever** (domain-model.md section 6.8): not the hash, the
 * moment it was established, its generation, the failed-attempt count, the lock, the version or a factor's secret. `mfa_enrolled` is
 * derived from the recorded factor and never settable, and `mfa_reset_state` is the projection of the one rule that decides the reset
 * (`platform/auth/mfa/mfa-reset-state.ts`).
 */
export const STAFF_IDENTITY_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'work_email',
    'full_name',
    'status',
    'role_bundle_id',
    'mfa_enrolled',
    'mfa_reset_state',
    'created_by',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    work_email: { type: 'string' },
    full_name: { type: 'string' },
    phone: { type: ['string', 'null'] },
    status: { type: 'string', enum: [...STAFF_STATUSES] },
    role_bundle_id: { type: 'string', format: 'uuid' },
    primary_hub_id: { type: ['string', 'null'], format: 'uuid' },
    mfa_enrolled: { type: 'boolean' },
    mfa_reset_state: {
      type: 'string',
      readOnly: true,
      enum: ['FACTOR_ACTIVE', 'ENROLMENT_UNFINISHED', 'NOT_ELIGIBLE'],
    },
    created_by: { type: 'string', format: 'uuid' },
    approved_by: { type: ['string', 'null'], format: 'uuid' },
  },
});

export const STAFF_IDENTITY_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: { type: 'array', items: STAFF_IDENTITY_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
  },
});

/** The one header of the read of a record: the version a mutation takes back as `If-Match`. */
export const ETAG_HEADERS = {
  ETag: {
    description: 'Opaque record version. Send back as `If-Match` on the next mutation.',
    schema: { type: 'string' },
  },
} as unknown as Record<string, never>;

/** The page size of a list: 25 unless the caller says (the contract's `PageSize`). */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_SEARCH_LENGTH = 128;
