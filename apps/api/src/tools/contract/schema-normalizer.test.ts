import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../platform/contract/json.js';
import { ContractModelError, createModel } from './schema-normalizer.js';

/** A document with a few components, so references have something to resolve to. */
const DOCUMENT = {
  openapi: '3.1.0',
  components: {
    schemas: {
      Money: {
        type: 'object',
        required: ['currency', 'amount_minor'],
        properties: {
          amount_minor: { type: 'integer' },
          currency: { type: 'string', enum: ['GHS'] },
        },
      },
      Alias: { $ref: '#/components/schemas/Money' },
      Node: {
        type: 'object',
        properties: { next: { $ref: '#/components/schemas/Node' }, label: { type: 'string' } },
      },
      'Weird~Name/With': { type: 'string' },
    },
  },
};

const model = createModel(DOCUMENT);
const normalize = (schema: unknown) => model.normalize(schema);

describe('types and nullability', () => {
  // Break caught: a schema's type reported differently for the same meaning, so the same contract
  // would differ from itself depending on which spelling a generator happens to emit.
  it('reads a single type and a list of types the same way', () => {
    expect(normalize({ type: 'string' })).toEqual({ types: ['string'] });
    expect(normalize({ type: ['string'] })).toEqual({ types: ['string'] });
  });

  // Break caught: the two nullable spellings being treated as different. The contract wrote 58 properties with the
  // 3.0 `nullable: true` inside a 3.1 document until audit C02 gave them a type list, and Nest still emits the
  // 3.0 one, so the code's description and the contract's must compare equal either way.
  it('treats `nullable: true` and a type list with "null" as the same thing', () => {
    const viaKeyword = normalize({ type: 'string', nullable: true });
    const viaList = normalize({ type: ['string', 'null'] });

    expect(viaKeyword).toEqual(viaList);
    expect(viaKeyword).toEqual({ types: ['null', 'string'] });
  });

  it('ignores `nullable: false`', () => {
    expect(normalize({ type: 'string', nullable: false })).toEqual({ types: ['string'] });
  });

  // Break caught: the order of a type list mattering.
  it('does not depend on the order of the types', () => {
    expect(normalize({ type: ['null', 'integer', 'string'] })).toEqual(
      normalize({ type: ['string', 'integer', 'null'] }),
    );
  });
});

describe('sets that carry no order', () => {
  // Break caught: a reordered `required` or `enum` reported as drift, which would make the check noisy
  // enough to be switched off.
  it('compares `required` and `enum` as sets', () => {
    const one = normalize({ type: 'object', required: ['b', 'a'], properties: { a: {}, b: {} } });
    const two = normalize({ type: 'object', required: ['a', 'b'], properties: { b: {}, a: {} } });
    expect(one).toEqual(two);
    expect(canonicalJson(one as never)).toBe(canonicalJson(two as never));

    expect(normalize({ enum: ['B', 'A', 'C'] })).toEqual(normalize({ enum: ['C', 'A', 'B'] }));
  });

  // Break caught: duplicates in a set being counted as a difference.
  it('ignores a repeated value in `required` or `enum`', () => {
    expect(normalize({ required: ['a', 'a'] })).toEqual(normalize({ required: ['a'] }));
    expect(normalize({ enum: ['A', 'A'] })).toEqual(normalize({ enum: ['A'] }));
  });

  // Break caught: `oneOf`/`anyOf` branches compared by position.
  it('compares the branches of `oneOf` and `anyOf` as sets', () => {
    const first = normalize({ oneOf: [{ type: 'string' }, { type: 'integer' }] });
    const second = normalize({ oneOf: [{ type: 'integer' }, { type: 'string' }] });
    expect(first).toEqual(second);
    expect(normalize({ anyOf: [{ type: 'string' }] })).not.toEqual(
      normalize({ oneOf: [{ type: 'string' }] }),
    );
  });

  // Break caught (audit F03): a repeated `oneOf` branch dropped as a duplicate. Exactly one branch must match,
  // so [string, string] accepts no string at all, and it is not the same schema as [string].
  it('keeps a repeated branch of `oneOf`, and collapses one of `anyOf` and `allOf`', () => {
    const branch = { type: 'string' };

    expect(normalize({ oneOf: [branch, branch] }).oneOf).toHaveLength(2);
    expect(normalize({ oneOf: [branch, branch] })).not.toEqual(normalize({ oneOf: [branch] }));
    expect(normalize({ anyOf: [branch, branch] })).toEqual(normalize({ anyOf: [branch] }));
    expect(normalize({ allOf: [branch, branch] })).toEqual(normalize({ allOf: [branch] }));
  });

  // Break caught: the order of repeated `oneOf` branches mattering. Reordered, they are the same rule.
  it('still ignores the order of `oneOf` branches when some repeat', () => {
    const a = { type: 'string' };
    const b = { type: 'integer' };

    expect(normalize({ oneOf: [a, b, a] })).toEqual(normalize({ oneOf: [a, a, b] }));
  });
});

describe('what is ignored', () => {
  // Break caught: prose, examples and vendor extensions inside a schema being compared. Rewording a
  // description is not a contract change.
  it('ignores descriptions, titles, examples and x- extensions', () => {
    const plain = normalize({ type: 'string', format: 'uuid' });
    const decorated = normalize({
      type: 'string',
      format: 'uuid',
      description: 'prose',
      title: 'T',
      example: 'x',
      examples: ['y'],
      externalDocs: { url: 'https://example.test' },
      'x-anything': { a: 1 },
      deprecated: false,
    });
    expect(decorated).toEqual(plain);
  });
});

describe('properties and additionalProperties', () => {
  // Break caught: a property map flattened or reordered. Names are the contract.
  it('normalizes every property, whatever order they are written in', () => {
    const schema = normalize({
      type: 'object',
      properties: { b: { type: 'string', nullable: true }, a: { type: 'integer' } },
    });
    expect(schema).toEqual({
      types: ['object'],
      properties: { a: { types: ['integer'] }, b: { types: ['null', 'string'] } },
    });
  });

  // Break caught: "open" and "closed" being indistinguishable. `additionalProperties: false` is how the
  // contract makes a rule structural (OrderItemize accepts no price); an implementation that relaxes it
  // must differ from the contract.
  it('tells an open object from a closed one, and absence from `true`', () => {
    expect(normalize({ type: 'object' })).toEqual(
      normalize({ type: 'object', additionalProperties: true }),
    );
    expect(normalize({ type: 'object', additionalProperties: false })).toEqual({
      types: ['object'],
      additionalProperties: 'closed',
    });
    expect(normalize({ type: 'object', additionalProperties: false })).not.toEqual(
      normalize({ type: 'object' }),
    );
    expect(normalize({ type: 'object', additionalProperties: { type: 'string' } })).toEqual({
      types: ['object'],
      additionalProperties: { types: ['string'] },
    });
  });

  it('reads an empty `additionalProperties` schema as open', () => {
    expect(normalize({ type: 'object', additionalProperties: {} })).toEqual(
      normalize({ type: 'object' }),
    );
  });
});

describe('references', () => {
  // Break caught: a reference left as a name, which would make two documents that name the same shape
  // differently (the contract's `Money`, the implementation's `MoneyDto`) always differ.
  it('replaces a reference with what it points to, so names do not matter', () => {
    const viaRef = normalize({ $ref: '#/components/schemas/Money' });
    expect(viaRef).toEqual(normalize(DOCUMENT.components.schemas.Money));
    expect(viaRef.required).toEqual(['amount_minor', 'currency']);
  });

  it('follows a chain of references', () => {
    expect(normalize({ $ref: '#/components/schemas/Alias' })).toEqual(
      normalize({ $ref: '#/components/schemas/Money' }),
    );
  });

  it('resolves a reference nested in properties, items and compositions', () => {
    const money = normalize({ $ref: '#/components/schemas/Money' });
    const nested = normalize({
      type: 'object',
      properties: {
        total: { $ref: '#/components/schemas/Money' },
        lines: { type: 'array', items: { $ref: '#/components/schemas/Money' } },
        either: { oneOf: [{ $ref: '#/components/schemas/Money' }, { type: 'null' }] },
      },
    });
    expect(nested.properties?.total).toEqual(money);
    expect(nested.properties?.lines?.items).toEqual(money);
    expect(nested.properties?.either?.oneOf).toContainEqual(money);
  });

  // Break caught: unbounded recursion on a schema that refers to itself, which would hang the check.
  it('marks a reference to a schema already being read, instead of looping', () => {
    const node = normalize({ $ref: '#/components/schemas/Node' });

    expect(node.properties?.label).toEqual({ types: ['string'] });
    expect(node.properties?.next).toEqual({ recursive: '#/components/schemas/Node' });
  });

  // Break caught: a rule written beside a reference being lost. OpenAPI 3.1 allows siblings of `$ref`, and a
  // default or limit placed there changes what is valid. Prose beside a reference changes nothing.
  it('keeps a rule written beside a reference, and ignores prose beside one', () => {
    const money = normalize({ $ref: '#/components/schemas/Money' });

    expect(normalize({ $ref: '#/components/schemas/Money', description: 'prose' })).toEqual(money);

    const withDefault = normalize({
      $ref: '#/components/schemas/Money',
      default: { amount_minor: 0, currency: 'GHS' },
    });
    expect(withDefault.allOf).toHaveLength(2);
    expect(withDefault.allOf).toContainEqual(money);
    expect(withDefault.allOf).toContainEqual({ default: { amount_minor: 0, currency: 'GHS' } });
  });

  // Break caught: a pointer written with escaped characters resolving to nothing.
  it('decodes the escapes in a JSON pointer', () => {
    expect(normalize({ $ref: '#/components/schemas/Weird~0Name~1With' })).toEqual({
      types: ['string'],
    });
  });

  // Break caught: a broken or external reference silently becoming "anything", which would let a
  // schema that points nowhere pass for one that matches.
  it.each([
    ['one that points nowhere', '#/components/schemas/Missing'],
    ['one into another file', 'other.yaml#/components/schemas/Money'],
    ['one that is not a pointer', 'Money'],
  ])('refuses %s', (_label, ref) => {
    expect(() => normalize({ $ref: ref })).toThrow(ContractModelError);
  });
});

describe('everything else is compared as it is written', () => {
  // Break caught: a keyword the comparator does not model being skipped, so a conditional or negated rule
  // (PickupRequestCreate carries five `if`/`then` pairs) could be dropped without notice. Unknown means
  // "compare exactly", never "ignore".
  it('keeps keywords it does not model, with their references resolved', () => {
    const schema = normalize({
      type: 'object',
      if: { properties: { kind: { const: 'A' } } },
      then: { required: ['a'], properties: { m: { $ref: '#/components/schemas/Money' } } },
      not: { required: ['forbidden'] },
      discriminator: { propertyName: 'kind' },
    });

    expect(Object.keys(schema.opaque ?? {}).sort()).toEqual(['discriminator', 'if', 'not', 'then']);
    expect(JSON.stringify(schema.opaque?.then)).toContain('"amount_minor"');
    expect(JSON.stringify(schema.opaque?.then)).not.toContain('$ref');
  });

  it('is unaffected by the order of keys inside an unmodelled keyword', () => {
    expect(normalize({ not: { required: ['a'], type: 'object' } })).toEqual(
      normalize({ not: { type: 'object', required: ['a'] } }),
    );
  });
});

describe('constraints and annotations that change meaning', () => {
  // Break caught: a limit changed without notice: a length, a range, a pattern, a minimum item count.
  it('keeps numeric, string, array and object limits', () => {
    expect(
      normalize({
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^a',
        minimum: 0,
        maximum: 5,
        exclusiveMinimum: 0,
        multipleOf: 1,
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
        minProperties: 1,
        maxProperties: 3,
      }).constraints,
    ).toEqual({
      exclusiveMinimum: 0,
      maxItems: 2,
      maxLength: 128,
      maxProperties: 3,
      maximum: 5,
      minItems: 1,
      minLength: 1,
      minProperties: 1,
      minimum: 0,
      multipleOf: 1,
      pattern: '^a',
      uniqueItems: true,
    });
  });

  it('keeps `default`, `const`, `readOnly` and `writeOnly`', () => {
    const schema = normalize({
      type: 'boolean',
      default: false,
      const: false,
      readOnly: true,
      writeOnly: true,
    });
    expect(schema.default).toBe(false);
    expect(schema.const).toBe(false);
    expect(schema.readOnly).toBe(true);
    expect(schema.writeOnly).toBe(true);
  });

  it('keeps `items`, `format` and the composition keywords', () => {
    const schema = normalize({
      type: 'array',
      format: 'x',
      items: { type: 'string' },
      allOf: [{ type: 'array' }],
    });
    expect(schema.items).toEqual({ types: ['string'] });
    expect(schema.format).toBe('x');
    expect(schema.allOf).toEqual([{ types: ['array'] }]);
  });
});

describe('boolean schemas', () => {
  // Break caught: `true` and `false` crashing the normalizer, or reading alike.
  it('reads `true` as anything and `false` as nothing', () => {
    expect(normalize(true)).toEqual({});
    expect(normalize(false)).toEqual({ never: true });
  });

  it('refuses something that is not a schema', () => {
    expect(() => normalize('string')).toThrow(ContractModelError);
    expect(() => normalize([])).toThrow(ContractModelError);
  });
});
