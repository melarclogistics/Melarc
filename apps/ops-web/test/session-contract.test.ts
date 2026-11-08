import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { SESSION_FIELDS } from '../src/platform/session/session-shape';

/**
 * The guard that judges a `getCurrentSession` answer (`src/platform/session/session-shape.ts`) is a runtime check, not a second
 * description of the wire: the type of the answer is the generated one. What keeps the two from drifting apart is this test, which reads
 * the contract and holds the guard to it: every field the guard reads is a field of `CurrentSession`, with the shape the guard assumes,
 * and every field the contract requires of the answer is one the guard requires.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Schema {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly enum?: readonly string[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly allOf?: readonly Schema[];
  readonly $ref?: string;
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema> };
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

const currentSession = flattened({ $ref: '#/components/schemas/CurrentSession' });

describe('the guard of the current session and the contract', () => {
  // Break caught: the guard reading a field the contract does not have (a rename in the contract would then leave the guard refusing
  // every real session, or accepting a shape nobody sends).
  it('reads only fields that CurrentSession has', () => {
    for (const name of [...SESSION_FIELDS.required, ...SESSION_FIELDS.optional]) {
      expect(Object.keys(currentSession.properties), name).toContain(name);
    }
  });

  // Break caught: the contract making a field mandatory that the guard treats as optional, so that an answer without it is accepted.
  it('requires every field that the contract requires of the answer', () => {
    for (const name of currentSession.required) {
      expect(SESSION_FIELDS.required, name).toContain(name);
    }
  });

  // Break caught: the guard requiring a field the contract says may be absent, which would refuse a real answer.
  it('requires only fields that the contract requires', () => {
    for (const name of SESSION_FIELDS.required) {
      expect(currentSession.required, name).toContain(name);
    }
  });

  it('judges the discriminators with the contract’s own enumerations', () => {
    const type = currentSession.properties.principal_type;
    const state = currentSession.properties.state;

    expect(type?.enum).toEqual(expect.arrayContaining([...SESSION_FIELDS.principalTypes]));
    expect(state?.enum).toEqual(expect.arrayContaining([...SESSION_FIELDS.states]));
    // The Ops Portal's session is a staff member's and an active one; the contract has more types and states than that.
    expect(SESSION_FIELDS.principalTypes).toEqual(['STAFF']);
    expect(SESSION_FIELDS.states).toEqual(['ACTIVE']);
  });

  it('assumes the shapes the contract gives the display fields and the permissions', () => {
    const name = currentSession.properties.principal_display_name;
    const hubs = currentSession.properties.authorized_hubs;
    const permissions = currentSession.properties.permissions;

    expect(name?.type).toEqual(['string', 'null']);
    expect(hubs?.type).toBe('array');
    expect(hubs?.items?.required).toEqual(expect.arrayContaining(['id', 'display_name']));
    expect(hubs?.items?.properties?.id?.format).toBe('uuid');
    expect(hubs?.items?.properties?.display_name?.type).toBe('string');
    expect(permissions?.type).toBe('array');
    expect(permissions?.items?.type).toBe('string');
    expect(currentSession.properties.id?.format).toBe('uuid');
    expect(currentSession.properties.expires_at?.format).toBe('date-time');
  });
});
