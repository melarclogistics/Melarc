import type { Request } from 'express';

import { bodyParseFailed } from './parse-failure.js';

export interface IdentifierSpec {
  /** The member of the JSON body that holds the identifier. */
  readonly field: string;
  /** The most bytes (UTF-8) the identifier may have. Anything longer is not taken. */
  readonly maxBytes: number;
}

/**
 * The identifier a limiter keys on (an email, a phone number, a token), taken from the body at the first step of the refusal
 * order, **without the validation of the eighth** (permission-enforcement.md §5.1; SLICE-000-FINAL-DECISIONS.md §9). The limiter
 * has to decide before authentication, before the schema is looked at and before anything is verified or counted, so it cannot
 * wait for the validator; and a limiter key is stored and compared, so what it takes is bounded.
 *
 * It returns the value exactly as sent, or `undefined`. The value is **not** canonicalised here (lower-casing an email, reading a
 * phone number in its canonical form belong to the credential rules the consumer applies), and nothing is trimmed. `undefined`
 * means the identifier could not be taken (no body, a body that is not an object, a member that is absent, not a string, empty,
 * longer than its bound, or a body that could not be parsed): the request then meets the coarse admission limits and is not
 * refused for it. Only members the body itself holds are read, never one inherited from a prototype.
 */
export function boundedIdentifier(request: Request, spec: IdentifierSpec): string | undefined {
  if (!Number.isInteger(spec.maxBytes) || spec.maxBytes <= 0) {
    throw new RangeError('The bound of an identifier is a positive whole number of bytes');
  }
  if (bodyParseFailed(request)) return undefined;
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  if (!Object.hasOwn(body, spec.field)) return undefined;
  const value = (body as Record<string, unknown>)[spec.field];
  if (typeof value !== 'string' || value === '') return undefined;
  return Buffer.byteLength(value, 'utf8') <= spec.maxBytes ? value : undefined;
}
