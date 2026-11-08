import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { isJsonObject, type Json, type JsonObject } from '../contract/json.js';
import { locateContract } from '../contract/locate-contract.js';
import { ApiException, DECLARED_ERROR_HEADERS } from './api-exception.js';
import { ERROR_STATUS, ErrorCode, statusOf } from './error-codes.js';

const contract = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;
const plan = readFileSync(
  resolve(import.meta.dirname, '../../../../../delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md'),
  'utf8',
).replaceAll('\r', '');

function object(value: Json | undefined, what: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${what} is not an object in the contract`);
  return value;
}

const enumeration = (): string[] => {
  const schemas = object(object(contract.components, 'components').schemas, 'schemas');
  const code = object(object(object(schemas.Error, 'Error').properties, 'properties').code, 'code');
  return (code.enum as string[]).slice();
};

/** The operations of the contract by `operationId`. */
function operations(): Map<string, JsonObject> {
  const found = new Map<string, JsonObject>();
  for (const item of Object.values(object(contract.paths, 'paths'))) {
    for (const [method, operation] of Object.entries(object(item, 'a path'))) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const each = object(operation, 'an operation');
      const id = each.operationId;
      if (typeof id === 'string') found.set(id, each);
    }
  }
  return found;
}

/** The 38 operations the slice builds, as the plan's table (section 6.1) lists them. */
function sliceOperations(): string[] {
  const table = plan.slice(plan.indexOf('### 6.1 Operations'), plan.indexOf('### 6.2 Criteria'));
  return [...table.matchAll(/^\| `([A-Za-z0-9]+)`\|/gm)].map((match) => match[1] ?? '');
}

describe('ErrorCode: the contract’s enumeration, all of it', () => {
  // Break caught: a code the contract has that the platform cannot name, or one the platform names that the contract does not
  // have (the enumeration is closed, so such a code must never be emitted).
  it('has exactly the codes of Error.code in contracts/openapi.yaml', () => {
    expect(Object.values(ErrorCode).toSorted()).toEqual(enumeration().toSorted());
    expect(new Set(Object.values(ErrorCode)).size).toBe(Object.values(ErrorCode).length);
  });

  it('has 121 codes, which the contract’s own header counts', () => {
    expect(Object.values(ErrorCode)).toHaveLength(121);
  });

  // Break caught: two names for one code, or a name that is not its code, which makes a grep for the code miss its uses.
  it('names each code in PascalCase from the code itself', () => {
    for (const [name, code] of Object.entries(ErrorCode)) {
      const expected = code
        .split('_')
        .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
        .join('');
      expect(name, code).toBe(expected);
    }
  });
});

describe('ERROR_STATUS: one rule for every operation (errors-and-enums.md §4, AC-SLICE-000-131)', () => {
  // Break caught: a status for a named code that is not the one the axis table gives it.
  it.each([
    ['VALIDATION_FAILED', 400],
    ['SESSION_INVALID', 401],
    ['SESSION_SUPERSEDED', 401],
    ['PERMISSION_DENIED', 403],
    ['INSUFFICIENT_AUTHORITY', 403],
    ['HUB_SCOPE_VIOLATION', 403],
    ['CSRF_VALIDATION_FAILED', 403],
    ['MFA_ENROLMENT_REQUIRED', 403],
    ['NOT_FOUND', 404],
    ['STATE_CONFLICT', 409],
    ['IDEMPOTENCY_KEY_CONFLICT', 409],
    ['RATE_LIMITED', 429],
    ['TRUST_DATA_UNAVAILABLE', 503],
  ] as const)('answers %s with %i', (code, status) => {
    expect(ERROR_STATUS[code]).toBe(status);
    expect(statusOf(code)).toBe(status);
  });

  // Break caught: a business-rule code answered with anything but 422, in particular VALIDATION_FAILED's 400 or a 409 by habit.
  it('answers every other code, which states a business rule, with 422', () => {
    const named = new Set([
      'VALIDATION_FAILED',
      'SESSION_INVALID',
      'SESSION_SUPERSEDED',
      'PERMISSION_DENIED',
      'INSUFFICIENT_AUTHORITY',
      'HUB_SCOPE_VIOLATION',
      'CSRF_VALIDATION_FAILED',
      'MFA_ENROLMENT_REQUIRED',
      'NOT_FOUND',
      'STATE_CONFLICT',
      'IDEMPOTENCY_KEY_CONFLICT',
      'RATE_LIMITED',
      'TRUST_DATA_UNAVAILABLE',
      'SETTING_MISSING',
      'SETTING_INVALID',
    ]);
    for (const code of Object.values(ErrorCode)) {
      if (named.has(code)) continue;
      expect(ERROR_STATUS[code], code).toBe(422);
    }
    expect(ERROR_STATUS[ErrorCode.SelfApprovalForbidden]).toBe(422);
    expect(ERROR_STATUS[ErrorCode.InvalidCredentials]).toBe(422);
    expect(ERROR_STATUS[ErrorCode.DeviceIntegrityFailed]).toBe(422);
  });

  // Break caught: an invented status. No retained document gives these two codes one, and the platform does not choose it.
  it('leaves the status of SETTING_MISSING and SETTING_INVALID undecided, and refuses to answer for them', () => {
    expect(ERROR_STATUS[ErrorCode.SettingMissing]).toBeNull();
    expect(ERROR_STATUS[ErrorCode.SettingInvalid]).toBeNull();
    expect(() => statusOf(ErrorCode.SettingMissing)).toThrow(/No status is decided/);
    expect(() => statusOf(ErrorCode.SettingInvalid)).toThrow(/No status is decided/);
  });

  it('has a status or an explicit null for every code', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(code in ERROR_STATUS, code).toBe(true);
    }
  });

  // Break caught: a status table that the operations of the slice cannot use. Every code an operation of the slice lists must be
  // answerable at the status the table gives it, by a response that operation declares. The contract's later slices are not
  // held to this here: their operations are corrected when their slice builds them.
  it('is a status each of the 38 operations of the slice declares for every code it lists', () => {
    const all = operations();
    const ids = sliceOperations();
    expect(ids).toHaveLength(38);
    for (const id of ids) {
      const operation = all.get(id);
      expect(operation, id).toBeDefined();
      const declared = Object.keys(object(operation?.responses, `${id} responses`));
      for (const code of (operation?.['x-error-codes'] as string[] | undefined) ?? []) {
        const status = ERROR_STATUS[code as ErrorCode];
        expect(declared, `${id} lists ${code}, which is answered ${String(status)}`).toContain(
          String(status),
        );
      }
    }
  });
});

describe('ApiException: what an error answer may carry beyond its code', () => {
  // Break caught: the declared error headers drifting from the contract. Today the contract declares one header on any error
  // response (`Retry-After`, on the 503 of TRUST_DATA_UNAVAILABLE), and the platform may set that and no other.
  it('may set exactly the headers the contract declares on error responses', () => {
    const declared = new Set<string>();
    const components = object(contract.components, 'components');
    const responseByRef = (ref: string): JsonObject => {
      const name = ref.split('/').pop() ?? '';
      return object(object(components.responses, 'responses')[name], `response ${name}`);
    };
    const walk = (response: Json | undefined): void => {
      if (!isJsonObject(response)) return;
      const resolved = typeof response.$ref === 'string' ? responseByRef(response.$ref) : response;
      for (const name of Object.keys(object(resolved.headers ?? {}, 'headers'))) declared.add(name);
    };
    for (const operation of operations().values()) {
      for (const [status, response] of Object.entries(object(operation.responses, 'responses'))) {
        if (status.startsWith('4') || status.startsWith('5')) walk(response);
      }
    }

    expect([...declared].toSorted()).toEqual([...DECLARED_ERROR_HEADERS].toSorted());
  });

  it('carries a declared header, validated, and nothing else', () => {
    const exception = new ApiException(
      ErrorCode.TrustDataUnavailable,
      503,
      'The attestation evidence could not be evaluated now',
      undefined,
      { 'Retry-After': '30' },
    );

    expect(exception.headers).toEqual({ 'Retry-After': '30' });
  });

  // Break caught: a header the contract does not declare being set by an error answer, which a client cannot know to read, or a
  // value that is not what the declared header's schema says.
  it.each([
    ['an undeclared header', { 'X-Anything': '1' }],
    ['a declared header with text', { 'Retry-After': 'soon' }],
    ['a declared header with nought', { 'Retry-After': '0' }],
    ['a declared header with a fraction', { 'Retry-After': '1.5' }],
    ['a declared header with an injected line', { 'Retry-After': '1\r\nSet-Cookie: a=b' }],
    ['the header in another case', { 'retry-after': '30' }],
  ])('refuses %s', (_label, headers) => {
    expect(
      () => new ApiException(ErrorCode.TrustDataUnavailable, 503, 'x', undefined, headers),
    ).toThrow(TypeError);
  });

  it('has none by default, and keeps them away from the body', () => {
    const exception = new ApiException(ErrorCode.NotFound, 404, 'Resource not found');

    expect(exception.headers).toEqual({});
  });

  // Break caught: the factory choosing its own status, or inventing one for a code that has none.
  it('can be made from a code alone, with the status of the table', () => {
    const exception = ApiException.of(
      ErrorCode.StateConflict,
      'The record is not in the state expected',
    );

    expect(exception.getStatus()).toBe(409);
    expect(exception.code).toBe('STATE_CONFLICT');
    expect(() => ApiException.of(ErrorCode.SettingMissing, 'x')).toThrow(/No status is decided/);
  });
});
