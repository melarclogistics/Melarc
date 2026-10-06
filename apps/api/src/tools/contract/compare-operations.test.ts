import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type { JsonObject } from '../../platform/contract/json.js';
import { JsonEditor } from '../../test-support/json-edit.js';
import { compareOperations } from './compare-operations.js';
import type { Finding, FindingCode } from './findings.js';
import {
  describeOperation,
  findOperation,
  listOperationIds,
  type OperationDescription,
} from './operation-description.js';
import { createModel } from './schema-normalizer.js';

/**
 * The comparison is exercised on the real contract. Each test takes one real operation, changes the
 * "implementation's" copy of the document in exactly one way a careless commit could, and expects the
 * check to say so. The copy is the test's input to the comparator; it is never presented as an
 * implementation (engineering-standards.md section 4).
 */
const CONTRACT = parse(
  readFileSync(resolve(import.meta.dirname, '../../../../../contracts/openapi.yaml'), 'utf8'),
) as JsonObject;

function describeIn(document: JsonObject, operationId: string): OperationDescription {
  const found = findOperation(document, operationId);
  if (found === undefined) throw new Error(`No operation ${operationId}`);
  return describeOperation(createModel(document), document, found.path, found.method);
}

/** The findings when the code's document is the contract with `edit` applied to a copy. */
function driftAfter(operationId: string, edit: (document: JsonEditor) => void): Finding[] {
  const copy = new JsonEditor(CONTRACT);
  edit(copy);
  return compareOperations(
    describeIn(CONTRACT, operationId),
    describeIn(copy.document, operationId),
  );
}

const codes = (findings: readonly Finding[]) => findings.map((finding) => finding.code);
const where = (findings: readonly Finding[], code: FindingCode) =>
  findings.filter((finding) => finding.code === code).map((finding) => finding.at);

const CONFIRM = 'confirmPickupRequest';
const CONFIRM_AT = 'POST /pickup-requests/{id}/confirm';
/** Where `confirmPickupRequest` is in the document. */
const CONFIRM_OPERATION = ['paths', '/pickup-requests/{id}/confirm', 'post'] as const;
const SCHEMAS = ['components', 'schemas'] as const;

describe('describing an operation', () => {
  // Break caught: a description that misses part of an operation, which would make that part invisible to
  // every check built on it.
  it('captures parameters, responses, security and extensions of a real operation', () => {
    const operation = describeIn(CONTRACT, CONFIRM);

    expect(operation.method).toBe('POST');
    expect(operation.path).toBe('/pickup-requests/{id}/confirm');
    expect(Object.keys(operation.parameters).toSorted()).toEqual(['header:if-match', 'path:id']);
    expect(operation.parameters['header:if-match']?.required).toBe(true);
    expect(operation.parameters['path:id']?.schema.format).toBe('uuid');
    expect(Object.keys(operation.responses).toSorted()).toEqual([
      '200',
      '401',
      '403',
      '409',
      '422',
    ]);
    expect(operation.security.alternatives).toEqual([
      ['browserSession', 'csrfToken'],
      ['riderSession'],
    ]);
    expect(operation.permission).toBe('pickup.request.confirm');
    expect(operation.errorCodes).toContain('STATE_CONFLICT');
  });

  it('captures response headers and the cookies a response sets', () => {
    expect(describeIn(CONTRACT, 'getPickupRequest').responses['200']?.headers.etag).toBeDefined();
    expect(describeIn(CONTRACT, 'vendorSignIn').responses['200']?.setCookies).toEqual([
      'melarc_csrf',
      'melarc_session',
    ]);
  });

  // Break caught: the credential a response's cookies depend on being left out of the description, so that a code
  // description which sets the sign-out cookies for every caller reads as equal to the contract's.
  it('captures the credential a response sets its cookies for', () => {
    const noContent = describeIn(CONTRACT, 'signOut').responses['204'];

    expect(noContent?.setCookies).toEqual(['melarc_csrf', 'melarc_session']);
    expect(noContent?.setCookiesFor).toBe('browserSession');
    expect(describeIn(CONTRACT, 'vendorSignIn').responses['200']?.setCookiesFor).toBeUndefined();
  });

  // Break caught: the document-level default being lost, so an operation that inherits its security
  // reads as having none, or an operation that overrides it reads as inheriting.
  it('applies the document default security, and an operation override replaces it', () => {
    expect(describeIn(CONTRACT, 'getPickupRequest').security.alternatives).toEqual([
      ['browserSession'],
      ['riderSession'],
    ]);
    expect(describeIn(CONTRACT, 'riderSignIn').security.alternatives).toEqual([]);
  });

  // Break caught: a path parameter left out of `required` being read as optional. OpenAPI makes every path
  // parameter required, so a document that forgets the flag must not differ from one that says it.
  it('reads a path parameter as required whether or not the document says so', () => {
    const document = (required: boolean | undefined): JsonObject => ({
      openapi: '3.1.0',
      paths: {
        '/things/{id}': {
          get: {
            operationId: 'thing',
            parameters: [
              {
                name: 'id',
                in: 'path',
                schema: { type: 'string' },
                ...(required === undefined ? {} : { required }),
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });

    expect(describeIn(document(undefined), 'thing').parameters['path:id']?.required).toBe(true);
    expect(describeIn(document(false), 'thing').parameters['path:id']?.required).toBe(true);
    expect(
      compareOperations(
        describeIn(document(true), 'thing'),
        describeIn(document(undefined), 'thing'),
      ),
    ).toEqual([]);
  });

  it('knows the operations of a document, and where each one is', () => {
    const ids = listOperationIds(CONTRACT);

    expect(ids.length).toBeGreaterThan(100);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findOperation(CONTRACT, CONFIRM)).toEqual({
      method: 'POST',
      path: '/pickup-requests/{id}/confirm',
    });
    expect(findOperation(CONTRACT, 'noSuchOperation')).toBeUndefined();
  });

  // Break caught: two operations with one id, after which "the operation" means whichever came first.
  it('refuses a document in which two operations share an id', () => {
    const copy = new JsonEditor(CONTRACT);
    copy.set(['paths', '/pickup-requests', 'get', 'operationId'], 'createPickupRequest');

    expect(() => findOperation(copy.document, 'createPickupRequest')).toThrow(/more than one/);
  });
});

describe('a document compared with itself', () => {
  // Break caught: a comparison that reports drift where there is none, or one that cannot read a real
  // construct. It runs on every operation in the contract, so a keyword it cannot handle surfaces here.
  it('has no drift in any operation of the contract', () => {
    const copy = structuredClone(CONTRACT);
    const model = createModel(CONTRACT);
    const copyModel = createModel(copy);
    const drifted: string[] = [];

    for (const operationId of listOperationIds(CONTRACT)) {
      const found = findOperation(CONTRACT, operationId);
      if (found === undefined) throw new Error(operationId);
      const findings = compareOperations(
        describeOperation(model, CONTRACT, found.path, found.method),
        describeOperation(copyModel, copy, found.path, found.method),
      );
      if (findings.length > 0) drifted.push(operationId);
    }

    expect(drifted).toEqual([]);
  });

  // Break caught: rewording prose being reported as a contract change.
  it('ignores a rewritten description, summary and example', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.set([...CONFIRM_OPERATION, 'description'], 'reworded');
      copy.set([...CONFIRM_OPERATION, 'summary'], 'reworded');
      copy.set([...SCHEMAS, 'Error', 'description'], 'reworded');
    });

    expect(findings).toEqual([]);
  });
});

describe('deliberate drift: required fields', () => {
  // Break caught: a field the contract requires in a request becoming optional in the code.
  it('reports a required field dropped from a request body', () => {
    const findings = driftAfter('createPickupRequest', (copy) => {
      copy.update<string[]>([...SCHEMAS, 'PickupRequestCreate', 'required'], (required) =>
        required.filter((name) => name !== 'pickup_intent'),
      );
    });

    expect(codes(findings)).toEqual(['SCHEMA_REQUIRED']);
    expect(findings[0]?.at).toBe('POST /pickup-requests > request body > application/json');
    expect(findings[0]?.message).toContain('"pickup_intent"');
  });

  // Break caught: a field the contract promises in a response becoming optional, which breaks every
  // client that reads it without checking.
  it('reports a required field dropped from a response body', () => {
    const findings = driftAfter('getPickupRequest', (copy) => {
      copy.update<string[]>([...SCHEMAS, 'PickupRequest', 'required'], (required) =>
        required.slice(1),
      );
    });

    expect(codes(findings)).toEqual(['SCHEMA_REQUIRED']);
    expect(findings[0]?.at).toBe('GET /pickup-requests/{id} > response 200 > application/json');
  });
});

describe('deliberate drift: enums', () => {
  // Break caught: an enum value withdrawn or added in the code. The error code enumeration is closed: it
  // is the only thing a client may branch on, and a withdrawn code is never reused.
  it('reports an error code removed from the closed enumeration, once for each response that uses it', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.update<string[]>([...SCHEMAS, 'Error', 'properties', 'code', 'enum'], (values) =>
        values.filter((value) => value !== 'STATE_CONFLICT'),
      );
    });

    expect(codes(findings)).toEqual(['SCHEMA_ENUM', 'SCHEMA_ENUM', 'SCHEMA_ENUM', 'SCHEMA_ENUM']);
    expect(where(findings, 'SCHEMA_ENUM').map((at) => at.split(' > ')[1])).toEqual([
      'response 401',
      'response 403',
      'response 409',
      'response 422',
    ]);
    expect(findings[0]?.message).toContain('"STATE_CONFLICT"');
  });

  it('reports an enum value added to a request field', () => {
    const findings = driftAfter('createPickupRequest', (copy) => {
      copy.push(
        [...SCHEMAS, 'PickupRequestCreate', 'properties', 'pickup_intent', 'enum'],
        'SMUGGLED',
      );
    });

    expect(codes(findings)).toEqual(['SCHEMA_ENUM']);
    expect(findings[0]?.at).toBe(
      'POST /pickup-requests > request body > application/json.properties.pickup_intent',
    );
  });
});

describe('deliberate drift: additional properties and structural rules', () => {
  const ITEMIZE = 'itemizeOrder';
  const ITEMIZE_BODY = 'POST /hub-intakes/{id}/orders > request body > application/json';

  // Break caught: the "clients never set prices" rule being relaxed. OrderItemize is closed so that no
  // client can send a price; code that opens it accepts one with no contract change.
  it('reports a closed request schema that the code leaves open', () => {
    const findings = driftAfter(ITEMIZE, (copy) => {
      copy.remove([...SCHEMAS, 'OrderItemize', 'additionalProperties']);
    });

    expect(codes(findings)).toEqual(['SCHEMA_ADDITIONAL_PROPERTIES']);
    expect(findings[0]?.at).toBe(ITEMIZE_BODY);
  });

  it('reports a property added to a closed request schema', () => {
    const findings = driftAfter(ITEMIZE, (copy) => {
      copy.set([...SCHEMAS, 'OrderItemize', 'properties', 'price'], { type: 'integer' });
    });

    expect(codes(findings)).toEqual(['SCHEMA_PROPERTY_EXTRA']);
    expect(findings[0]?.at).toBe(`${ITEMIZE_BODY}.properties.price`);
  });

  // Break caught: the blind count ceasing to be blind. getHubIntake answers with one of two shapes, and
  // the pre-count one has no `rider_declared_count`; a code that adds the field "for the UI" changes the
  // set of shapes the operation can answer with.
  it('reports the blind count gaining the field it must not have', () => {
    const findings = driftAfter('getHubIntake', (copy) => {
      copy.set(
        [...SCHEMAS, 'HubIntakePreCount', 'allOf', 1, 'properties', 'rider_declared_count'],
        { type: 'integer' },
      );
    });

    expect(codes(findings)).toEqual(['SCHEMA_COMPOSITION']);
    expect(findings[0]?.at).toBe('GET /hub-intakes/{id} > response 200 > application/json');
  });
});

describe('deliberate drift: error responses', () => {
  // Break caught: an error answer the contract documents no longer being given, or a new one invented.
  it('reports an error status that is missing, and one that is not in the contract', () => {
    const missing = driftAfter(CONFIRM, (copy) => {
      copy.remove([...CONFIRM_OPERATION, 'responses', '409']);
    });
    const invented = driftAfter(CONFIRM, (copy) => {
      copy.set([...CONFIRM_OPERATION, 'responses', '500'], { description: 'invented' });
    });

    expect(codes(missing)).toEqual(['ERROR_RESPONSE_DRIFT']);
    expect(missing[0]?.at).toBe(`${CONFIRM_AT} > response 409`);
    expect(codes(invented)).toEqual(['ERROR_RESPONSE_DRIFT']);
    expect(invented[0]?.at).toBe(`${CONFIRM_AT} > response 500`);
  });

  // Break caught: the body of an error answer changing shape. Every client parses it as the contract's
  // Error, so a different body is unreadable to all of them.
  it('reports an error body whose shape changed, at the response that carries it', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.set([...SCHEMAS, 'Error', 'required'], ['code', 'message']);
    });

    expect(codes(findings)).toEqual([
      'SCHEMA_REQUIRED',
      'SCHEMA_REQUIRED',
      'SCHEMA_REQUIRED',
      'SCHEMA_REQUIRED',
    ]);
    expect(findings.every((finding) => /response (401|403|409|422) >/.test(finding.at))).toBe(true);
    expect(findings[0]?.message).toContain('"request_id"');
  });

  // Break caught: success and error being reported alike, which would hide which kind of answer drifted.
  it('reports a missing success status as a response drift, not an error one', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.remove([...CONFIRM_OPERATION, 'responses', '200']);
    });

    expect(codes(findings)).toEqual(['RESPONSE_DRIFT']);
  });

  it('reports a response whose media type changed', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.update<{ content: Record<string, unknown> }>(
        [...CONFIRM_OPERATION, 'responses', '200'],
        (ok) => ({ ...ok, content: { 'text/plain': ok.content['application/json'] } }),
      );
    });

    expect(codes(findings)).toEqual(['RESPONSE_DRIFT']);
  });
});

describe('deliberate drift: authentication and security', () => {
  // Break caught: the CSRF requirement dropped from the default security, so every state-changing
  // operation that inherits it silently stops asking for the token.
  it('reports the CSRF requirement removed from the inherited security', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.set(['security'], [{ browserSession: [] }, { riderSession: [] }]);
    });

    expect(codes(findings)).toEqual(['SECURITY_DRIFT']);
    expect(findings[0]?.at).toBe(`${CONFIRM_AT} > security`);
  });

  // Break caught: an operation becoming reachable without a session.
  it('reports an operation that the code makes anonymous', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.set([...CONFIRM_OPERATION, 'security'], []);
    });

    expect(codes(findings)).toEqual(['SECURITY_DRIFT']);
  });

  // Break caught: a scheme redefined without changing which one an operation names: the cookie becomes a
  // header, or the CSRF header is renamed.
  it('reports a security scheme whose definition changed', () => {
    const renamed = driftAfter(CONFIRM, (copy) => {
      copy.set(['components', 'securitySchemes', 'csrfToken', 'name'], 'X-XSRF-Token');
    });
    const moved = driftAfter(CONFIRM, (copy) => {
      copy.set(['components', 'securitySchemes', 'browserSession', 'in'], 'header');
    });

    expect(codes(renamed)).toEqual(['SECURITY_DRIFT']);
    expect(renamed[0]?.message).toContain('csrfToken');
    expect(codes(moved)).toEqual(['SECURITY_DRIFT']);
    expect(moved[0]?.message).toContain('browserSession');
  });

  it('does not depend on the order of the alternatives', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.set(['security'], [{ riderSession: [] }, { csrfToken: [], browserSession: [] }]);
    });

    expect(findings).toEqual([]);
  });
});

describe('deliberate drift: headers and cookies', () => {
  // Break caught: a header the contract requires of the client, or sends back, being dropped or invented.
  it('reports a required request header that the code no longer declares', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.update<{ $ref?: string }[]>([...CONFIRM_OPERATION, 'parameters'], (parameters) =>
        parameters.filter((parameter) => parameter.$ref !== '#/components/parameters/IfMatch'),
      );
    });

    expect(codes(findings)).toEqual(['HEADER_DRIFT']);
    expect(findings[0]?.message).toContain('If-Match');
  });

  it('reports a header that the code requires and the contract does not', () => {
    const findings = driftAfter('getPickupRequest', (copy) => {
      copy.set(
        ['paths', '/pickup-requests/{id}', 'get', 'parameters'],
        [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
      );
    });

    expect(codes(findings)).toEqual(['HEADER_DRIFT']);
    expect(findings[0]?.message).toContain('Idempotency-Key');
  });

  it('reports a header that became optional', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.set(['components', 'parameters', 'IfMatch', 'required'], false);
    });

    expect(codes(findings)).toEqual(['HEADER_DRIFT']);
  });

  // Break caught: header names are case-insensitive on the wire, so a differently cased name is the same
  // header and must not be reported.
  it('treats header names as case-insensitive', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.set(['components', 'parameters', 'IfMatch', 'name'], 'if-match');
    });

    expect(findings).toEqual([]);
  });

  // Break caught: a response header (the ETag a client sends back as If-Match) being dropped.
  it('reports a response header the contract promises and the code omits', () => {
    const findings = driftAfter('getPickupRequest', (copy) => {
      copy.remove(['paths', '/pickup-requests/{id}', 'get', 'responses', '200', 'headers', 'ETag']);
    });

    expect(codes(findings)).toEqual(['HEADER_DRIFT']);
    expect(findings[0]?.at).toBe('GET /pickup-requests/{id} > response 200');
    expect(findings[0]?.message).toContain('ETag');
  });

  // Break caught: a sign-in that stops setting the CSRF cookie. Without it the browser has no token to
  // echo and every later state change fails. Cookies are carried by x-set-cookies, not by a header.
  it('reports a cookie that a response no longer sets, and one it newly sets', () => {
    const cookies = [
      'paths',
      '/auth/vendor/sign-in',
      'post',
      'responses',
      '200',
      'x-set-cookies',
    ] as const;
    const dropped = driftAfter('vendorSignIn', (copy) => {
      copy.set(cookies, ['melarc_session']);
    });
    const added = driftAfter('vendorSignIn', (copy) => {
      copy.push(cookies, 'melarc_vendor_device');
    });

    expect(codes(dropped)).toEqual(['COOKIE_DRIFT']);
    expect(dropped[0]?.message).toContain('melarc_csrf');
    expect(codes(added)).toEqual(['COOKIE_DRIFT']);
    expect(added[0]?.message).toContain('melarc_vendor_device');
  });

  // Break caught: a sign-out that sets (or expires) its cookies for every caller, or for the wrong credential. The
  // same cookies are named; who is owed them is what differs, and a Rider's sign-out would then carry cookies.
  it('reports a sign-out whose cookies are set for another credential, or for every caller', () => {
    const answer = ['paths', '/auth/session', 'delete', 'responses', '204'] as const;
    const everyone = driftAfter('signOut', (copy) => {
      copy.remove([...answer, 'x-set-cookies-for']);
    });
    const riders = driftAfter('signOut', (copy) => {
      copy.set([...answer, 'x-set-cookies-for'], 'riderSession');
    });

    expect(codes(everyone)).toEqual(['COOKIE_DRIFT']);
    expect(everyone[0]?.at).toBe('DELETE /auth/session > response 204');
    expect(everyone[0]?.message).toContain('browserSession');
    expect(codes(riders)).toEqual(['COOKIE_DRIFT']);
    expect(riders[0]?.message).toContain('riderSession');
  });
});

describe('deliberate drift: the rest of an operation', () => {
  // Break caught: the permission that guards an operation, or the errors it may return, changing in the
  // description without a contract change.
  it('reports a changed permission and a changed list of error codes', () => {
    const permission = driftAfter(CONFIRM, (copy) => {
      copy.set([...CONFIRM_OPERATION, 'x-permission'], 'pickup.read');
    });
    const errors = driftAfter(CONFIRM, (copy) => {
      copy.update<string[]>([...CONFIRM_OPERATION, 'x-error-codes'], (list) => list.slice(0, -1));
    });

    expect(codes(permission)).toEqual(['EXTENSION_DRIFT']);
    expect(permission[0]?.message).toContain('pickup.read');
    expect(codes(errors)).toEqual(['EXTENSION_DRIFT']);
  });

  it('reports a query parameter that was added or removed', () => {
    const parameters = ['paths', '/pickup-requests', 'get', 'parameters'] as const;
    const removed = driftAfter('listPickupRequests', (copy) => {
      copy.update<unknown[]>(parameters, (list) => list.slice(1));
    });
    const added = driftAfter('listPickupRequests', (copy) => {
      copy.push(parameters, { name: 'owner', in: 'query', schema: { type: 'string' } });
    });

    expect(codes(removed)).toEqual(['PARAMETER_DRIFT']);
    expect(codes(added)).toEqual(['PARAMETER_DRIFT']);
    expect(added[0]?.message).toContain('owner');
  });

  it('reports a parameter whose schema changed', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.remove(['components', 'parameters', 'Id', 'schema', 'format']);
    });

    expect(codes(findings)).toEqual(['SCHEMA_FORMAT']);
    expect(findings[0]?.at).toBe(`${CONFIRM_AT} > parameter path:id`);
  });

  it('reports a request body that became optional, or that changed media type', () => {
    const body = ['paths', '/pickup-requests', 'post', 'requestBody'] as const;
    const optional = driftAfter('createPickupRequest', (copy) => {
      copy.remove([...body, 'required']);
    });
    const media = driftAfter('createPickupRequest', (copy) => {
      copy.update<{ content: Record<string, unknown> }>(body, (current) => ({
        ...current,
        content: { 'text/plain': current.content['application/json'] },
      }));
    });

    expect(codes(optional)).toEqual(['REQUEST_BODY_DRIFT']);
    expect(codes(media)).toEqual(['REQUEST_BODY_DRIFT']);
  });

  it('reports a request body the code lacks, and one it invents', () => {
    const lacking = driftAfter('createPickupRequest', (copy) => {
      copy.remove(['paths', '/pickup-requests', 'post', 'requestBody']);
    });
    const invented = driftAfter(CONFIRM, (copy) => {
      copy.set([...CONFIRM_OPERATION, 'requestBody'], {
        content: { 'application/json': { schema: { type: 'object' } } },
      });
    });

    expect(codes(lacking)).toEqual(['REQUEST_BODY_DRIFT']);
    expect(codes(invented)).toEqual(['REQUEST_BODY_DRIFT']);
  });

  // Break caught: an operation answering at another method or path than the contract's. The same id at a
  // different route is not the same operation to a client built from the contract.
  it('reports an operation that sits at a different path template', () => {
    const copy = new JsonEditor(CONTRACT);
    const item = copy.get(['paths', '/pickup-requests/{id}/confirm']);
    copy.remove(['paths', '/pickup-requests/{id}/confirm']);
    copy.set(['paths', '/pickup-requests/{pickupId}/confirm'], item);
    const found = findOperation(copy.document, CONFIRM);
    if (found === undefined) throw new Error('moved operation not found');

    const findings = compareOperations(
      describeIn(CONTRACT, CONFIRM),
      describeOperation(createModel(copy.document), copy.document, found.path, found.method),
    );

    expect(codes(findings)).toContain('OPERATION_ROUTE_DRIFT');
  });

  it('reports every kind of drift in one operation together', () => {
    const findings = driftAfter(CONFIRM, (copy) => {
      copy.set(['security'], [{ riderSession: [] }]);
      copy.remove([...CONFIRM_OPERATION, 'responses', '409']);
      copy.set([...CONFIRM_OPERATION, 'x-permission'], 'other');
    });

    expect(codes(findings).toSorted()).toEqual([
      'ERROR_RESPONSE_DRIFT',
      'EXTENSION_DRIFT',
      'SECURITY_DRIFT',
    ]);
  });
});

/** A one-operation document, `GET /things/{id}`, for facts the real contract does not use. */
function thing(
  pieces: {
    id?: JsonObject;
    parameters?: JsonObject[];
    operation?: JsonObject;
    pathItem?: JsonObject;
    requestBody?: JsonObject;
    response?: JsonObject;
    root?: JsonObject;
  } = {},
): JsonObject {
  return {
    openapi: '3.1.0',
    ...pieces.root,
    paths: {
      '/things/{id}': {
        ...pieces.pathItem,
        get: {
          operationId: 'thing',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, ...pieces.id },
            ...(pieces.parameters ?? []),
          ],
          ...(pieces.requestBody === undefined ? {} : { requestBody: pieces.requestBody }),
          responses: { '200': { description: 'OK', ...pieces.response } },
          ...pieces.operation,
        },
      },
    },
  };
}

/** The findings when the contract's document is the first and the code's is the second. */
const between = (contract: JsonObject, code: JsonObject): Finding[] =>
  compareOperations(describeIn(contract, 'thing'), describeIn(code, 'thing'));

const ids = (extra: JsonObject = {}): JsonObject => ({
  name: 'ids',
  in: 'query',
  schema: { type: 'array', items: { type: 'string' } },
  ...extra,
});
const withIds = (extra: JsonObject = {}): JsonObject => thing({ parameters: [ids(extra)] });

describe('how a parameter is written into a request (audit F03)', () => {
  // Break caught: serialization facts dropped from the description. With `explode: true` an array is sent as
  // `ids=a&ids=b`, with `explode: false` as `ids=a,b`: a client generated from the contract and a server
  // reading the other form disagree on every request, and the comparison saw nothing.
  it.each([
    ['explode true to false', { explode: true }, { explode: false }],
    ['explode false to true', { explode: false }, { explode: true }],
    ['style form to spaceDelimited', { style: 'form' }, { style: 'spaceDelimited' }],
    [
      'style spaceDelimited to pipeDelimited',
      { style: 'spaceDelimited' },
      { style: 'pipeDelimited' },
    ],
    ['allowReserved false to true', { allowReserved: false }, { allowReserved: true }],
    ['allowEmptyValue left out to true', {}, { allowEmptyValue: true }],
    ['a parameter that became deprecated', {}, { deprecated: true }],
    ['a changed default style only', {}, { style: 'pipeDelimited' }],
  ])('reports %s on a query parameter', (_label, contract, code) => {
    const findings = between(withIds(contract), withIds(code));

    expect(codes(findings)).toEqual(['PARAMETER_DRIFT']);
    expect(findings[0]?.at).toBe('GET /things/{id} > parameter query:ids');
  });

  it('names what each side says', () => {
    const [finding] = between(withIds({ explode: true }), withIds({ explode: false }));

    expect(finding?.message).toContain('explode');
    expect(finding?.message).toMatch(/true/);
    expect(finding?.message).toMatch(/false/);
  });

  it('reports the style of a path parameter, and the style of a header', () => {
    expect(codes(between(thing(), thing({ id: { style: 'label' } })))).toEqual(['PARAMETER_DRIFT']);
    const trace = (extra: JsonObject = {}): JsonObject => ({
      name: 'X-Trace',
      in: 'header',
      schema: { type: 'array', items: { type: 'string' } },
      ...extra,
    });
    expect(
      codes(
        between(
          thing({ parameters: [trace()] }),
          thing({ parameters: [trace({ explode: true })] }),
        ),
      ),
    ).toEqual(['HEADER_DRIFT']);
  });

  // Break caught: the comparison reporting a difference where the wire form is the same. OpenAPI gives every
  // location a default style and a default `explode`, so saying the default out loud is not a change.
  it.each([
    [
      'a query parameter that states its defaults',
      {},
      {
        style: 'form',
        explode: true,
        allowReserved: false,
        allowEmptyValue: false,
        deprecated: false,
      },
    ],
    ['form with explode left to its default', { style: 'form' }, { explode: true }],
    [
      'spaceDelimited with explode left to its default',
      { style: 'spaceDelimited' },
      { style: 'spaceDelimited', explode: false },
    ],
    [
      'prose and examples',
      { description: 'the contract' },
      { description: 'the code', example: ['a'], examples: { a: { value: ['a'] } } },
    ],
  ])('reports nothing for %s', (_label, contract, code) => {
    expect(between(withIds(contract), withIds(code))).toEqual([]);
  });

  it('reports nothing for a path, header or cookie parameter that states its defaults', () => {
    expect(between(thing(), thing({ id: { style: 'simple', explode: false } }))).toEqual([]);
    const header = (extra: JsonObject = {}): JsonObject => ({
      name: 'X-Trace',
      in: 'header',
      schema: { type: 'string' },
      ...extra,
    });
    expect(
      between(
        thing({ parameters: [header()] }),
        thing({ parameters: [header({ style: 'simple', explode: false })] }),
      ),
    ).toEqual([]);
    const cookie = (extra: JsonObject = {}): JsonObject => ({
      name: 'melarc_session',
      in: 'cookie',
      schema: { type: 'string' },
      ...extra,
    });
    expect(
      between(
        thing({ parameters: [cookie()] }),
        thing({ parameters: [cookie({ style: 'form', explode: true })] }),
      ),
    ).toEqual([]);
  });

  // Break caught: a parameter described by a media type (JSON in the query) read as one described by a
  // schema. They are sent differently, and the media type is dropped when only the schema is kept.
  it('reports a parameter described by content against one described by a schema, and a changed media type', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const bySchema = thing({ parameters: [{ name: 'filter', in: 'query', schema }] });
    const byContent = (media: string): JsonObject =>
      thing({ parameters: [{ name: 'filter', in: 'query', content: { [media]: { schema } } }] });

    expect(codes(between(bySchema, byContent('application/json')))).toEqual(['PARAMETER_DRIFT']);
    expect(codes(between(byContent('application/json'), bySchema))).toEqual(['PARAMETER_DRIFT']);
    expect(codes(between(byContent('application/json'), byContent('application/xml')))).toEqual([
      'PARAMETER_DRIFT',
    ]);
    expect(
      between(byContent('application/json'), byContent('Application/JSON; charset=utf-8')),
    ).toEqual([]);
  });
});

describe('facts about the operation itself (audit F03)', () => {
  // Break caught: a parameter on the path item counted beside the operation's own for the same name and place,
  // or its statements kept after the operation replaced it. The operation's parameter is the one that applies.
  it('describes the parameter the operation states, and not the path item’s that it replaced', () => {
    const replaced = thing({
      pathItem: {
        parameters: [
          {
            name: 'tag',
            in: 'query',
            schema: { type: 'string' },
            style: 'pipeDelimited',
            callbacks: { stale: {} },
          },
        ],
      },
      parameters: [{ name: 'tag', in: 'query', schema: { type: 'string' } }],
    });
    const plain = thing({ parameters: [{ name: 'tag', in: 'query', schema: { type: 'string' } }] });

    expect(between(plain, replaced)).toEqual([]);
    expect(describeIn(replaced, 'thing').unmodelled).toEqual({});
  });

  it('reports an operation that became deprecated, or stopped being', () => {
    const findings = between(thing(), thing({ operation: { deprecated: true } }));

    expect(codes(findings)).toEqual(['OPERATION_DRIFT']);
    expect(findings[0]?.at).toBe('GET /things/{id} > deprecated');
    expect(codes(between(thing({ operation: { deprecated: true } }), thing()))).toEqual([
      'OPERATION_DRIFT',
    ]);
    expect(between(thing(), thing({ operation: { deprecated: false } }))).toEqual([]);
  });

  // Break caught (audit C03): the operation-level `servers` of the eight Rider operations dropped, so that the
  // dedicated Rider host could change, or disappear, without a finding. The limitation is now a check.
  it('reports servers the contract states for an operation and the code does not, and the reverse', () => {
    const rider = { servers: [{ url: 'https://api.melarc.example/v1' }] };

    const missing = between(thing({ operation: rider }), thing());
    expect(codes(missing)).toEqual(['OPERATION_ROUTE_DRIFT']);
    expect(missing[0]?.at).toBe('GET /things/{id} > servers');
    expect(codes(between(thing(), thing({ operation: rider })))).toEqual(['OPERATION_ROUTE_DRIFT']);
    expect(
      codes(
        between(
          thing({ operation: rider }),
          thing({ operation: { servers: [{ url: 'https://api.other.example/v1' }] } }),
        ),
      ),
    ).toEqual(['OPERATION_ROUTE_DRIFT']);
  });

  it('compares servers as a set with their variables, and not their prose', () => {
    const one = {
      url: 'https://{region}.melarc.example/v1',
      variables: { region: { default: 'gh', enum: ['gh', 'ng'], description: 'where' } },
    };
    const two = { url: 'https://api.melarc.example/v1' };

    expect(
      between(
        thing({ operation: { servers: [one, two] } }),
        thing({ operation: { servers: [{ ...two, description: 'other words' }, one] } }),
      ),
    ).toEqual([]);
    expect(
      codes(
        between(
          thing({ operation: { servers: [one] } }),
          thing({
            operation: {
              servers: [{ ...one, variables: { region: { default: 'ng', enum: ['gh', 'ng'] } } }],
            },
          }),
        ),
      ),
    ).toEqual(['OPERATION_ROUTE_DRIFT']);
    // The same servers stated on the path item are the operation's servers all the same.
    expect(
      between(thing({ operation: { servers: [two] } }), thing({ pathItem: { servers: [two] } })),
    ).toEqual([]);
  });

  it('reports the real eight: servers removed from a Rider operation', () => {
    const findings = driftAfter('riderSignIn', (copy) => {
      copy.remove(['paths', '/auth/rider/sign-in', 'post', 'servers']);
    });

    expect(codes(findings)).toEqual(['OPERATION_ROUTE_DRIFT']);
  });
});

describe('facts the comparison does not model are reported, never dropped (audit F03)', () => {
  // Break caught: a key the description does not read being thrown away, so that a statement in the contract
  // (a callback, a link, an encoding) could change or vanish with no finding. Each is reported in both
  // directions, and a statement on both sides that agrees is not.
  const upload = (extra: JsonObject = {}): JsonObject => ({
    content: { 'multipart/form-data': { schema: { type: 'object' }, ...extra } },
  });
  const etag = (extra: JsonObject = {}): JsonObject => ({
    headers: { ETag: { schema: { type: 'string' }, ...extra } },
  });
  const callback = {
    onEvent: { '{$request.body#/url}': { post: { responses: { '200': { description: 'OK' } } } } },
  };
  const link = { next: { operationId: 'thing', parameters: { id: '$response.body#/next' } } };

  it.each([
    [
      'a callback on the operation',
      thing(),
      thing({ operation: { callbacks: callback } }),
      /> callbacks$/,
    ],
    [
      'a link on a response',
      thing(),
      thing({ response: { links: link } }),
      /> response 200 > links$/,
    ],
    [
      'an encoding on a request body',
      thing({ requestBody: upload() }),
      thing({ requestBody: upload({ encoding: { file: { contentType: 'image/png' } } }) }),
      /> request body > multipart\/form-data > encoding$/,
    ],
    [
      'a style on a response header',
      thing({ response: etag() }),
      thing({ response: etag({ style: 'simple' }) }),
      /> response 200 > header ETag > style$/,
    ],
  ])('reports %s', (_label, plain, stated, where) => {
    const missing = between(stated, plain);
    const invented = between(plain, stated);

    expect(codes(missing)).toEqual(['OPERATION_UNMODELLED']);
    expect(missing[0]?.at).toMatch(where);
    expect(missing[0]?.message).toContain('contract');
    expect(codes(invented)).toEqual(['OPERATION_UNMODELLED']);
    expect(invented[0]?.message).toContain('code');
    expect(between(stated, structuredClone(stated))).toEqual([]);
  });

  it('reports a fact that differs, and reads a link written by reference as the link itself', () => {
    const link = { operationId: 'thing', parameters: { id: '$response.body#/next' } };
    const inline = thing({ response: { links: { next: link } } });
    const byReference = thing({
      response: { links: { next: { $ref: '#/components/links/Next' } } },
      root: { components: { links: { Next: link } } },
    });
    const changed = thing({ response: { links: { next: { ...link, operationId: 'other' } } } });

    expect(between(inline, byReference)).toEqual([]);
    expect(codes(between(inline, changed))).toEqual(['OPERATION_UNMODELLED']);
  });

  // Break caught: prose and metadata that carry no rule being reported, which would make the check unusable.
  it('ignores summaries, descriptions, tags, external docs, examples and x- extensions', () => {
    const body = (extra: JsonObject = {}, media: JsonObject = {}): JsonObject => ({
      required: true,
      ...extra,
      content: { 'application/json': { schema: { type: 'object' }, ...media } },
    });
    const plain = thing({ requestBody: body(), response: etag() });
    const decorated = thing({
      operation: {
        summary: 'Reads a thing',
        description: 'Longer prose',
        tags: ['things'],
        externalDocs: { url: 'https://docs.example' },
        'x-internal-note': 'not a rule',
      },
      id: { description: 'the id', example: 'abc', examples: { a: { value: 'abc' } } },
      requestBody: body(
        { description: 'the body' },
        { example: {}, examples: { a: { value: {} } } },
      ),
      response: {
        description: 'OK, with prose',
        ...etag({ description: 'version', example: '"1"', examples: { a: { value: '"1"' } } }),
      },
    });

    expect(between(plain, decorated)).toEqual([]);
    expect(between(decorated, plain)).toEqual([]);
  });

  // Break caught: the list of what the comparison models drifting from what the real contract says. The
  // contract states nothing today that the comparison cannot model, so every key the real contract uses is
  // either read or deliberately ignored. A new kind of fact then shows up here first.
  it('finds nothing in the real contract that it does not model', () => {
    const unmodelled = listOperationIds(CONTRACT).flatMap((id) => {
      const facts = describeIn(CONTRACT, id).unmodelled;
      return Object.keys(facts).map((key) => `${id}: ${key}`);
    });

    expect(unmodelled).toEqual([]);
  });

  it('reports no difference between the real contract and a copy of it, for every operation', () => {
    const copy = new JsonEditor(CONTRACT);
    const noisy = listOperationIds(CONTRACT).filter(
      (id) => compareOperations(describeIn(CONTRACT, id), describeIn(copy.document, id)).length > 0,
    );

    expect(noisy).toEqual([]);
  });
});
