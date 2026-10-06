import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { compareSchemas } from './compare-schemas.js';
import type { FindingCode } from './findings.js';
import { createModel } from './schema-normalizer.js';

// Ajv is a CommonJS package; the validator loads it the same way (see contract-validator.ts).
const { Ajv2020 } = createRequire(import.meta.url)('ajv/dist/2020.js') as {
  Ajv2020: typeof import('ajv/dist/2020.js').Ajv2020;
};

/** Compares two schemas written as plain JSON, the first being the contract and the second the code. */
function drift(
  expected: unknown,
  actual: unknown,
  documents: { expected?: object; actual?: object } = {},
) {
  const contract = createModel((documents.expected ?? {}) as never);
  const implementation = createModel((documents.actual ?? {}) as never);
  return compareSchemas(contract.normalize(expected), implementation.normalize(actual), 'body');
}

const codes = (findings: readonly { code: FindingCode }[]) =>
  findings.map((finding) => finding.code);

describe('schemas that say the same thing', () => {
  // Break caught: a comparison that reports a difference where there is none, which would be switched off
  // within a week. Each case is a different way of writing the same schema.
  it.each([
    ['identical schemas', { type: 'string' }, { type: 'string' }],
    ['nullable written two ways', { type: 'string', nullable: true }, { type: ['null', 'string'] }],
    [
      'required and enum in another order',
      { type: 'object', required: ['a', 'b'], properties: { a: { enum: ['X', 'Y'] }, b: {} } },
      { type: 'object', required: ['b', 'a'], properties: { b: {}, a: { enum: ['Y', 'X'] } } },
    ],
    [
      'prose that differs',
      { type: 'string', description: 'the contract says this' },
      { type: 'string', description: 'the code says something else', example: 'x' },
    ],
    [
      'an open object written two ways',
      { type: 'object' },
      { type: 'object', additionalProperties: true },
    ],
  ])('reports nothing for %s', (_label, expected, actual) => {
    expect(drift(expected, actual)).toEqual([]);
  });

  it('reports nothing when a shape is named differently on the two sides', () => {
    const shape = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
    const findings = drift(
      { $ref: '#/components/schemas/Order' },
      { $ref: '#/components/schemas/OrderDto' },
      {
        expected: { components: { schemas: { Order: shape } } },
        actual: { components: { schemas: { OrderDto: shape } } },
      },
    );
    expect(findings).toEqual([]);
  });
});

describe('drift in a field a client relies on', () => {
  // Break caught: a field the contract requires becoming optional in the code (or the reverse). Clients
  // generated from the contract rely on it being present.
  it('reports a required field that is no longer required, and one that newly is', () => {
    const contract = { type: 'object', required: ['a', 'b'], properties: { a: {}, b: {}, c: {} } };
    const code = { type: 'object', required: ['a', 'c'], properties: { a: {}, b: {}, c: {} } };

    const findings = drift(contract, code);

    expect(codes(findings)).toEqual(['SCHEMA_REQUIRED']);
    expect(findings[0]?.at).toBe('body');
    expect(findings[0]?.message).toContain('"b"');
    expect(findings[0]?.message).toContain('"c"');
    expect(findings[0]?.expected).toEqual(['a', 'b']);
    expect(findings[0]?.actual).toEqual(['a', 'c']);
  });

  // Break caught: an enum value added, removed, or the restriction dropped altogether. The contract's
  // enums are closed on purpose (errors-and-enums.md): an extra value is a new state nobody approved.
  it.each([
    ['a value removed', { type: 'string', enum: ['A', 'B'] }, { type: 'string', enum: ['A'] }],
    [
      'a value added',
      { type: 'string', enum: ['A', 'B'] },
      { type: 'string', enum: ['A', 'B', 'C'] },
    ],
    ['the restriction dropped', { type: 'string', enum: ['A', 'B'] }, { type: 'string' }],
    ['a restriction invented', { type: 'string' }, { type: 'string', enum: ['A'] }],
  ])('reports an enum with %s', (_label, expected, actual) => {
    const findings = drift(expected, actual);

    expect(codes(findings)).toEqual(['SCHEMA_ENUM']);
    expect(findings[0]?.at).toBe('body');
  });

  it('names the values that differ', () => {
    const [finding] = drift(
      { type: 'string', enum: ['A', 'B'] },
      { type: 'string', enum: ['A', 'C'] },
    );

    expect(finding?.message).toContain('"B"');
    expect(finding?.message).toContain('"C"');
  });

  // Break caught: a type changed, and nullability changed. They are different findings because a field
  // that can suddenly be null breaks a client in a different way from one that changes type.
  it('reports a changed type, and a changed nullability separately', () => {
    expect(codes(drift({ type: 'string' }, { type: 'integer' }))).toEqual(['SCHEMA_TYPE']);
    expect(codes(drift({ type: 'string' }, { type: 'string', nullable: true }))).toEqual([
      'SCHEMA_NULLABLE',
    ]);
    expect(codes(drift({ type: 'string', nullable: true }, { type: 'string' }))).toEqual([
      'SCHEMA_NULLABLE',
    ]);
  });

  // Break caught: a value fixed by `const` (the contract's `count_phase: PRE_COUNT`) changing or being dropped.
  it('reports a fixed value that changed, was dropped or was invented', () => {
    expect(codes(drift({ const: 'PRE_COUNT' }, { const: 'POST_COUNT' }))).toEqual(['SCHEMA_ENUM']);
    expect(codes(drift({ const: 'PRE_COUNT' }, {}))).toEqual(['SCHEMA_ENUM']);
    expect(codes(drift({}, { const: 'PRE_COUNT' }))).toEqual(['SCHEMA_ENUM']);
    expect(drift({ const: 'PRE_COUNT' }, { const: 'PRE_COUNT' })).toEqual([]);
  });

  it('reports a changed format', () => {
    expect(codes(drift({ type: 'string', format: 'uuid' }, { type: 'string' }))).toEqual([
      'SCHEMA_FORMAT',
    ]);
  });

  it('reports a changed limit, naming it', () => {
    const [finding, ...rest] = drift(
      { type: 'string', maxLength: 128, minLength: 1 },
      { type: 'string', maxLength: 255, minLength: 1 },
    );

    expect(rest).toEqual([]);
    expect(finding?.code).toBe('SCHEMA_CONSTRAINT');
    expect(finding?.message).toContain('maxLength');
  });

  it('reports a changed default and a changed read-only flag', () => {
    expect(
      codes(drift({ type: 'boolean', default: false }, { type: 'boolean', default: true })),
    ).toEqual(['SCHEMA_DEFAULT']);
    expect(codes(drift({ type: 'string', readOnly: true }, { type: 'string' }))).toEqual([
      'SCHEMA_ACCESS',
    ]);
  });
});

describe('drift in what an object may contain', () => {
  const closed = {
    type: 'object',
    additionalProperties: false,
    properties: { name: { type: 'string' } },
  };

  // Break caught: the structural rules the contract carries as schema shape. OrderItemize is closed so a
  // client can never set a price; relaxing that in code would let it through with no review.
  it('reports a closed object that the code leaves open, and an open one that it closes', () => {
    const open = { type: 'object', properties: { name: { type: 'string' } } };

    expect(codes(drift(closed, open))).toEqual(['SCHEMA_ADDITIONAL_PROPERTIES']);
    expect(codes(drift(open, closed))).toEqual(['SCHEMA_ADDITIONAL_PROPERTIES']);
  });

  it('reports additional properties given a schema where the contract allows none', () => {
    expect(codes(drift(closed, { ...closed, additionalProperties: { type: 'string' } }))).toEqual([
      'SCHEMA_ADDITIONAL_PROPERTIES',
    ]);
  });

  it('compares the schema of additional properties when both sides give one', () => {
    const withExtra = (type: string) => ({ type: 'object', additionalProperties: { type } });

    expect(drift(withExtra('string'), withExtra('string'))).toEqual([]);
    expect(codes(drift(withExtra('string'), withExtra('integer')))).toEqual(['SCHEMA_TYPE']);
  });

  // Break caught: a property added that the contract does not have. This is the blind count: the pre-count
  // intake has no `rider_declared_count`, and adding it "for the UI" must not pass unnoticed.
  it('reports a property the contract does not have, and one it has that the code lacks', () => {
    const contract = {
      type: 'object',
      properties: { id: { type: 'string' }, state: { type: 'string' } },
    };
    const code = {
      type: 'object',
      properties: { id: { type: 'string' }, rider_declared_count: { type: 'integer' } },
    };

    const findings = drift(contract, code);

    expect(codes(findings).toSorted()).toEqual([
      'SCHEMA_PROPERTY_EXTRA',
      'SCHEMA_PROPERTY_MISSING',
    ]);
    expect(findings.find((f) => f.code === 'SCHEMA_PROPERTY_EXTRA')?.message).toContain(
      'rider_declared_count',
    );
    expect(findings.find((f) => f.code === 'SCHEMA_PROPERTY_MISSING')?.message).toContain(
      '"state"',
    );
  });
});

describe('where a finding points', () => {
  // Break caught: a finding that says something is wrong without saying where, in a schema with hundreds
  // of properties.
  it('gives the path through properties, items and additional properties', () => {
    const wrap = (leaf: object) => ({
      type: 'object',
      properties: {
        lines: { type: 'array', items: { type: 'object', properties: { price: leaf } } },
      },
    });

    const [finding] = drift(wrap({ type: 'integer' }), wrap({ type: 'string' }));

    expect(finding?.at).toBe('body.properties.lines.items.properties.price');
  });

  // Break caught: the checker stopping at the first difference, so fixing one reveals the next.
  it('reports every difference, not just the first', () => {
    const findings = drift(
      {
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' }, b: { type: 'integer' } },
      },
      {
        type: 'object',
        required: [],
        properties: { a: { type: 'integer' }, b: { type: 'string' } },
      },
    );

    expect(codes(findings).toSorted()).toEqual(['SCHEMA_REQUIRED', 'SCHEMA_TYPE', 'SCHEMA_TYPE']);
    expect(findings.map((f) => f.at).toSorted()).toEqual([
      'body',
      'body.properties.a',
      'body.properties.b',
    ]);
  });
});

describe('compositions and rules the comparator does not model', () => {
  // Break caught: a branch of oneOf/anyOf/allOf added or dropped.
  it('reports a changed set of branches', () => {
    expect(
      codes(
        drift(
          { oneOf: [{ type: 'string' }, { type: 'integer' }] },
          { oneOf: [{ type: 'string' }] },
        ),
      ),
    ).toEqual(['SCHEMA_COMPOSITION']);
    expect(codes(drift({ allOf: [{ type: 'object' }] }, {}))).toEqual(['SCHEMA_COMPOSITION']);
  });

  it('does not depend on the order of the branches', () => {
    expect(
      drift(
        { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        { oneOf: [{ type: 'integer' }, { type: 'string' }] },
      ),
    ).toEqual([]);
  });

  // Break caught: a conditional rule dropped or changed. PickupRequestCreate decides what is required from
  // `pickup_intent` with five `if`/`then` pairs, and a code-first description cannot produce them: the
  // check must fail closed rather than pass what it cannot read.
  it('reports a rule it does not model that is missing, extra or changed', () => {
    const conditional = {
      type: 'object',
      if: { properties: { kind: { const: 'A' } } },
      then: { required: ['a'] },
    };

    // A conditional is two keywords, `if` and `then`, and each missing or extra one is its own finding.
    const both = ['SCHEMA_UNMODELLED', 'SCHEMA_UNMODELLED'];
    expect(codes(drift(conditional, { type: 'object' }))).toEqual(both);
    expect(codes(drift({ type: 'object' }, conditional))).toEqual(both);
    expect(codes(drift(conditional, { ...conditional, then: { required: ['b'] } }))).toEqual([
      'SCHEMA_UNMODELLED',
    ]);
    expect(drift(conditional, { ...conditional })).toEqual([]);
  });

  // Break caught: an unreadable construct (here, recursion) passing silently when only one side has it.
  it('reports recursion on only one side, and accepts it on both', () => {
    const tree = (name: string) => ({
      components: {
        schemas: {
          [name]: {
            type: 'object',
            properties: { next: { $ref: `#/components/schemas/${name}` } },
          },
        },
      },
    });

    expect(
      drift(
        { $ref: '#/components/schemas/Node' },
        { $ref: '#/components/schemas/Tree' },
        {
          expected: tree('Node'),
          actual: tree('Tree'),
        },
      ),
    ).toEqual([]);
    expect(
      codes(
        drift(
          { $ref: '#/components/schemas/Node' },
          { type: 'object', properties: { next: { type: 'object' } } },
          { expected: tree('Node') },
        ),
      ),
    ).toEqual(['SCHEMA_SHAPE']);
  });

  it('reports a schema that accepts nothing against one that accepts something', () => {
    expect(codes(drift({ type: 'string' }, false))).toContain('SCHEMA_SHAPE');
  });
});

describe('a repeat or an explicit null that changes what is valid (audit F03)', () => {
  // Break caught: `oneOf` branches treated as a set. `oneOf` means exactly one branch matches, so a string
  // satisfies `oneOf: [string]` and fails `oneOf: [string, string]` (it matches twice). A repeat is a rule.
  it('reports a repeated oneOf branch, in either direction', () => {
    const once = { oneOf: [{ type: 'string' }] };
    const twice = { oneOf: [{ type: 'string' }, { type: 'string' }] };

    expect(codes(drift(once, twice))).toEqual(['SCHEMA_COMPOSITION']);
    expect(codes(drift(twice, once))).toEqual(['SCHEMA_COMPOSITION']);
    expect(drift(twice, twice)).toEqual([]);
  });

  // Break caught: the repeat being counted in `anyOf` and `allOf`, where it changes nothing (any one match
  // is enough, and every branch holding twice is every branch holding).
  it('does not report a repeated anyOf or allOf branch', () => {
    for (const keyword of ['anyOf', 'allOf']) {
      expect(
        drift(
          { [keyword]: [{ type: 'string' }] },
          { [keyword]: [{ type: 'string' }, { type: 'string' }] },
        ),
      ).toEqual([]);
    }
  });

  // Break caught: `const: null` read as no `const` at all, because both came out as null in a comparison.
  // With the first a string is rejected, and with the second it is accepted.
  it('reports a fixed null against no fixed value, in either direction', () => {
    expect(codes(drift({ const: null }, {}))).toEqual(['SCHEMA_ENUM']);
    expect(codes(drift({}, { const: null }))).toEqual(['SCHEMA_ENUM']);
    expect(codes(drift({ const: null }, { const: 'x' }))).toEqual(['SCHEMA_ENUM']);
    expect(drift({ const: null }, { const: null })).toEqual([]);
  });

  it('reports a default of null against no default, in either direction', () => {
    const nullable = { type: ['string', 'null'] };

    expect(codes(drift({ ...nullable, default: null }, nullable))).toEqual(['SCHEMA_DEFAULT']);
    expect(codes(drift(nullable, { ...nullable, default: null }))).toEqual(['SCHEMA_DEFAULT']);
    expect(drift({ ...nullable, default: null }, { ...nullable, default: null })).toEqual([]);
  });

  // The guard behind the three above and every other case of the kind: a pair of schemas that a real JSON
  // Schema validator treats differently on some value must be reported, whatever way the difference is
  // spelt. The samples are chosen to tell each pair apart.
  const AJV = new Ajv2020({ strict: false, allErrors: true, logger: false });
  const accepts = (schema: unknown, value: unknown): boolean =>
    AJV.compile(schema as object)(value);

  const BEHAVIOUR: readonly (readonly [
    label: string,
    before: object,
    after: object,
    samples: unknown[],
  ])[] = [
    [
      'a repeated oneOf branch',
      { oneOf: [{ type: 'string' }] },
      { oneOf: [{ type: 'string' }, { type: 'string' }] },
      ['x'],
    ],
    ['a fixed null dropped', { const: null }, {}, ['x', null]],
    ['a fixed null invented', {}, { const: null }, ['x', null]],
    ['null dropped from an enum', { enum: ['A', null] }, { enum: ['A'] }, ['A', null]],
    ['an enum value dropped', { enum: ['A', 'B'] }, { enum: ['A'] }, ['A', 'B']],
    ['a type widened', { type: 'string' }, { type: ['string', 'integer'] }, ['x', 1]],
    [
      'a limit loosened',
      { type: 'string', maxLength: 2 },
      { type: 'string', maxLength: 3 },
      ['abc'],
    ],
    ['a required property dropped', { required: ['a'] }, {}, [{}]],
    [
      'an object opened',
      { type: 'object', additionalProperties: false },
      { type: 'object' },
      [{ x: 1 }],
    ],
    [
      'a branch of anyOf dropped',
      { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      { anyOf: [{ type: 'string' }] },
      [1],
    ],
    [
      'a rule behind if/then dropped',
      { if: { required: ['a'] }, then: { required: ['b'] } },
      { if: { required: ['a'] } },
      [{ a: 1 }],
    ],
  ];

  it.each(BEHAVIOUR)(
    'reports %s, which a validator can tell apart',
    (_label, before, after, samples) => {
      const differs = samples.some((sample) => accepts(before, sample) !== accepts(after, sample));

      expect(differs, 'the samples must tell the two schemas apart').toBe(true);
      expect(drift(before, after).length).toBeGreaterThan(0);
    },
  );

  // Break caught: the other half of the guard. Schemas a validator cannot tell apart on any value, written
  // differently, must not be reported, or the check is switched off for being noisy.
  it.each([
    [
      'a repeated anyOf branch',
      { anyOf: [{ type: 'string' }] },
      { anyOf: [{ type: 'string' }, { type: 'string' }] },
      ['x', 1],
    ],
    [
      'a repeated allOf branch',
      { allOf: [{ type: 'string' }] },
      { allOf: [{ type: 'string' }, { type: 'string' }] },
      ['x', 1],
    ],
    [
      'oneOf branches reordered',
      { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      { oneOf: [{ type: 'integer' }, { type: 'string' }] },
      ['x', 1, null],
    ],
    ['a repeated enum value', { enum: ['A'] }, { enum: ['A', 'A'] }, ['A', 'B']],
    [
      'nullable written two ways',
      { type: 'string', nullable: true },
      { type: ['null', 'string'] },
      ['x', null, 1],
    ],
  ])('does not report %s', (_label, before, after, samples) => {
    for (const sample of samples) expect(accepts(before, sample)).toBe(accepts(after, sample));
    expect(drift(before, after)).toEqual([]);
  });
});

describe('items', () => {
  it('reports items present on only one side, and compares them when on both', () => {
    expect(codes(drift({ type: 'array' }, { type: 'array', items: { type: 'string' } }))).toEqual([
      'SCHEMA_ITEMS',
    ]);
    expect(codes(drift({ type: 'array', items: { type: 'string' } }, { type: 'array' }))).toEqual([
      'SCHEMA_ITEMS',
    ]);
    expect(
      codes(
        drift(
          { type: 'array', items: { type: 'string' } },
          { type: 'array', items: { type: 'integer' } },
        ),
      ),
    ).toEqual(['SCHEMA_TYPE']);
  });
});
