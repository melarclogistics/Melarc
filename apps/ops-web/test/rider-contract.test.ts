import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  ENROLMENT_URI,
  ENROLMENT_URI_LENGTH,
  RIDER_FIELDS,
} from '../src/platform/rider/rider-shape';

/**
 * The guards that judge the answers of the rider operations (`src/platform/rider/rider-shape.ts`) are runtime checks, not a second description
 * of the wire: the types of the answers are the generated ones. This test reads the contract and holds each guard to it, as
 * `staff-contract.test.ts` does for the identity screens: every field a guard reads is a field of its schema, every field the contract
 * requires of an answer is one the guard requires, and every value of an enumeration a guard recognises is one the contract has (and the other
 * way round, so that a status the contract adds is a failing test and not a refused roster). The enrolment code's pattern is held to the
 * contract's own.
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
  readonly minLength?: number;
  readonly maxLength?: number;
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema>; parameters: Record<string, Schema> };
};

/** The schema with its `$ref` and `allOf` resolved into one list of properties and one list of required names. */
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
    for (const each of part.allOf ?? []) take(each);
  };
  take(schema);
  return { properties, required };
}

const schemaNamed = (name: string) => flattened({ $ref: `#/components/schemas/${name}` });

describe.each(Object.entries(RIDER_FIELDS))('the guard of %s and the contract', (name, fields) => {
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

  // Break caught: a value the contract adds to an enumeration (or drops from it) that the guard does not know, so that a real roster is
  // refused, or a value nobody sends is accepted.
  it('recognises exactly the values of each enumeration the contract has', () => {
    const enums: Record<string, readonly string[]> = fields.enums;
    for (const [field, values] of Object.entries(enums)) {
      const enumeration = (schema.properties[field]?.enum ?? []).filter(
        (value): value is string => value !== null,
      );
      expect([...values].toSorted(), field).toEqual([...enumeration].toSorted());
    }
  });
});

describe('the shapes the guards assume', () => {
  it('has uuids for every identifier and instants for every time', () => {
    const rider = schemaNamed('RiderSummary').properties;
    for (const field of ['id', 'primary_hub_id']) expect(rider[field]?.format, field).toBe('uuid');
    const device = schemaNamed('RegisteredDevice').properties;
    for (const field of ['id', 'principal_id', 'registered_by']) {
      expect(device[field]?.format, field).toBe('uuid');
    }
    expect(device.registered_at?.format).toBe('date-time');
    const grant = schemaNamed('DeviceEnrolmentGrant').properties;
    expect(grant.expires_at?.format).toBe('date-time');
    expect(grant.rider_id?.format).toBe('uuid');
  });

  // Break caught: a rider's guard that accepts a device kind or a principal the rider's device cannot be.
  it('has the device kind and principal of a rider’s device among the contract’s', () => {
    const device = schemaNamed('RegisteredDevice').properties;
    expect(device.principal_type?.enum).toContain('RIDER');
    expect(device.device_kind?.enum).toContain('RIDER_ANDROID_KEYPAIR');
  });

  // Break caught: the screens offering or accepting a field the schemas close on purpose. `pin_established` says whether a PIN is set and
  // holds none; the code of a registration (`enrolment_uri`) is named for what it is and is the one credential a rider screen draws.
  it('has no PIN, key, hash or credential in any answer the guards read', () => {
    const says = new Set(['RiderSummary.pin_established']);
    for (const name of Object.keys(RIDER_FIELDS)) {
      for (const field of Object.keys(schemaNamed(name).properties)) {
        if (says.has(`${name}.${field}`)) continue;
        expect(field, `${name}.${field}`).not.toMatch(
          /password|pin|token|secret|hash|credential|public_key|attestation|nonce|signature/i,
        );
      }
    }
  });

  // Break caught: a guard that takes a different code than the contract promises, so that a real code is not drawn or a false one is.
  it('has the enrolment code the guard recognises, exactly as the contract has it', () => {
    const uri = schemaNamed('DeviceEnrolmentGrant').properties.enrolment_uri;

    // A regular expression writes a slash as `\/`; the contract's pattern does not.
    expect(uri?.pattern).toBe(ENROLMENT_URI.source.replaceAll('\\/', '/'));
    expect(uri?.minLength).toBe(ENROLMENT_URI_LENGTH);
    expect(uri?.maxLength).toBe(ENROLMENT_URI_LENGTH);
  });

  it('has the page size the list guard assumes as its largest', () => {
    const pageSize = document.components.parameters.PageSize as unknown as {
      schema: { maximum: number };
    };
    expect(pageSize.schema.maximum).toBe(100);
  });
});
