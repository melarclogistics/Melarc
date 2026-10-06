import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type { JsonObject } from '../../platform/contract/json.js';
import { locateContract } from '../../platform/contract/locate-contract.js';
import { JsonEditor } from '../../test-support/json-edit.js';
import { checkConformance } from './check-conformance.js';
import { compareOperations } from './compare-operations.js';
import type { Finding } from './findings.js';
import {
  describeOperation,
  findOperation,
  type OperationDescription,
} from './operation-description.js';
import { createModel } from './schema-normalizer.js';

/**
 * `pnpm run contract:check` compares no operation today, because none is implemented, so the comparison has
 * only been shown on copies of the contract and on fixtures. This file shows it on the real contract and a
 * description written by hand: one real read, `GET /auth/sessions` (`listSessions`), which has two required
 * query parameters, an object response with a nested record, and the four error answers every read has.
 *
 * The hand-written description is what an implementation of the operation would have to say, written the way
 * the application's own generator writes it (shapes inline, one shared `Error`) and not by copying the
 * contract's text. It must read as the same operation, and every way of getting it wrong must be reported.
 */
const CONTRACT = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;

const ID = 'listSessions';
const AT = 'GET /auth/sessions';
/** A new list each time: a shape shared by two places would be changed in both by one edit of a copy. */
const principalTypes = (): string[] => ['STAFF', 'RIDER', 'VENDOR'];

/** The closed enumeration of error codes: 121 names that no description of one operation would repeat. */
function errorCodes(): string[] {
  const properties = (
    ((CONTRACT.components as JsonObject).schemas as JsonObject).Error as JsonObject
  ).properties as JsonObject;
  return [...((properties.code as JsonObject).enum as string[])];
}

const uuid = (): JsonObject => ({ type: 'string', format: 'uuid' });
const dateTime = (): JsonObject => ({ type: 'string', format: 'date-time' });
const errorAnswer = (what: string): JsonObject => ({
  description: what,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

/** What an application that implements `listSessions` as the contract says would describe itself as. */
function written(): JsonObject {
  return {
    openapi: '3.1.0',
    info: { title: 'Melarc API (derived from the implementation)', version: '0.0.0' },
    servers: [{ url: '/api/v1' }],
    paths: {
      '/auth/sessions': {
        get: {
          operationId: ID,
          'x-permission': 'staff.read',
          'x-error-codes': [
            'HUB_SCOPE_VIOLATION',
            'INSUFFICIENT_AUTHORITY',
            'NOT_FOUND',
            'PERMISSION_DENIED',
            'SESSION_INVALID',
            'VALIDATION_FAILED',
          ],
          security: [{ browserSession: [] }],
          parameters: [
            {
              name: 'principal_type',
              in: 'query',
              required: true,
              schema: { type: 'string', enum: principalTypes() },
            },
            { name: 'principal_id', in: 'query', required: true, schema: uuid() },
          ],
          responses: {
            '200': {
              description: 'The sessions of the principal',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['items'],
                    properties: {
                      items: { type: 'array', items: { $ref: '#/components/schemas/Session' } },
                    },
                  },
                },
              },
            },
            '400': errorAnswer('The query is not valid'),
            '401': errorAnswer('No usable session'),
            '403': errorAnswer('Not permitted'),
            '404': errorAnswer('No such principal'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        browserSession: { type: 'apiKey', in: 'cookie', name: 'melarc_session' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['code', 'message', 'request_id'],
          properties: {
            code: { type: 'string', enum: errorCodes() },
            message: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
            request_id: { type: 'string' },
          },
        },
        Session: {
          type: 'object',
          required: ['id', 'principal_type', 'state', 'expires_at'],
          properties: {
            id: uuid(),
            principal_type: { type: 'string', enum: principalTypes() },
            principal_id: uuid(),
            state: { type: 'string', enum: ['ACTIVE', 'TERMINATED'] },
            authorized_hub_ids: { type: 'array', items: uuid() },
            permissions: {
              type: 'array',
              uniqueItems: true,
              readOnly: true,
              items: { type: 'string', pattern: String.raw`^[a-z][a-z_]*(\.[a-z][a-z_]*)+$` },
            },
            registered_device_id: { type: ['string', 'null'], format: 'uuid' },
            issued_at: dateTime(),
            expires_at: dateTime(),
            last_activity_at: dateTime(),
            termination_reason: {
              type: ['string', 'null'],
              enum: [
                'SIGNED_OUT',
                'SUPERSEDED_BY_NEW_LOGIN',
                'REPLACED_BY_NEW_SESSION',
                'EXPIRED',
                'CREDENTIAL_CHANGED',
                'SUSPENDED',
                'OFFBOARDED',
                'ADMIN_REVOKED',
                'AUTHORITY_CHANGED',
                'HUB_SCOPE_CHANGED',
                'DEVICE_REVOKED',
                'DEVICE_REPLACED',
                'MFA_RESET',
                null,
              ],
            },
          },
        },
      },
    },
  };
}

function describeIn(document: JsonObject): OperationDescription {
  const found = findOperation(document, ID);
  if (found === undefined) throw new Error(`No operation ${ID}`);
  return describeOperation(createModel(document), document, found.path, found.method);
}

const contractSide = (): OperationDescription => describeIn(CONTRACT);

/** What the comparison says about the contract's operation and the hand-written one after `edit`. */
function driftAfter(edit: (document: JsonEditor) => void): Finding[] {
  const document = new JsonEditor(written());
  edit(document);
  return compareOperations(contractSide(), describeIn(document.document));
}

const GET = ['paths', '/auth/sessions', 'get'] as const;
const SESSION = ['components', 'schemas', 'Session'] as const;
const summary = (findings: readonly Finding[]) =>
  findings.map((finding) => [finding.code, finding.at] as const);

describe('a real read, written out by hand', () => {
  // Break caught: the comparison being proven only on fixtures it was written beside. This is the contract's
  // own operation, and the description of it says the same thing in different words: inline shapes where the
  // contract names components, a response named by status where the contract shares them, no prose.
  it('is the same operation as the contract states it, and the test is not reading nothing', () => {
    const expected = contractSide();
    const actual = describeIn(written());

    expect(Object.keys(expected.parameters).toSorted()).toEqual([
      'query:principal_id',
      'query:principal_type',
    ]);
    expect(expected.parameters['query:principal_type']?.required).toBe(true);
    expect(Object.keys(expected.responses)).toEqual(['200', '400', '401', '403', '404']);
    expect(expected.permission).toBe('staff.read');
    expect(expected.errorCodes).toHaveLength(6);
    expect(compareOperations(expected, actual)).toEqual([]);
  });

  it('does not depend on the order of its parameters, or on how its answers are spelt out', () => {
    const findings = driftAfter((document) => {
      document.update<unknown[]>([...GET, 'parameters'], (parameters) => parameters.toReversed());
      document.set(
        [...GET, 'responses', '401', 'description'],
        'Words that the contract does not use',
      );
      document.set(['info', 'title'], 'Another title');
    });

    expect(findings).toEqual([]);
  });

  // Break caught: the engine behind `pnpm run contract:check` finding nothing to say about a real operation
  // because it has only ever been given none. With `listSessions` claimed, live and bound, it compares one
  // operation and finds the hand-written description conforming.
  it('conforms through the whole check, which then compares one operation', () => {
    const live = [
      { method: 'GET', path: '/api/v1/auth/sessions' },
      { method: 'GET', path: '/livez' },
      { method: 'GET', path: '/readyz' },
    ];
    const report = checkConformance({
      contract: CONTRACT,
      generated: written(),
      live,
      scope: [ID],
      technicalRoutes: live.slice(1),
      bound: [{ operationId: ID, method: 'GET', path: '/api/v1/auth/sessions' }],
    });

    expect(report.findings).toEqual([]);
    expect(report.checkedOperations).toEqual([ID]);
  });
});

describe('a real read, written out wrongly', () => {
  // Break caught: a success answer on the wrong status. A client generated from the contract reads 200 and
  // the server answers 201; each side's answer is reported, because each is a promise the other did not make.
  it('reports a success status that is not the contract’s', () => {
    const findings = driftAfter((document) => {
      document.update<JsonObject>([...GET, 'responses'], ({ '200': ok, ...others }) => ({
        '201': ok as JsonObject,
        ...others,
      }));
    });

    expect(summary(findings)).toEqual([
      ['RESPONSE_DRIFT', `${AT} > response 200`],
      ['RESPONSE_DRIFT', `${AT} > response 201`],
    ]);
    expect(findings[0]?.message).toBe('The contract answers 200 and the code does not.');
    expect(findings[1]?.message).toBe('The code answers 201 and the contract does not.');
  });

  it('reports an error status that is not the contract’s', () => {
    const findings = driftAfter((document) => {
      document.update<JsonObject>([...GET, 'responses'], ({ '404': gone, ...others }) => ({
        ...others,
        '410': gone as JsonObject,
      }));
    });

    expect(summary(findings)).toEqual([
      ['ERROR_RESPONSE_DRIFT', `${AT} > response 404`],
      ['ERROR_RESPONSE_DRIFT', `${AT} > response 410`],
    ]);
  });

  // Break caught: a required query parameter the code no longer takes, so the contract's `principal_id` is
  // ignored and every list answers for the wrong principal, or is demanded of callers who need not send it.
  it('reports a required query parameter that is missing, one that is optional, and one that is extra', () => {
    const parameters = [...GET, 'parameters'] as const;
    const missing = driftAfter((document) => {
      document.update<{ name: string }[]>(parameters, (list) =>
        list.filter((parameter) => parameter.name !== 'principal_id'),
      );
    });
    const optional = driftAfter((document) => {
      document.set([...parameters, 1, 'required'], false);
    });
    const extra = driftAfter((document) => {
      document.push(parameters, { name: 'limit', in: 'query', schema: { type: 'integer' } });
    });

    expect(summary(missing)).toEqual([['PARAMETER_DRIFT', `${AT} > parameter query:principal_id`]]);
    expect(missing[0]?.message).toBe(
      'The contract declares the query parameter principal_id (required) and the code does not.',
    );
    expect(summary(optional)).toEqual([
      ['PARAMETER_DRIFT', `${AT} > parameter query:principal_id`],
    ]);
    expect(optional[0]?.message).toBe(
      'The query parameter principal_id is required in the contract and optional in the code.',
    );
    expect(summary(extra)).toEqual([['PARAMETER_DRIFT', `${AT} > parameter query:limit`]]);
  });

  it('reports a query parameter whose allowed values or format changed', () => {
    const wider = driftAfter((document) => {
      document.push([...GET, 'parameters', 0, 'schema', 'enum'], 'ADMIN');
    });
    const looser = driftAfter((document) => {
      document.remove([...GET, 'parameters', 1, 'schema', 'format']);
    });

    expect(summary(wider)).toEqual([['SCHEMA_ENUM', `${AT} > parameter query:principal_type`]]);
    expect(summary(looser)).toEqual([['SCHEMA_FORMAT', `${AT} > parameter query:principal_id`]]);
  });

  // Break caught: a response body that is not the contract's: a record that can be missing the field every
  // client reads, a value outside the closed set, or a type that changed.
  it('reports a response schema that differs: a required field, a value, a type, a nullable field', () => {
    const item = `${AT} > response 200 > application/json.properties.items.items`;
    const required = driftAfter((document) => {
      document.update<string[]>([...SESSION, 'required'], (names) =>
        names.filter((name) => name !== 'expires_at'),
      );
    });
    const state = driftAfter((document) => {
      document.set([...SESSION, 'properties', 'state', 'enum'], ['ACTIVE']);
    });
    const type = driftAfter((document) => {
      document.set([...SESSION, 'properties', 'expires_at'], { type: 'integer' });
    });
    const nullable = driftAfter((document) => {
      document.set([...SESSION, 'properties', 'registered_device_id', 'type'], 'string');
    });
    const reason = driftAfter((document) => {
      document.update<unknown[]>(
        [...SESSION, 'properties', 'termination_reason', 'enum'],
        (values) => values.filter((value) => value !== 'MFA_RESET'),
      );
    });

    expect(summary(required)).toEqual([['SCHEMA_REQUIRED', item]]);
    expect(required[0]?.message).toContain('"expires_at"');
    expect(summary(state)).toEqual([['SCHEMA_ENUM', `${item}.properties.state`]]);
    expect(state[0]?.message).toContain('"TERMINATED"');
    expect(summary(type)).toEqual([
      ['SCHEMA_TYPE', `${item}.properties.expires_at`],
      ['SCHEMA_FORMAT', `${item}.properties.expires_at`],
    ]);
    expect(summary(nullable)).toEqual([
      ['SCHEMA_NULLABLE', `${item}.properties.registered_device_id`],
    ]);
    expect(summary(reason)).toEqual([['SCHEMA_ENUM', `${item}.properties.termination_reason`]]);
  });

  it('reports a response body that is not an object with the contract’s items, or that moved', () => {
    const body = [...GET, 'responses', '200', 'content', 'application/json', 'schema'] as const;
    const bare = driftAfter((document) => {
      document.set(body, { type: 'array', items: { $ref: '#/components/schemas/Session' } });
    });
    const renamed = driftAfter((document) => {
      document.update<JsonObject>([...body, 'properties'], ({ items, ...rest }) => ({
        sessions: items as JsonObject,
        ...rest,
      }));
    });

    expect(summary(bare).map(([code]) => code)).toContain('SCHEMA_TYPE');
    expect(
      summary(renamed)
        .map(([code]) => code)
        .toSorted(),
    ).toEqual(['SCHEMA_PROPERTY_EXTRA', 'SCHEMA_PROPERTY_MISSING']);
  });

  // Break caught: an answer the contract never promised: a status the code can give and the contract does
  // not list, which no client was built to handle.
  it('reports an extra undeclared response, of each kind', () => {
    const teapot = driftAfter((document) => {
      document.set([...GET, 'responses', '418'], { description: 'tea' });
    });
    const server = driftAfter((document) => {
      document.set([...GET, 'responses', '500'], errorAnswer('boom'));
    });
    const accepted = driftAfter((document) => {
      document.set([...GET, 'responses', '202'], { description: 'later' });
    });
    const fallback = driftAfter((document) => {
      document.set([...GET, 'responses', 'default'], errorAnswer('anything'));
    });

    expect(summary(teapot)).toEqual([['ERROR_RESPONSE_DRIFT', `${AT} > response 418`]]);
    expect(summary(server)).toEqual([['ERROR_RESPONSE_DRIFT', `${AT} > response 500`]]);
    expect(summary(accepted)).toEqual([['RESPONSE_DRIFT', `${AT} > response 202`]]);
    expect(summary(fallback)).toEqual([['ERROR_RESPONSE_DRIFT', `${AT} > response default`]]);
    expect(teapot[0]?.message).toBe('The code answers 418 and the contract does not.');
  });

  it('reports a changed error body at the answer that carries it', () => {
    const findings = driftAfter((document) => {
      document.set(['components', 'schemas', 'Error', 'required'], ['code', 'message']);
    });

    expect(summary(findings)).toEqual(
      ['400', '401', '403', '404'].map(
        (status) => ['SCHEMA_REQUIRED', `${AT} > response ${status} > application/json`] as const,
      ),
    );
  });

  // Break caught: the authority of the operation changing without the contract. The permission, the way to
  // sign in and the errors it may return are what a reviewer reads to decide who may call it.
  it('reports a different permission, credential or list of errors', () => {
    const permission = driftAfter((document) => {
      document.set([...GET, 'x-permission'], 'staff.write');
    });
    const credential = driftAfter((document) => {
      document.set([...GET, 'security'], [{ browserSession: [] }, { riderSession: [] }]);
    });
    const errors = driftAfter((document) => {
      document.push([...GET, 'x-error-codes'], 'STATE_CONFLICT');
    });

    expect(summary(permission)).toEqual([['EXTENSION_DRIFT', `${AT} > x-permission`]]);
    expect(summary(credential)).toEqual([['SECURITY_DRIFT', `${AT} > security`]]);
    expect(summary(errors)).toEqual([['EXTENSION_DRIFT', `${AT} > x-error-codes`]]);
  });

  // Break caught: the comparison stopping at the first difference, so that fixing one reveals the next.
  it('reports every difference at once, in the order of the operation’s parts', () => {
    const findings = driftAfter((document) => {
      document.update<{ name: string }[]>([...GET, 'parameters'], (list) =>
        list.filter((parameter) => parameter.name !== 'principal_id'),
      );
      document.set([...GET, 'responses', '418'], { description: 'tea' });
      document.set([...SESSION, 'properties', 'expires_at'], {
        type: 'integer',
        format: 'date-time',
      });
      document.remove([...GET, 'responses', '403']);
    });

    expect(summary(findings)).toEqual([
      ['PARAMETER_DRIFT', `${AT} > parameter query:principal_id`],
      [
        'SCHEMA_TYPE',
        `${AT} > response 200 > application/json.properties.items.items.properties.expires_at`,
      ],
      ['ERROR_RESPONSE_DRIFT', `${AT} > response 403`],
      ['ERROR_RESPONSE_DRIFT', `${AT} > response 418`],
    ]);
  });
});
