import { isJsonObject, type Json, type JsonObject } from './json.js';

const POSITION = /^(?:0|[1-9]\d*)$/;

function decodeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function encodeSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** The keywords whose subschemas describe the same place in the data as the schema that holds them. */
const SAME_PLACE = ['allOf', 'anyOf', 'oneOf'] as const;
const CONDITIONAL = ['if', 'then', 'else'] as const;

function isListShape(shape: JsonObject): boolean {
  const type = shape.type;
  return (
    type === 'array' ||
    (Array.isArray(type) && type.includes('array')) ||
    shape.items !== undefined ||
    shape.prefixItems !== undefined
  );
}

/**
 * Decides which segments of a path into some data a violation may repeat. A segment is the contract's own
 * when the schema names it at that place, as a property (through a reference, `allOf`, `anyOf`, `oneOf` or a
 * conditional) or as a position in an array. Every other segment is the data's: the key of a dictionary, a
 * property a closed object refuses. It can be a name, a card number or a token, and it is replaced by `*`.
 *
 * What a key looks like proves nothing about whose it is, so no key is judged by its characters. A name that the
 * schema declares in any branch at that place counts as the contract's even if another branch applied, because
 * it is still a word from the contract and not from the data.
 */
export class PointerOwnership {
  constructor(private readonly document: JsonObject) {}

  /** `instancePath`, a JSON pointer into data that `schema` describes, with the data's own segments replaced. */
  pointer(schema: Json, instancePath: string): string {
    const segments = instancePath.split('/').slice(1).map(decodeSegment);
    let shapes = this.shapes(schema);
    let result = '';
    for (const segment of segments) {
      const step = this.step(shapes, segment);
      result += `/${step.owned ? encodeSegment(segment) : '*'}`;
      shapes = step.next;
    }
    return result;
  }

  /** What a schema says about its place: itself and every schema it is composed of, references followed. */
  private shapes(schema: Json | undefined, seen = new Set<JsonObject>()): JsonObject[] {
    if (!isJsonObject(schema) || seen.has(schema)) return [];
    seen.add(schema);
    const found: JsonObject[] = [schema];
    if (typeof schema.$ref === 'string')
      found.push(...this.shapes(this.reference(schema.$ref), seen));
    for (const keyword of SAME_PLACE) {
      const branches = schema[keyword];
      if (Array.isArray(branches)) {
        for (const branch of branches as Json[]) found.push(...this.shapes(branch, seen));
      }
    }
    for (const keyword of CONDITIONAL) found.push(...this.shapes(schema[keyword], seen));
    return found;
  }

  private reference(ref: string): Json | undefined {
    if (!ref.startsWith('#/')) return undefined;
    let node: Json | undefined = this.document;
    for (const segment of ref.slice(2).split('/').map(decodeSegment)) {
      node = isJsonObject(node) && Object.hasOwn(node, segment) ? node[segment] : undefined;
    }
    return node;
  }

  private step(
    shapes: readonly JsonObject[],
    segment: string,
  ): { owned: boolean; next: JsonObject[] } {
    const declared = shapes.flatMap((shape) =>
      isJsonObject(shape.properties) && Object.hasOwn(shape.properties, segment)
        ? [shape.properties[segment]]
        : [],
    );
    if (declared.length > 0) {
      return { owned: true, next: declared.flatMap((schema) => this.shapes(schema)) };
    }

    if (POSITION.test(segment) && shapes.some(isListShape)) {
      const index = Number(segment);
      const items = shapes.flatMap((shape) => {
        if (Array.isArray(shape.prefixItems) && index < shape.prefixItems.length) {
          return [(shape.prefixItems as Json[])[index]];
        }
        return shape.items === undefined || Array.isArray(shape.items) ? [] : [shape.items];
      });
      return { owned: true, next: items.flatMap((schema) => this.shapes(schema)) };
    }

    const open = shapes.flatMap((shape) => [
      shape.additionalProperties,
      shape.unevaluatedProperties,
      ...(isJsonObject(shape.patternProperties) ? Object.values(shape.patternProperties) : []),
    ]);
    return { owned: false, next: open.flatMap((schema) => this.shapes(schema)) };
  }
}
