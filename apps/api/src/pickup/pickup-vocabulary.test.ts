import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REASON_FAILURE_CATEGORIES,
  WORKFLOW_REASON_DOMAINS,
} from '../platform/database/schema/reference-data.js';
import {
  decideReason,
  ReasonRefusedError,
  type ReasonRow,
} from '../platform/settings/reason-validator.js';
import { WORKFLOW_REASONS } from '../tools/seed/workflow-reasons.js';
import {
  PICKUP_FAILURE_CATEGORIES,
  PICKUP_REASON_DOMAINS,
  SKIP_REQUESTED_VENDOR_ACTIONS,
  pickupReasonRequest,
  requestedVendorActionOf,
} from './pickup-vocabulary.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const read = (path: string): string =>
  readFileSync(resolve(ROOT, path), 'utf8').replaceAll('\r', '');
const OPENAPI = read('contracts/openapi.yaml');
const FAILURE_FEATURE = read('features/pickup/pickup-failure.md');

/**
 * The words the pickup operations are written in (S1.7; domain-model.md sections 3.9 and 6.5; pickup-failure.md): the four fixed failure
 * categories, and the reason domain each pickup operation takes its reason from. Both are read from the documents here, so that a
 * category added in code only, or an operation given another domain, fails.
 */
describe('the fixed pickup-failure categories (section 21.5)', () => {
  // Break caught: a fifth category added in code (it would be accepted by no document), or one of the four missing from it.
  it('are the four of the feature, the contract’s request and the stop’s field', () => {
    const named = [
      ...FAILURE_FEATURE.matchAll(/^ {3}- \*\*one fixed category\*\* — (.*)$/gm),
    ].flatMap((match) => [...(match[1] ?? '').matchAll(/`([A-Z_]+)`/g)].map((each) => each[1]));
    expect(named).toHaveLength(4);
    expect([...PICKUP_FAILURE_CATEGORIES].toSorted()).toEqual(named.toSorted());

    const enums = [...OPENAPI.matchAll(/enum: \[VENDOR_UNAVAILABLE,([^\]]*)\]/g)].map((match) =>
      `VENDOR_UNAVAILABLE,${match[1] ?? ''}`
        .split(',')
        .map((word) => word.trim())
        .filter((word) => word !== 'null')
        .toSorted(),
    );
    expect(enums.length).toBeGreaterThanOrEqual(2);
    for (const each of enums) expect(each).toEqual([...PICKUP_FAILURE_CATEGORIES].toSorted());
  });

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(PICKUP_FAILURE_CATEGORIES)).toBe(true);
  });

  // Break caught (D-A4): the platform's copy of the categories, which the catalogue's check and the stop's guard hold, drifting from the pickup domain's list.
  it('are the four the catalogue binds a failure reason to', () => {
    expect([...REASON_FAILURE_CATEGORIES]).toEqual([...PICKUP_FAILURE_CATEGORIES]);
  });
});

describe('the reason domain of each pickup operation', () => {
  // Break caught: an operation that names an operationId the contract does not have (so no request could reach it), or a domain that
  // is not a workflow domain of the catalogue.
  it('names operations of the contract and domains of the catalogue', () => {
    const operations = new Set(
      [...OPENAPI.matchAll(/^\s+operationId:\s*(\w+)\s*$/gm)].map((match) => match[1]),
    );
    for (const [operationId, domain] of Object.entries(PICKUP_REASON_DOMAINS)) {
      expect(operations.has(operationId), operationId).toBe(true);
      expect(WORKFLOW_REASON_DOMAINS as readonly string[], operationId).toContain(domain);
    }
  });

  it('is the table of the five operations that take a catalogue reason', () => {
    expect(PICKUP_REASON_DOMAINS).toEqual({
      skipPickupStop: 'PICKUP_STOP_SKIP',
      cancelPickupRequest: 'PICKUP_CANCELLATION',
      reportPickupFailure: 'PICKUP_FAILURE',
      recordCollection: 'PICKUP_SHORT_COUNT',
      createPickupManifest: 'PICKUP_CARRYOVER',
    });
  });
});

describe('validating a reason of a pickup domain', () => {
  const rowOf = (domain: string, overrides: Partial<ReasonRow> = {}): ReasonRow => ({
    code: 'FIXTURE_CODE',
    domain,
    label: 'Fixture code',
    requires_note: false,
    requires_photo: false,
    requires_contact_attempt: false,
    requires_approval: false,
    requires_ops_review: false,
    requires_escalation: false,
    attribution: 'CUSTOMER',
    consumes_delivery_attempt: false,
    active: true,
    permitted_operations: null,
    ...overrides,
  });
  const refusal = (run: () => unknown): ReasonRefusedError => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(ReasonRefusedError);
      return error as ReasonRefusedError;
    }
    throw new Error('expected the reason to be refused');
  };

  const OPERATIONS = Object.entries(PICKUP_REASON_DOMAINS);

  // Break caught: the domain of a pickup operation not honoured, so a code of any domain (a delivery failure offered for a cancellation)
  // would pass; and the attribution not handed on, which decides the cancellation charge.
  it.each(OPERATIONS)(
    '%s accepts an active reason of %s and hands on its attribution and flags',
    (operationId, domain) => {
      const accepted = decideReason(
        pickupReasonRequest(operationId, 'FIXTURE_CODE'),
        rowOf(domain, { attribution: 'MELARC', requires_photo: true }),
      );
      expect(accepted).toMatchObject({
        code: 'FIXTURE_CODE',
        domain,
        attribution: 'MELARC',
        requiresPhoto: true,
      });
    },
  );

  // Break caught: a reason of one pickup domain accepted by an operation of another, or a retired reason, or an identity reason.
  it.each(OPERATIONS)(
    '%s refuses a reason of another domain and a retired one',
    (operationId, domain) => {
      const others = [...WORKFLOW_REASON_DOMAINS, 'SESSION_REVOCATION'].filter(
        (each) => each !== domain,
      );
      for (const other of others) {
        expect(
          refusal(() =>
            decideReason(pickupReasonRequest(operationId, 'FIXTURE_CODE'), rowOf(other)),
          ).code,
          `${operationId} given a ${other} code`,
        ).toBe('REASON_NOT_ACTIVE');
      }
      expect(
        refusal(() =>
          decideReason(
            pickupReasonRequest(operationId, 'FIXTURE_CODE'),
            rowOf(domain, { active: false }),
          ),
        ).code,
      ).toBe('REASON_NOT_ACTIVE');
    },
  );

  // Break caught: a domain with no seeded code accepting anything: the catalogue is empty, so every code is unknown.
  it.each(OPERATIONS)('%s refuses every code of a domain that has none seeded', (operationId) => {
    expect(
      refusal(() => decideReason(pickupReasonRequest(operationId, 'ANY_CODE'), undefined)).code,
    ).toBe('REASON_NOT_ACTIVE');
  });

  // Break caught: a note the reason requires not being asked for (the stop skip records the note on LOCATION_INACCESSIBLE and
  // STOP_RAISED_IN_ERROR), and a blank reason answered as an unknown one.
  it('asks for the note a reason requires, and for a reason at all', () => {
    const needsNote = rowOf('PICKUP_STOP_SKIP', { requires_note: true });
    expect(
      refusal(() => decideReason(pickupReasonRequest('skipPickupStop', 'FIXTURE_CODE'), needsNote))
        .code,
    ).toBe('REASON_REQUIRED');
    expect(
      decideReason(pickupReasonRequest('skipPickupStop', 'FIXTURE_CODE', 'Gate locked'), needsNote)
        .code,
    ).toBe('FIXTURE_CODE');
    expect(
      refusal(() => decideReason(pickupReasonRequest('skipPickupStop', undefined), needsNote)).code,
    ).toBe('REASON_REQUIRED');
  });

  // Break caught: the domain taken from the request body, which is client text.
  it('takes the domain from the operation and never from what the client sent', () => {
    const request = pickupReasonRequest('cancelPickupRequest', 'FIXTURE_CODE');
    expect(request.domain).toBe('PICKUP_CANCELLATION');
    expect(() => pickupReasonRequest('getPickupRequest', 'FIXTURE_CODE')).toThrow(TypeError);
  });
});

describe('what a skip asks of the Vendor (S1.23; domain-model.md section 3.9, MSC-DEC-412)', () => {
  const skipCodes = WORKFLOW_REASONS.filter((reason) => reason.domain === 'PICKUP_STOP_SKIP').map(
    (reason) => reason.code,
  );

  // Break caught: a seeded code that nobody decided the vendor action of (it would default to asking nothing, silently), or a decision for a
  // code the catalogue does not hold.
  it('has a decision for every seeded skip reason and for no other', () => {
    expect(skipCodes.toSorted()).toEqual(Object.keys(SKIP_REQUESTED_VENDOR_ACTIONS).toSorted());
  });

  // Break caught: a notice that asks the vendor for a correction where the skip is Melarc's own decision, or one that asks nothing where the
  // rider could not reach the place. Only an inaccessible location asks anything (the document: "reschedule, often with a location correction").
  it('asks for a corrected location where the rider could not reach it, and nothing otherwise', () => {
    expect(requestedVendorActionOf('LOCATION_INACCESSIBLE')).toBe('CORRECT_PICKUP_LOCATION');
    for (const code of skipCodes.filter((each) => each !== 'LOCATION_INACCESSIBLE')) {
      expect(requestedVendorActionOf(code), code).toBe('NONE');
    }
  });

  // Break caught: a reason the catalogue gains later with no decision here, which must ask nothing and not fail the skip.
  it('asks nothing for a code it has no decision for', () => {
    expect(requestedVendorActionOf('A_FUTURE_REASON')).toBe('NONE');
  });
});
