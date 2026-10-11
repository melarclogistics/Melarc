import type { IdempotencyScope } from '../auth/ports/idempotency-store.port.js';
import { isUuid, type SecurityContext } from '../database/transaction-context.js';

/**
 * The operations that replay a secret, and only these (SECURITY_DESIGN.md §14.16, Product decision of 8 October 2026;
 * SLICE-000-FINAL-DECISIONS.md §5). `registerRiderDevice` takes an `Idempotency-Key` and its response carries a one-time enrolment
 * payload, which the hash-only rule forbids keeping in the clear; its secret fields alone are kept sealed. A second operation that
 * appears to need the exception is a contract change: this list is not widened by a task, and `complete` refuses a sealed replay
 * for any operation not on it (and refuses to complete this one without).
 */
export const SEALED_REPLAY_OPERATIONS = ['registerRiderDevice'] as const;

export const isSealedReplayOperation = (operationId: string): boolean =>
  (SEALED_REPLAY_OPERATIONS as readonly string[]).includes(operationId);

export type IdempotencyRefusal =
  'IDEMPOTENCY_SCOPE_REFUSED' | 'SCOPE_NOT_OPEN' | 'SEALED_REPLAY_REFUSED';

/**
 * A use of the store that is wrong: a scope that is not the transaction's principal's, an operation that may not replay a secret,
 * a completion of a command that was never begun here. These are defects of the caller and not conditions a request can cause;
 * the message names the field and never a value (a key, a fingerprint or a secret).
 */
export class IdempotencyRefusedError extends Error {
  constructor(
    readonly code: IdempotencyRefusal,
    readonly field: string,
  ) {
    super(`The idempotency store refused the call (${code}): ${field}`);
    this.name = 'IdempotencyRefusedError';
  }
}

const OPERATION_ID = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** No control characters (Unicode Cc), one to 128 characters: the contract's bound and the table's. Nothing is trimmed or folded. */
const KEY = /^\P{Cc}{1,128}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const PRINCIPAL_TYPES: readonly string[] = ['STAFF', 'RIDER', 'VENDOR'];

const refuse = (field: string): never => {
  throw new IdempotencyRefusedError('IDEMPOTENCY_SCOPE_REFUSED', field);
};

/**
 * The scope as it is stored, or a refusal. The scope must be that of the principal the transaction runs as: a key belongs to its
 * principal, and a transaction that named another's would read or write that principal's records (row-level security refuses
 * it as well, and this refuses it first, with a name). A `SYSTEM` transaction has no principal to key a command by: the stable
 * identity of a `SYSTEM` task principal is defined by its first consumer (OB-48), not here.
 */
export function checkScope(scope: IdempotencyScope, context: SecurityContext): IdempotencyScope {
  if (!PRINCIPAL_TYPES.includes(scope.principalType)) refuse('principalType');
  if (!isUuid(scope.principalId)) refuse('principalId');
  if (typeof scope.operationId !== 'string' || !OPERATION_ID.test(scope.operationId)) {
    refuse('operationId');
  }
  if (typeof scope.key !== 'string' || !KEY.test(scope.key)) refuse('key');
  const principalId = scope.principalId.toLowerCase();
  if (
    context.principalType === 'SYSTEM' ||
    context.principalType !== scope.principalType ||
    context.principalId.toLowerCase() !== principalId
  ) {
    refuse('principal');
  }
  return {
    principalType: scope.principalType,
    principalId,
    operationId: scope.operationId,
    key: scope.key,
  };
}

export function checkFingerprint(fingerprint: string): string {
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) refuse('fingerprint');
  return fingerprint;
}

/** One text for the four parts of a scope, in which no part can run into the next (each is written with its length). */
export function scopeKey(scope: IdempotencyScope): string {
  return [scope.principalType, scope.principalId, scope.operationId, scope.key]
    .map((part) => `${String(part.length)}:${part}`)
    .join('|');
}
