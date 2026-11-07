import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  MANIFEST_FIELDS,
  MANIFEST_FILTER_STATES,
  MAX_STOPS,
} from '../src/platform/manifest/manifest-shape';
import { listManifests, manifest, world } from './browser/support/manifest-api';

/**
 * The guards that judge the answers of the manifest operations (`src/platform/manifest/manifest-shape.ts`) are runtime checks, not a second
 * description of the wire: the types are the generated ones. This test reads the contract and holds each guard to it, as
 * `pickup-contract.test.ts` does for the pickup screens: every field a guard reads is a field of its schema, every field the contract requires
 * of an answer is one the guard requires, and every value of an enumeration a guard recognises is one the contract has (and the other way
 * round). The headers each act sends, the permissions the routes are guarded by, and the bounds the builder keeps are held to the contract's.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Schema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly (string | null)[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly allOf?: readonly Schema[];
  readonly $ref?: string;
  readonly maxItems?: number;
  readonly minItems?: number;
}

interface Operation {
  readonly operationId?: string;
  readonly 'x-permission'?: string;
  readonly 'x-error-codes'?: readonly string[];
  readonly parameters?: readonly (
    | {
        readonly $ref?: string;
        readonly name?: string;
        readonly in?: string;
        readonly required?: boolean;
        readonly schema?: Schema & { readonly format?: string };
      }
    | undefined
  )[];
  readonly requestBody?: unknown;
  readonly responses?: Record<string, unknown>;
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema> };
  paths: Record<string, Record<string, unknown>>;
};

function flattened(schema: Schema): { properties: Record<string, Schema>; required: string[] } {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  const take = (part: Schema): void => {
    if (part.$ref !== undefined) {
      const name = part.$ref.split('/').at(-1) ?? '';
      const target = document.components.schemas[name];
      if (target === undefined) throw new Error(`The contract has no schema ${name}`);
      take(target);
      return;
    }
    Object.assign(properties, part.properties ?? {});
    required.push(...(part.required ?? []));
  };
  take(schema);
  return { properties, required };
}

const schemaNamed = (name: string) => flattened({ $ref: `#/components/schemas/${name}` });
const valuesOf = (schema: Schema | undefined): string[] =>
  (schema?.enum ?? []).filter((value): value is string => value !== null);

const operations = Object.values(document.paths).flatMap((item) =>
  Object.values(item).filter(
    (candidate): candidate is Operation =>
      typeof candidate === 'object' && candidate !== null && 'operationId' in candidate,
  ),
);
const operationNamed = (operationId: string): Operation => {
  const operation = operations.find((candidate) => candidate.operationId === operationId);
  if (operation === undefined) throw new Error(`The contract has no operation ${operationId}`);
  return operation;
};

describe.each(Object.entries(MANIFEST_FIELDS))(
  'the guard of %s and the contract',
  (name, fields) => {
    const schema = schemaNamed(name);

    // Break caught: a guard reading a field the contract does not have (a rename would leave it refusing every real answer).
    it('reads only fields that the schema has', () => {
      for (const field of [...fields.required, ...fields.optional]) {
        expect(Object.keys(schema.properties), field).toContain(field);
      }
    });

    // Break caught: the contract making a field mandatory that the guard treats as optional.
    it('requires every field that the contract requires of the answer', () => {
      for (const field of schema.required) {
        expect(fields.required, field).toContain(field);
      }
    });

    // Break caught: the guard requiring a field the contract says may be absent, which would refuse a real answer.
    it('requires only fields that the contract requires', () => {
      for (const field of fields.required) {
        expect(schema.required, field).toContain(field);
      }
    });

    // Break caught: a value the contract adds to an enumeration (or drops from it) that the guard does not know.
    it('recognises exactly the values of each enumeration the contract has', () => {
      const enums: Record<string, readonly string[]> = fields.enums;
      for (const [field, values] of Object.entries(enums)) {
        expect([...values].toSorted(), field).toEqual(
          valuesOf(schema.properties[field]).toSorted(),
        );
      }
    });
  },
);

describe('the bounds the screens keep', () => {
  // Break caught: a builder that lets 65 requests be chosen, or that stops at fewer than the contract allows.
  it('holds a manifest to the 64 requests the create schema allows', () => {
    const create = schemaNamed('PickupManifestCreate').properties;
    expect(create.pickup_request_ids?.maxItems).toBe(MAX_STOPS);
    expect(create.pickup_request_ids?.minItems).toBe(1);
    expect(create.carryover?.maxItems).toBe(MAX_STOPS);
  });

  // Break caught: the carry-over sent under a name the schema does not have, which the server would refuse whole.
  it('names the members of a carry-over entry as its schema does', () => {
    const entry = schemaNamed('PickupManifestCreate').properties.carryover?.items;
    expect(entry?.required?.toSorted()).toEqual(['pickup_request_id', 'reason_code']);
    expect(Object.keys(entry?.properties ?? {}).toSorted()).toEqual([
      'note',
      'pickup_request_id',
      'reason_code',
    ]);
  });

  // Break caught: a custody act sent with a field it does not take, or without the one it must carry.
  it('names the mandatory text and the destinations of the custody acts as their schemas do', () => {
    expect(schemaNamed('RunCustodyHandoverCreate').required).toEqual(['note']);
    expect(Object.keys(schemaNamed('RunCustodyHandoverCreate').properties).toSorted()).toEqual([
      'note',
      'to_hub_id',
      'to_rider_id',
    ]);
    expect(schemaNamed('RunCustodyHandoverFail').required).toEqual(['note']);
    expect(schemaNamed('RunCustodyHandoverAccept').required).toEqual(['parcel_count_taken']);
    expect(schemaNamed('ManifestCancel').required).toEqual(['note']);
    expect(schemaNamed('ManifestStopOrder').required).toEqual(['ordered_stop_ids']);
    expect(schemaNamed('RiderAssignment').required).toEqual(['rider_id']);
  });

  // Break caught: a skip sent with a field the operation does not take (its body is a reason and a note, in these names).
  it('has a skip that takes a reason code and a note', () => {
    const skip = operationNamed('skipPickupStop');
    const body = (
      skip.requestBody as {
        content: { 'application/json': { schema: Schema } };
      }
    ).content['application/json'].schema;
    expect(body.required).toEqual(['reason_code']);
    expect(Object.keys(body.properties ?? {}).toSorted()).toEqual(['note', 'reason_code']);
  });
});

describe('the permission and the headers of each operation', () => {
  const headersOf = (operationId: string): string[] =>
    (operationNamed(operationId).parameters ?? [])
      .map((parameter) => parameter?.$ref?.split('/').at(-1))
      .filter((name): name is string => name === 'IdempotencyKey' || name === 'IfMatch')
      .toSorted();

  // Break caught: an act sent with a key its operation does not take, or without the version it must carry (manifest-commands.ts says which).
  it.each([
    ['createPickupManifest', ['IdempotencyKey']],
    ['setManifestStopOrder', ['IdempotencyKey', 'IfMatch']],
    ['assignRider', ['IfMatch']],
    ['dispatchManifest', ['IfMatch']],
    ['cancelPickupManifest', ['IdempotencyKey', 'IfMatch']],
    ['skipPickupStop', ['IdempotencyKey', 'IfMatch']],
    ['initiateRunCustodyHandover', ['IfMatch']],
    ['acceptRunCustodyHandover', ['IdempotencyKey', 'IfMatch']],
    ['failRunCustodyHandover', ['IdempotencyKey', 'IfMatch']],
    ['listPickupManifests', []],
    ['getPickupManifest', []],
    ['getPickupStop', []],
    ['listRunCustodyHandovers', []],
    ['getRunCustodyHandover', []],
  ])('has %s sending %j', (operationId, expected) => {
    expect(headersOf(operationId)).toEqual(expected);
  });

  // Break caught: a page offering an act to a key other than the one its operation needs (the server checks it again; this is the hint).
  it.each([
    ['listPickupManifests', 'pickup.read'],
    ['getPickupManifest', 'pickup.read'],
    ['createPickupManifest', 'pickup.manifest.create'],
    ['setManifestStopOrder', 'pickup.manifest.create'],
    ['cancelPickupManifest', 'pickup.manifest.create'],
    ['assignRider', 'pickup.manifest.assign'],
    ['dispatchManifest', 'pickup.manifest.dispatch'],
    ['skipPickupStop', 'pickup.stop.skip'],
    ['listRiders', 'dispatch.read'],
    ['initiateRunCustodyHandover', 'fleet.custody.initiate'],
    ['failRunCustodyHandover', 'fleet.custody.initiate'],
    ['acceptRunCustodyHandover', 'fleet.custody.accept'],
    ['listRunCustodyHandovers', 'fleet.custody.read'],
    ['getRunCustodyHandover', 'fleet.custody.read'],
    ['listReasonDefinitions', 'settings.reason.read'],
  ])('has %s behind %s', (operationId, permission) => {
    expect(operationNamed(operationId)['x-permission']).toBe(permission);
  });

  // Break caught: the pool asked for with a filter the list does not have.
  it('has the pool filter on the request list', () => {
    const list = operationNamed('listPickupRequests');
    const manifested = list.parameters?.find((parameter) => parameter?.name === 'manifested');
    expect(manifested?.schema?.type).toBe('boolean');
  });

  // Break caught: the custody list narrowed by a filter it does not have.
  it('has the filters of the custody list', () => {
    const list = operationNamed('listRunCustodyHandovers');
    const names = (list.parameters ?? []).map((parameter) => parameter?.name);
    expect(names).toEqual(expect.arrayContaining(['manifest_id', 'state']));
  });
});

describe('the filters of the manifest list (OB-S1-25) and the contract', () => {
  const list = operationNamed('listPickupManifests');
  const parameter = (name: string) => list.parameters?.find((each) => each?.name === name);

  // Break caught: the screen offering a state the contract does not have, or the contract adding one the screen never offers.
  it('has a state filter whose values are exactly the states the screen offers', () => {
    const state = parameter('state');
    expect(state).toMatchObject({ in: 'query', schema: { type: 'string' } });
    expect(state?.required ?? false).toBe(false);
    expect([...MANIFEST_FILTER_STATES].toSorted()).toEqual(valuesOf(state?.schema).toSorted());
  });

  it('has a service date filter that is an optional date, sent as `service_date`', () => {
    const day = parameter('service_date');
    expect(day).toMatchObject({ in: 'query', schema: { type: 'string', format: 'date' } });
    expect(day?.required ?? false).toBe(false);
  });

  // Break caught: the hub of the run list declared as something other than the optional identifier that the lists which already take a hub
  // declare (a required parameter, a header or a path parameter, a pattern or an enumeration no other list has), or dropped while a screen is
  // built to send it (step R4): it is the same parameter and type as on the staff, rider and vendor lists (task C3, `AC-HUBF-02`).
  it('has a hub filter that is an optional uuid in the query, sent as `hub_id`', () => {
    const hub = parameter('hub_id');

    expect(hub).toMatchObject({
      name: 'hub_id',
      in: 'query',
      schema: { type: 'string', format: 'uuid' },
    });
    expect(hub?.required ?? false).toBe(false);
    expect(hub?.schema).toEqual({ type: 'string', format: 'uuid' });
    for (const operationId of ['listStaffIdentities', 'listRiders', 'listVendorAccounts']) {
      const other = operationNamed(operationId).parameters?.find((each) => each?.name === 'hub_id');
      expect(other, operationId).toBeDefined();
      expect(hub?.schema, operationId).toEqual(other?.schema);
    }
  });

  // Break caught: the screen telling a refused filter in words the contract does not promise (it must be a 400 `VALIDATION_FAILED`).
  it('answers a value that is not one with a 400 VALIDATION_FAILED', () => {
    expect(list['x-error-codes']).toContain('VALIDATION_FAILED');
    expect(Object.keys(list.responses ?? {})).toContain('400');
  });
});

/**
 * The stand-in the browser tests use for the list (`test/browser/support/manifest-api.ts`, `listManifests`) is held to the same text as the real
 * API: each filter exact, the two combined as "and", narrowing and never widening, and a value that is not one a 400 `VALIDATION_FAILED` that
 * names the parameter and never an empty list. Without this a screen could pass its browser tests against an answer the API never gives.
 */
describe('the stand-in list keeps the contract of the filters', () => {
  const states = valuesOf(
    operationNamed('listPickupManifests').parameters?.find((each) => each?.name === 'state')
      ?.schema,
  );
  const at = (suffix: string) => `a1000000-0000-4000-8000-0000000000${suffix}`;
  const w = world({
    manifests: [
      manifest({ id: at('a1'), state: 'DRAFT', service_date: '2026-11-04' }),
      manifest({ id: at('a2'), state: 'DRAFT', service_date: '2026-11-05' }),
      manifest({ id: at('a3'), state: 'DISPATCHED', service_date: '2026-11-04' }),
      manifest({ id: at('a4'), state: 'IN_PROGRESS', service_date: '2026-11-04' }),
      manifest({ id: at('a5'), state: 'COMPLETED', service_date: '2026-11-03' }),
      manifest({ id: at('a6'), state: 'CANCELLED', service_date: '2026-11-03' }),
    ],
    pageSize: 100,
  });
  const ask = (query: string) => listManifests(w, new URLSearchParams(query));
  const idsOf = (query: string): string[] =>
    (ask(query).json as { items: { id: string }[] }).items.map((item) => item.id.slice(-2));

  it('lists everything, oldest first, for no filter', () => {
    expect(idsOf('')).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });

  it.each(states)('lists exactly the manifests in %s', (state) => {
    const found = (ask(`state=${state}`).json as { items: { state: string }[] }).items;
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((item) => item.state === state)).toBe(true);
    expect(found).toHaveLength(w.manifests.filter((each) => each.state === state).length);
  });

  it('lists exactly the manifests worked on a day', () => {
    expect(idsOf('service_date=2026-11-04')).toEqual(['a1', 'a3', 'a4']);
    expect(idsOf('service_date=2026-11-03')).toEqual(['a5', 'a6']);
  });

  // Break caught: the two filters combined as "or", or either one ignored.
  it('combines the two as "and"', () => {
    expect(idsOf('state=DRAFT&service_date=2026-11-04')).toEqual(['a1']);
    expect(idsOf('state=DRAFT&service_date=2026-11-03')).toEqual([]);
  });

  // Break caught: a filter that widens what the reader is shown.
  it('only narrows: a filtered list is always part of the unfiltered one, in the same order', () => {
    const everything = idsOf('');
    for (const query of [
      'state=DRAFT',
      'service_date=2026-11-04',
      'state=DRAFT&service_date=2026-11-05',
    ]) {
      const part = idsOf(query);
      expect(
        part.every((id) => everything.includes(id)),
        query,
      ).toBe(true);
      expect(part, query).toEqual(everything.filter((id) => part.includes(id)));
    }
  });

  // Break caught: a value that is not one answered with an empty list, which hides the mistake; or a 400 that does not name the parameter.
  it.each([
    ['state=draft', '/state'],
    ['state=Draft', '/state'],
    ['state=', '/state'],
    ['state=ASSIGNED', '/state'],
    ['state=DRAFT&state=DRAFT', '/state'],
    ['state=DRAFT&state=DISPATCHED', '/state'],
    ['service_date=', '/service_date'],
    ['service_date=2026-02-30', '/service_date'],
    ['service_date=2026-13-01', '/service_date'],
    ['service_date=0000-01-01', '/service_date'],
    ['service_date=2026-11-4', '/service_date'],
    ['service_date=tomorrow', '/service_date'],
    ['service_date=2026-11-04T00:00:00Z', '/service_date'],
    ['service_date=2026-11-04&service_date=2026-11-05', '/service_date'],
  ])('refuses %s with a 400 VALIDATION_FAILED naming %s', (query, pointer) => {
    const answer = ask(query);

    expect(answer.status).toBe(400);
    const body = answer.json as {
      code: string;
      details: { violations: { in: string; pointer: string }[] };
    };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details.violations.map((each) => [each.in, each.pointer])).toEqual([
      ['query', pointer],
    ]);
  });

  it('accepts a leap day and refuses a day that is not one', () => {
    expect(ask('service_date=2028-02-29').status).toBe(200);
    expect(ask('service_date=2026-02-29').status).toBe(400);
  });

  it('uses a page token as a position in the order, with whatever filters come with it', () => {
    const paged = world({ manifests: w.manifests, pageSize: 2 });
    const first = listManifests(paged, new URLSearchParams('state=DRAFT')).json as {
      items: { id: string }[];
      next_page_token: string | null;
    };
    expect(first.items).toHaveLength(2);
    expect(first.next_page_token).toBeNull();
    const everything = listManifests(paged, new URLSearchParams('')).json as {
      next_page_token: string | null;
    };
    expect(everything.next_page_token).toBe('2');
    const second = listManifests(paged, new URLSearchParams('page_token=2&state=DRAFT')).json as {
      items: unknown[];
    };
    expect(second.items).toEqual([]);
    expect(listManifests(paged, new URLSearchParams('page_token=x')).status).toBe(400);
  });
});
