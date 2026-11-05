import { described } from '../platform/openapi/described-schema.js';

/**
 * The bodies of `cancelPickupRequest` and `waiveCancellationCharge` as the application describes them (S1.17): the inline body of the
 * cancellation (its reason, the optional note, the replacement of S1.18 and the discretionary charge with its reason) and the contract's
 * `CancellationChargeWaiver`, which carries a note and **no amount**: a waiver removes an applied charge in full or is not a waiver, and a
 * partial one would reprice a snapshotted charge (domain-model.md section 3.7). The conformance check compares both with the contract.
 */
export const CANCEL_BODY = described({
  type: 'object',
  required: ['reason_code'],
  properties: {
    reason_code: {
      type: 'string',
      description:
        "A reason's own metadata may make a note, photo or contact attempt mandatory\n(§35.9.2). Omitting a field the reason requires returns `REASON_REQUIRED`.\n",
    },
    note: { type: 'string' },
    create_replacement: { type: 'boolean', default: false },
    apply_charge: {
      type: 'boolean',
      description:
        "**Discretionary**. Requires `pickup.request.cancel_chargeable`\nand a rider already assigned; a vendor may never set it.\n\n**A request is ignored where the selected reason's `attribution` is\n`MELARC`**. The server records\n`cancellation_charge_outcome: EXEMPT` and the cancellation proceeds - it is\nnever refused, for the same reason a missing amount does not refuse it.\nBilling a vendor for Melarc's own operational failure is the error\n`scheduleRedelivery` already prevents by deriving `chargeable` from the same\nattribution field. `CUSTOMER` and `EXTERNAL` attribution leave this field\nexactly as discretionary as MSC-DEC-197 made it.\n\nRequired on a post-assignment cancellation — but either value is valid. The\nrequirement is that Ops makes an explicit decision, not that the charge\napplies. There is no default, because a default would let the decision go\nunmade.\n",
    },
    charge_reason_code: {
      type: 'string',
      description:
        '**Mandatory on any post-assignment cancellation**, whichever way\n`apply_charge` went. Recording why no charge applied matters as much as\nrecording why one did.\n',
    },
  },
});

export const CANCELLATION_CHARGE_WAIVER_BODY = described({
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    note: {
      type: 'string',
      minLength: 1,
      description:
        "Mandatory (blank is REASON_REQUIRED); there is no reason catalogue for a waiver (D-05). The waiver's frequency and its notes are what make the discretion observable (MSC-DEC-197).",
    },
  },
  description:
    '**No `amount` field.** A waiver removes the applied charge in full or is not a waiver.\nA partial waiver would be a repricing of a snapshotted charge, which 3.7 forbids.\n',
});
