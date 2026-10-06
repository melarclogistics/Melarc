import { describe, expect, it } from 'vitest';

import { checkConformance, routeShape, type ConformanceInput } from './check-conformance.js';
import type { Finding, FindingCode } from './findings.js';
import type { JsonObject } from '../../platform/contract/json.js';
import { JsonEditor } from '../../test-support/json-edit.js';

/**
 * The check on plain data: a contract, the code's description of itself, the routes its router answers,
 * and the operations it says it implements. The application-level tests start a real application and feed
 * the same function from it.
 */
function contractDocument(): JsonObject {
  return {
    openapi: '3.1.0',
    info: { title: 'Fixture', version: '1' },
    servers: [{ url: '/api/v1' }],
    security: [],
    paths: {
      '/things/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          operationId: 'getThing',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
            },
          },
        },
      },
      '/things': {
        post: {
          operationId: 'createThing',
          responses: { '201': { description: 'Created' } },
        },
      },
      '/others': {
        get: { operationId: 'listOthers', responses: { '200': { description: 'OK' } } },
      },
    },
    components: {
      schemas: {
        Thing: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' }, size: { type: 'integer' } },
        },
      },
    },
  };
}

/** A description that conforms: the contract's own operations for the ones in scope, under other names. */
function describedBy(contract: JsonObject, ids: readonly string[]): JsonObject {
  const copy = new JsonEditor(contract);
  const paths = copy.get(['paths']) as Record<
    string,
    Record<string, { operationId?: string } | undefined>
  >;
  for (const [path, item] of Object.entries(paths)) {
    for (const method of ['get', 'post']) {
      const operation = item[method];
      if (operation !== undefined && !ids.includes(operation.operationId ?? '')) {
        copy.remove(['paths', path, method]);
      }
    }
    if (item.get === undefined && item.post === undefined) copy.remove(['paths', path]);
  }
  return copy.document;
}

const TECHNICAL = [
  { method: 'GET', path: '/livez' },
  { method: 'GET', path: '/readyz' },
];

function conforming(overrides: Partial<ConformanceInput> = {}): ConformanceInput {
  const contract = contractDocument();
  return {
    contract,
    generated: describedBy(contract, ['getThing', 'createThing']),
    live: [
      { method: 'GET', path: '/api/v1/things/:id' },
      { method: 'POST', path: '/api/v1/things' },
      ...TECHNICAL,
    ],
    scope: ['getThing', 'createThing'],
    technicalRoutes: TECHNICAL,
    bound: [
      { operationId: 'getThing', method: 'GET', path: '/api/v1/things/:id' },
      { operationId: 'createThing', method: 'POST', path: '/api/v1/things' },
    ],
    ...overrides,
  };
}

const codes = (findings: readonly Finding[]) => findings.map((finding) => finding.code);
const only = (findings: readonly Finding[], code: FindingCode) =>
  findings.filter((finding) => finding.code === code);

describe('routeShape', () => {
  // Break caught: a route written the router's way and the contract's way not meeting. Parameter names are
  // compared elsewhere; here only the shape decides whether two routes are the same one.
  it.each([
    ['/api/v1/things/:id', '/api/v1/things/:'],
    ['/api/v1/things/{thingId}', '/api/v1/things/:'],
    ['/api/v1//things/:id/', '/api/v1/things/:'],
    ['/api/v1/a/:x/b/:y', '/api/v1/a/:/b/:'],
    ['/livez', '/livez'],
  ])('reads %s as %s', (path, shape) => {
    expect(routeShape(path)).toBe(shape);
  });
});

describe('an implementation that conforms', () => {
  it('has no findings', () => {
    expect(checkConformance(conforming()).findings).toEqual([]);
  });

  // Break caught: the empty scope, which is today's real state, reporting something or failing to run.
  it('has none when nothing is implemented and only the probes are live', () => {
    const contract = contractDocument();
    const report = checkConformance({
      contract,
      generated: describedBy(contract, []),
      live: TECHNICAL,
      scope: [],
      technicalRoutes: TECHNICAL,
      bound: [],
    });

    expect(report.findings).toEqual([]);
    expect(report.checkedOperations).toEqual([]);
  });

  it('says which operations it compared', () => {
    expect(checkConformance(conforming()).checkedOperations).toEqual(['createThing', 'getThing']);
  });

  // Break caught: parameter names deciding whether a route matches. The router writes `:id` and the
  // contract `{id}`; the names themselves are a finding, not a reason to lose the route.
  it('matches a route to its operation whatever the parameter is called', () => {
    const report = checkConformance(
      conforming({
        live: [
          { method: 'GET', path: '/api/v1/things/:thingId' },
          { method: 'POST', path: '/api/v1/things' },
          ...TECHNICAL,
        ],
      }),
    );

    expect(codes(report.findings)).toEqual([]);
  });
});

describe('technical routes', () => {
  // Break caught: a probe exempted by path alone. A technical route is a method and a path, so the same path
  // answered with another method is a different route and is not exempt.
  it('are exempt only for the method they are declared with', () => {
    const technicalRoutes = [...TECHNICAL, { method: 'POST', path: '/hooks/ping' }];
    const exempt = checkConformance(
      conforming({
        technicalRoutes,
        live: [...conforming().live, { method: 'POST', path: '/hooks/ping' }],
      }),
    );
    const notExempt = checkConformance(
      conforming({
        technicalRoutes,
        live: [...conforming().live, { method: 'GET', path: '/hooks/ping' }],
      }),
    );

    expect(exempt.findings).toEqual([]);
    expect(codes(notExempt.findings)).toEqual(['UNDOCUMENTED_ROUTE']);
  });
});

describe('deliberate drift: routes', () => {
  // Break caught: a route that exists and that the contract does not describe. The most important thing
  // the check does: no business route may exist outside the contract.
  it.each([
    ['a route under the API prefix', { method: 'GET', path: '/api/v1/secret/:id' }],
    ['a route outside the API prefix', { method: 'POST', path: '/admin/reset' }],
    ['a probe answered with another method', { method: 'POST', path: '/livez' }],
    ['a router mounted by hand', { method: 'ALL', path: '(mounted router) /hidden' }],
  ])('reports %s as undocumented', (_label, route) => {
    const report = checkConformance(conforming({ live: [...conforming().live, route] }));

    expect(codes(report.findings)).toEqual(['UNDOCUMENTED_ROUTE']);
    expect(report.findings[0]?.at).toBe(`${route.method} ${route.path}`);
  });

  // Break caught: an operation that is in the contract, is live, and is not declared as implemented. The
  // scope has to be what is true, or "not yet implemented" stops meaning anything.
  it('reports a live route that the scope does not list', () => {
    const report = checkConformance(
      conforming({
        live: [...conforming().live, { method: 'GET', path: '/api/v1/others' }],
      }),
    );

    expect(codes(report.findings)).toEqual(['ROUTE_OUTSIDE_SCOPE']);
    expect(report.findings[0]?.message).toContain('listOthers');
  });

  // Break caught: the scope claiming an operation that nothing serves.
  it('reports an operation in the scope that has no live route', () => {
    const report = checkConformance(
      conforming({ live: [{ method: 'POST', path: '/api/v1/things' }, ...TECHNICAL] }),
    );

    expect(only(report.findings, 'OPERATION_NOT_LIVE').map((f) => f.at)).toEqual([
      'GET /things/{id}',
    ]);
    expect(report.findings[0]?.message).toContain('getThing');
  });

  // Break caught: a scope naming an operation the contract does not have, such as a misspelt id, which
  // would otherwise be "implemented" by nothing and checked against nothing.
  it('reports an operation in the scope that the contract does not know', () => {
    const report = checkConformance(
      conforming({ scope: ['getThing', 'createThing', 'getThingg'] }),
    );

    expect(codes(report.findings)).toEqual(['SCOPE_OPERATION_UNKNOWN']);
    expect(report.findings[0]?.at).toBe('scope > getThingg');
  });

  // Break caught: a route hidden from the generated description with an exclusion decorator. It is live
  // and it is in scope, but the description does not say so.
  it('reports an implemented operation that the description leaves out', () => {
    const contract = contractDocument();
    const report = checkConformance(
      conforming({ generated: describedBy(contract, ['createThing']) }),
    );

    expect(codes(report.findings)).toEqual(['OPERATION_NOT_DESCRIBED']);
    expect(report.findings[0]?.message).toContain('getThing');
  });

  // Break caught: the description claiming a route the router does not serve, which would make the
  // description a promise and not a fact.
  it('reports a route the description documents and the router does not serve', () => {
    const contract = contractDocument();
    const report = checkConformance(
      conforming({
        generated: describedBy(contract, ['getThing', 'createThing', 'listOthers']),
      }),
    );

    expect(codes(report.findings)).toEqual(['DESCRIBED_BUT_NOT_LIVE']);
    expect(report.findings[0]?.at).toBe('GET /api/v1/others');
  });
});

describe('deliberate drift: validation left off', () => {
  // Break caught: an operation that is implemented and conforms in every way the description can show, while
  // nothing validates what it receives. The conditional rules and closed bodies of the contract are enforced
  // only by the runtime validator, which a handler gets by being bound to its operation.
  it('reports an implemented operation whose handler is not bound to it', () => {
    const report = checkConformance(
      conforming({
        bound: [{ operationId: 'createThing', method: 'POST', path: '/api/v1/things' }],
      }),
    );

    expect(codes(report.findings)).toEqual(['OPERATION_NOT_VALIDATED']);
    expect(report.findings[0]?.at).toBe('GET /things/{id}');
    expect(report.findings[0]?.message).toContain('getThing');
  });

  // Break caught: a handler bound to the id of a different operation than the route it serves.
  it('reports a handler bound to another operation than the one its route implements', () => {
    const report = checkConformance(
      conforming({
        bound: [
          { operationId: 'createThing', method: 'GET', path: '/api/v1/things/:id' },
          { operationId: 'createThing', method: 'POST', path: '/api/v1/things' },
        ],
      }),
    );

    expect(codes(report.findings)).toEqual(['OPERATION_NOT_VALIDATED']);
  });

  it('does not also report an operation that is not live', () => {
    const report = checkConformance(
      conforming({
        live: [{ method: 'POST', path: '/api/v1/things' }, ...TECHNICAL],
        bound: [{ operationId: 'createThing', method: 'POST', path: '/api/v1/things' }],
      }),
    );

    expect(codes(report.findings)).toEqual(['OPERATION_NOT_LIVE']);
  });
});

describe('deliberate drift reaches the report from inside an operation', () => {
  // Break caught: the route-level check passing and the semantic comparison never being run on the
  // operations in scope.
  it('compares every operation in scope and reports what differs', () => {
    const contract = contractDocument();
    const generated = new JsonEditor(describedBy(contract, ['getThing', 'createThing']));
    generated.set(['components', 'schemas', 'Thing', 'required'], []);

    const report = checkConformance(conforming({ generated: generated.document }));

    expect(codes(report.findings)).toEqual(['SCHEMA_REQUIRED']);
    expect(report.findings[0]?.at).toBe('GET /things/{id} > response 200 > application/json');
  });

  // Break caught: the description of one operation drifting while an unrelated one is fine, and the
  // finding being lost or attributed to the wrong operation.
  it('keeps findings with the operation they belong to', () => {
    const contract = contractDocument();
    const generated = new JsonEditor(describedBy(contract, ['getThing', 'createThing']));
    generated.remove(['paths', '/things', 'post', 'responses', '201']);

    const report = checkConformance(conforming({ generated: generated.document }));

    expect(codes(report.findings)).toEqual(['RESPONSE_DRIFT']);
    expect(report.findings[0]?.at).toBe('POST /things > response 201');
  });
});

describe('a description that cannot be read', () => {
  // Break caught: a malformed description producing "no findings" because nothing could be compared.
  it('fails loudly instead of reporting nothing', () => {
    const input = conforming({ generated: { openapi: '3.1.0', paths: 'nonsense' } });

    expect(() => checkConformance(input)).toThrow(/paths/);
  });
});
