import { isWellFormedUnicode } from '../credentials/unicode.js';

/** The longest a field of a context may be, in UTF-8 bytes. An identifier is a UUID or a short operation name. */
const MAX_FIELD_BYTES = 1024;

export interface SealedContextParts {
  /** Whose value this is: the identity the sealed value belongs to. */
  readonly principal: string;
  /**
   * The operation the sealed value belongs to, as one stable name: the same when it is sealed and every time it is opened (for a
   * replayed answer, the `operationId` whose replay it is). A name that differs between sealing and opening never opens.
   */
  readonly operation: string;
  /** Which record holds it: the row the envelope is stored in. */
  readonly record: string;
}

function fieldBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value === '' || !isWellFormedUnicode(value)) {
    throw new TypeError('A sealed context field is non-empty, well-formed text.');
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_FIELD_BYTES) {
    throw new RangeError('A sealed context field is at most 1 KiB.');
  }
  return bytes;
}

/**
 * The authenticated data that ties a sealed value to the principal, operation and record it belongs to: a value that is moved to
 * another row, or opened for another operation, does not authenticate (SECURITY_DESIGN.md §14.9: an envelope "authenticates its
 * purpose, principal, operation, record and envelope version as associated data"). The cipher adds the purpose, the key version
 * and the envelope version itself; the caller states the other three with this, so that every caller states them the same way.
 *
 * The same three fields must be given again to open the value, exactly as they were given to seal it: they are part of what the
 * value is, and nothing stores them with it. A caller therefore derives them from the record (its owner, the operation it belongs
 * to, its id) and never from the request that happens to be opening it.
 *
 * Each field is written with its length as four big-endian bytes before it, so a boundary cannot be moved between fields:
 * ("ab", "c") and ("a", "bc") are two contexts. Fields are UTF-8 text, never empty.
 */
export function sealedContext(parts: SealedContextParts): Uint8Array {
  const pieces = [parts.principal, parts.operation, parts.record].flatMap((field) => {
    const bytes = fieldBytes(field);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return [length, bytes];
  });
  return new Uint8Array(Buffer.concat(pieces));
}
