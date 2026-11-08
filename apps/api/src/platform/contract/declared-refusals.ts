import type { Request } from 'express';

import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import type { BoundOperation } from './contract-operation.js';
import type { ContractValidator } from './contract-validator.js';

/**
 * Whether a refusal is one its operation's contract lets it give (S0.67; `AC-SLICE-000-131`, "every refusal the tests provoke";
 * errors-and-enums.md section 4). The success path is held to the contract by the validation interceptor; a refusal leaves through
 * the exception filter and was held to nothing, so an operation could answer a code its `x-error-codes` does not list and no test
 * would notice. Outside production the filter asks this, and a refusal the contract does not admit is answered as what it is, a
 * defect: the plain `500` a response that breaks the contract gets, with the operation and the code in the log.
 *
 * **What the contract admits** is the operation's own `x-error-codes`, and the two rules errors-and-enums.md section 4 states for every
 * operation instead of in each list: `SESSION_SUPERSEDED`, which an operation that authenticates a vendor session answers and none
 * declares, and `NOT_FOUND` on an operation addressed by an identifier, which "the table governs ... whether or not its
 * `x-error-codes` yet lists the code". A refusal that carries no code (the operational `503`, a transport refusal) has nothing to judge.
 */
export interface RefusalCheck {
  /** The operation and the code, when the request was routed to a bound operation and the refusal is not one it may give. */
  undeclared(
    request: Pick<Request, 'method' | 'route'>,
    exception: unknown,
  ): { readonly operationId: string; readonly code: string } | undefined;
}

/**
 * Refusals the slice's tests provoke and the contract does not yet list, **awaiting the Product Owner's decision** (plan section 7.49,
 * finding 1): each is the answer the authorization-axis table of errors-and-enums.md section 4 gives (a request that violates its schema
 * is `400 VALIDATION_FAILED`; a principal type the operation does not serve is `403 PERMISSION_DENIED`), and each operation's
 * `x-error-codes` omits it. They are admitted by name, one operation and one code at a time, so that no other omission is: a refusal
 * a test provokes that is neither listed nor here fails that test. `declared-refusals.test.ts` holds this list to the contract: an entry
 * the contract has since come to list fails it, and is removed.
 */
export const AWAITING_DECLARATION: Readonly<Record<string, readonly string[]>> = Object.freeze({
  getStaffIdentity: Object.freeze([ErrorCode.ValidationFailed]),
  requestAdditionalDeviceGrant: Object.freeze([
    ErrorCode.ValidationFailed,
    ErrorCode.PermissionDenied,
  ]),
});

/** Codes every operation may answer although none lists them, and the ones an operation addressed by an identifier may. */
const CONTRACT_WIDE: ReadonlySet<string> = new Set([ErrorCode.SessionSuperseded]);
const ADDRESSED: ReadonlySet<string> = new Set([ErrorCode.NotFound]);

export function refusalCheckOf(
  validator: Pick<ContractValidator, 'errorCodesOf'>,
  bound: readonly BoundOperation[],
): RefusalCheck {
  const byRoute = new Map<
    string,
    { readonly operationId: string; readonly admitted: ReadonlySet<string> }
  >();
  for (const operation of bound) {
    const listed = validator.errorCodesOf(operation.operationId);
    // An operation that states no list (a test's fixture contract) is not judged; every operation of the product's contract states one.
    if (listed === undefined) continue;
    byRoute.set(`${operation.method} ${operation.path}`, {
      operationId: operation.operationId,
      admitted: new Set([
        ...listed,
        ...CONTRACT_WIDE,
        ...(operation.path.includes('/:') ? ADDRESSED : []),
        ...(AWAITING_DECLARATION[operation.operationId] ?? []),
      ]),
    });
  }
  return {
    undeclared(request, exception) {
      if (!(exception instanceof ApiException)) return undefined;
      const path: unknown = (request.route as { path?: unknown } | undefined)?.path;
      if (typeof path !== 'string') return undefined;
      const operation = byRoute.get(`${request.method} ${path}`);
      if (operation === undefined || operation.admitted.has(exception.code)) return undefined;
      return { operationId: operation.operationId, code: exception.code };
    },
  };
}
