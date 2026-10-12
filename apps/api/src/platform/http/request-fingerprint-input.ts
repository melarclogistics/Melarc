import type { Request } from 'express';

import { requestFingerprint } from '../idempotency/request-fingerprint.js';

/**
 * The fingerprint of a request as the pipeline gives it to `IdempotencyStore.begin` (plan OB-112; SECURITY_DESIGN.md §14.16):
 * the operation, **every path parameter the router found**, and the parsed body. `requestFingerprint` takes the path parameters as
 * an optional input, because a store test has none; this is the door the pipeline goes through, and it cannot forget them. A
 * `registerRiderDevice` has no body and names the rider in the path: without them two riders sending the same key would share a
 * fingerprint, and the second would be answered with the first's sealed enrolment secret.
 *
 * It reads the request after routing (the parameters are found by the router), which is where an idempotent command begins; it
 * is not the first place a request is looked at. An absent body stays absent (`undefined`), so it is not confused with an empty
 * one.
 */
export function fingerprintOfRequest(request: Request, operationId: string): string {
  const pathParameters: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.params)) {
    // Express reads a wildcard segment as a list. No path in the contract has one, so a list is a route that is not the contract's,
    // and it is refused, not flattened into something that could stand for two different requests.
    if (typeof value !== 'string') {
      throw new TypeError(`The path parameter "${name}" is not a single value`);
    }
    pathParameters[name] = value;
  }
  return requestFingerprint({ operationId, pathParameters, body: request.body as unknown });
}
