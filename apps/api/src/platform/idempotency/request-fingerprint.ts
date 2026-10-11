import { createHash } from 'node:crypto';

const OPERATION_ID = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** The value as sorted-key JSON text. Anything JSON cannot hold faithfully is refused, never turned into something else. */
function canonical(value: unknown, where: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${where} holds a number JSON cannot write`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item: unknown) => canonical(item, where)).join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${where} holds an object that is not plain data`);
      }
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key], where)}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new TypeError(`${where} holds a value JSON cannot write`);
  }
}

export interface FingerprintInput {
  /** The operation, by its `operationId`: the same body sent to two operations is two requests. */
  readonly operationId: string;
  /** The values of the path parameters, by name. */
  readonly pathParameters?: Readonly<Record<string, string>>;
  /** The parsed JSON body, if the request had one. An absent body, `null`, `{}`, `[]` and `""` are five different requests. */
  readonly body?: unknown;
}

/**
 * The fingerprint of a request, for `IdempotencyStore.begin` (SECURITY_DESIGN.md §14.16: "payload_hash evaluated inside" the
 * identity). The same key with the same fingerprint replays the original answer; the same key with another is
 * `IDEMPOTENCY_KEY_CONFLICT`.
 *
 * It is the SHA-256, as 64 lower-case hexadecimal characters, of the canonical JSON of the operation, the path parameters and the
 * body: keys sorted at every depth, no whitespace, so a retry that lists its keys in another order is the same request, and a
 * change to any value, any array's order or the operation is another. The headers are not part of it (`Idempotency-Key` is the
 * identity, the rest describe the current request). The principal is not part of it either: the store binds the key to the
 * principal and the operation already, and a second copy here could only disagree.
 *
 * The fingerprint is a comparison value and not a secret, but the body it was made from may hold one: it is a one-way digest,
 * stored in place of the body, and the body is never kept.
 */
export function requestFingerprint(input: FingerprintInput): string {
  if (typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)) {
    throw new TypeError('The operation of a fingerprint is an operationId');
  }
  const members = [
    ...(input.body === undefined ? [] : [`"body":${canonical(input.body, 'The body')}`]),
    `"operation":${JSON.stringify(input.operationId)}`,
    `"path":${canonical(input.pathParameters ?? {}, 'The path parameters')}`,
  ];
  return createHash('sha256')
    .update(`{${members.join(',')}}`, 'utf8')
    .digest('hex');
}
