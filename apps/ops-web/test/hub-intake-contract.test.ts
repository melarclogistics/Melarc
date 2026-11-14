import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { EVIDENCE_FIELDS } from '../src/platform/evidence/evidence-shape';
import {
  ADJUDICATION_OUTCOMES,
  COUNT_PHASES,
  COUNT_VARIANCES,
  FINDING_KINDS,
  HUB_INTAKE_FIELDS,
  INTAKE_CONDITIONS,
  INTAKE_STATES,
  MAX_PAGE_ITEMS,
} from '../src/platform/hub-intake/hub-intake-shape';

/**
 * The guards that judge the answers of the receiving screens (`src/platform/hub-intake/hub-intake-shape.ts`, `src/platform/evidence/evidence-shape.ts`) are runtime checks, not a second description of the
 * wire: the types are the generated ones (apart from the counted shape's two enumerations, which the generator turns into `never`: see the shape). This test reads the contract and holds each guard to it, as
 * `pickup-work-contract.test.ts` does for the screens of the door: every field a guard reads is a field of its schema, every field the contract requires of an answer is one the guard requires, and every value of
 * an enumeration a guard recognises is one the contract has. **And the blind count is held to the contract's own words**: the schema of an intake that has not been counted has no member of the counted shape, the
 * body of the count has the physical count and nothing else, and the permission, the headers and the refusals of each operation are the ones the screens rely on.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Schema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly (string | null)[];
  readonly const?: string;
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly allOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
  readonly $ref?: string;
  readonly minimum?: number;
  readonly additionalProperties?: boolean;
  readonly description?: string;
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
  readonly security?: readonly Record<string, unknown>[];
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
    for (const each of part.allOf ?? []) take(each);
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

function bodyOf(operationId: string): {
  properties: Record<string, Schema>;
  required: string[];
  closed: boolean;
} {
  const schema = operationNamed(operationId).requestBody?.content['application/json'].schema;
  if (schema === undefined) throw new Error(`${operationId} takes no body`);
  const resolved =
    schema.$ref === undefined
      ? schema
      : (document.components.schemas[schema.$ref.split('/').at(-1) ?? ''] ?? schema);
  return { ...flattened(schema), closed: resolved.additionalProperties === false };
}

describe.each(Object.entries(HUB_INTAKE_FIELDS))(
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

describe('the guard of the evidence answers and the contract', () => {
  // The portal reads a few members of the record and the whole of the instruction: it requires only what the contract requires, and for the instruction every member the contract requires.
  it.each(Object.entries(EVIDENCE_FIELDS))(
    'reads only fields of %s, and requires only what the contract requires',
    (name, fields) => {
      const schema = schemaNamed(name);
      for (const field of [...fields.required, ...fields.optional]) {
        expect(Object.keys(schema.properties), field).toContain(field);
      }
      for (const field of fields.required) expect(schema.required, field).toContain(field);
      if (name === 'EvidenceUploadInstruction') {
        for (const field of schema.required) expect(fields.required, field).toContain(field);
      }
      const enums: Record<string, readonly string[]> = fields.enums;
      for (const [field, values] of Object.entries(enums)) {
        expect([...values].toSorted(), field).toEqual(
          valuesOf(schema.properties[field]).toSorted(),
        );
      }
    },
  );

  // Break caught: an upload instruction the portal reads without the form a `POST` would need: the guard refuses `form_fields`, so the contract has to keep them optional and apart from the headers.
  it('has an instruction with a method, an address and an expiry, and optional headers and form fields', () => {
    const instruction = schemaNamed('EvidenceUploadInstruction');
    expect(instruction.required.toSorted()).toEqual(['expires_at', 'method', 'url']);
    expect(Object.keys(instruction.properties).toSorted()).toEqual([
      'expires_at',
      'form_fields',
      'headers',
      'method',
      'url',
    ]);
  });

  // Break caught: the declaration sent for an owner or a purpose the contract does not have, or with a member it does not take.
  it('declares evidence of an intake with the owner and the purposes the screens use, and nothing else', () => {
    const body = bodyOf('createEvidence');
    expect(body.closed).toBe(true);
    expect(body.required.toSorted()).toEqual(
      [
        'byte_size',
        'captured_at',
        'checksum_sha256',
        'content_type',
        'owner_id',
        'owner_type',
        'purpose',
      ].toSorted(),
    );
    expect(valuesOf(body.properties.owner_type)).toContain('PICKUP_INTAKE');
    expect(valuesOf(body.properties.purpose)).toEqual(expect.arrayContaining(['CONDITION', 'OSD']));
    expect(body.properties.byte_size).toMatchObject({ type: 'integer', minimum: 1 });
  });
});

describe('the blind count and the contract', () => {
  // Break caught: the contract giving an intake that has not been counted a member of the counted shape (the guard refuses an answer that carries one, and this is the promise it relies on).
  it('has an intake that has not been counted with no member of the counted shape', () => {
    const pre = schemaNamed('HubIntakePreCount');
    for (const member of [
      'rider_declared_count',
      'physical_count',
      'count_variance',
      'count_difference',
      'condition',
      'condition_findings',
      'dispute_state',
      'parcel_photo_ids',
    ]) {
      expect(Object.keys(pre.properties), member).not.toContain(member);
    }
    const post = schemaNamed('HubIntakePostCount');
    for (const member of [
      'rider_declared_count',
      'physical_count',
      'count_variance',
      'condition',
    ]) {
      expect(post.required, member).toContain(member);
    }
  });

  // Break caught: the count's body widened (a declaration in it would be accepted, or refused for another reason), or the physical count made optional or negative.
  it('has the body of the count carrying the physical count and nothing else', () => {
    const body = bodyOf('submitBlindCount');
    expect(body.closed).toBe(true);
    expect(body.required).toEqual(['physical_count']);
    expect(Object.keys(body.properties)).toEqual(['physical_count']);
    expect(body.properties.physical_count).toMatchObject({ type: 'integer', minimum: 0 });
  });

  // Break caught: a list or a read that stops telling a counted intake from one that has not been counted (the page tells them apart by this member alone).
  it('has the intake told counted or not by `count_phase`, in the list, the read and the lock', () => {
    for (const operationId of ['listHubIntakes', 'getHubIntake', 'acquireIntakeLock']) {
      const text = JSON.stringify(operationNamed(operationId));
      expect(text, operationId).toContain('HubIntakePreCount');
      expect(text, operationId).toContain('HubIntakePostCount');
      expect(text, operationId).toContain('count_phase');
    }
    expect([...COUNT_PHASES].toSorted()).toEqual(['POST_COUNT', 'PRE_COUNT']);
  });

  // Break caught: the findings of an intake read with kinds or members the contract does not describe (the contract leaves the member open and states its shape in its description).
  it('describes the findings as the guard reads them', () => {
    const findings = schemaNamed('HubIntakePostCount').properties.condition_findings;
    expect(findings?.type).toBe('array');
    const text = findings?.description ?? '';
    for (const word of [
      ...FINDING_KINDS,
      'id',
      'kind',
      'condition',
      'outcome',
      'note',
      'evidence_ids',
      'recorded_by',
      'recorded_at',
    ]) {
      expect(text, word).toContain(word);
    }
  });

  // Break caught: the two phases changing under the page (it tells a counted intake from one that has not been counted by this member alone), or the schemas no longer fixing theirs.
  it('has the two phases, each fixed by its own schema', () => {
    expect([...COUNT_PHASES].toSorted()).toEqual(
      valuesOf(schemaNamed('HubIntakeBase').properties.count_phase).toSorted(),
    );
    expect(schemaNamed('HubIntakePreCount').properties.count_phase?.const).toBe('PRE_COUNT');
    expect(schemaNamed('HubIntakePostCount').properties.count_phase?.const).toBe('POST_COUNT');
  });

  // Break caught: the enumerations of the counted shape drifting from the lists the guard holds (the generator gives them no type: this test is the only thing that holds them).
  it('has the variance and the condition as the guard lists them', () => {
    const post = schemaNamed('HubIntakePostCount');
    expect([...COUNT_VARIANCES].toSorted()).toEqual(
      valuesOf(post.properties.count_variance).toSorted(),
    );
    expect([...INTAKE_CONDITIONS].toSorted()).toEqual(
      valuesOf(post.properties.condition).toSorted(),
    );
    expect([...INTAKE_STATES].toSorted()).toEqual(valuesOf(post.properties.state).toSorted());
  });
});

describe('the permission, the headers and the refusals of each operation', () => {
  const headersOf = (operationId: string): string[] =>
    (operationNamed(operationId).parameters ?? [])
      .map((parameter) => parameter?.$ref?.split('/').at(-1))
      .filter((name): name is string => name === 'IdempotencyKey' || name === 'IfMatch')
      .toSorted();

  // Break caught: an act sent with a key its operation does not take, or with a version it does not declare (hub-intake-commands.ts says which).
  it.each([
    ['acquireIntakeLock', []],
    ['submitBlindCount', ['IdempotencyKey', 'IfMatch']],
    ['recordIntakeCondition', ['IdempotencyKey', 'IfMatch']],
    ['adjudicateDiscrepancy', ['IfMatch']],
    ['createEvidence', ['IdempotencyKey']],
    ['completeEvidenceUpload', ['IfMatch']],
    ['listHubIntakes', []],
    ['getHubIntake', []],
  ])('has %s sending %j', (operationId, expected) => {
    expect(headersOf(operationId)).toEqual(expected);
  });

  // Break caught: an act offered to a key other than the one its operation needs, or the adjudication offered to the key Ops Staff hold (the server checks it again; this is the hint).
  it.each([
    ['listHubIntakes', 'hub.read'],
    ['getHubIntake', 'hub.read'],
    ['acquireIntakeLock', 'hub.intake.count'],
    ['submitBlindCount', 'hub.intake.count'],
    ['recordIntakeCondition', 'hub.intake.count'],
    ['adjudicateDiscrepancy', 'hub.osd.adjudicate'],
    // Evidence holds no authority of its own: the key is the act it is about (`owner`).
    ['createEvidence', 'owner'],
    ['completeEvidenceUpload', 'owner'],
  ])('has %s behind %s', (operationId, permission) => {
    expect(operationNamed(operationId)['x-permission']).toBe(permission);
  });

  // Break caught: the words of a refusal that the table has and the contract does not promise: each refusal the screens word is a code its operation declares.
  it.each([
    [
      'submitBlindCount',
      [
        'STATE_CONFLICT',
        'VALIDATION_FAILED',
        'NOT_FOUND',
        'HUB_SCOPE_VIOLATION',
        'PERMISSION_DENIED',
      ],
    ],
    [
      'recordIntakeCondition',
      [
        'STATE_CONFLICT',
        'REASON_REQUIRED',
        'EVIDENCE_NOT_STORED',
        'VALIDATION_FAILED',
        'NOT_FOUND',
      ],
    ],
    [
      'adjudicateDiscrepancy',
      [
        'STATE_CONFLICT',
        'REASON_REQUIRED',
        'EVIDENCE_NOT_STORED',
        'INSUFFICIENT_AUTHORITY',
        'PERMISSION_DENIED',
      ],
    ],
    ['acquireIntakeLock', ['NOT_FOUND', 'HUB_SCOPE_VIOLATION', 'PERMISSION_DENIED']],
    ['createEvidence', ['STATE_CONFLICT', 'VALIDATION_FAILED', 'NOT_FOUND', 'PERMISSION_DENIED']],
    [
      'completeEvidenceUpload',
      ['EVIDENCE_UPLOAD_EXPIRED', 'VALIDATION_FAILED', 'NOT_FOUND', 'STATE_CONFLICT'],
    ],
    ['getHubIntake', ['NOT_FOUND', 'HUB_SCOPE_VIOLATION', 'PERMISSION_DENIED']],
  ])('has %s declaring the codes the screens word', (operationId, codes) => {
    expect(operationNamed(operationId)['x-error-codes']).toEqual(expect.arrayContaining(codes));
  });
});

describe('the list and the bodies of the acts and the contract', () => {
  // Break caught: the page sending a filter under a name the list does not have, or sending a hub the list does not take (the queue says it is not narrowed by the hub switcher, and this holds why).
  it('has the list taking `state`, `page_size` and `page_token` and no hub', () => {
    expect(parameterOf('listHubIntakes', 'state')).toMatchObject({ in: 'query' });
    expect(valuesOf(parameterOf('listHubIntakes', 'state')?.schema).toSorted()).toEqual(
      [...INTAKE_STATES].toSorted(),
    );
    expect(parameterOf('listHubIntakes', 'page_token')).toMatchObject({ in: 'query' });
    for (const name of ['state', 'page_token']) {
      expect(parameterOf('listHubIntakes', name)?.required ?? false, name).toBe(false);
    }
    expect(parameterOf('listHubIntakes', 'hub_id')).toBeUndefined();
  });

  // Break caught: the page believing a longer page than the contract allows.
  it('has a page of at most the number of items the guard accepts', () => {
    expect(parameterOf('listHubIntakes', 'page_size')?.schema).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: MAX_PAGE_ITEMS,
    });
  });

  // Break caught: the condition sent under names the schema does not have, or the contract making evidence mandatory for every condition.
  it('has the condition taking a condition, a note and evidence, the condition alone required', () => {
    const body = bodyOf('recordIntakeCondition');
    expect(body.closed).toBe(true);
    expect(body.required).toEqual(['condition']);
    expect(Object.keys(body.properties).toSorted()).toEqual(['condition', 'evidence_ids', 'note']);
    expect(valuesOf(body.properties.condition).toSorted()).toEqual(
      [...INTAKE_CONDITIONS].toSorted(),
    );
  });

  // Break caught: the adjudication sent under other names, a reason that is optional, or an outcome the page does not offer.
  it('has the adjudication taking an outcome and a reason, with a condition and evidence it may carry', () => {
    const body = bodyOf('adjudicateDiscrepancy');
    expect(body.closed).toBe(true);
    expect(body.required.toSorted()).toEqual(['note', 'outcome']);
    expect(Object.keys(body.properties).toSorted()).toEqual([
      'condition',
      'evidence_ids',
      'note',
      'outcome',
    ]);
    expect(valuesOf(body.properties.outcome).toSorted()).toEqual(
      [...ADJUDICATION_OUTCOMES].toSorted(),
    );
    expect(body.properties.note).toMatchObject({ type: 'string', minLength: 1 });
    expect(valuesOf(body.properties.condition).toSorted()).toEqual(
      [...INTAKE_CONDITIONS].toSorted(),
    );
  });

  // Break caught: the lock taking a body or a header the page does not send.
  it('has the lock taking no body', () => {
    expect(operationNamed('acquireIntakeLock').requestBody).toBeUndefined();
  });
});
