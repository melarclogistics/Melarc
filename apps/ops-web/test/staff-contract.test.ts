import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { STAFF_FIELDS } from '../src/platform/staff/staff-shape';

/**
 * The guards that judge the answers of the identity operations (`src/platform/staff/staff-shape.ts`) are runtime checks, not a second
 * description of the wire: the types of the answers are the generated ones. This test reads the contract and holds each guard to it, the
 * way `session-contract.test.ts` does for the session: every field a guard reads is a field of its schema, every field the contract
 * requires of an answer is one the guard requires, and every value of an enumeration a guard recognises is one the contract has (and the
 * other way round, so that a status the contract adds is a failing test and not a refused list).
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
  readonly maxItems?: number;
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

describe.each(Object.entries(STAFF_FIELDS))('the guard of %s and the contract', (name, fields) => {
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

  // Break caught: a value the contract adds to an enumeration (or drops from it) that the guard does not know, so that a real list is
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
    const identity = schemaNamed('StaffIdentity').properties;
    for (const field of ['id', 'role_bundle_id', 'primary_hub_id', 'created_by', 'approved_by']) {
      expect(identity[field]?.format, field).toBe('uuid');
    }
    const session = schemaNamed('SessionRecord').properties;
    for (const field of ['id', 'principal_id']) expect(session[field]?.format, field).toBe('uuid');
    for (const field of ['issued_at', 'expires_at', 'last_activity_at']) {
      expect(session[field]?.format, field).toBe('date-time');
    }
    expect(schemaNamed('MfaResetResult').properties.grant_expires_at?.format).toBe('date-time');
    expect(schemaNamed('SetupGrant').properties.expires_at?.format).toBe('date-time');
  });

  // Break caught: the screens offering or accepting a field the schemas close on purpose.
  it('has no credential, token or hash in any answer the guards read', () => {
    for (const name of Object.keys(STAFF_FIELDS)) {
      for (const field of Object.keys(schemaNamed(name).properties)) {
        expect(field, `${name}.${field}`).not.toMatch(/password|token|secret|hash|credential$/i);
      }
    }
  });

  it('has the page size the list guard assumes as its largest', () => {
    const pageSize = document.components.parameters.PageSize as unknown as {
      schema: { maximum: number };
    };
    expect(pageSize.schema.maximum).toBe(100);
  });
});
