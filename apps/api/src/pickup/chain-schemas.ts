import { described } from '../platform/openapi/described-schema.js';

/**
 * The bodies of `extendPickupAttempts` and `escalatePickupRequest` as the application describes them (S1.18): the contract's
 * `AttemptExtension`, a reason and **no ceiling of its own** (an extension permits one further attempt, and a settable ceiling would let one
 * action make a request uncapped), and `PickupEscalation`, a note and **no resolution** (reschedule and cancel are `cancelPickupRequest`, and
 * the escalation-only rule of a refused collection stays behind a separate permissioned call). The conformance check compares both with the
 * contract.
 */
export const ATTEMPT_EXTENSION_BODY = described({
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    reason: {
      type: 'string',
      minLength: 1,
      description: 'Mandatory and immutable once recorded (21.6, MSC-DEC-116).',
    },
  },
  description:
    '**No `new_ceiling` field.** The extension is granted for this request, once; it is not a\nper-request configuration value. A settable ceiling would let one Senior Ops action\ncreate an effectively uncapped request, which is what the cap exists to prevent.\n',
});

export const ESCALATION_BODY = described({
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    note: {
      type: 'string',
      minLength: 1,
      description:
        "Mandatory (blank is REASON_REQUIRED); there is no reason catalogue for an escalation (D-05). Also carries the assisted review of AC-SLICE-001-35: what the vendor's support contact asked and what Ops decided, audited with the reviewer and the time. A review never reverses a physical failure.",
    },
  },
  description:
    '**No `resolution` field, and that is deliberate.** Escalation is the terminal Ops\nresolution; reschedule and cancel are `cancelPickupRequest`. Collapsing all three into\none enum-carrying endpoint would put the escalation-only rule for `REFUSED_COLLECTION`\nbehind a runtime branch instead of behind a separate permissioned call.\n',
});
