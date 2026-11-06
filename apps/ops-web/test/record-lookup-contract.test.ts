import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { components } from '@melarc/api-client';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { MAX_DESTINATION_HINT } from '../src/platform/notifications/notification-shape';
import {
  RECORD_LOOKUP_FIELDS,
  RECORD_LOOKUP_KINDS,
  RECORD_LOOKUP_MAX_ITEMS,
} from '../src/platform/lookup/record-lookup-shape';

/**
 * The guard that judges the answer of `lookupRecords` (`src/platform/lookup/record-lookup-shape.ts`) is a runtime check, not a second
 * description of the wire: the types are the generated ones. This test reads the contract and holds the guard to it, as the queue summary's does:
 * every field the guard reads is a field of its schema, every field the contract names is one the guard knows, every field the contract requires
 * is one the guard requires, and every kind the guard recognises is one the contract names and the other way round, so that a kind the contract
 * adds has to be decided on here before a screen can draw it.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Schema {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly enum?: readonly string[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly additionalProperties?: boolean;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly $ref?: string;
}

interface Operation {
  readonly operationId?: string;
  readonly 'x-permission'?: string;
  readonly security?: readonly Record<string, unknown>[];
  readonly 'x-error-codes'?: readonly string[];
  readonly parameters?: readonly {
    readonly name: string;
    readonly in: string;
  }[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content?: Record<string, { readonly schema?: Schema }>;
  };
  readonly responses?: Record<
    string,
    { readonly headers?: Record<string, { readonly $ref?: string }> }
  >;
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema> };
  paths: Record<string, Record<string, Operation>>;
};

const page = document.components.schemas.RecordLookupPage;
const result = document.components.schemas.RecordLookupResult;
const kind = document.components.schemas.RecordLookupKind;
if (page === undefined || result === undefined || kind === undefined) {
  throw new Error('The contract lacks RecordLookupPage, RecordLookupResult or RecordLookupKind.');
}

/** Whether two unions of words are the same, member for member. For a union of string literals that is equality; it asks the compiler. */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('the guard of RecordLookupPage and the contract', () => {
  const fields = RECORD_LOOKUP_FIELDS;

  // Break caught: a guard reading a field the contract does not have.
  it('reads only fields that the schemas have', () => {
    expect(Object.keys(page.properties ?? {})).toEqual([...fields.RecordLookupPage.required]);
    for (const field of [
      ...fields.RecordLookupResult.required,
      ...fields.RecordLookupResult.optional,
    ]) {
      expect(Object.keys(result.properties ?? {}), field).toContain(field);
    }
  });

  // Break caught: a field the contract adds that the guard never decides about.
  it('knows every field that the schemas have', () => {
    expect(
      [...fields.RecordLookupResult.required, ...fields.RecordLookupResult.optional].toSorted(),
    ).toEqual(Object.keys(result.properties ?? {}).toSorted());
  });

  // Break caught: the contract making a field mandatory that the guard treats as optional, or the guard requiring what may be absent.
  it('requires exactly the fields the contract requires', () => {
    expect([...(result.required ?? [])].toSorted()).toEqual(
      [...fields.RecordLookupResult.required].toSorted(),
    );
    expect([...(page.required ?? [])].toSorted()).toEqual(
      [...fields.RecordLookupPage.required].toSorted(),
    );
  });

  // Break caught: a kind the guard draws that the contract does not name, or a kind of the contract the page would silently drop.
  it('recognises exactly the kinds the contract names, in its order', () => {
    expect([...(kind.enum ?? [])]).toEqual([...RECORD_LOOKUP_KINDS]);
    const sameKinds: Equal<
      (typeof RECORD_LOOKUP_KINDS)[number],
      components['schemas']['RecordLookupKind']
    > = true;
    expect(sameKinds).toBe(true);
  });

  // Break caught: a closed schema opened, which would let a field of a record ride along in an answer.
  it('is closed against any other property, in the page, in a result and in its hub', () => {
    expect(page.additionalProperties).toBe(false);
    expect(result.additionalProperties).toBe(false);
    expect(result.properties?.hub?.additionalProperties).toBe(false);
    expect(page.properties?.items?.maxItems).toBe(RECORD_LOOKUP_MAX_ITEMS);
  });

  // Break caught (the Product Owner's decision D1): a route or a sentence put back into the answer, so that the API owns words and pages again.
  it('names no route and no sentence', () => {
    expect(Object.keys(result.properties ?? {})).not.toContain('route');
    expect(Object.keys(result.properties ?? {})).not.toContain('subtitle');
  });

  // Break caught: the hub read with a field the contract does not have, or one it requires left out.
  it('reads the hub as the contract describes it, and the masked phone as the destination hint is', () => {
    expect(RECORD_LOOKUP_FIELDS.RecordLookupHub.required).toEqual(['id', 'display_name']);
    const hub = result.properties?.hub;
    expect([...(hub?.required ?? [])].toSorted()).toEqual(
      [...RECORD_LOOKUP_FIELDS.RecordLookupHub.required].toSorted(),
    );
    expect(Object.keys(hub?.properties ?? {}).toSorted()).toEqual(
      [...RECORD_LOOKUP_FIELDS.RecordLookupHub.required].toSorted(),
    );
    expect(hub?.properties?.id?.format).toBe('uuid');
    expect(result.properties?.service_date?.format).toBe('date');
    expect(result.properties?.phone_hint?.maxLength).toBe(MAX_DESTINATION_HINT);
  });
});

describe('the operation lookupRecords in the contract', () => {
  const path = document.paths['/ops/lookup'];
  const operation = path?.post;

  // Break caught: the lookup taking a permission of its own, served to a Vendor session, or sent without the synchronizer token of a POST.
  it('is a self operation of the browser session, with the synchronizer token, and a POST that changes nothing', () => {
    expect(operation?.operationId).toBe('lookupRecords');
    expect(operation?.['x-permission']).toBe('self');
    expect(operation?.security).toEqual([{ browserSession: [], csrfToken: [] }]);
    expect(operation?.['x-error-codes']).toContain('CSRF_VALIDATION_FAILED');
  });

  // Break caught (the Product Owner's decision of 6 November 2026): a text in the address again, or a GET that serves it, which would put a phone
  // number typed in full into a URL that a proxy or a monitoring tool keeps.
  it('asks one field q of 2 to 64 characters in the body, with nothing in the address and no GET', () => {
    expect(path?.get).toBeUndefined();
    // No query parameter, and no Idempotency-Key header: no convention asks one of a read.
    expect(operation?.parameters ?? []).toEqual([]);
    expect(operation?.requestBody?.required).toBe(true);
    expect(operation?.requestBody?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/RecordLookupRequest',
    });
    const body = document.components.schemas.RecordLookupRequest;
    expect(body).toMatchObject({ type: 'object', required: ['q'], additionalProperties: false });
    expect(Object.keys(body?.properties ?? {})).toEqual(['q']);
    expect(body?.properties?.q).toMatchObject({ type: 'string', minLength: 2, maxLength: 64 });
  });
});
