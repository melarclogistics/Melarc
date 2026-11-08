import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of `requestOnePackageException` and `approveOnePackageException` as the application describes them (S1.16): the contract's
 * `OnePackageExceptionRequest` (the maker's body: a note and the recipient, whose name, phone and delivery address section 21.1 makes
 * mandatory for a single package) and the `Approval` both operations answer (the uniform maker-checker record). The conformance check
 * compares both with the contract. A note that is blank is `REASON_REQUIRED`, which the schema's `minLength` cannot say (a note of spaces
 * is long enough), so the service judges it.
 */
export const ONE_PACKAGE_EXCEPTION_REQUEST_BODY = described({
  type: 'object',
  required: ['note', 'recipient'],
  additionalProperties: false,
  properties: {
    note: {
      type: 'string',
      minLength: 1,
      description:
        'Mandatory (blank is REASON_REQUIRED); there is no reason catalogue for the exception (D-05).',
    },
    recipient: {
      type: 'object',
      required: ['name', 'phone', 'location'],
      additionalProperties: false,
      description:
        'Mandatory for a one-package request (21.1); the delivery address makes the estimate exact.',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
        location: {
          type: 'object',
          required: ['address'],
          properties: {
            address: { type: 'string' },
            landmark: { type: 'string' },
            map_link: { type: 'string', format: 'uri' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
          },
          description:
            'Coordinates are optional and must never be required for validity — the operation runs on\nlandmarks and phone calls. Service zone is **resolved from** a location, never stored on\nit, because zones are hub-owned and versioned.\n',
        },
      },
    },
  },
});

export const APPROVAL_SCHEMA = described({
  type: 'object',
  required: ['id', 'state', 'requested_by'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    state: { type: 'string', enum: ['REQUESTED', 'APPROVED', 'REJECTED'] },
    requested_by: { type: 'string', format: 'uuid' },
    approved_by: { type: ['string', 'null'], format: 'uuid' },
    reason_code: { type: 'string' },
    note: { type: 'string' },
  },
});
