import { described } from '../platform/openapi/described-schema.js';

/**
 * The bodies and the answer of the custody handover operations as the application describes them (S1.24): the contract's
 * `RunCustodyHandoverCreate`, `RunCustodyHandoverAccept`, `RunCustodyHandoverFail` and `RunCustodyHandover`. The conformance check compares them
 * with the contract; a member added to the contract and not here is a finding, and a body the contract's schema refuses never reaches the service.
 */

export const RUN_CUSTODY_HANDOVER_CREATE_BODY = described({
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    to_rider_id: { type: 'string', format: 'uuid' },
    to_hub_id: { type: 'string', format: 'uuid' },
    note: {
      type: 'string',
      minLength: 1,
      description:
        'Mandatory (blank is REASON_REQUIRED); there is no reason catalogue for a custody handover (D-05).',
    },
  },
  description:
    '**Exactly one of `to_rider_id` and `to_hub_id` is set**, and the schema carries no field for the\noriginal rider. A handover names where custody is **going**; where it comes **from** is read\nfrom the run. A settable origin would be a rider-ID edit wearing another name, and 36.14 forbids\nthat outright because completed-stop attribution depends on it.\n',
});

/** The largest count the column holds (`integer`): a larger one is the client's error and must never reach the statement. */
export const MAX_PARCEL_COUNT_TAKEN = 2_147_483_647;

export const RUN_CUSTODY_HANDOVER_ACCEPT_BODY = described({
  type: 'object',
  required: ['parcel_count_taken'],
  additionalProperties: false,
  properties: {
    parcel_count_taken: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_PARCEL_COUNT_TAKEN,
      description:
        'What the receiver physically took. **A custody record, not a count.** The hub blind count\nruns independently at intake and is never seeded from this figure.\n',
    },
  },
});

export const RUN_CUSTODY_HANDOVER_FAIL_BODY = described({
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    note: {
      type: 'string',
      minLength: 1,
      description: 'Why the named receiver did not take custody; mandatory.',
    },
  },
});

export const RUN_CUSTODY_HANDOVER_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'manifest_id',
    'from_rider_id',
    'to_rider_id',
    'to_hub_id',
    'state',
    'parcel_count_taken',
    'initiated_at',
    'resolved_at',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    manifest_id: { type: 'string', format: 'uuid' },
    from_rider_id: {
      type: 'string',
      format: 'uuid',
      description:
        "The rider who held custody when the handover was opened. Never overwritten, and never the\nassigned rider's id rewritten: completed-stop attribution depends on it.\n",
    },
    to_rider_id: { type: ['string', 'null'], format: 'uuid' },
    to_hub_id: { type: ['string', 'null'], format: 'uuid' },
    state: { type: 'string', enum: ['PENDING', 'COMPLETED', 'FAILED'] },
    parcel_count_taken: {
      type: ['integer', 'null'],
      description:
        'Set exactly when the handover is COMPLETED. A custody record, never a count the hub is\ngiven to match.\n',
    },
    initiated_at: { type: 'string', format: 'date-time' },
    resolved_at: {
      type: ['string', 'null'],
      format: 'date-time',
      description: 'Set exactly when the handover is COMPLETED or FAILED.',
    },
  },
  description:
    "Carries no note: the note of opening or failing a handover is Ops's own text, in the audit\ntrail, and a rider party to the handover is not shown it.\n",
});

export const RUN_CUSTODY_HANDOVER_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: { type: 'array', items: RUN_CUSTODY_HANDOVER_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
  },
});
