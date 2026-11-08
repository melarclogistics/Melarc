import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  CUTOFF_DECISIONS,
  OPERATIONAL_CODE,
  PAYER_INTENTS,
  PICKUP_FIELDS,
  SPLIT_BASES,
} from '../src/platform/pickup/pickup-shape';

/**
 * The guards that judge the answers of the pickup operations (`src/platform/pickup/pickup-shape.ts`) are runtime checks, not a second
 * description of the wire: the types are the generated ones. This test reads the contract and holds each guard to it, as
 * `rider-contract.test.ts` does for the rider screens: every field a guard reads is a field of its schema, every field the contract requires of
 * an answer is one the guard requires, and every value of an enumeration a guard recognises is one the contract has (and the other way round).
 * The operational code's pattern and the enumerations the booking form offers are held to the contract's own.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Schema {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly enum?: readonly (string | null)[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly allOf?: readonly Schema[];
  readonly $ref?: string;
  readonly pattern?: string;
}

interface Operation {
  readonly operationId?: string;
  readonly 'x-permission'?: string;
  readonly parameters?: readonly ({ readonly $ref?: string; readonly name?: string } | undefined)[];
  readonly requestBody?: unknown;
}

/** An operation read for its query parameters, inline ones with their schema. */
interface ListOperation {
  readonly operationId?: string;
  readonly parameters?: readonly (
    { readonly name?: string; readonly schema?: Schema } | undefined
  )[];
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema>; parameters: Record<string, Schema> };
  paths: Record<string, Record<string, unknown>>;
};

/** The schema with its `$ref` and its `allOf` parts that are schemas resolved into one list of properties and one list of required names. */
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

describe.each(Object.entries(PICKUP_FIELDS))('the guard of %s and the contract', (name, fields) => {
  const schema = schemaNamed(name);

  // Break caught: a guard reading a field the contract does not have (a rename in the contract would leave it refusing every real answer).
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
      expect([...values].toSorted(), field).toEqual(valuesOf(schema.properties[field]).toSorted());
    }
  });
});

describe('the values the screens offer and recognise', () => {
  it('has the operational code the guard recognises, exactly as the contract has it', () => {
    expect(schemaNamed('PickupRequest').properties.code?.pattern).toBe(OPERATIONAL_CODE.source);
  });

  // Break caught: the booking offering a payer or a split basis the create schema does not have, which the server would refuse.
  it('offers the payer intents and split bases of the create schema', () => {
    const create = schemaNamed('PickupRequestCreate').properties;
    expect([...PAYER_INTENTS].toSorted()).toEqual(valuesOf(create.default_payer_intent).toSorted());
    expect([...SPLIT_BASES].toSorted()).toEqual(valuesOf(create.split_basis).toSorted());
  });

  it('offers the decisions on a late booking that the contract has', () => {
    const resolution = schemaNamed('CutoffExceptionResolution').properties;
    expect([...CUTOFF_DECISIONS].toSorted()).toEqual(valuesOf(resolution.decision).toSorted());
  });

  // Break caught: a note sent under the wrong name: the extension's mandatory text is `reason`, the others' `note`.
  it('names the mandatory text of each act as its schema does', () => {
    expect(schemaNamed('PickupEscalation').required).toEqual(['note']);
    expect(schemaNamed('CancellationChargeWaiver').required).toEqual(['note']);
    expect(schemaNamed('AttemptExtension').required).toEqual(['reason']);
    expect(schemaNamed('CutoffExceptionResolution').required.toSorted()).toEqual([
      'decision',
      'note',
    ]);
    expect(schemaNamed('OnePackageExceptionRequest').required.toSorted()).toEqual([
      'note',
      'recipient',
    ]);
  });

  // Break caught: a waiver that sends an amount, which would reprice a snapshotted charge.
  it('has a waiver with no amount', () => {
    expect(Object.keys(schemaNamed('CancellationChargeWaiver').properties)).toEqual(['note']);
  });

  // Break caught: a recipient read under another name than the exception's own, which would refuse every request that carries one.
  it('has the recipient the exception guard reads', () => {
    const recipient = schemaNamed('OnePackageException').properties.recipient;
    expect(recipient?.required?.toSorted()).toEqual(['location', 'name', 'phone']);
    expect(recipient?.properties?.location?.$ref).toBe('#/components/schemas/Location');
  });

  // Break caught: the approver's queue asked for with a filter the list does not have, or a value it does not take.
  it('has the filter of the approver’s queue on the list', () => {
    const list = Object.values(document.paths['/pickup-requests'] ?? {}).find(
      (candidate) => (candidate as ListOperation | undefined)?.operationId === 'listPickupRequests',
    ) as ListOperation | undefined;
    const filter = list?.parameters?.find(
      (parameter) => parameter?.name === 'one_package_exception_state',
    );
    expect(valuesOf(filter?.schema)).toContain('REQUESTED');
  });

  it('has the page size the list guard assumes as its largest', () => {
    const pageSize = document.components.parameters.PageSize as unknown as {
      schema: { maximum: number };
    };
    expect(pageSize.schema.maximum).toBe(100);
  });
});

/**
 * The exception the portal draws is staff's, in whole (the Product Owner's decision of 29 October 2026): the contract has two views of it, one
 * for staff that requires who asked, who decided it and why, and one for every other reader that has none of the three. The guard is held to the
 * first, which is why it may require what it does; the second is a body this portal refuses.
 */
describe('the exception the portal draws', () => {
  const STAFF_ONLY = ['requested_by', 'approved_by', 'note'];

  // Break caught: the guard held to a view that does not promise the members it requires, which would let it refuse a real answer.
  it('is the staff view, which requires who asked, who decided it and why', () => {
    expect(schemaNamed('OnePackageException').required).toEqual(expect.arrayContaining(STAFF_ONLY));
  });

  // Break caught: the guard widened to the outcome, which would draw an exception with no requester beside an approval that looks eligible.
  it('is not the outcome every other audience reads, which has none of the three and has no guard here', () => {
    const outcome = schemaNamed('OnePackageExceptionOutcome');

    for (const member of STAFF_ONLY) {
      expect(Object.keys(outcome.properties), member).not.toContain(member);
    }
    expect(Object.keys(PICKUP_FIELDS)).not.toContain('OnePackageExceptionOutcome');
  });
});

describe('the headers each act sends', () => {
  const operations = Object.values(document.paths).flatMap((item) =>
    Object.values(item).filter(
      (candidate): candidate is Operation =>
        typeof candidate === 'object' && candidate !== null && 'operationId' in candidate,
    ),
  );
  const headersOf = (operationId: string): string[] => {
    const operation = operations.find((candidate) => candidate.operationId === operationId);
    if (operation === undefined) throw new Error(`The contract has no operation ${operationId}`);
    return (operation.parameters ?? [])
      .map((parameter) => parameter?.$ref?.split('/').at(-1))
      .filter((name): name is string => name === 'IdempotencyKey' || name === 'IfMatch')
      .toSorted();
  };

  // Break caught: the approval sent with a body, which the operation does not take (it is the id alone that is approved).
  it('has an approval that takes no body', () => {
    const approve = operations.find(
      (candidate) => candidate.operationId === 'approveOnePackageException',
    );
    expect(approve).toBeDefined();
    expect(approve?.requestBody).toBeUndefined();
  });

  // Break caught: an act sent with a key its operation does not take, or without the version it must carry (pickup-commands.ts says which).
  it.each([
    ['createPickupRequest', ['IdempotencyKey']],
    ['confirmPickupRequest', ['IfMatch']],
    ['cancelPickupRequest', ['IdempotencyKey', 'IfMatch']],
    ['resolveCutoffException', ['IdempotencyKey', 'IfMatch']],
    ['escalatePickupRequest', ['IdempotencyKey', 'IfMatch']],
    ['extendPickupAttempts', ['IdempotencyKey', 'IfMatch']],
    ['waiveCancellationCharge', ['IfMatch']],
    ['requestOnePackageException', []],
    ['approveOnePackageException', []],
  ])('has %s take %j', (operationId, headers) => {
    expect(headersOf(operationId)).toEqual(headers);
  });
});
