import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_PURPOSES,
  MAX_PAGE_ITEMS,
  PICKUP_WORK_FIELDS,
} from '../src/platform/pickup-work/pickup-work-shape';
import { STOP_EVIDENCE_PAGE_SIZE } from '../src/platform/pickup-work/use-pickup-work-queries';

/**
 * The guards that judge the answers of the screens of the door and the failure (`src/platform/pickup-work/pickup-work-shape.ts`) are runtime checks, not a second description of the wire:
 * the types are the generated ones. This test reads the contract and holds each guard to it, as `manifest-contract.test.ts` does for the manifest screens: every field a guard reads is a
 * field of its schema, every field the contract requires of an answer is one the guard requires, and every value of an enumeration a guard recognises is one the contract has (and the other
 * way round). The permission of each operation, the headers each act sends, the filters each list takes and the body each act carries are held to the contract's.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Schema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly (string | null)[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly allOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
  readonly $ref?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly format?: string;
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
  readonly parameters?: readonly (Parameter | undefined)[];
  readonly requestBody?: { content: { 'application/json': { schema: Schema } } };
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema>; parameters: Record<string, Parameter> };
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

/** A parameter of an operation, whether it is written there or shared (`$ref`). */
function parameterOf(operationId: string, name: string): Parameter | undefined {
  for (const each of operationNamed(operationId).parameters ?? []) {
    if (each === undefined) continue;
    const parameter =
      each.$ref === undefined
        ? each
        : document.components.parameters[each.$ref.split('/').at(-1) ?? ''];
    if (parameter?.name === name) return parameter;
  }
  return undefined;
}

/** The body of an act, flattened: what it requires and the members it has. */
function bodyOf(operationId: string): { properties: Record<string, Schema>; required: string[] } {
  const schema = operationNamed(operationId).requestBody?.content['application/json'].schema;
  if (schema === undefined) throw new Error(`${operationId} takes no body`);
  return flattened(schema);
}

describe.each(Object.entries(PICKUP_WORK_FIELDS))(
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

describe('the members of the nested answers and the contract', () => {
  // Break caught: the escalation read with a member the contract does not state, or its three actors changed without the page knowing.
  it('has an escalation of `by`, `threshold_hours` and `waited_seconds`, the first of PERSON, BACKSTOP and UNKNOWN', () => {
    const escalation = schemaNamed('PickupFailureQueueItem').properties.escalation;
    expect(escalation?.type).toEqual(['object', 'null']);
    expect([...(escalation?.required ?? [])].toSorted()).toEqual([
      'by',
      'threshold_hours',
      'waited_seconds',
    ]);
    expect(escalation?.additionalProperties).toBe(false);
    expect(valuesOf(escalation?.properties?.by).toSorted()).toEqual([
      'BACKSTOP',
      'PERSON',
      'UNKNOWN',
    ]);
    expect(escalation?.properties?.threshold_hours).toMatchObject({
      type: ['integer', 'null'],
      minimum: 1,
    });
    expect(escalation?.properties?.waited_seconds).toMatchObject({
      type: ['integer', 'null'],
      minimum: 0,
    });
  });

  // Break caught: the progress of the photos read with a member the contract does not state (the page works out none of it).
  it('has a progress of `declared`, `stored`, `pending` and `expired`, whole numbers from zero', () => {
    const progress = schemaNamed('StopEvidenceList').properties.parcel_photos;
    expect([...(progress?.required ?? [])].toSorted()).toEqual([
      'declared',
      'expired',
      'pending',
      'stored',
    ]);
    expect(progress?.additionalProperties).toBe(false);
    for (const member of ['declared', 'stored', 'pending', 'expired']) {
      expect(progress?.properties?.[member], member).toMatchObject({ type: 'integer', minimum: 0 });
    }
  });

  // Break caught: a stop's evidence read without the exception that the page tells who, when and why from.
  it('has the exception of a stop as a ParcelPhotoException or null', () => {
    const exception = schemaNamed('StopEvidenceList').properties.parcel_photo_exception;
    expect(exception?.oneOf).toEqual([
      { $ref: '#/components/schemas/ParcelPhotoException' },
      { type: 'null' },
    ]);
  });

  // Break caught: an item that carries an address or an object key (the closed projection of the contract is what the page may rely on).
  it('has an evidence item with no address, object key or signed operation', () => {
    const names = Object.keys(schemaNamed('StopEvidenceItem').properties);
    expect(names.toSorted()).toEqual(
      [
        'captured_at',
        'content_type',
        'id',
        'purpose',
        'scanned_clean',
        'state',
        'uploaded_at',
      ].toSorted(),
    );
  });

  // Break caught: the authorization drawn with a header or a method the page's `<img>` could not send.
  it('has an authorization with a method, an address, an expiry and optional headers', () => {
    const authorization = schemaNamed('EvidenceRetrievalAuthorization');
    expect(Object.keys(authorization.properties).toSorted()).toEqual([
      'expires_at',
      'headers',
      'method',
      'url',
    ]);
    expect(authorization.required.toSorted()).toEqual(['expires_at', 'method', 'url']);
  });
});

describe('the permission and the headers of each operation', () => {
  const headersOf = (operationId: string): string[] =>
    (operationNamed(operationId).parameters ?? [])
      .map((parameter) => parameter?.$ref?.split('/').at(-1))
      .filter((name): name is string => name === 'IdempotencyKey' || name === 'IfMatch')
      .toSorted();

  // Break caught: an act sent with a key its operation does not take, or with a version that it does not declare (pickup-work-commands.ts says which).
  it.each([
    ['authoriseHandshakeOverride', ['IdempotencyKey']],
    ['resolveHandshake', ['IdempotencyKey']],
    ['authoriseParcelPhotoException', ['IdempotencyKey']],
    ['createEvidenceRetrievalAuthorization', []],
    ['listPickupFailures', []],
    ['listHandshakesForOps', []],
    ['listCollectionShortfalls', []],
    ['listCollectionDisputes', []],
    ['listPickupStopEvidence', []],
  ])('has %s sending %j', (operationId, expected) => {
    expect(headersOf(operationId)).toEqual(expected);
  });

  // Break caught: a page offering an act to a key other than the one its operation needs (the server checks it again; this is the hint).
  it.each([
    ['listPickupFailures', 'pickup.failure.resolve'],
    ['listHandshakesForOps', 'pickup.handshake.override'],
    ['listCollectionShortfalls', 'pickup.handshake.override'],
    ['listCollectionDisputes', 'pickup.read'],
    ['listPickupStopEvidence', 'pickup.read'],
    ['authoriseHandshakeOverride', 'pickup.handshake.override'],
    ['resolveHandshake', 'pickup.handshake.resolve'],
    ['authoriseParcelPhotoException', 'pickup.handshake.override'],
    // The authorization of a photo is the read of the stop it belongs to: it names `owner`, and the stop's read is `pickup.read`.
    ['createEvidenceRetrievalAuthorization', 'owner'],
  ])('has %s behind %s', (operationId, permission) => {
    expect(operationNamed(operationId)['x-permission']).toBe(permission);
  });
});

describe('the filters of the lists and the contract', () => {
  const lists = [
    'listPickupFailures',
    'listHandshakesForOps',
    'listCollectionShortfalls',
    'listCollectionDisputes',
  ] as const;

  // Break caught: the page sending a filter under a name the list does not have (it would be ignored, and the list would pass for filtered).
  it.each(lists)('has %s taking `open`, `hub_id`, `page_size` and `page_token`', (operationId) => {
    expect(parameterOf(operationId, 'open')).toMatchObject({
      in: 'query',
      schema: { type: 'boolean' },
    });
    expect(parameterOf(operationId, 'hub_id')).toMatchObject({
      in: 'query',
      schema: { type: 'string', format: 'uuid' },
    });
    expect(parameterOf(operationId, 'page_token')).toMatchObject({
      in: 'query',
      schema: { type: 'string' },
    });
    for (const name of ['open', 'hub_id', 'page_token']) {
      expect(parameterOf(operationId, name)?.required ?? false, name).toBe(false);
    }
  });

  // Break caught: the page believing a longer page than the contract allows (a guard that accepts more would pass an answer that is not the API's).
  it('has a page of at most the number of items the guards accept', () => {
    for (const operationId of [...lists, 'listPickupStopEvidence'] as const) {
      expect(parameterOf(operationId, 'page_size')?.schema, operationId).toMatchObject({
        type: 'integer',
        minimum: 1,
        maximum: MAX_PAGE_ITEMS,
      });
    }
    expect(STOP_EVIDENCE_PAGE_SIZE).toBeLessThanOrEqual(MAX_PAGE_ITEMS);
  });

  // Break caught: the evidence read narrowed by a purpose the contract does not have, or the contract adding one the page never knows.
  it('has an evidence list narrowed by the purposes the page knows', () => {
    const purpose = parameterOf('listPickupStopEvidence', 'purpose');
    expect(purpose).toMatchObject({ in: 'query', schema: { type: 'string' } });
    expect(purpose?.required ?? false).toBe(false);
    expect([...EVIDENCE_PURPOSES].toSorted()).toEqual(valuesOf(purpose?.schema).toSorted());
  });

  // Break caught: a refused filter told in words the contract does not promise: it must be a `VALIDATION_FAILED`.
  it.each([...lists, 'listPickupStopEvidence'] as const)(
    'has %s refusing a value that is not one with VALIDATION_FAILED',
    (operationId) => {
      expect(operationNamed(operationId)['x-error-codes']).toContain('VALIDATION_FAILED');
    },
  );
});

describe('the bodies of the acts and the contract', () => {
  // Break caught: the override sent under a name the schema does not have (the server would refuse it whole, and the note would never be recorded).
  it('has an override that takes its reason as `verification_note`, and nothing else', () => {
    const body = bodyOf('authoriseHandshakeOverride');
    expect(body.required).toEqual(['verification_note']);
    expect(Object.keys(body.properties)).toEqual(['verification_note']);
  });

  // Break caught: the exception sent with a field the operation does not take.
  it('has the exception taking a note and nothing else', () => {
    const body = bodyOf('authoriseParcelPhotoException');
    expect(body.required).toEqual(['note']);
    expect(Object.keys(body.properties)).toEqual(['note']);
  });

  // Break caught: the resolution sent under another name for its note, or the contract making the evidence it may carry mandatory (the form attaches none: the portal has no upload).
  it('has the resolution requiring its note alone, with evidence that it may carry and the form does not', () => {
    const body = bodyOf('resolveHandshake');
    expect(body.required).toEqual(['note']);
    expect(Object.keys(body.properties).toSorted()).toEqual(['evidence_ids', 'note']);
  });

  // Break caught: a refusal of a missing note that the page words as something else (the note is the one mandatory field of each act).
  it.each(['authoriseHandshakeOverride', 'resolveHandshake', 'authoriseParcelPhotoException'])(
    'has %s refusing a missing note with REASON_REQUIRED',
    (operationId) => {
      expect(operationNamed(operationId)['x-error-codes']).toContain('REASON_REQUIRED');
    },
  );

  // Break caught: an act that the page offers to a handshake it cannot settle, with a refusal in words the table does not have.
  it.each(['authoriseHandshakeOverride', 'resolveHandshake'])(
    'has %s refusing a count that was not recorded with COLLECTION_NOT_RECORDED',
    (operationId) => {
      expect(operationNamed(operationId)['x-error-codes']).toContain('COLLECTION_NOT_RECORDED');
    },
  );
});
