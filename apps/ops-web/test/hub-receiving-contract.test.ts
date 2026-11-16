import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  MAX_PAGE_ITEMS,
  MISSING_VIEWS,
  PARCEL_ORIGINS,
  PARCEL_STATES,
  RECEIVING_FIELDS,
  RECEIVING_MODES,
  RUN_VIEWS,
} from '../src/platform/hub-receiving/receiving-shape';

/**
 * The guards that judge the answers of the receiving screens of a run (`src/platform/hub-receiving/receiving-shape.ts`) are runtime checks, not a second description of the wire: the types are the generated ones. This
 * test reads the contract and holds each guard to it, as `hub-intake-contract.test.ts` does for the blind count: every field a guard requires is a field of its schema, **every field the contract requires of an
 * answer is one the guard requires**, every value of an enumeration a guard recognises is one the contract has (and the other way round), and the permission, the headers and the refusals of each operation are the ones
 * the screens rely on. **No schema of the run's receiving page has a member that could carry a phone number, a key or an address**: a name is a display name, and a picture is an evidence identifier.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Schema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly (string | null)[];
  readonly const?: string;
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly $ref?: string;
  readonly maximum?: number;
  readonly additionalProperties?: boolean;
}
interface Parameter {
  readonly $ref?: string;
  readonly name?: string;
  readonly in?: string;
  readonly required?: boolean;
  readonly schema?: Schema;
}
interface Operation {
  readonly operationId?: string;
  readonly 'x-permission'?: string;
  readonly 'x-error-codes'?: readonly string[];
  readonly parameters?: readonly Parameter[];
  readonly requestBody?: { content: { 'application/json': { schema: Schema } } };
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema>; parameters: Record<string, Parameter> };
  paths: Record<string, Record<string, unknown>>;
};

const schemaNamed = (name: string): Schema => {
  const schema = document.components.schemas[name];
  if (schema === undefined) throw new Error(`The contract has no schema ${name}`);
  return schema;
};
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
function parameterOf(operationId: string, name: string): Parameter | undefined {
  for (const each of operationNamed(operationId).parameters ?? []) {
    const parameter =
      each.$ref === undefined
        ? each
        : document.components.parameters[each.$ref.split('/').at(-1) ?? ''];
    if (parameter?.name === name) return parameter;
  }
  return undefined;
}
/** The values of an enumeration, through a `$ref` to a named enumeration where the member points at one. */
const valuesOf = (schema: Schema | undefined): string[] => {
  const resolved =
    schema?.$ref === undefined
      ? schema
      : document.components.schemas[schema.$ref.split('/').at(-1) ?? ''];
  return (resolved?.enum ?? []).filter((value): value is string => value !== null);
};

describe('the guards of the receiving screens of a run, held to the contract', () => {
  for (const [name, fields] of Object.entries(RECEIVING_FIELDS)) {
    const schema = schemaNamed(name);

    // Break caught: a guard that reads a member the contract does not have (it would refuse every real answer), or ignores one the contract requires (it would accept an answer without it).
    it(`${name}: reads exactly the members the contract requires, and no other required one`, () => {
      expect([...(schema.required ?? [])].toSorted()).toEqual([...fields.required].toSorted());
      for (const member of fields.required) {
        expect(Object.keys(schema.properties ?? {}), `${name}.${member}`).toContain(member);
      }
    });

    for (const [member, values] of Object.entries<readonly string[]>(fields.enums)) {
      // Break caught: a value the guard takes that the contract does not have, or one the contract adds that the guard would refuse.
      it(`${name}.${member}: the values are the contract's`, () => {
        const declared = valuesOf(schema.properties?.[member]);
        expect([...values].toSorted()).toEqual([...declared].toSorted());
      });
    }
  }

  it('lists the modes, the parcel states and origins and the views as the contract has them', () => {
    expect([...RECEIVING_MODES].toSorted()).toEqual(
      valuesOf(schemaNamed('ReceivingMode')).toSorted(),
    );
    expect([...PARCEL_STATES].toSorted()).toEqual(
      valuesOf(schemaNamed('IntakeParcelState')).toSorted(),
    );
    expect([...PARCEL_ORIGINS].toSorted()).toEqual(
      valuesOf(schemaNamed('IntakeParcelOrigin')).toSorted(),
    );
    expect([...RUN_VIEWS].toSorted()).toEqual(
      valuesOf(parameterOf('listReceivingRuns', 'view')?.schema).toSorted(),
    );
    expect([...MISSING_VIEWS].toSorted()).toEqual(
      valuesOf(parameterOf('listMissingParcels', 'view')?.schema).toSorted(),
    );
  });

  it('takes the largest page the contract names', () => {
    const size = document.components.parameters.PageSize;
    expect(size?.schema?.maximum).toBe(MAX_PAGE_ITEMS);
  });

  // Break caught: a member that could carry a number to dial, a key or an address added to the run's page, which the screens would then draw: the schemas have none, by name.
  it('has no member that could carry a phone number, a key or an address in what the run page reads', () => {
    for (const name of Object.keys(RECEIVING_FIELDS)) {
      for (const member of Object.keys(schemaNamed(name).properties ?? {})) {
        expect(member, `${name}.${member}`).not.toMatch(
          /phone|mobile|msisdn|email|object_key|storage|url|address|signed|token$/i,
        );
      }
    }
  });

  // Break caught: the blind-count vendor of the run's page given a member that is the rider's number: its section has no member of the kind.
  it('has no declared count in a vendor’s section or a row of the queue', () => {
    for (const name of ['ReceivingVendor', 'ReceivingRunSummary', 'MissingParcel']) {
      for (const member of Object.keys(schemaNamed(name).properties ?? {})) {
        expect(member, `${name}.${member}`).not.toMatch(/declar/i);
      }
    }
  });

  it('asks the operations the keys, the headers and the bodies the screens send', () => {
    for (const [operationId, permission] of [
      ['listReceivingRuns', 'hub.read'],
      ['getReceivingRun', 'hub.read'],
      ['listMissingParcels', 'hub.read'],
      ['recordParcelArrival', 'hub.intake.count'],
      ['finishCheckIn', 'hub.intake.count'],
      ['addExtraParcel', 'hub.intake.count'],
      ['correctIntakeCount', 'hub.osd.adjudicate'],
    ] as const) {
      expect(operationNamed(operationId)['x-permission'], operationId).toBe(permission);
    }
    const headers = (operationId: string): string[] =>
      (operationNamed(operationId).parameters ?? [])
        .map((each) =>
          each.$ref === undefined
            ? each.name
            : document.components.parameters[each.$ref.split('/').at(-1) ?? '']?.name,
        )
        .filter((name): name is string => name === 'Idempotency-Key' || name === 'If-Match');
    expect(headers('recordParcelArrival')).toEqual([]);
    expect(headers('finishCheckIn').toSorted()).toEqual(['Idempotency-Key', 'If-Match']);
    expect(headers('addExtraParcel')).toEqual(['Idempotency-Key']);
    expect(headers('correctIntakeCount').toSorted()).toEqual(['Idempotency-Key', 'If-Match']);
    expect(Object.keys(schemaNamed('ParcelArrival').properties ?? {})).toEqual(['arrived']);
    expect(Object.keys(schemaNamed('CheckInFinish').properties ?? {}).toSorted()).toEqual([
      'all_arrived',
      'confirmed_count',
    ]);
    expect(schemaNamed('CheckInFinish').additionalProperties).toBe(false);
    expect(Object.keys(schemaNamed('ExtraParcelAdd').properties ?? {}).toSorted()).toEqual([
      'note',
      'photo_evidence_id',
    ]);
  });

  it('declares the refusals the screens word for the acts', () => {
    for (const operationId of [
      'finishCheckIn',
      'addExtraParcel',
      'correctIntakeCount',
      'recordParcelArrival',
    ]) {
      const codes = operationNamed(operationId)['x-error-codes'] ?? [];
      expect(codes, operationId).toContain('STATE_CONFLICT');
      expect(codes, operationId).toContain('PERMISSION_DENIED');
      expect(codes, operationId).toContain('NOT_FOUND');
    }
  });
});
