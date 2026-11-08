import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { authorizationOf, type AuthorizedRequest } from './authorized-request.js';

/**
 * The decision of the authorization step for the request a handler is serving (S0.34, the first authenticated routes): the session
 * that acts, the grant that authorizes the operation (none for a `self` operation), the scope and the activity policy of the route.
 * A handler that opens a transaction passes it to `OperationRunner`, which builds the context from it; nothing a client sent is in it.
 *
 * It is the guard chain that holds the decision, and a handler of an authenticated route is reached only through the chain. A request
 * that arrives here without one is a defect of the wiring, and it fails closed: the handler is not run on a guess of who is calling.
 */
export const Authorized = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthorizedRequest => {
    const authorized = authorizationOf(context.switchToHttp().getRequest<Request>());
    if (authorized === undefined) {
      throw new Error(
        'An authenticated operation was reached without the decision of the authorization step',
      );
    }
    return authorized;
  },
);
