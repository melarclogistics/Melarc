import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { FIXTURE_CONTRACT } from '../../test-support/contract-fixtures.js';
import {
  ContractValidator,
  MAX_VIOLATIONS,
  type RequestParts,
  type ResponseParts,
} from './contract-validator.js';
import type { JsonObject } from './json.js';
import { locateContract } from './locate-contract.js';

const REAL_CONTRACT = parse(
  readFileSync(locateContract(import.meta.dirname), 'utf8'),
) as JsonObject;
const fixture = new ContractValidator(FIXTURE_CONTRACT);
const real = new ContractValidator(REAL_CONTRACT);

const UUID = '0190d7c2-7a3e-7c1e-9d2a-3f4b5c6d7e8f';

function request(overrides: Partial<RequestParts> = {}): RequestParts {
  return { params: {}, query: {}, headers: {}, body: undefined, hasBody: false, ...overrides };
}

function response(overrides: Partial<ResponseParts> = {}): ResponseParts {
  return { status: 200, body: undefined, headers: {}, ...overrides };
}

/** A fixture createWidget request that is valid, with some parts replaced. */
function createRequest(overrides: Partial<RequestParts> = {}): RequestParts {
  return request({
    headers: { 'idempotency-key': 'key-1' },
    body: { label: 'Widget' },
    hasBody: true,
    ...overrides,
  });
}

describe('the contract as a validator reads it', () => {
  // Break caught: an operation of the real contract that the validator cannot be built for, which would
  // fail the first request to it, not the start of the application. Every one of the contract's
  // operations must compile, so the first slice to use one cannot find out it never could.
  it('compiles every operation in the real contract', () => {
    const operationIds = Object.values(REAL_CONTRACT.paths as JsonObject).flatMap((item) =>
      Object.values(item as JsonObject).flatMap((operation) =>
        typeof (operation as JsonObject | undefined)?.operationId === 'string'
          ? [(operation as JsonObject).operationId as string]
          : [],
      ),
    );

    expect(operationIds.length).toBeGreaterThan(100);
    for (const id of operationIds)
      expect(() => {
        real.prepare(id);
      }, id).not.toThrow();
  });

  it('knows which operations the contract has', () => {
    expect(fixture.hasOperation('getWidget')).toBe(true);
    expect(fixture.hasOperation('noSuchOperation')).toBe(false);
    expect(real.hasOperation('confirmPickupRequest')).toBe(true);
  });

  // Break caught: an unknown operation treated as "nothing to validate", which would let a mistyped id
  // switch validation off without a sound.
  it('refuses to validate against an operation the contract does not have', () => {
    expect(() => fixture.validateRequest('noSuchOperation', request())).toThrow(
      /no operation noSuchOperation/,
    );
    expect(() => fixture.validateResponse('noSuchOperation', response())).toThrow(
      /no operation noSuchOperation/,
    );
  });
});

describe('a request the contract accepts', () => {
  it('has no violations', () => {
    expect(fixture.validateRequest('createWidget', createRequest())).toEqual([]);
    expect(
      fixture.validateRequest(
        'createWidget',
        createRequest({ body: { label: 'W', urgent: true } }),
      ),
    ).toEqual([]);
    expect(fixture.validateRequest('getWidget', request({ params: { id: UUID } }))).toEqual([]);
  });

  // Break caught: rules applied to what the contract does not state. Extra query parameters are not a
  // contract matter, and a body on an operation that declares none is not validated.
  // Break caught: validation changing the request it reads. Text from the query is read as the type the
  // contract gives it, and that must happen to a copy: the handler still sees what the caller sent.
  it('does not change the request it validates', () => {
    const query = { dry_run: 'true' };
    const parts = createRequest({ query });

    fixture.validateRequest('createWidget', parts);

    expect(query).toEqual({ dry_run: 'true' });
    expect(parts.query).toBe(query);
  });

  it('ignores an undeclared query parameter and a body the operation does not declare', () => {
    expect(
      fixture.validateRequest(
        'getWidget',
        request({ params: { id: UUID }, query: { anything: 'x' }, body: { x: 1 }, hasBody: true }),
      ),
    ).toEqual([]);
  });
});

describe('a request body that breaks a rule', () => {
  // Break caught: a body accepted although it breaks the contract's schema. Each row is one rule; the
  // violation says where (a JSON pointer inside the body) and which rule, and nothing the caller sent.
  it.each([
    ['a required field missing', {}, '/label', 'required'],
    ['a field of the wrong type', { label: 5 }, '/label', 'type'],
    ['a string over its limit', { label: 'x'.repeat(41) }, '/label', 'maxLength'],
    ['a field of the wrong type, not coerced', { label: 'ok', urgent: 'true' }, '/urgent', 'type'],
  ])('reports %s', (_label, body, pointer, rule) => {
    expect(fixture.validateRequest('createWidget', createRequest({ body }))).toEqual([
      { in: 'body', pointer, rule },
    ]);
  });

  // Break caught: a closed object accepting a property it does not name. This is the contract's
  // structural rule (nothing the schema does not list is accepted), and the offending name is the
  // caller's input, so it must never come back in the answer.
  it('reports a property a closed body does not allow, without repeating its name', () => {
    const violations = fixture.validateRequest(
      'createWidget',
      createRequest({ body: { label: 'Widget', price: 100, '<script>alert(1)</script>': 1 } }),
    );

    // One violation per place and rule: how many unknown properties there were is not the point.
    expect(violations).toEqual([{ in: 'body', pointer: '', rule: 'additionalProperties' }]);
    expect(JSON.stringify(violations)).not.toContain('price');
    expect(JSON.stringify(violations)).not.toContain('script');
  });

  // Break caught: a required body that is not there, or not JSON.
  it('reports a required body that was not sent', () => {
    expect(
      fixture.validateRequest('createWidget', createRequest({ body: undefined, hasBody: false })),
    ).toEqual([{ in: 'body', pointer: '', rule: 'required' }]);
  });

  // Break caught: the whole body being checked as a single value that is not an object.
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'text'],
  ])('reports a body that is %s instead of an object', (_label, body) => {
    expect(fixture.validateRequest('createWidget', createRequest({ body }))).toEqual([
      { in: 'body', pointer: '', rule: 'type' },
    ]);
  });
});

describe('a request with a wrong parameter', () => {
  // Break caught: a malformed identifier reaching a handler, which then asks the database for it.
  it('reports a path parameter that is not the format the contract says', () => {
    expect(fixture.validateRequest('getWidget', request({ params: { id: 'not-a-uuid' } }))).toEqual(
      [{ in: 'path', pointer: 'id', rule: 'format' }],
    );
  });

  // Break caught: a required header (the contract's Idempotency-Key and If-Match) accepted when absent,
  // which removes replay and concurrency protection from the operation.
  it('reports a required header that is missing, and one that is too long', () => {
    expect(fixture.validateRequest('createWidget', createRequest({ headers: {} }))).toEqual([
      { in: 'header', pointer: 'idempotency-key', rule: 'required' },
    ]);
    expect(
      fixture.validateRequest(
        'createWidget',
        createRequest({ headers: { 'idempotency-key': 'k'.repeat(129) } }),
      ),
    ).toEqual([{ in: 'header', pointer: 'idempotency-key', rule: 'maxLength' }]);
  });

  // Break caught: query values rejected for arriving as text, or accepted whatever they say. Query values are
  // always strings on the wire; the contract types them.
  it('reads a query value as the type the contract gives it', () => {
    expect(
      fixture.validateRequest('createWidget', createRequest({ query: { dry_run: 'true' } })),
    ).toEqual([]);
    expect(
      fixture.validateRequest('createWidget', createRequest({ query: { dry_run: 'maybe' } })),
    ).toEqual([{ in: 'query', pointer: 'dry_run', rule: 'type' }]);
  });

  it('reports every violation, whichever part of the request it is in', () => {
    const violations = fixture.validateRequest(
      'createWidget',
      createRequest({ headers: {}, body: {}, query: { dry_run: 'maybe' } }),
    );

    expect(
      violations.map((violation) => `${violation.in}:${violation.pointer}`).toSorted(),
    ).toEqual(['body:/label', 'header:idempotency-key', 'query:dry_run']);
  });

  // Break caught: an answer that grows with the size of a hostile request.
  it('reports at most a fixed number of violations', () => {
    const many = Array.from({ length: 200 }, () => 'not a number');
    const schema = new ContractValidator({
      openapi: '3.1.0',
      paths: {
        '/bulk': {
          post: {
            operationId: 'bulk',
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { type: 'array', items: { type: 'integer' } } },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });

    const violations = schema.validateRequest('bulk', request({ body: many, hasBody: true }));

    expect(violations).toHaveLength(MAX_VIOLATIONS);
  });
});

describe('a body that matches none of several shapes', () => {
  const choice = new ContractValidator({
    openapi: '3.1.0',
    paths: {
      '/choice': {
        post: {
          operationId: 'choice',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
                    { type: 'object', required: ['b'], properties: { b: { type: 'string' } } },
                  ],
                },
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });

  // Break caught: the problems inside each branch being reported as if they were the problem. A body that
  // fits neither of two shapes has one fault, that it fits neither, and not one for every field it lacks.
  it('is reported once, as the choice it failed, and not as the faults of each branch', () => {
    expect(choice.validateRequest('choice', request({ body: {}, hasBody: true }))).toEqual([
      { in: 'body', pointer: '', rule: 'oneOf' },
    ]);
    expect(choice.validateRequest('choice', request({ body: { a: 'x' }, hasBody: true }))).toEqual(
      [],
    );
    expect(choice.validateRequest('choice', request({ body: { b: 'x' }, hasBody: true }))).toEqual(
      [],
    );
  });

  // Break caught: `anyOf` handled differently from `oneOf`. The contract uses both.
  it('is reported once for anyOf as well', () => {
    const either = new ContractValidator({
      openapi: '3.1.0',
      paths: {
        '/either': {
          post: {
            operationId: 'either',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { anyOf: [{ required: ['a'] }, { required: ['b'] }] },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });

    expect(either.validateRequest('either', request({ body: {}, hasBody: true }))).toEqual([
      { in: 'body', pointer: '', rule: 'anyOf' },
    ]);
    expect(either.validateRequest('either', request({ body: { b: 1 }, hasBody: true }))).toEqual(
      [],
    );
  });

  // Break caught: dropping the errors of a neighbouring field because they came just before a choice. Only the
  // choice's own branches are hidden; a fault elsewhere in the same body is still a fault.
  it('does not hide a fault in another field that is reported just before the choice', () => {
    const neighbours = new ContractValidator({
      openapi: '3.1.0',
      paths: {
        '/neighbours': {
          post: {
            operationId: 'neighbours',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      count: { type: 'integer' },
                      pick: { oneOf: [{ type: 'string' }, { type: 'boolean' }] },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });

    const violations = neighbours.validateRequest(
      'neighbours',
      request({ body: { count: 'many', pick: 5 }, hasBody: true }),
    );

    expect(violations).toHaveLength(2);
    expect(violations).toContainEqual({ in: 'body', pointer: '/count', rule: 'type' });
    expect(violations).toContainEqual({ in: 'body', pointer: '/pick', rule: 'oneOf' });
  });

  // Break caught: the filter that hides branch faults hiding an ordinary one. A schema can state its own rules
  // beside a choice; a fault in those is a fault of its own and has to be reported with the choice.
  it('still reports a rule the same schema states beside the choice', () => {
    const beside = new ContractValidator({
      openapi: '3.1.0',
      paths: {
        '/beside': {
          post: {
            operationId: 'beside',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id'],
                    oneOf: [{ required: ['a'] }, { required: ['b'] }],
                  },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });

    const violations = beside.validateRequest('beside', request({ body: {}, hasBody: true }));

    expect(violations).toHaveLength(2);
    expect(violations).toContainEqual({ in: 'body', pointer: '/id', rule: 'required' });
    expect(violations).toContainEqual({ in: 'body', pointer: '', rule: 'oneOf' });
  });

  it('is reported the same way for the real contract’s choice of intake shapes', () => {
    expect(
      real.validateResponse('getHubIntake', response({ body: { count_phase: 'NEITHER' } })),
    ).toEqual([{ in: 'response-body', pointer: '', rule: 'oneOf' }]);
  });
});

/**
 * Audit F05. A violation may name what the contract names (a property of a schema) and a position in an array,
 * and nothing else. A dictionary's key is the caller's, or the data's: it can be a name, a card number or a
 * token, and text that looks like a contract name is no proof that it is one.
 */
describe('what a violation may say (audit F05)', () => {
  /** A validator for one operation whose request body and 200 response share `schema`. */
  function validatorFor(schema: JsonObject, components: JsonObject = {}): ContractValidator {
    return new ContractValidator({
      openapi: '3.1.0',
      paths: {
        '/x': {
          post: {
            operationId: 'x',
            requestBody: { required: true, content: { 'application/json': { schema } } },
            responses: {
              '200': { description: 'OK', content: { 'application/json': { schema } } },
            },
          },
        },
      },
      components,
    });
  }

  /** What a request with this body, and a response with it, each report: `pointer:rule`, sorted. */
  function reported(validator: ContractValidator, body: unknown): [string[], string[]] {
    const flat = (violations: readonly { pointer: string; rule: string }[]) =>
      violations.map((violation) => `${violation.pointer}:${violation.rule}`).toSorted();
    return [
      flat(validator.validateRequest('x', request({ body, hasBody: true }))),
      flat(validator.validateResponse('x', response({ body }))),
    ];
  }

  const LABELS = {
    type: 'object',
    properties: { labels: { type: 'object', additionalProperties: { type: 'integer' } } },
  };

  // Break caught: the old rule, that any key of 1 to 64 letters, digits, `_`, `.` and `-` is safe to repeat.
  // These all pass that test and are exactly what must never come back: a name, a token, a card number.
  it.each([
    'jane.doe',
    'FAKE-PRIVATE-CANARY',
    'CANARY_9f3a2c71',
    '4111111111111111',
    'sk_live_51HxAbCdEfGhIjKlM',
    'a'.repeat(64),
    'user@example.com',
    '<img src=x onerror=alert(1)>',
    '0',
    '__proto__',
    'constructor',
    'toString',
  ])('never names the dictionary key %j, in a request or in a response', (key) => {
    const [fromRequest, fromResponse] = reported(
      validatorFor(LABELS),
      JSON.parse(`{"labels": {${JSON.stringify(key)}: "not-an-integer"}}`) as unknown,
    );

    expect(fromRequest).toEqual(['/labels/*:type']);
    expect(fromResponse).toEqual(['/labels/*:type']);
  });

  // Break caught: the placeholder hiding the useful part of a path. The names the schema gives below a
  // dictionary key, and a missing required property of its value, are still reported.
  it('keeps the schema’s own names below a dictionary key', () => {
    const validator = validatorFor({
      type: 'object',
      properties: {
        rows: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            required: ['count'],
            properties: { count: { type: 'integer' } },
          },
        },
      },
    });

    const [fromRequest, fromResponse] = reported(validator, {
      rows: { 'jane.doe': { count: 'many' }, '4111111111111111': {} },
    });

    const expected = ['/rows/*/count:required', '/rows/*/count:type'];
    expect(fromRequest).toEqual(expected);
    expect(fromResponse).toEqual(expected);
  });

  // Break caught: array positions lost with the names. A position is a place in the data, not data.
  it('keeps array positions, and the schema’s names inside them', () => {
    const validator = validatorFor({
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: { type: 'object', properties: { price: { type: 'integer' } } },
        },
      },
    });

    expect(reported(validator, { lines: [{ price: 1 }, { price: 'x' }] })).toEqual([
      ['/lines/1/price:type'],
      ['/lines/1/price:type'],
    ]);
  });

  // Break caught: a dictionary under an array, or an array under a dictionary, losing its way.
  it('follows a dictionary of lists and a list of dictionaries', () => {
    const validator = validatorFor({
      type: 'object',
      properties: {
        byOwner: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'integer' } },
        },
        rows: {
          type: 'array',
          items: { type: 'object', additionalProperties: { type: 'integer' } },
        },
      },
    });

    const body = { byOwner: { 'jane.doe': [1, 'x'] }, rows: [{ 'jane.doe': 'y' }] };

    expect(reported(validator, body)).toEqual([
      ['/byOwner/*/1:type', '/rows/0/*:type'],
      ['/byOwner/*/1:type', '/rows/0/*:type'],
    ]);
  });

  // Break caught: names declared in a composed schema (`allOf` of references, `then`) treated as unknown,
  // which would blank out every path of a schema the contract builds from parts.
  it('knows the names a schema declares through allOf, a reference or a conditional', () => {
    const components = {
      schemas: {
        Base: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        Extension: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            labels: { type: 'object', additionalProperties: { type: 'integer' } },
          },
        },
      },
    };
    const validator = validatorFor(
      {
        allOf: [
          { $ref: '#/components/schemas/Base' },
          { $ref: '#/components/schemas/Extension' },
          {
            if: { properties: { kind: { const: 'A' } } },
            then: { properties: { a: { type: 'integer' } } },
          },
        ],
      },
      components,
    );

    const body = { id: 7, count: 'x', labels: { 'jane.doe': 'y' }, kind: 'A', a: 'z' };

    expect(reported(validator, body)).toEqual([
      ['/a:type', '/count:type', '/id:type', '/labels/*:type'],
      ['/a:type', '/count:type', '/id:type', '/labels/*:type'],
    ]);
  });

  // Break caught: dictionaries whose keys are chosen by a pattern, and tuples, losing their way: the key is
  // the data's, the position is not, and the schema's own names below either are still said.
  it('follows patterned keys and tuple positions', () => {
    const patterned = validatorFor({
      type: 'object',
      patternProperties: {
        '^x-': { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } },
      },
    });
    const tuple = validatorFor({
      type: 'array',
      prefixItems: [
        { type: 'integer' },
        { type: 'object', properties: { a: { type: 'integer' } } },
      ],
    });

    expect(reported(patterned, { 'x-jane.doe': { n: 'a' } })).toEqual([
      ['/*/n:type'],
      ['/*/n:type'],
    ]);
    expect(reported(tuple, [1, { a: 'x' }])).toEqual([['/1/a:type'], ['/1/a:type']]);
  });

  // Break caught: a property the schema never names being reported because the data happens to have it.
  it('reports a key as a dictionary key unless the schema names it at that place', () => {
    const validator = validatorFor({
      type: 'object',
      properties: { known: { type: 'integer' } },
      additionalProperties: { type: 'integer' },
    });

    expect(reported(validator, { known: 'x', stranger: 'y' })).toEqual([
      ['/*:type', '/known:type'],
      ['/*:type', '/known:type'],
    ]);
  });

  // Break caught: a name every object inherits (`constructor`, `toString`, `__proto__`) counting as one the
  // schema declares, because "is it a property of `properties`" was asked of the prototype chain too.
  it('does not take an inherited name for one the schema declares', () => {
    const validator = validatorFor({
      type: 'object',
      properties: { known: { type: 'integer' } },
      additionalProperties: { type: 'integer' },
    });
    const body = JSON.parse(
      '{"known": "x", "constructor": "y", "toString": "z", "__proto__": "w", "hasOwnProperty": "v"}',
    ) as unknown;

    expect(reported(validator, body)).toEqual([
      ['/*:type', '/known:type'],
      ['/*:type', '/known:type'],
    ]);
  });

  // Break caught: the name of a required property left out of the path because it is declared in `required` and
  // nowhere else. It comes from the schema, so it is safe, and it is the most useful word in the answer.
  it('names a required property that only `required` mentions', () => {
    const validator = validatorFor({ type: 'object', required: ['id'] });

    expect(reported(validator, {})).toEqual([['/id:required'], ['/id:required']]);
  });

  // Break caught (audit F05, with the real contract's own dictionaries): the key under `headers` of an
  // authorization, which a real response fills with the storage provider's header names.
  it('names no key of a dictionary in the real contract', () => {
    const body = {
      method: 'GET',
      url: 'https://storage.example/object',
      expires_at: '2026-10-05T10:00:00Z',
      headers: { 'FAKE-PRIVATE-CANARY': 5 },
    };

    // The answer carries the header the contract now requires of it, so that what is left is the body's.
    const violations = real.validateResponse(
      'createEvidenceRetrievalAuthorization',
      response({ body, headers: { 'cache-control': 'no-store' } }),
    );

    expect(violations).toEqual([{ in: 'response-body', pointer: '/headers/*', rule: 'type' }]);
    expect(JSON.stringify(violations)).not.toContain('CANARY');
  });

  // Break caught: a parameter name chosen by the caller reaching the answer. Only a declared parameter can be
  // wrong, and it is named by the contract.
  it('names only declared parameters', () => {
    const violations = fixture.validateRequest(
      'createWidget',
      createRequest({ query: { 'jane.doe': 'x', dry_run: 'maybe' } }),
    );

    expect(violations).toEqual([{ in: 'query', pointer: 'dry_run', rule: 'type' }]);
  });
});

describe('a response', () => {
  const WIDGET = { id: UUID, state: 'ACTIVE', note: null };
  const ERROR = { code: 'NOT_FOUND', message: 'Resource not found', request_id: 'req-1' };

  it('that the contract describes has no violations', () => {
    expect(fixture.validateResponse('getWidget', response({ body: WIDGET }))).toEqual([]);
    expect(fixture.validateResponse('getWidget', response({ status: 404, body: ERROR }))).toEqual(
      [],
    );
    expect(
      fixture.validateResponse('createWidget', response({ status: 201, body: WIDGET })),
    ).toEqual([]);
  });

  // Break caught: a response that drifts from the contract at run time even though the description of it
  // does not. Each row is a way a handler's real output can be wrong.
  it.each([
    ['a required field missing', { id: UUID }, '/state', 'required'],
    ['a value outside its enum', { ...WIDGET, state: 'ARCHIVED' }, '/state', 'enum'],
    ['a field of the wrong type', { ...WIDGET, note: 5 }, '/note', 'type'],
    ['an identifier that is not a UUID', { ...WIDGET, id: 'abc' }, '/id', 'format'],
  ])('reports %s', (_label, body, pointer, rule) => {
    expect(fixture.validateResponse('getWidget', response({ body }))).toEqual([
      { in: 'response-body', pointer, rule },
    ]);
  });

  // Break caught: an answer with a status the contract never lists for the operation.
  it('reports a status the operation does not declare', () => {
    expect(fixture.validateResponse('getWidget', response({ status: 500, body: ERROR }))).toEqual([
      { in: 'status', pointer: '500', rule: 'undeclared' },
    ]);
  });

  // Break caught: a handler that returns nothing where the contract promises a body.
  it('reports a missing body where the contract describes one', () => {
    expect(fixture.validateResponse('getWidget', response({ body: undefined }))).toEqual([
      { in: 'response-body', pointer: '', rule: 'required' },
    ]);
  });

  // Break caught: the catch-all `default` response being ignored, so any status it covers reads as undeclared.
  it('judges a status the contract does not list by its default response', () => {
    const validator = new ContractValidator({
      openapi: '3.1.0',
      paths: {
        '/things': {
          get: {
            operationId: 'things',
            responses: {
              '200': { description: 'OK' },
              default: {
                description: 'Failure',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['code'],
                      properties: { code: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(
      validator.validateResponse('things', response({ status: 503, body: { code: 'X' } })),
    ).toEqual([]);
    expect(validator.validateResponse('things', response({ status: 503, body: {} }))).toEqual([
      { in: 'response-body', pointer: '/code', rule: 'required' },
    ]);
  });

  // Break caught (audit F04): a status range such as `2XX`, which OpenAPI allows as a response key, read as a
  // status nobody sends, so every 201 reads as undeclared. An exact status wins over its range, a range over
  // `default`.
  it('judges a status by its range, after the exact status and before the default', () => {
    const body = (field: string): JsonObject => ({
      description: field,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: [field],
            properties: { [field]: { type: 'string' } },
          },
        },
      },
    });
    const validator = new ContractValidator({
      openapi: '3.1.0',
      paths: {
        '/ranged': {
          get: {
            operationId: 'ranged',
            responses: {
              '200': body('exact'),
              '2XX': body('success'),
              '4XX': body('client'),
              default: body('other'),
            },
          },
        },
      },
    });
    const judged = (status: number, field: string) =>
      validator.validateResponse('ranged', response({ status, body: { [field]: 'x' } }));

    expect(judged(200, 'exact')).toEqual([]);
    expect(judged(201, 'success')).toEqual([]);
    expect(judged(404, 'client')).toEqual([]);
    expect(judged(503, 'other')).toEqual([]);
    expect(judged(201, 'exact')).toEqual([
      { in: 'response-body', pointer: '/success', rule: 'required' },
    ]);
    expect(judged(200, 'success')).toEqual([
      { in: 'response-body', pointer: '/exact', rule: 'required' },
    ]);
  });

  it('reports a body where the contract describes none, and accepts none', () => {
    const validator = new ContractValidator({
      openapi: '3.1.0',
      paths: {
        '/gone': {
          delete: { operationId: 'gone', responses: { '204': { description: 'Deleted' } } },
        },
      },
    });

    expect(validator.validateResponse('gone', response({ status: 204, body: { x: 1 } }))).toEqual([
      { in: 'response-body', pointer: '', rule: 'unexpected' },
    ]);
    expect(validator.validateResponse('gone', response({ status: 204 }))).toEqual([]);
  });

  // Break caught: a header the contract says is always sent (an ETag the next write depends on) missing.
  it('reports a required response header that was not set', () => {
    const validator = new ContractValidator({
      openapi: '3.1.0',
      paths: {
        '/things': {
          get: {
            operationId: 'things',
            responses: {
              '200': {
                description: 'OK',
                headers: { ETag: { required: true, schema: { type: 'string' } } },
              },
            },
          },
        },
      },
    });

    expect(validator.validateResponse('things', response())).toEqual([
      { in: 'response-header', pointer: 'etag', rule: 'required' },
    ]);
    expect(validator.validateResponse('things', response({ headers: { etag: '"v1"' } }))).toEqual(
      [],
    );
  });
});

/**
 * Headers and cookies, and who owns them (audit F04, "header/cookie ownership").
 *
 * - The contract declares them: response headers with schemas, `x-cookies` (every cookie's attributes) once at
 *   the root, `x-set-cookies` on each response that sets some.
 * - This validator checks what a response really carries (outside production) and what a request really
 *   carries, against that declaration: header values, the cookies set and their attributes, declared cookie
 *   parameters.
 * - It never decides who a caller is. A cookie parameter that is present is not a session: authenticating
 *   the session belongs to the guard, which the identity slice adds.
 * - Error bodies made by the exception filter, and the real operation's behaviour, are covered by each
 *   operation's own integration test.
 */
describe('a response header whose value breaks its schema', () => {
  const validator = new ContractValidator({
    openapi: '3.1.0',
    paths: {
      '/things': {
        get: {
          operationId: 'things',
          responses: {
            '200': {
              description: 'OK',
              headers: {
                ETag: { required: true, schema: { type: 'string', pattern: '^"[0-9]+"$' } },
                'Retry-After': { schema: { type: 'integer', minimum: 1 } },
              },
            },
          },
        },
      },
    },
  });
  const sent = (headers: Record<string, unknown>) =>
    validator.validateResponse('things', response({ headers }));

  // Break caught: a header that is present and wrong passing because only its presence was looked at. The ETag
  // is what the next write sends as If-Match; one that is not a version breaks that write.
  it('is reported by header and rule, and only when present', () => {
    expect(sent({ etag: '"7"' })).toEqual([]);
    expect(sent({ etag: 'W/not-a-version' })).toEqual([
      { in: 'response-header', pointer: 'etag', rule: 'pattern' },
    ]);
    expect(sent({ etag: '"7"', 'retry-after': '30' })).toEqual([]);
    expect(sent({ etag: '"7"', 'retry-after': '0' })).toEqual([
      { in: 'response-header', pointer: 'retry-after', rule: 'minimum' },
    ]);
    expect(sent({ etag: '"7"', 'retry-after': 'soon' })).toEqual([
      { in: 'response-header', pointer: 'retry-after', rule: 'type' },
    ]);
  });

  it('is reported once, alongside a header that is missing', () => {
    expect(
      sent({ 'retry-after': '0' })
        .map((v) => `${v.pointer}:${v.rule}`)
        .toSorted(),
    ).toEqual(['etag:required', 'retry-after:minimum']);
  });

  // Break caught: the value of the header repeated in the answer, which can hold anything a handler set.
  it('never repeats the value', () => {
    expect(JSON.stringify(sent({ etag: 'HEADER-VALUE-CANARY' }))).not.toContain('CANARY');
  });
});

describe('the cookies a response sets', () => {
  const SESSION = 'melarc_session=SESSION-CANARY; Path=/; HttpOnly; Secure; SameSite=Lax';
  const CSRF = 'melarc_csrf=CSRF-CANARY; Path=/; Secure; SameSite=Lax';
  const json = (schema: JsonObject): JsonObject => ({ 'application/json': { schema } });
  const validator = new ContractValidator({
    openapi: '3.1.0',
    'x-cookies': {
      melarc_session: {
        attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/',
        host_only: true,
        read_by_javascript: false,
      },
      melarc_csrf: {
        attributes: 'Secure; SameSite=Lax; Path=/',
        host_only: true,
        read_by_javascript: true,
      },
      melarc_vendor_device: {
        attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/',
        host_only: true,
        read_by_javascript: false,
      },
    },
    paths: {
      '/sign-in': {
        post: {
          operationId: 'signIn',
          responses: {
            '200': {
              description: 'Signed in',
              'x-set-cookies': ['melarc_session', 'melarc_csrf'],
              headers: { 'Set-Cookie': { schema: { type: 'string' } } },
              content: json({ type: 'object' }),
            },
            '202': { description: 'A second factor is needed', content: json({ type: 'object' }) },
          },
        },
      },
    },
  });
  const cookiesOf = (status: number, setCookie?: string | string[]) =>
    validator
      .validateResponse(
        'signIn',
        response({
          status,
          body: {},
          headers: setCookie === undefined ? {} : { 'set-cookie': setCookie },
        }),
      )
      .filter((violation) => violation.in === 'response-cookie');

  it('has no violation when exactly the declared cookies are set, as declared', () => {
    expect(cookiesOf(200, [SESSION, CSRF])).toEqual([]);
    expect(cookiesOf(202)).toEqual([]);
  });

  // Break caught: a cookie the response declares not being set, so a sign-in that leaves the browser without a
  // session, or without the token it must echo, passes.
  it('reports a declared cookie that is not set, and all of them when none is', () => {
    expect(cookiesOf(200, [CSRF])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'required' },
    ]);
    expect(
      cookiesOf(200)
        .map((violation) => violation.pointer)
        .toSorted(),
    ).toEqual(['melarc_csrf', 'melarc_session']);
  });

  // Break caught (the point of judging by the real status): the answer that says a second factor is still
  // needed (202) establishing a session. A cookie a response does not declare is a defect, and a session
  // cookie on the wrong answer is the worst of them.
  it('reports a cookie the response does not declare, naming it when the contract knows it', () => {
    expect(cookiesOf(202, [SESSION])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'undeclared' },
    ]);
    expect(cookiesOf(200, [SESSION, CSRF, 'tracker=1; Path=/'])).toEqual([
      { in: 'response-cookie', pointer: '*', rule: 'undeclared' },
    ]);
    expect(
      cookiesOf(200, [
        SESSION,
        CSRF,
        'melarc_vendor_device=D; HttpOnly; Secure; SameSite=Lax; Path=/',
      ]),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'undeclared' }]);
  });

  // Break caught: a cookie named like something every object has (`constructor`, `toString`) being taken for one
  // the contract knows, which names it in the violation. The contract's own names are looked up as its own.
  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'does not take a cookie named %s for one the contract knows',
    (name) => {
      expect(cookiesOf(200, [SESSION, CSRF, `${name}=1; Path=/`])).toEqual([
        { in: 'response-cookie', pointer: '*', rule: 'undeclared' },
      ]);
    },
  );

  // Break caught: a cookie set with weaker attributes than the contract's `x-cookies` states. Each attribute is
  // its own rule, named in the contract's words.
  it.each([
    [
      'the session cookie without HttpOnly',
      'melarc_session=S; Path=/; Secure; SameSite=Lax',
      'melarc_session',
      'httponly',
    ],
    [
      'the CSRF cookie with HttpOnly, which hides it from the page that must echo it',
      'melarc_csrf=C; Path=/; HttpOnly; Secure; SameSite=Lax',
      'melarc_csrf',
      'httponly',
    ],
    [
      'a cookie without Secure',
      'melarc_session=S; Path=/; HttpOnly; SameSite=Lax',
      'melarc_session',
      'secure',
    ],
    [
      'a cookie with another SameSite',
      'melarc_session=S; Path=/; HttpOnly; Secure; SameSite=None',
      'melarc_session',
      'samesite',
    ],
    [
      'a cookie without SameSite',
      'melarc_session=S; Path=/; HttpOnly; Secure',
      'melarc_session',
      'samesite',
    ],
    [
      'a cookie on another path',
      'melarc_session=S; Path=/api; HttpOnly; Secure; SameSite=Lax',
      'melarc_session',
      'path',
    ],
    [
      'a cookie with no path',
      'melarc_session=S; HttpOnly; Secure; SameSite=Lax',
      'melarc_session',
      'path',
    ],
    [
      'a cookie shared with subdomains',
      'melarc_session=S; Path=/; Domain=melarc.example; HttpOnly; Secure; SameSite=Lax',
      'melarc_session',
      'domain',
    ],
  ])('reports %s', (_label, line, pointer, rule) => {
    const other = pointer === 'melarc_session' ? CSRF : SESSION;

    expect(cookiesOf(200, [line, other])).toEqual([{ in: 'response-cookie', pointer, rule }]);
  });

  it('reads attribute names and values without regard to case, and one line or several alike', () => {
    expect(
      cookiesOf(200, [
        'melarc_session=S; path=/; httponly; SECURE; samesite=LAX',
        'melarc_csrf=C; PATH=/; secure; SameSite=lax; Max-Age=3600',
      ]),
    ).toEqual([]);
    expect(cookiesOf(200, SESSION)).toEqual([
      { in: 'response-cookie', pointer: 'melarc_csrf', rule: 'required' },
    ]);
  });

  // Break caught: a cookie's value, which is a credential, reaching the answer or the log.
  it('never repeats a cookie value', () => {
    const violations = cookiesOf(200, [
      'melarc_session=SESSION-CANARY; Path=/api',
      'tracker=TRACKER-CANARY',
    ]);

    expect(violations.length).toBeGreaterThan(0);
    expect(JSON.stringify(violations)).not.toContain('CANARY');
  });

  // Break caught: a contract that contradicts itself being read as it was meant. A cookie named in
  // `x-set-cookies` that `x-cookies` does not define cannot be checked, and a cookie that is HttpOnly and
  // readable by script cannot be both. The application would run unprotected, so preparing fails.
  it('refuses a contract whose cookies it cannot check', () => {
    const build = (xCookies: JsonObject, set: string[]) =>
      new ContractValidator({
        openapi: '3.1.0',
        'x-cookies': xCookies,
        paths: {
          '/c': {
            get: {
              operationId: 'c',
              responses: { '200': { description: 'OK', 'x-set-cookies': set } },
            },
          },
        },
      });

    expect(() => {
      build({ a: { attributes: 'Secure', host_only: true, read_by_javascript: true } }, [
        'ghost',
      ]).prepare('c');
    }).toThrow(/ghost/);
    expect(() => {
      build({ a: { attributes: 'HttpOnly; Secure', host_only: true, read_by_javascript: true } }, [
        'a',
      ]).prepare('c');
    }).toThrow(/HttpOnly/);
    expect(() => {
      build({ a: { attributes: 'Secure', host_only: true, read_by_javascript: true } }, [
        'a',
      ]).prepare('c');
    }).not.toThrow();
  });
});

/**
 * Cookie lifetimes (Product Owner decision of 6 October 2026, I15). The session and CSRF cookies are browser-session
 * cookies: issued with no `Max-Age` and no `Expires`, so they end with the browser, and the server's own idle and
 * absolute timeouts decide validity. `x-cookies` says so with `browser_session: true`. The vendor device credential
 * is the opposite: it carries `Max-Age=34560000` (400 days) among its attributes, which the existing attribute check
 * already holds it to.
 */
describe('the lifetime of the cookies a response sets', () => {
  const SESSION = 'melarc_session=S; Path=/; HttpOnly; Secure; SameSite=Lax';
  const CSRF = 'melarc_csrf=C; Path=/; Secure; SameSite=Lax';
  const DEVICE = 'melarc_vendor_device=D; Max-Age=34560000; Path=/; HttpOnly; Secure; SameSite=Lax';
  const xCookies = (): JsonObject => ({
    melarc_session: {
      attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/',
      browser_session: true,
      host_only: true,
      read_by_javascript: false,
    },
    melarc_csrf: {
      attributes: 'Secure; SameSite=Lax; Path=/',
      browser_session: true,
      host_only: true,
      read_by_javascript: true,
    },
    melarc_vendor_device: {
      attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000',
      host_only: true,
      read_by_javascript: false,
    },
  });
  const build = (cookies: JsonObject, set: string[]) =>
    new ContractValidator({
      openapi: '3.1.0',
      'x-cookies': cookies,
      paths: {
        '/c': {
          get: {
            operationId: 'c',
            responses: {
              '200': {
                description: 'OK',
                'x-set-cookies': set,
                headers: { 'Set-Cookie': { schema: { type: 'string' } } },
              },
            },
          },
        },
      },
    });
  const validator = build(xCookies(), ['melarc_session', 'melarc_csrf', 'melarc_vendor_device']);
  const cookiesOf = (session: string, csrf = CSRF, device = DEVICE) =>
    validator
      .validateResponse(
        'c',
        response({ status: 200, headers: { 'set-cookie': [session, csrf, device] } }),
      )
      .filter((violation) => violation.in === 'response-cookie');

  // Break caught: a session cookie issued with a lifetime. A persistent session cookie outlives the browser session
  // on the user's disk, which is the weakness the browser-session rule exists to remove.
  it('accepts the session and CSRF cookies issued with neither Max-Age nor Expires', () => {
    expect(cookiesOf(SESSION)).toEqual([]);
  });

  it.each([
    ['Max-Age=3600', 'max-age'],
    ['Max-Age=1', 'max-age'],
    ['Max-Age=34560000', 'max-age'],
    ['Max-Age=abc', 'max-age'],
    ['Max-Age=', 'max-age'],
    ['Max-Age=3600.5', 'max-age'],
    ['Max-Age=+60', 'max-age'],
    ['Expires=Fri, 31 Dec 2999 23:59:59 GMT', 'expires'],
    ['Expires=not a date', 'expires'],
    ['Expires=', 'expires'],
  ])('reports a session cookie issued with %s', (attribute, rule) => {
    expect(
      cookiesOf(`melarc_session=S; ${attribute}; Path=/; HttpOnly; Secure; SameSite=Lax`),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_session', rule }]);
    expect(cookiesOf(SESSION, `melarc_csrf=C; ${attribute}; Path=/; Secure; SameSite=Lax`)).toEqual(
      [{ in: 'response-cookie', pointer: 'melarc_csrf', rule }],
    );
  });

  it('reports both when a session cookie carries both, each once, in order', () => {
    expect(
      cookiesOf(
        'melarc_session=S; Max-Age=60; Expires=Fri, 31 Dec 2999 23:59:59 GMT; Path=/; HttpOnly; Secure; SameSite=Lax',
      ),
    ).toEqual([
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'expires' },
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'max-age' },
    ]);
  });

  // Break caught: the rule refusing the expiry that sign-out sets. A browser removes a cookie only when it is set
  // again already expired, so an expiry is the one lifetime a session cookie may carry: `Max-Age=0` as the contract
  // writes it, a negative one, or an `Expires` in the past, which is what Express writes when it clears one.
  it.each([
    'Max-Age=0',
    'Max-Age=00',
    'Max-Age=-1',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0',
    'max-age=0',
    'EXPIRES=Thu, 01 Jan 1970 00:00:00 GMT',
  ])('accepts a session cookie that is being expired with %s', (attribute) => {
    expect(
      cookiesOf(`melarc_session=; ${attribute}; Path=/; HttpOnly; Secure; SameSite=Lax`),
    ).toEqual([]);
    expect(cookiesOf(SESSION, `melarc_csrf=; ${attribute}; Path=/; Secure; SameSite=Lax`)).toEqual(
      [],
    );
  });

  // Break caught: an expiry that carries a lifetime beside it being let through because part of it is an expiry. A
  // browser that reads the later of the two would keep the cookie.
  it('reports a session cookie whose Expires is in the past but whose Max-Age is not zero', () => {
    expect(
      cookiesOf(
        'melarc_session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax',
      ),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_session', rule: 'max-age' }]);
  });

  // Break caught: the lifetime rule taking the place of the others, or leaving them off a cookie that has one.
  it('still holds a session cookie with a lifetime rule broken to its other attributes', () => {
    expect(
      cookiesOf('melarc_session=S; Max-Age=60; Path=/api; HttpOnly; Secure; SameSite=Lax'),
    ).toEqual([
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'max-age' },
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'path' },
    ]);
  });

  // Break caught: the device credential issued as a session cookie, so the registered browser forgets itself at
  // the end of every browser session, or with the wrong lifetime. Its lifetime is an attribute like the others.
  it('holds the vendor device credential to its Max-Age', () => {
    expect(cookiesOf(SESSION, CSRF, DEVICE)).toEqual([]);
    expect(
      cookiesOf(SESSION, CSRF, 'melarc_vendor_device=D; Path=/; HttpOnly; Secure; SameSite=Lax'),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'max-age' }]);
    expect(
      cookiesOf(
        SESSION,
        CSRF,
        'melarc_vendor_device=D; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax',
      ),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'max-age' }]);
  });

  // Break caught: the browser-session rule spreading to a cookie the contract did not mark. Only a cookie that says
  // `browser_session: true` is held to it.
  it('applies the rule only to a cookie the contract marks as a browser-session cookie', () => {
    const unmarked = build(
      {
        melarc_session: {
          attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/',
          host_only: true,
          read_by_javascript: false,
        },
      },
      ['melarc_session'],
    );

    expect(
      unmarked.validateResponse(
        'c',
        response({
          status: 200,
          headers: {
            'set-cookie': ['melarc_session=S; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax'],
          },
        }),
      ),
    ).toEqual([]);
  });

  // Break caught: a contract that contradicts itself being read as one or the other. A cookie cannot be a
  // browser-session cookie and have a lifetime, so the application refuses to start.
  it.each(['Max-Age=3600', 'Expires=Fri, 31 Dec 2999 23:59:59 GMT'])(
    'refuses a contract that gives a browser-session cookie %s',
    (attribute) => {
      expect(() => {
        build(
          {
            a: {
              attributes: `Secure; ${attribute}`,
              browser_session: true,
              host_only: true,
              read_by_javascript: true,
            },
          },
          ['a'],
        ).prepare('c');
      }).toThrow(/browser-session/);
    },
  );

  it('refuses a browser_session that is not true or false', () => {
    expect(() => {
      build(
        {
          a: {
            attributes: 'Secure',
            browser_session: 'yes',
            host_only: true,
            read_by_javascript: true,
          },
        },
        ['a'],
      ).prepare('c');
    }).toThrow(/browser_session/);
  });
});

describe('a cookie a request must carry', () => {
  const validator = new ContractValidator({
    openapi: '3.1.0',
    paths: {
      '/pref': {
        get: {
          operationId: 'pref',
          parameters: [
            {
              name: 'melarc_theme',
              in: 'cookie',
              required: true,
              schema: { type: 'string', enum: ['light', 'dark'] },
            },
            { name: 'melarc_density', in: 'cookie', schema: { type: 'integer', minimum: 1 } },
          ],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });
  const sent = (cookie?: string | string[]) =>
    validator.validateRequest('pref', request({ headers: cookie === undefined ? {} : { cookie } }));

  // Break caught: a declared cookie parameter skipped, so a missing or malformed one passes. This is a check of
  // the cookie as declared; whether the cookie is a valid session is the guard's to decide.
  it('is reported by name and rule when it is missing or wrong', () => {
    expect(sent('melarc_theme=dark')).toEqual([]);
    expect(sent()).toEqual([{ in: 'cookie', pointer: 'melarc_theme', rule: 'required' }]);
    expect(sent('other=1')).toEqual([{ in: 'cookie', pointer: 'melarc_theme', rule: 'required' }]);
    expect(sent('melarc_theme=purple')).toEqual([
      { in: 'cookie', pointer: 'melarc_theme', rule: 'enum' },
    ]);
    expect(sent('melarc_theme=dark; melarc_density=0')).toEqual([
      { in: 'cookie', pointer: 'melarc_density', rule: 'minimum' },
    ]);
  });

  it('is found among other cookies, with names read exactly and the first of a repeat used', () => {
    expect(sent('a=1; melarc_theme=light; b=2')).toEqual([]);
    expect(sent('MELARC_THEME=light')).toEqual([
      { in: 'cookie', pointer: 'melarc_theme', rule: 'required' },
    ]);
    expect(sent('melarc_theme=dark; melarc_theme=purple')).toEqual([]);
    expect(sent(['melarc_theme=dark'])).toEqual([]);
    expect(sent('melarc_theme="dark"')).toEqual([]);
  });

  it('does not repeat its value, or the name of a cookie it does not declare', () => {
    const violations = sent('melarc_theme=VALUE-CANARY; CANARY_NAME=1');

    expect(JSON.stringify(violations)).not.toContain('CANARY');
  });
});

describe('the real contract, enforced at run time', () => {
  const SESSION = 'melarc_session=S; Path=/; HttpOnly; Secure; SameSite=Lax';
  const CSRF = 'melarc_csrf=C; Path=/; Secure; SameSite=Lax';
  const cookieViolations = (status: number, setCookie: string[]) =>
    real
      .validateResponse(
        'staffSignIn',
        response({ status, body: {}, headers: { 'set-cookie': setCookie } }),
      )
      .filter((violation) => violation.in === 'response-cookie');

  // Break caught: the real sign-in, whose 200 establishes a session and whose 202 (a second factor is needed)
  // must not. Both are in the contract; only judging by the status sent tells them apart.
  it('lets staff sign-in set its two cookies on 200 and none on 202', () => {
    expect(cookieViolations(200, [SESSION, CSRF])).toEqual([]);
    expect(cookieViolations(200, [SESSION])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_csrf', rule: 'required' },
    ]);
    expect(cookieViolations(202, [SESSION, CSRF])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_csrf', rule: 'undeclared' },
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'undeclared' },
    ]);
    expect(cookieViolations(202, [])).toEqual([]);
  });

  // Break caught: the header that makes a write safe against a concurrent change being optional in practice.
  it('requires If-Match and a UUID path identifier on confirmPickupRequest', () => {
    expect(
      real.validateRequest(
        'confirmPickupRequest',
        request({ params: { id: UUID }, headers: { 'if-match': '"3"' } }),
      ),
    ).toEqual([]);

    expect(
      real
        .validateRequest('confirmPickupRequest', request({ params: { id: 'nope' } }))
        .toSorted((a, b) => a.in.localeCompare(b.in)),
    ).toEqual([
      { in: 'header', pointer: 'if-match', rule: 'required' },
      { in: 'path', pointer: 'id', rule: 'format' },
    ]);
  });

  // Break caught: "clients never set prices" being a convention instead of a rule. OrderItemize is closed,
  // so a request that carries a price is refused whatever the handler does.
  it('refuses a price on itemizeOrder, because OrderItemize is closed', () => {
    const body = {
      recipient: {
        name: 'Ama',
        phone: '0240000000',
        location: { address: 'Accra' },
      },
      size_class: 'SMALL',
    };
    const parts = { params: { id: UUID }, headers: { 'idempotency-key': 'k', 'if-match': '"1"' } };

    expect(
      real.validateRequest('itemizeOrder', request({ ...parts, body, hasBody: true })),
    ).toEqual([]);
    expect(
      real.validateRequest(
        'itemizeOrder',
        request({ ...parts, body: { ...body, price_minor: 100 }, hasBody: true }),
      ),
    ).toEqual([{ in: 'body', pointer: '', rule: 'additionalProperties' }]);
  });

  // Break caught: the conditional rules a description cannot carry. PickupRequestCreate decides what is
  // required from `pickup_intent` with if/then pairs; only a validator built from the contract's own schema
  // can enforce them.
  it('enforces the rule that OWN_PACKAGES needs a vendor organization', () => {
    const body = {
      pickup_intent: 'OWN_PACKAGES',
      scheduled_service_date: '2026-10-06',
      declared_package_count: 2,
      default_payer_intent: 'RECIPIENT_PAYS',
    };
    const parts = { headers: { 'idempotency-key': 'k' }, hasBody: true };

    const missing = real.validateRequest('createPickupRequest', request({ ...parts, body }));
    const present = real.validateRequest(
      'createPickupRequest',
      request({ ...parts, body: { ...body, vendor_organization_id: UUID } }),
    );

    // Exactly the one violation: the failed `if` that led to it is a summary of it, not a second problem.
    expect(missing).toEqual([{ in: 'body', pointer: '/vendor_organization_id', rule: 'required' }]);
    expect(present).toEqual([]);
  });

  it('enforces an enum and a minimum on a real request body', () => {
    const parts = { headers: { 'idempotency-key': 'k' }, hasBody: true };
    const violations = real.validateRequest(
      'createPickupRequest',
      request({
        ...parts,
        body: {
          pickup_intent: 'WHATEVER',
          scheduled_service_date: 'tomorrow',
          declared_package_count: 0,
          default_payer_intent: 'RECIPIENT_PAYS',
        },
      }),
    );

    const rules = violations.map((violation) => `${violation.pointer}:${violation.rule}`);
    expect(rules).toContain('/pickup_intent:enum');
    expect(rules).toContain('/scheduled_service_date:format');
    expect(rules).toContain('/declared_package_count:minimum');
  });
});

describe('text on the wire that the validator reads as another type', () => {
  // Break caught: a value that is valid only because it was read as a number, while the handler, which is given
  // the text as it was sent, reads it another way. Ajv's coercion accepts `0x10` (16), ` 5`, `1e1` (10), `+5`,
  // `05` and `5.0` as the integer they stand for, so `parseInt(text, 10)` and `Number(text)` gave a handler two
  // different page sizes for the same request. The text must be what the number would be written as.
  it.each(['0x10', '1e1', ' 5', '5 ', '+5', '05', '5.0', '5.', '0b11'])(
    'refuses %j as an integer, although it can be read as one',
    (text) => {
      expect(
        real.validateRequest('listPickupManifests', request({ query: { page_size: text } })),
      ).toEqual([{ in: 'query', pointer: 'page_size', rule: 'type' }]);
    },
  );

  it.each(['1', '25', '100'])('accepts %j as an integer', (text) => {
    expect(
      real.validateRequest('listPickupManifests', request({ query: { page_size: text } })),
    ).toEqual([]);
  });

  // Break caught: the canonical-text rule making a range error disappear, or reporting it twice.
  it('still reports a number out of range, once', () => {
    expect(
      real.validateRequest('listPickupManifests', request({ query: { page_size: '101' } })),
    ).toEqual([{ in: 'query', pointer: 'page_size', rule: 'maximum' }]);
  });

  // Break caught: the rule above reading only numbers: a boolean is read from text too, and only the two words
  // the contract's type is written with stand for one.
  it('refuses text that is read as a boolean it does not write', () => {
    expect(
      fixture.validateRequest('createWidget', createRequest({ query: { dry_run: 'True' } })),
    ).toEqual([{ in: 'query', pointer: 'dry_run', rule: 'type' }]);
  });
});

describe('an identifier written as a URN', () => {
  // Break caught: ajv-formats' `uuid`, whose pattern allows a `urn:uuid:` prefix. The text validated as an
  // identifier, PostgreSQL then refused it (22P02) and the caller got a server error and an alert, and the same
  // identifier could be written as two different strings.
  it.each([
    `urn:uuid:${UUID}`,
    `URN:UUID:${UUID}`,
    `{${UUID}}`,
    UUID.replaceAll('-', ''),
    ` ${UUID}`,
  ])('refuses %j as a uuid', (id) => {
    expect(fixture.validateRequest('getWidget', request({ params: { id } }))).toEqual([
      { in: 'path', pointer: 'id', rule: 'format' },
    ]);
  });

  it.each([UUID, UUID.toUpperCase()])('accepts %j as a uuid', (id) => {
    expect(fixture.validateRequest('getWidget', request({ params: { id } }))).toEqual([]);
  });
});

describe('numbers read from text', () => {
  const numbers = new ContractValidator({
    openapi: '3.1.0',
    info: { title: 'Numbers', version: '1' },
    servers: [{ url: '/api/v1' }],
    security: [],
    paths: {
      '/numbers': {
        get: {
          operationId: 'listNumbers',
          security: [],
          'x-permission': 'number.read',
          parameters: [
            { name: 'amount', in: 'query', required: false, schema: { type: 'number' } },
            {
              name: 'counts',
              in: 'query',
              required: false,
              schema: { type: 'array', items: { type: 'integer' } },
            },
          ],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  } satisfies JsonObject);

  // Break caught: a number that is not finite standing for the text. `Infinity` is what the text writes, so the
  // canonical-text rule alone does not refuse it, and a handler that adds it to a total, or compares it, is wrong.
  it.each(['Infinity', '-Infinity'])('refuses %j as a number', (text) => {
    expect(numbers.validateRequest('listNumbers', request({ query: { amount: text } }))).toEqual([
      { in: 'query', pointer: 'amount', rule: 'type' },
    ]);
  });

  // Break caught: the canonical-text rule looking only at single values. A single value for an array parameter is
  // wrapped into a one-item array in the copy that is validated, and its item was read as a number too.
  it.each([
    ['a single value that reads as another integer', '0x10'],
    ['a single value with a space', ' 5'],
  ])('refuses %s for an array of integers', (_label, text) => {
    expect(numbers.validateRequest('listNumbers', request({ query: { counts: text } }))).toEqual([
      { in: 'query', pointer: 'counts', rule: 'type' },
    ]);
  });

  it('refuses a list of integers when one of them reads as another', () => {
    expect(
      numbers.validateRequest('listNumbers', request({ query: { counts: ['5', '0x10'] } })),
    ).toEqual([{ in: 'query', pointer: 'counts', rule: 'type' }]);
  });

  it.each([['5'], [['5', '6']]])('accepts %j for an array of integers', (counts) => {
    expect(numbers.validateRequest('listNumbers', request({ query: { counts } }))).toEqual([]);
  });

  it.each(['1.5', '0', '-2', '1000000'])('accepts %j as a number', (text) => {
    expect(numbers.validateRequest('listNumbers', request({ query: { amount: text } }))).toEqual(
      [],
    );
  });
});
