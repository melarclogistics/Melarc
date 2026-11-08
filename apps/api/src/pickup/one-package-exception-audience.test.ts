import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { ContractValidator } from '../platform/contract/contract-validator.js';
import { isJsonObject, type JsonObject } from '../platform/contract/json.js';
import { locateContract } from '../platform/contract/locate-contract.js';
import { exceptionViewOf, type ExceptionRow } from './one-package-exception-view.js';
import {
  exceptionAudienceOf,
  forAudience,
  viewOf,
  type PickupRequestRow,
  type PickupRequestView,
} from './pickup-request-view.js';

/**
 * Who reads what of a one-package exception, held to the published contract (S1.16; the Product Owner's decision of 29 October 2026): **staff read the
 * exception in whole** (who asked, who decided it, why) and **every other audience reads its outcome only**, without those three members. The contract
 * says it as two views and not as one view with three optional members (`OnePackageException` and `OnePackageExceptionOutcome`, which are not
 * both a valid answer for one reader), so that each guarantee is a rule a validator can enforce: a staff answer that loses one of the three, and an
 * outcome that gains one, are answers the contract refuses. The projections are the real ones (`exceptionViewOf`, `forAudience`) and the judge is
 * the one that validates every response of a running API outside production (`ContractValidator`).
 */
const CONTRACT = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;
const validator = new ContractValidator(CONTRACT);

const COMPONENTS = CONTRACT.components;
const SCHEMAS: JsonObject =
  isJsonObject(COMPONENTS) && isJsonObject(COMPONENTS.schemas) ? COMPONENTS.schemas : {};

/** The three members that are staff's: who asked, who decided, and why. */
const STAFF_ONLY = ['requested_by', 'approved_by', 'note'] as const;

const REQUEST: PickupRequestRow = {
  id: '5eed0200-0000-4000-8000-000000000001',
  code: 'ACC-PR-7K3M9Q',
  state: 'PENDING',
  responsible_hub_id: '5eed0100-0000-4000-8000-000000000001',
  pickup_intent: 'OWN_PACKAGES',
  vendor_organization_id: '5eed0300-0000-4000-8000-000000000001',
  ad_hoc_sender_id: null,
  sender_name: 'Demonstration Vendor',
  collection_point: null,
  collection_reference: null,
  collection_item: null,
  destination_location_id: null,
  pickup_location: null,
  resolved_pickup_location: { address: 'Shop, Community 1' },
  current_item_description: null,
  scheduled_service_date: '2026-11-03',
  declared_package_count: 1,
  default_payer_intent: 'RECIPIENT_PAYS',
  one_package_exception_id: null,
  attempt_number: 1,
  replaces_request_id: null,
  replacement_request_id: null,
  cancelled_by_actor_type: null,
  declared_value_minor: null,
  liability_cap_acknowledged_at: null,
  liability_cap_snapshot: null,
  cancellation_charge_outcome: null,
  cancellation_charge_snapshot: null,
  created_at: new Date('2026-11-02T09:00:00.000Z'),
  created_at_text: '2026-11-02 09:00:00+00',
  confirmed_at: null,
  cancelled_at: null,
  escalated_at: null,
  cutoff_exception_state: null,
  vendor_pickup_location_id: null,
  primary_phone: '+233200000001',
  secondary_phone: null,
  split_basis: null,
  split_sender_amount_minor: null,
  split_sender_percentage: null,
  location_overrides: null,
  attempt_extension_id: null,
  cancellation_reason_code: null,
  cancellation_reason_label: null,
  rider_assigned: false,
  version: 1,
};

/** An exception that was asked for and waits for a checker, and one that a checker approved: the two shapes `approved_by` takes. */
const ASKED: ExceptionRow = {
  id: '5eed0400-0000-4000-8000-000000000001',
  pickup_request_id: REQUEST.id,
  state: 'REQUESTED',
  requested_by: '5eed0500-0000-4000-8000-000000000001',
  requested_at: '2026-11-02T09:05:00.000Z',
  approved_by: null,
  decided_at: null,
  note: 'A bridal gown, urgent',
  recipient_name: 'Abena Demo',
  recipient_phone: '+233240000000',
  recipient_location: { address: '9 Demo Street, Tema', landmark: 'Near the demo clinic' },
  single_package_fee_snapshot: null,
};

const DECIDED: ExceptionRow = {
  ...ASKED,
  state: 'APPROVED',
  approved_by: '5eed0500-0000-4000-8000-000000000002',
  decided_at: '2026-11-02T09:30:00.000Z',
  single_package_fee_snapshot: {
    amount_minor: 2000,
    setting_key: 'single_package_pickup_fee',
    effective_version: '3',
  },
};

/** The request as the answer of `principalType` reads it: the real projection, built from the real view of the exception. */
function answerFor(principalType: string, exception: ExceptionRow | null): PickupRequestView {
  return forAudience(
    viewOf(REQUEST, { exception: exception === null ? null : exceptionViewOf(exception) }),
    exceptionAudienceOf(principalType),
  );
}

/** What the contract says of `one_package_exception` in a `getPickupRequest` answer, or nothing at all when the answer is valid there. */
function violationsOfException(body: unknown): string[] {
  return validator
    .validateResponse(
      'getPickupRequest',
      { status: 200, body, headers: { etag: '"5eed"' } },
      { headers: {} },
    )
    .filter((violation) => violation.in === 'response-body')
    .filter((violation) => violation.pointer.startsWith('/one_package_exception'))
    .map((violation) => `${violation.pointer} ${violation.rule}`);
}

/** The same answer with the exception replaced by `exception`, as a client would receive it over the wire. */
const withException = (exception: unknown): unknown => ({
  ...(JSON.parse(JSON.stringify(answerFor('STAFF', null))) as object),
  one_package_exception: exception,
});

const wire = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const exceptionOf = (view: PickupRequestView): Record<string, unknown> =>
  wire(view.one_package_exception);

describe('a staff principal reads the exception in whole', () => {
  it.each([
    ['asked for and waiting', ASKED],
    ['approved, with its checker and its fee', DECIDED],
  ])(
    'has the three staff-only members, and the contract takes the answer, when it is %s',
    (_state, row) => {
      const shown = answerFor('STAFF', row);

      expect(Object.keys(exceptionOf(shown))).toEqual(expect.arrayContaining([...STAFF_ONLY]));
      expect(violationsOfException(wire(shown))).toEqual([]);
    },
  );

  // Break caught: the checker left out of an exception that nobody has decided, which a client would read as "not yet known" and not as "not yet".
  it('says that nobody has decided it with a null checker, and not with no checker at all', () => {
    const shown = exceptionOf(answerFor('STAFF', ASKED));

    expect(shown).toHaveProperty('approved_by', null);
    expect(shown).toHaveProperty('decided_at', null);
  });

  // Break caught: a staff answer that lost one of the three (a serializer that drops a member, a projection that treated the reader as less than
  // staff), which would show the maker-checker screens an exception with no maker or no reason, and which the contract's one shared shape accepted.
  it.each(STAFF_ONLY)('is refused by the contract when it lacks %s', (member) => {
    const without = Object.fromEntries(
      Object.entries(exceptionOf(answerFor('STAFF', DECIDED))).filter(([key]) => key !== member),
    );

    expect(violationsOfException(withException(without))).not.toEqual([]);
  });

  it('is refused by the contract when its requester is not an identifier', () => {
    const asked = { ...exceptionOf(answerFor('STAFF', ASKED)), requested_by: 'someone' };

    expect(violationsOfException(withException(asked))).not.toEqual([]);
  });
});

describe('every other principal reads the outcome only', () => {
  it.each([
    ['asked for and waiting', ASKED],
    ['approved, with its fee', DECIDED],
  ])(
    'has none of the three staff-only members, and the contract takes the answer, when it is %s',
    (_state, row) => {
      const shown = answerFor('VENDOR', row);

      for (const member of STAFF_ONLY) expect(exceptionOf(shown)).not.toHaveProperty(member);
      expect(violationsOfException(wire(shown))).toEqual([]);
    },
  );

  it('keeps the outcome: the state, when it was asked for and decided, the recipient and the fee that became due', () => {
    expect(exceptionOf(answerFor('VENDOR', DECIDED))).toEqual({
      id: DECIDED.id,
      state: 'APPROVED',
      requested_at: DECIDED.requested_at,
      decided_at: DECIDED.decided_at,
      recipient: {
        name: 'Abena Demo',
        phone: '+233240000000',
        location: { address: '9 Demo Street, Tema', landmark: 'Near the demo clinic' },
      },
      single_package_fee: { amount_minor: 2000, currency: 'GHS' },
    });
  });

  // Break caught: a principal that is not staff read as staff because its name is spelt a little differently, or because it is a kind added later;
  // the audience fails closed, so only the exact word is staff.
  it.each(['VENDOR', 'RIDER', '', 'staff', 'Staff', ' STAFF', 'STAFF ', 'ADMIN', 'SERVICE'])(
    'reads the outcome only for the principal %j',
    (principalType) => {
      expect(exceptionAudienceOf(principalType)).toBe('OUTCOME_ONLY');
      const shown = answerFor(principalType, DECIDED);

      for (const member of STAFF_ONLY) expect(exceptionOf(shown)).not.toHaveProperty(member);
    },
  );

  // Break caught: an outcome that gained one of the three (a leak of who asked, who decided or why), which the contract's one shared shape accepted
  // and which now matches neither view.
  it.each(STAFF_ONLY)('is refused by the contract when it carries %s', (member) => {
    const leaked = { ...exceptionOf(answerFor('VENDOR', DECIDED)), [member]: ASKED.note };
    const withIdentifier = member === 'note' ? leaked : { ...leaked, [member]: ASKED.requested_by };

    expect(violationsOfException(withException(withIdentifier))).not.toEqual([]);
  });

  it('is refused by the contract when it carries something else that is not its own', () => {
    const extra = { ...exceptionOf(answerFor('VENDOR', DECIDED)), internal_ref: 'x' };

    expect(violationsOfException(withException(extra))).not.toEqual([]);
  });
});

describe('a request with no exception, for either audience', () => {
  it.each(['STAFF', 'VENDOR'])(
    'has none, and the contract takes the answer, for %s',
    (principalType) => {
      const shown = answerFor(principalType, null);

      expect(shown.one_package_exception).toBeNull();
      expect(violationsOfException(wire(shown))).toEqual([]);
    },
  );
});

describe('the contract’s two views of an exception', () => {
  const view = (name: string): JsonObject => {
    const found = SCHEMAS[name];
    if (!isJsonObject(found)) throw new Error(`The contract has no schema ${name}`);
    return found;
  };
  const propertiesOf = (schema: JsonObject): JsonObject =>
    isJsonObject(schema.properties) ? schema.properties : {};
  const requiredOf = (schema: JsonObject): string[] =>
    Array.isArray(schema.required) ? (schema.required as string[]) : [];

  it('has the staff view require the three members and the outcome view carry none of them', () => {
    const staff = view('OnePackageException');
    const outcome = view('OnePackageExceptionOutcome');

    for (const member of STAFF_ONLY) {
      expect(requiredOf(staff), member).toContain(member);
      expect(Object.keys(propertiesOf(outcome)), member).not.toContain(member);
    }
  });

  // Break caught: an outcome that is open, which a staff member added to it later would pass unnoticed: the omission is the guard.
  it('has the outcome view closed, so that nothing else can be added to what every other audience reads', () => {
    expect(view('OnePackageExceptionOutcome').additionalProperties).toBe(false);
  });

  // Break caught: the two views drifting apart in a member they share, so that the vendor's outcome would say something the staff view does not.
  it('has the outcome view be the staff view without exactly those three members', () => {
    const staff = propertiesOf(view('OnePackageException'));
    const outcome = propertiesOf(view('OnePackageExceptionOutcome'));

    expect(Object.keys(outcome).toSorted()).toEqual(
      Object.keys(staff)
        .filter((name) => !(STAFF_ONLY as readonly string[]).includes(name))
        .toSorted(),
    );
    for (const [name, schema] of Object.entries(outcome)) {
      expect(schema, name).toEqual(staff[name]);
    }
  });

  it('offers a request either view, or none', () => {
    const request = propertiesOf(view('PickupRequest')).one_package_exception;
    const branches = isJsonObject(request) && Array.isArray(request.oneOf) ? request.oneOf : [];

    expect(branches).toEqual([
      { $ref: '#/components/schemas/OnePackageException' },
      { $ref: '#/components/schemas/OnePackageExceptionOutcome' },
      { type: 'null' },
    ]);
  });
});
