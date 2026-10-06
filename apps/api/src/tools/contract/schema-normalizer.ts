import {
  canonicalize,
  isJsonObject,
  sortedUnique,
  sortedWithRepeats,
  type Json,
  type JsonObject,
} from '../../platform/contract/json.js';

/** The document cannot be read as the model assumes: a reference that goes nowhere, or a schema that is not one. */
export class ContractModelError extends Error {
  override name = 'ContractModelError';
}

/**
 * A schema reduced to the facts that decide what is valid, written one way. Two schemas that mean the
 * same thing, in one document or in two, reduce to equal values: the same type spelt as a string or a list,
 * nullability spelt `nullable: true` or with a `"null"` type, a set written in a different order, a shape
 * reached through a reference or written inline. Names are never part of it.
 *
 * What is not recognised as equivalent is reported as different. A difference that is not real costs one
 * review; a difference that is missed lets the code override the contract.
 */
export interface NormSchema {
  types?: string[];
  format?: string;
  enum?: Json[];
  const?: Json;
  required?: string[];
  properties?: Record<string, NormSchema>;
  /** Absent means open, which is what absent, `true` and `{}` all say. */
  additionalProperties?: 'closed' | NormSchema;
  items?: NormSchema;
  allOf?: NormSchema[];
  oneOf?: NormSchema[];
  anyOf?: NormSchema[];
  /** Limits on numbers, strings, arrays and objects. */
  constraints?: Record<string, Json>;
  default?: Json;
  readOnly?: boolean;
  writeOnly?: boolean;
  /** Keywords this module does not model (`if`, `then`, `not`, `discriminator`, ...), with references resolved. */
  opaque?: Record<string, Json>;
  /** A reference back to a schema that is still being read; names that schema's pointer. */
  recursive?: string;
  /** The schema `false`: nothing is valid. */
  never?: true;
}

const CONSTRAINT_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
] as const;

/** Keywords that carry no rule: prose, examples and tooling hints. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  'description',
  'title',
  'example',
  'examples',
  'externalDocs',
  'deprecated',
  '$comment',
  'xml',
]);

const MODELLED_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref',
  'type',
  'nullable',
  'format',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'allOf',
  'oneOf',
  'anyOf',
  'default',
  'readOnly',
  'writeOnly',
  ...CONSTRAINT_KEYWORDS,
]);

export interface DocumentModel {
  /** The value a local reference such as `#/components/schemas/Money` points to. */
  resolve(ref: string): Json;
  normalize(schema: unknown): NormSchema;
  /** A value with every `$ref` in it replaced by what it points to. */
  inlineReferences(value: Json): Json;
}

/** The keywords written beside a `$ref`. */
function withoutRef(schema: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref'));
}

function decodePointerSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Not percent-encoded; use it as written.
  }
  return decoded.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function createModel(document: JsonObject): DocumentModel {
  function resolve(ref: string): Json {
    if (!ref.startsWith('#/')) {
      throw new ContractModelError(`Only references inside the document are supported: ${ref}`);
    }
    let node: Json | undefined = document;
    for (const segment of ref.slice(2).split('/').map(decodePointerSegment)) {
      node = Array.isArray(node)
        ? (node[Number(segment)] as Json | undefined)
        : isJsonObject(node)
          ? node[segment]
          : undefined;
      if (node === undefined)
        throw new ContractModelError(`The reference ${ref} points to nothing.`);
    }
    return node;
  }

  function inline(value: Json, stack: readonly string[]): Json {
    if (Array.isArray(value)) return value.map((item) => inline(item as Json, stack));
    if (!isJsonObject(value)) return value;
    const ref = value.$ref;
    if (typeof ref === 'string') {
      if (stack.includes(ref)) return { $recursive: ref };
      const siblings = withoutRef(value);
      const target = inline(resolve(ref), [...stack, ref]);
      return Object.keys(siblings).length === 0
        ? target
        : { allOf: [target, inline(siblings, stack)] };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, inline(child, stack)]),
    );
  }

  function normalizeKeywords(schema: JsonObject, stack: readonly string[]): NormSchema {
    const norm: NormSchema = {};

    const nullable = schema.nullable === true;
    if (schema.type !== undefined || nullable) {
      const declared = Array.isArray(schema.type)
        ? (schema.type as string[])
        : typeof schema.type === 'string'
          ? [schema.type]
          : [];
      const types = sortedUnique([...declared, ...(nullable ? ['null'] : [])]);
      if (types.length > 0) norm.types = types;
    }
    if (typeof schema.format === 'string') norm.format = schema.format;
    if (Array.isArray(schema.enum)) norm.enum = sortedUnique(schema.enum as Json[]);
    if (schema.const !== undefined) norm.const = canonicalize(schema.const);
    if (Array.isArray(schema.required)) {
      norm.required = sortedUnique(schema.required as string[]);
    }

    if (isJsonObject(schema.properties)) {
      norm.properties = Object.fromEntries(
        Object.keys(schema.properties)
          .toSorted()
          .map((name) => [name, normalizeSchema((schema.properties as JsonObject)[name], stack)]),
      );
    }

    const additional = schema.additionalProperties;
    if (additional === false) {
      norm.additionalProperties = 'closed';
    } else if (isJsonObject(additional)) {
      const inner = normalizeSchema(additional, stack);
      if (Object.keys(inner).length > 0) norm.additionalProperties = inner;
    }

    if (schema.items !== undefined) norm.items = normalizeSchema(schema.items, stack);

    for (const keyword of ['allOf', 'oneOf', 'anyOf'] as const) {
      const branches = schema[keyword];
      if (!Array.isArray(branches)) continue;
      const normalized = (branches as Json[]).map((branch) => normalizeSchema(branch, stack));
      // A repeated `anyOf` or `allOf` branch changes nothing, but `oneOf` needs exactly one match: a branch
      // written twice makes everything that matches it match two, so the repeat is part of the rule.
      const ordered = keyword === 'oneOf' ? sortedWithRepeats : sortedUnique;
      norm[keyword] = ordered(normalized as unknown as Json[]) as unknown as NormSchema[];
    }

    const constraints = Object.fromEntries(
      CONSTRAINT_KEYWORDS.filter((keyword) => schema[keyword] !== undefined).map((keyword) => [
        keyword,
        schema[keyword] as Json,
      ]),
    );
    if (Object.keys(constraints).length > 0) norm.constraints = constraints;

    if (schema.default !== undefined) norm.default = canonicalize(schema.default);
    if (schema.readOnly === true) norm.readOnly = true;
    if (schema.writeOnly === true) norm.writeOnly = true;

    const opaque = Object.fromEntries(
      Object.keys(schema)
        .filter(
          (key) =>
            !MODELLED_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key) && !key.startsWith('x-'),
        )
        .toSorted()
        .map((key) => [key, canonicalize(inline(schema[key] as Json, stack))]),
    );
    if (Object.keys(opaque).length > 0) norm.opaque = opaque;

    return norm;
  }

  function normalizeSchema(schema: unknown, stack: readonly string[]): NormSchema {
    if (schema === true) return {};
    if (schema === false) return { never: true };
    if (!isJsonObject(schema)) {
      throw new ContractModelError('A schema must be an object or a boolean.');
    }

    const ref = schema.$ref;
    if (typeof ref === 'string') {
      if (stack.includes(ref)) return { recursive: ref };
      const target = normalizeSchema(resolve(ref), [...stack, ref]);
      const own = normalizeKeywords(withoutRef(schema), stack);
      return Object.keys(own).length === 0
        ? target
        : { allOf: sortedUnique([target, own] as unknown as Json[]) as unknown as NormSchema[] };
    }
    return normalizeKeywords(schema, stack);
  }

  return {
    resolve,
    normalize: (schema) => normalizeSchema(schema, []),
    inlineReferences: (value) => inline(value, []),
  };
}
