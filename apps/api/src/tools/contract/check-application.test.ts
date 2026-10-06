import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { ModulesContainer } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';

import { locateContract } from '../../platform/contract/locate-contract.js';
import { listBoundOperations } from '../../platform/contract/contract-operation.js';
import { buildOpenApiDocument } from '../../platform/openapi/build-openapi-document.js';
import { listLiveRoutes } from '../../platform/routes/route-inventory.js';
import {
  AnonymousWidgetsModule,
  ConformingGadgetsModule,
  ConformingWidgetsModule,
  EnumDriftWidgetsModule,
  ErrorBodyDriftWidgetsModule,
  ExplodeDriftGadgetsModule,
  ExtensionDriftWidgetsModule,
  FIXTURE_CONTRACT,
  FIXTURE_SECURITY_SCHEMES,
  GADGET_CONTRACT,
  HeaderDriftWidgetsModule,
  HiddenWidgetsModule,
  LooseMarkerGadgetsModule,
  MissingErrorWidgetsModule,
  NullableDriftWidgetsModule,
  OpenBodyWidgetsModule,
  ReadOnlyWidgetsModule,
  RepeatedBranchGadgetsModule,
  RequiredDriftWidgetsModule,
  SecurityDriftWidgetsModule,
  UnboundWidgetsModule,
  UndocumentedRouteWidgetsModule,
} from '../../test-support/contract-fixtures.js';
import { appWith, startTestApp, type TestApp } from '../../test-support/test-app.js';
import { checkApplication, TECHNICAL_ROUTES } from './check-application.js';
import { checkConformance } from './check-conformance.js';
import type { Finding, FindingCode } from './findings.js';
import type { JsonObject } from '../../platform/contract/json.js';
import { JsonEditor } from '../../test-support/json-edit.js';
import { IMPLEMENTED_OPERATIONS } from './implemented-scope.js';

const REAL_CONTRACT = parse(
  readFileSync(locateContract(import.meta.dirname), 'utf8'),
) as JsonObject;

let running: TestApp | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/**
 * The application is started with the fixture contract as the source its runtime validates against: its
 * handlers are bound to the fixture's operations, which the real contract does not have, and the application
 * refuses to start when a bound operation is missing from the contract it validates with.
 */
const FIXTURE_SOURCE = { load: () => FIXTURE_CONTRACT as unknown as JsonObject };

async function start(...extra: Parameters<typeof appWith>): Promise<TestApp> {
  running = await startTestApp(
    extra.length === 0 ? {} : { rootModule: appWith(...extra), contractSource: FIXTURE_SOURCE },
  );
  return running;
}

/**
 * The fixture application against the fixture contract. The application's own description carries no
 * security scheme definitions yet (the identity slice registers them), so the ones the contract defines
 * are added here: what is under test is each operation's use of them, not their registration.
 */
async function checkFixture(
  module: Parameters<typeof appWith>[0],
  scope = ['getWidget', 'createWidget'],
) {
  const { app } = await start(module);
  await app.init();
  const generated = new JsonEditor(
    JSON.parse(JSON.stringify(buildOpenApiDocument(app))) as JsonObject,
  );
  generated.set(['components', 'securitySchemes'], FIXTURE_SECURITY_SCHEMES);
  return checkConformance({
    contract: FIXTURE_CONTRACT,
    generated: generated.document,
    live: listLiveRoutes(app),
    scope,
    technicalRoutes: TECHNICAL_ROUTES,
    bound: listBoundOperations(app.get(ModulesContainer, { strict: false })),
  });
}

const codes = (findings: readonly Finding[]) => findings.map((finding) => finding.code);

describe('the real application against the real contract', () => {
  // Break caught: the shipped application disagreeing with the canonical contract in the scope it claims.
  // Today that scope is empty and the only live routes are the probes; this is the check that fails the
  // build when a route, a response or a header drifts from contracts/openapi.yaml.
  it('conforms in the scope it declares', async () => {
    const { app } = await start();

    const report = await checkApplication(app, {
      contract: REAL_CONTRACT,
      scope: IMPLEMENTED_OPERATIONS,
    });

    expect(report.findings).toEqual([]);
    expect(report.checkedOperations).toEqual([...IMPLEMENTED_OPERATIONS].toSorted());
  });

  // Break caught: "implemented" claimed for work that does not exist, with the real contract. A declared
  // operation with no live route and no description must fail, and say which operation it was.
  it('fails when the scope claims an operation that has no route', async () => {
    const { app } = await start();

    const report = await checkApplication(app, {
      contract: REAL_CONTRACT,
      scope: [...IMPLEMENTED_OPERATIONS, 'getPickupRequest'],
    });

    expect(codes(report.findings).toSorted()).toEqual([
      'OPERATION_NOT_DESCRIBED',
      'OPERATION_NOT_LIVE',
    ]);
    expect(report.findings.every((finding) => finding.at === 'GET /pickup-requests/{id}')).toBe(
      true,
    );
  });

  // Break caught: a business route added without the contract having an operation for it. The real
  // contract has none at the fixture's paths, so every route the fixture serves is undocumented.
  it('fails on a route that the real contract does not have', async () => {
    const { app } = await start(ConformingWidgetsModule);

    const report = await checkApplication(app, { contract: REAL_CONTRACT, scope: [] });

    expect(report.findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['UNDOCUMENTED_ROUTE', 'GET /api/v1/widgets/:id'],
      ['UNDOCUMENTED_ROUTE', 'POST /api/v1/widgets'],
    ]);
  });

  it('knows the probes and nothing else as technical routes', () => {
    expect(TECHNICAL_ROUTES).toEqual([
      { method: 'GET', path: '/livez' },
      { method: 'GET', path: '/readyz' },
    ]);
  });
});

describe('a fixture application that conforms to the fixture contract', () => {
  // Break caught: a check that cannot succeed, which would be unusable. A real decorated controller, its
  // DTOs and its raw schemas produce a description that says what the hand-written contract says.
  it('has no findings, and compares both of its operations', async () => {
    const report = await checkFixture(ConformingWidgetsModule);

    expect(report.findings).toEqual([]);
    expect(report.checkedOperations).toEqual(['createWidget', 'getWidget']);
  });
});

/**
 * One defect each. Every row is a controller identical to the conforming one except for the single thing
 * named, and the check must say exactly what that thing is: the demonstration that contract enforcement is
 * proved, not assumed.
 */
const DRIFTS: readonly [
  label: string,
  module: Parameters<typeof appWith>[0],
  expected: readonly FindingCode[],
  at: RegExp,
][] = [
  [
    'a required field dropped from a request body',
    RequiredDriftWidgetsModule,
    ['SCHEMA_REQUIRED'],
    /^POST \/widgets > request body > application\/json$/,
  ],
  [
    'an enum value the contract does not have',
    EnumDriftWidgetsModule,
    ['SCHEMA_ENUM'],
    /^GET \/widgets\/\{id\} > response 200 > application\/json\.properties\.state$/,
  ],
  [
    'a property that can no longer be null',
    NullableDriftWidgetsModule,
    ['SCHEMA_NULLABLE'],
    /^GET \/widgets\/\{id\} > response 200 > application\/json\.properties\.note$/,
  ],
  [
    'a closed request body described as open',
    OpenBodyWidgetsModule,
    ['SCHEMA_ADDITIONAL_PROPERTIES'],
    /^POST \/widgets > request body > application\/json$/,
  ],
  [
    'an error answer the contract documents, left out',
    MissingErrorWidgetsModule,
    ['ERROR_RESPONSE_DRIFT'],
    /^GET \/widgets\/\{id\} > response 404$/,
  ],
  [
    'an error body that lost a required property',
    ErrorBodyDriftWidgetsModule,
    ['SCHEMA_REQUIRED', 'SCHEMA_PROPERTY_MISSING'],
    /^GET \/widgets\/\{id\} > response 404 > application\/json(\.properties\.request_id)?$/,
  ],
  [
    'a state-changing operation signed in with the wrong credential',
    SecurityDriftWidgetsModule,
    ['SECURITY_DRIFT'],
    /^POST \/widgets > security$/,
  ],
  [
    'a state-changing operation open to anyone',
    AnonymousWidgetsModule,
    ['SECURITY_DRIFT'],
    /^POST \/widgets > security$/,
  ],
  [
    'a required request header no longer declared',
    HeaderDriftWidgetsModule,
    ['HEADER_DRIFT', 'HEADER_DRIFT'],
    /^(POST \/widgets > parameter header:idempotency-key|GET \/widgets\/\{id\} > response 200)$/,
  ],
  [
    'a permission that differs from the contract',
    ExtensionDriftWidgetsModule,
    ['EXTENSION_DRIFT'],
    /^GET \/widgets\/\{id\} > x-permission$/,
  ],
  [
    'an implemented route hidden from the application description',
    HiddenWidgetsModule,
    ['OPERATION_NOT_DESCRIBED'],
    /^GET \/widgets\/\{id\}$/,
  ],
  [
    'an implemented operation whose handler is not bound to it',
    UnboundWidgetsModule,
    ['OPERATION_NOT_VALIDATED'],
    /^GET \/widgets\/\{id\}$/,
  ],
  [
    'a route the contract has never heard of',
    UndocumentedRouteWidgetsModule,
    ['UNDOCUMENTED_ROUTE'],
    /^GET \/api\/v1\/widgets\/debug\/dump$/,
  ],
];

/**
 * The three differences the audit reproduced with isolated schemas, pushed through a real decorated
 * application, its own description and the same check the command runs: a request parameter written another
 * way, a `oneOf` branch described twice, and a value fixed to null described as free. Before the repair each
 * of these reported nothing.
 */
describe('comparison gaps closed (audit F03), in a real application', () => {
  async function checkGadgets(module: Parameters<typeof appWith>[0]) {
    running = await startTestApp({
      rootModule: appWith(module),
      contractSource: { load: () => GADGET_CONTRACT },
    });
    const { app } = running;
    await app.init();
    return checkConformance({
      contract: GADGET_CONTRACT,
      generated: JSON.parse(JSON.stringify(buildOpenApiDocument(app))) as JsonObject,
      live: listLiveRoutes(app),
      scope: ['listGadgets'],
      technicalRoutes: TECHNICAL_ROUTES,
      bound: listBoundOperations(app.get(ModulesContainer, { strict: false })),
    });
  }

  it('finds nothing in the conforming gadget slice, and compares its operation', async () => {
    const report = await checkGadgets(ConformingGadgetsModule);

    expect(report.findings).toEqual([]);
    expect(report.checkedOperations).toEqual(['listGadgets']);
  });

  it.each([
    [
      'an array written as ids=a,b where the contract writes ids=a&ids=b',
      ExplodeDriftGadgetsModule,
      ['PARAMETER_DRIFT'],
      /^GET \/gadgets > parameter query:ids$/,
    ],
    [
      'a oneOf branch described twice',
      RepeatedBranchGadgetsModule,
      ['SCHEMA_COMPOSITION'],
      /^GET \/gadgets > response 200 > application\/json\.properties\.kind$/,
    ],
    [
      'a value the contract fixes to null described as free',
      LooseMarkerGadgetsModule,
      ['SCHEMA_ENUM'],
      /^GET \/gadgets > response 200 > application\/json\.properties\.marker$/,
    ],
  ] as const)('reports %s', async (_label, module, expected, at) => {
    const report = await checkGadgets(module);

    expect(codes(report.findings)).toEqual(expected);
    for (const finding of report.findings) expect(finding.at).toMatch(at);
  });
});

describe('deliberate drift in a real application', () => {
  it.each(DRIFTS)('is reported for %s', async (_label, module, expected, at) => {
    const report = await checkFixture(module);

    expect(codes(report.findings)).toEqual(expected);
    for (const finding of report.findings) expect(finding.at).toMatch(at);
  });

  // Break caught: an operation the scope claims being served by nothing, in an application that does serve
  // a neighbour. The router, not the description, decides what is live.
  it('reports a declared operation with no live route', async () => {
    const report = await checkFixture(ReadOnlyWidgetsModule);

    expect(codes(report.findings)).toEqual(['OPERATION_NOT_LIVE', 'OPERATION_NOT_DESCRIBED']);
    expect(report.findings.map((finding) => finding.at)).toEqual([
      'POST /widgets',
      'POST /widgets',
    ]);
    expect(report.findings[0]?.message).toContain('createWidget');
  });

  // Break caught: a route that conforms while the scope fails to list it, so that "implemented" and
  // "declared" drift apart without anything failing.
  it('reports a route that conforms but is not in the declared scope', async () => {
    const report = await checkFixture(ConformingWidgetsModule, ['getWidget']);

    expect(codes(report.findings)).toEqual(['ROUTE_OUTSIDE_SCOPE']);
    expect(report.findings[0]?.at).toBe('POST /api/v1/widgets');
  });
});
