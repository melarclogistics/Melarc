import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * How many bytes of JSON each request's body held, recorded by the body parser as it reads it. The parser answers
 * `{}` for a JSON request whose body is empty, so the object it hands over cannot say whether a body was sent; the
 * count can. A request that was not read as JSON has no entry.
 */
const bytesRead = new WeakMap<IncomingMessage, number>();

/** The number of bytes the body parser read for this request, or undefined when it did not read one. */
export function bodyBytesOf(request: IncomingMessage): number | undefined {
  return bytesRead.get(request);
}

/**
 * What the platform asks of the JSON body parser. The reviver refuses a `__proto__` key anywhere in a body: JSON.parse
 * makes it an ordinary property, and the first `Object.assign({}, body)` or recursive merge in a handler would set
 * the prototype of what it builds. Throwing a SyntaxError is how a body that cannot be read is reported, so the
 * answer is the 400 every unreadable body gets.
 */
export const JSON_BODY_OPTIONS = {
  reviver: (key: string, value: unknown): unknown => {
    if (key === '__proto__') throw new SyntaxError('A request body may not have a __proto__ key.');
    return value;
  },
  verify: (request: IncomingMessage, _response: ServerResponse, body: Buffer): void => {
    bytesRead.set(request, body.length);
  },
};
