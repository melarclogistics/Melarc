import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { ContractValidator, type RequestParts, type ResponseParts } from './contract-validator.js';
import { isJsonObject, type JsonObject } from './json.js';
import { locateContract } from './locate-contract.js';

/**
 * Behaviour of the real contracts/openapi.yaml, read through the validator that will enforce it. These are the
 * corrections made to the contract in audit task 4: each is a rule the contract states in words and now states
 * in a form a validator can enforce, so the test is the proof that the form works and not only that the words
 * are there.
 */
const CONTRACT = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;
const validator = new ContractValidator(CONTRACT);
const UUID_SAMPLE = '0190d7c2-7a3e-7c1e-9d2a-3f4b5c6d7e8f';

function response(overrides: Partial<ResponseParts> = {}): ResponseParts {
  return { status: 200, body: undefined, headers: {}, ...overrides };
}

/** Only the response headers of an answer: the body is another rule, and these tests are not about it. */
const headerViolations = (operationId: string, headers: Record<string, unknown>) =>
  validator
    .validateResponse(operationId, response({ headers }))
    .filter((violation) => violation.in === 'response-header');

describe('Cache-Control: no-store (audit C-cache)', () => {
  // The four answers whose description says the response is never to be cached: two retrieval authorizations
  // (a bearer capability over stored evidence or a payment-ledger package) and two enrolment grants (a setup
  // credential). Their header is declared once in the shared component and twice inline.
  const NO_STORE_OPERATIONS = [
    'createEvidenceRetrievalAuthorization',
    'createAccountingExportRetrievalAuthorization',
    'registerRiderDevice',
    'reregisterRiderDevice',
  ];

  // Break caught: an answer carrying a capability or a setup credential being cacheable because the header was
  // missing. The header was declared as any string and not required, so none of these was a violation.
  it.each(NO_STORE_OPERATIONS)('requires the header on %s', (operationId) => {
    expect(headerViolations(operationId, {})).toEqual([
      { in: 'response-header', pointer: 'cache-control', rule: 'required' },
    ]);
  });

  // Break caught: a header that is there and says something else. `public, max-age=3600` on a retrieval
  // authorization would let an intermediary keep a bearer capability.
  it.each(NO_STORE_OPERATIONS)('refuses any value but no-store on %s', (operationId) => {
    for (const value of [
      'public, max-age=3600',
      'no-cache',
      'private',
      'No-Store',
      'no-store, public',
      '',
    ]) {
      expect(headerViolations(operationId, { 'cache-control': value }), value).toEqual([
        { in: 'response-header', pointer: 'cache-control', rule: 'const' },
      ]);
    }
  });

  it.each(NO_STORE_OPERATIONS)('accepts no-store on %s', (operationId) => {
    expect(headerViolations(operationId, { 'cache-control': 'no-store' })).toEqual([]);
  });

  // Break caught: the rule spreading to cache policies it was not written for. Every other response keeps whatever
  // it has: nothing else declares a Cache-Control header, and none of them is made to.
  it('is declared on those four responses and no other', () => {
    const declaring: string[] = [];
    for (const [path, item] of Object.entries(CONTRACT.paths as JsonObject)) {
      if (!isJsonObject(item)) continue;
      for (const [method, operation] of Object.entries(item)) {
        if (!isJsonObject(operation) || !isJsonObject(operation.responses)) continue;
        for (const [status, answer] of Object.entries(operation.responses)) {
          if (!isJsonObject(answer) || !isJsonObject(answer.headers)) continue;
          if (Object.keys(answer.headers).some((name) => name.toLowerCase() === 'cache-control')) {
            declaring.push(
              typeof operation.operationId === 'string'
                ? operation.operationId
                : `${method.toUpperCase()} ${path} ${status}`,
            );
          }
        }
      }
    }

    expect(declaring.toSorted()).toEqual(NO_STORE_OPERATIONS.toSorted());
  });
});

describe('sign-out: browser cookies are expired, a bearer sign-out sets none (audit task 4)', () => {
  const EXPIRED_SESSION = 'melarc_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax';
  const EXPIRED_CSRF = 'melarc_csrf=; Max-Age=0; Path=/; Secure; SameSite=Lax';
  const EXPIRED_DEVICE = 'melarc_vendor_device=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax';
  const BROWSER: Pick<RequestParts, 'headers'> = {
    headers: { cookie: 'melarc_session=S; melarc_csrf=C', 'x-csrf-token': 'C' },
  };
  const RIDER: Pick<RequestParts, 'headers'> = { headers: { authorization: 'Bearer R' } };

  const signOut = (request: Pick<RequestParts, 'headers'>, setCookie?: string[]) =>
    validator
      .validateResponse(
        'signOut',
        response({
          status: 204,
          headers: setCookie === undefined ? {} : { 'set-cookie': setCookie },
        }),
        request,
      )
      .filter((violation) => violation.in === 'response-cookie' || violation.in === 'status');

  // Break caught: a sign-out that ends the session and leaves the browser holding its cookies.
  it('has a browser sign-out expire the session and CSRF cookies, and reports each one it leaves', () => {
    expect(signOut(BROWSER, [EXPIRED_SESSION, EXPIRED_CSRF])).toEqual([]);
    expect(signOut(BROWSER, [EXPIRED_CSRF])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'required' },
    ]);
    expect(
      signOut(BROWSER)
        .map((violation) => violation.pointer)
        .toSorted(),
    ).toEqual(['melarc_csrf', 'melarc_session']);
  });

  // Break caught: the device credential being cleared with the session, which would stop the vendor's own
  // registered browser from signing in again.
  it('never expires the vendor device credential, and refuses any other cookie', () => {
    expect(signOut(BROWSER, [EXPIRED_SESSION, EXPIRED_CSRF, EXPIRED_DEVICE])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'undeclared' },
    ]);
    expect(signOut(BROWSER, [EXPIRED_SESSION, EXPIRED_CSRF, 'analytics=1'])).toEqual([
      { in: 'response-cookie', pointer: '*', rule: 'undeclared' },
    ]);
  });

  // Break caught: cookies required of every 204, so that the Rider app, which has none, could never sign out.
  it('owes a bearer sign-out no cookie, and refuses one that sets any', () => {
    expect(signOut(RIDER)).toEqual([]);
    expect(signOut(RIDER, [EXPIRED_SESSION, EXPIRED_CSRF])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_csrf', rule: 'undeclared' },
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'undeclared' },
    ]);
  });

  // Break caught: the cookies being checked as the attributes they were set with. An expiry sent with a different
  // path or without the security attributes does not remove the cookie the browser holds.
  it('holds the expiry to the attributes the cookies were set with', () => {
    expect(
      signOut(BROWSER, [
        'melarc_session=; Max-Age=0; Path=/; Secure; SameSite=Lax',
        'melarc_csrf=; Max-Age=0; Path=/api; Secure; SameSite=Lax',
      ]),
    ).toEqual([
      { in: 'response-cookie', pointer: 'melarc_csrf', rule: 'path' },
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'httponly' },
    ]);
  });

  it('cannot be judged without the request, because the cookies depend on it', () => {
    expect(() => validator.validateResponse('signOut', response({ status: 204 }))).toThrow(
      /signOut/,
    );
  });

  // Break caught: the correction reaching further than it was meant to. Sign-in still sets its cookies for whoever
  // asks, and sign-out keeps its 204 and 401, its CSRF requirement and its error codes.
  it('leaves the rest of the contract as it was', () => {
    const request: Pick<RequestParts, 'headers'> = { headers: {} };
    const staff = validator
      .validateResponse('staffSignIn', response({ status: 200, body: {} }), request)
      .filter((violation) => violation.in === 'response-cookie')
      .map((violation) => violation.pointer)
      .toSorted();
    const mfa = validator
      .validateResponse('staffSignIn', response({ status: 202, body: {} }), request)
      .filter((violation) => violation.in === 'response-cookie');
    const item = (CONTRACT.paths as JsonObject)['/auth/session'] as JsonObject;
    const operation = item.delete as JsonObject;

    expect(staff).toEqual(['melarc_csrf', 'melarc_session']);
    expect(mfa).toEqual([]);
    // The 403 is the one a failed CSRF check answers with: every operation that lists CSRF_VALIDATION_FAILED has it.
    expect(Object.keys(operation.responses as JsonObject)).toEqual(['204', '401', '403']);
    expect(operation.security).toBeUndefined();
    expect(operation['x-error-codes']).toEqual(['CSRF_VALIDATION_FAILED', 'SESSION_INVALID']);
  });

  it('declares its cookie header and what it clears in the contract itself', () => {
    const answer = (
      ((CONTRACT.paths as JsonObject)['/auth/session'] as JsonObject).delete as JsonObject
    ).responses as JsonObject;
    const noContent = answer['204'] as JsonObject;

    expect(noContent['x-set-cookies']).toEqual(['melarc_session', 'melarc_csrf']);
    expect(noContent['x-set-cookies-for']).toBe('browserSession');
    expect(noContent.headers).toEqual({ 'Set-Cookie': { $ref: '#/components/headers/SetCookie' } });
  });
});

describe('CollectionRecord: a record the server can really answer with (audit C01)', () => {
  const UUID = '0190d7c2-7a3e-7c1e-9d2a-3f4b5c6d7e8f';
  const OTHER = '0190d7c2-7a3e-7c1e-9d2a-3f4b5c6d7e90';
  const schemas = (CONTRACT.components as JsonObject).schemas as JsonObject;

  /** What the rider sends, and what comes back for it. */
  const created = {
    collected_count: 3,
    handshake_type: 'VENDOR_ENTERED_RIDER_DISPLAYED',
    handshake_channel: 'PORTAL',
    evidence_ids: [OTHER],
    captured_at: '2026-10-05T09:30:00Z',
  };
  const record = {
    ...created,
    id: UUID,
    pickup_stop_id: OTHER,
    declared_count: 3,
    variance: 'MATCH',
    office_notified_at: null,
  };

  const answer = (body: unknown) =>
    validator
      .validateResponse('recordCollection', response({ status: 200, body }))
      .filter((violation) => violation.in === 'response-body');
  const sent = (body: unknown) =>
    validator.validateRequest('recordCollection', {
      params: { id: UUID },
      query: {},
      headers: { 'idempotency-key': 'k', 'if-match': '"1"' },
      body,
      hasBody: true,
    });

  // Break caught: a record no answer can satisfy. The schema was the closed creation schema plus the fields
  // the server adds, so the creation branch refused `id` and every other server field, and the operation could
  // never answer 200 without its own response validation failing.
  it('accepts the record the server answers with, a short one and a clean one', () => {
    expect(answer(record)).toEqual([]);
    expect(
      answer({
        ...record,
        collected_count: 1,
        variance: 'SHORT',
        variance_reason_code: 'NOT_READY',
        variance_note: 'Two parcels were not ready.',
        office_notified_at: '2026-10-05T09:31:00Z',
      }),
    ).toEqual([]);
  });

  it('needs the fields every record has: what was sent that is required, and what the server adds', () => {
    const required = [
      'collected_count',
      'handshake_type',
      'id',
      'pickup_stop_id',
      'declared_count',
      'variance',
    ];
    for (const field of required) {
      const without = Object.fromEntries(Object.entries(record).filter(([name]) => name !== field));
      expect(answer(without), field).toEqual([
        { in: 'response-body', pointer: `/${field}`, rule: 'required' },
      ]);
    }
  });

  it('keeps every value to the type and enum it had in the request', () => {
    expect(answer({ ...record, variance: 'OVER' })).toEqual([
      { in: 'response-body', pointer: '/variance', rule: 'enum' },
    ]);
    expect(answer({ ...record, handshake_type: 'ANYTHING' })).toEqual([
      { in: 'response-body', pointer: '/handshake_type', rule: 'enum' },
    ]);
    expect(answer({ ...record, collected_count: -1 })).toEqual([
      { in: 'response-body', pointer: '/collected_count', rule: 'minimum' },
    ]);
    expect(answer({ ...record, id: 'not-a-uuid' })).toEqual([
      { in: 'response-body', pointer: '/id', rule: 'format' },
    ]);
  });

  // Break caught: a record that carries a field nobody declared, such as a hidden server value (§42.3). The
  // original schema refused unknown fields, and the repair keeps refusing them.
  it('refuses a field it does not declare', () => {
    expect(answer({ ...record, rider_declared_count: 3 })).toEqual([
      { in: 'response-body', pointer: '', rule: 'additionalProperties' },
    ]);
  });

  // Break caught: the repair of the record loosening the request. The creation schema stays closed: the server's
  // own fields are not something a rider may send, and a request is still held to its two required fields.
  it('leaves the creation request exactly as strict as it was', () => {
    expect(sent(created)).toEqual([]);
    expect(sent({ collected_count: 3 })).toEqual([
      { in: 'body', pointer: '/handshake_type', rule: 'required' },
    ]);
    expect(sent({ ...created, rider_declared_count: 3 })).toEqual([
      { in: 'body', pointer: '', rule: 'additionalProperties' },
    ]);
    for (const serverField of ['id', 'pickup_stop_id', 'declared_count', 'variance']) {
      expect(
        sent({ ...created, [serverField]: record[serverField as keyof typeof record] }),
        serverField,
      ).toEqual([{ in: 'body', pointer: '', rule: 'additionalProperties' }]);
    }
    expect(sent({ ...created, collected_count: -1 })).toEqual([
      { in: 'body', pointer: '/collected_count', rule: 'minimum' },
    ]);
  });

  // Break caught: the two schemas drifting apart now that the record repeats the creation fields instead of
  // composing the closed creation schema. A field changed in one and not the other would be accepted going in
  // and refused coming back (or the reverse).
  it('repeats the creation fields exactly as the creation schema states them', () => {
    const create = schemas.CollectionRecordCreate as JsonObject;
    const full = schemas.CollectionRecord as JsonObject;

    expect(create.additionalProperties).toBe(false);
    expect(full.additionalProperties).toBe(false);
    const shared = Object.keys(create.properties as JsonObject);
    expect(shared.length).toBeGreaterThan(5);
    for (const field of shared) {
      expect((full.properties as JsonObject)[field], field).toEqual(
        (create.properties as JsonObject)[field],
      );
    }
    expect(full.required).toEqual(expect.arrayContaining(create.required as string[]));
  });
});

describe('the Rider operations that name the dedicated host (audit C03)', () => {
  const RIDER_OPERATIONS = [
    'arriveAtDeliveryStop',
    'arriveAtPickupStop',
    'completeRiderDeviceEnrolment',
    'requestDeliveryOtp',
    'requestRiderSignInChallenge',
    'riderSignIn',
    'startDeliveryRun',
    'startRun',
  ];

  /** Every operation that declares `servers` of its own, by operationId. */
  const withServers = (): string[] => {
    const found: string[] = [];
    for (const item of Object.values(CONTRACT.paths as JsonObject)) {
      if (!isJsonObject(item)) continue;
      for (const operation of Object.values(item)) {
        if (isJsonObject(operation) && Array.isArray(operation.servers)) {
          found.push(
            typeof operation.operationId === 'string' ? operation.operationId : '(no operationId)',
          );
        }
      }
    }
    return found.toSorted();
  };

  // Break caught: a server declaration dropped to make a count agree. All eight stay: the dedicated host is
  // where a native client calls these, and removing one would send it to the cookie-only default.
  it('keeps all eight operation-level server declarations', () => {
    expect(withServers()).toEqual(RIDER_OPERATIONS);
  });

  // Break caught: the comment above `servers` giving a different count from the one the document has, which
  // sends the next reader looking for an operation that is not there.
  it('says in its header comment how many there are, and says eight', () => {
    const text = readFileSync(locateContract(import.meta.dirname), 'utf8');
    const stated = /declared per operation on the (\w+)\s+# Rider native operations/.exec(text);
    const words = [
      'zero',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
    ];

    expect(stated?.[1]).toBe(words[withServers().length]);
    expect(stated?.[1]).toBe('eight');
  });
});

describe('nullable, written the way OpenAPI 3.1 writes it (audit C02)', () => {
  /**
   * The 58 properties the contract marked `nullable: true`, a keyword OpenAPI 3.0 has and 3.1 dropped in favour of
   * a type list with `"null"`. Each is listed by its place under `components/schemas`, so converting them is
   * checked one by one and a property cannot be converted by losing its nullability.
   */
  const NULLABLE_PROPERTIES = [
    'DeliveryCommitment/properties/requestedDate',
    'DeliveryCommitment/properties/committedWindowStart',
    'DeliveryCommitment/properties/committedWindowEnd',
    'DeliveryCommitment/properties/changeReasonCode',
    'DeliveryCommitment/properties/requestedByParty',
    'DeliveryCommitment/properties/approvedByStaffId',
    'DeliveryCommitment/properties/supersededAt',
    'DeliveryCommitmentRevision/properties/committedWindowStart',
    'DeliveryCommitmentRevision/properties/committedWindowEnd',
    'DeliveryCommitmentRevision/properties/requestedDate',
    'DeliveryCommitmentRevision/properties/note',
    'ServiceWindowOverride/properties/revisedDate',
    'ServiceWindowOverride/properties/note',
    'ParcelHandlingAssessment/properties/reasonCode',
    'ParcelHandlingAssessment/properties/note',
    'VerificationFallbackRequest/properties/note',
    'RoadExpense/properties/deliveryRunId',
    'RoadExpense/properties/motorcycleId',
    'RoadExpense/properties/evidenceId',
    'RoadExpense/properties/decidedByStaffId',
    'RoadExpense/properties/decisionReasonCode',
    'RoadExpense/properties/appliedToCashHandoverId',
    'RoadExpense/properties/appliedAt',
    'RoadExpense/properties/decidedAt',
    'RoadExpenseCreate/properties/deliveryRunId',
    'RoadExpenseCreate/properties/motorcycleId',
    'RoadExpenseCreate/properties/evidenceId',
    'RoadExpenseDecision/properties/reasonCode',
    'RoadExpenseDecision/properties/note',
    'RunCashSummary/properties/cashCustody/properties/declaredMinor',
    'RunCashSummary/properties/cashCustody/properties/countedMinor',
    'RunCashSummary/properties/cashCustody/properties/varianceMinor',
    'HubCashReconciliation/properties/countedMinor',
    'HubCashReconciliation/properties/varianceMinor',
    'HubCashReconciliation/properties/varianceReasonCode',
    'HubCashReconciliation/properties/reconciledByStaffId',
    'HubCashReconciliation/properties/closedAt',
    'HubCashCount/properties/varianceReasonCode',
    'HubCashCount/properties/note',
    'CashDisposition/properties/reference',
    'CashDisposition/properties/evidenceId',
    'VendorOperationalEligibility/properties/restrictionCategory',
    'DailyOperationsCashReport/properties/moneyFlow/properties/riderCashPositions/items/properties/confirmedTotalMinor',
    'DailyOperationsCashReport/properties/moneyFlow/properties/hubCashReconciliation',
    'DailyOperationsCashReport/properties/moneyFlow/properties/hubCashReconciliation/properties/countedMinor',
    'DailyOperationsCashReport/properties/moneyFlow/properties/hubCashReconciliation/properties/varianceMinor',
    'DailyOperationsCashReport/properties/moneyFlow/properties/revenueByType/items/properties/commercialMode',
    'BundleChange/properties/approved_by',
    'BundleChange/properties/decided_at',
    'StaffIdentity/properties/phone',
    'StaffIdentity/properties/primary_hub_id',
    'StaffIdentity/properties/approved_by',
    'Evidence/properties/responsible_hub_id',
    'Evidence/properties/vendor_organization_id',
    'Evidence/properties/device_context',
    'Evidence/properties/content_type',
    'Evidence/properties/byte_size',
    'Evidence/properties/uploaded_at',
  ];

  const schemaAt = (place: string): JsonObject => {
    let node: unknown = (CONTRACT.components as JsonObject).schemas;
    for (const step of place.split('/')) node = (node as Record<string, unknown>)[step];
    return node as JsonObject;
  };

  /** A value the property's schema accepts, other than null. */
  function sample(schema: JsonObject): unknown {
    if (Array.isArray(schema.enum)) return schema.enum.find((value) => value !== null);
    const type = [schema.type].flat().find((name) => name !== 'null');
    if (type === 'integer') return 1;
    if (type === 'boolean') return true;
    if (type === 'object') {
      const properties = isJsonObject(schema.properties) ? schema.properties : {};
      return Object.fromEntries(
        ((schema.required as string[] | undefined) ?? []).map((name) => [
          name,
          sample(properties[name] as JsonObject),
        ]),
      );
    }
    if (schema.format === 'uuid') return UUID_SAMPLE;
    if (schema.format === 'date') return '2026-10-05';
    if (schema.format === 'date-time') return '2026-10-05T09:30:00Z';
    return 'text';
  }

  /** The property's schema, put where a response body is, so it is judged by the validator the application uses. */
  const judging = (place: string) => {
    const schema = schemaAt(place);
    const alone = new ContractValidator({
      openapi: '3.1.0',
      components: CONTRACT.components ?? {},
      paths: {
        '/value': {
          get: {
            operationId: 'value',
            responses: {
              '200': { description: 'OK', content: { 'application/json': { schema } } },
            },
          },
        },
      },
    });
    return {
      schema,
      accepts: (body: unknown) =>
        alone.validateResponse('value', response({ status: 200, body })).length === 0,
    };
  };

  it('has 58 places to convert, none of them listed twice', () => {
    expect(new Set(NULLABLE_PROPERTIES).size).toBe(58);
  });

  // Break caught: the 3.0 keyword staying in a 3.1 document. A tool that reads the document as 3.1 ignores it,
  // so the field is typed as never null, and a client then fails on the null the server really sends.
  it('uses the 3.0 `nullable` keyword nowhere', () => {
    const found: string[] = [];
    (function walk(node: unknown, path: string[]): void {
      if (Array.isArray(node))
        node.forEach((child, index) => {
          walk(child, [...path, String(index)]);
        });
      else if (isJsonObject(node)) {
        if (typeof node.nullable === 'boolean') found.push(path.join('/'));
        for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
      }
    })(CONTRACT, []);

    expect(found).toEqual([]);
  });

  // Break caught: a conversion that only changes the spelling for the plain cases. Every property has the same
  // shape afterwards: its type and "null", and, where it has an enum, null in the enum too (an enum is checked
  // apart from the type, so a null the type allows is still refused by an enum that does not list it).
  it.each(NULLABLE_PROPERTIES)('%s is its own type or null', (place) => {
    const { schema } = judging(place);

    expect(schema.nullable).toBeUndefined();
    expect(Array.isArray(schema.type) ? schema.type : []).toContain('null');
    expect((schema.type as string[]).filter((name) => name !== 'null')).toHaveLength(1);
    if (schema.enum !== undefined) {
      expect((schema.enum as unknown[]).filter((value) => value === null)).toHaveLength(1);
    }
  });

  it.each(NULLABLE_PROPERTIES)(
    '%s accepts null and its value, and refuses another type',
    (place) => {
      const { schema, accepts } = judging(place);
      const base = (schema.type as string[]).find((name) => name !== 'null');

      expect(accepts(null)).toBe(true);
      expect(accepts(sample(schema))).toBe(true);
      expect(accepts(base === 'string' ? 5 : 'not-that-type')).toBe(false);
      if (Array.isArray(schema.enum)) expect(accepts('NOT_ONE_OF_THEM')).toBe(false);
    },
  );

  // Break caught: the two properties whose null is documented meaningful being the ones that fail. The
  // commercial mode's null says "an ordinary doorstep order, never unknown", and the requester's says no party
  // asked: neither may be refused by the schema that describes it.
  it('accepts the null that the commercial mode and the requesting party document', () => {
    const mode = judging(
      'DailyOperationsCashReport/properties/moneyFlow/properties/revenueByType/items/properties/commercialMode',
    );
    const party = judging('DeliveryCommitment/properties/requestedByParty');

    expect(mode.accepts(null)).toBe(true);
    expect(mode.accepts('STATION_DROP')).toBe(true);
    expect(party.accepts(null)).toBe(true);
    expect(party.accepts('SYSTEM')).toBe(true);
  });
});
