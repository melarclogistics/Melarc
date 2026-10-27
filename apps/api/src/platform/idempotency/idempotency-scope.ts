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

/**
 * The operations whose record the `authentication` capability keeps **on behalf of the principal whose session asked**, and the principal
 * type each is for (S0.49). `requestAdditionalDeviceGrant` issues a setup grant and queues its message, which only that capability may write
 * (data-scope-registry.md: Vendor `DENY` on `SetupGrant` and `CredentialDeliveryJob`), and its `Idempotency-Key` must be kept in the same
 * transaction; the act runs under the capability, holding the vendor session's policy locks, and keys the record by the vendor account of
 * that session. The record is still the vendor's own: no principal is ever given another's saved result. This list is not widened by a task
 * (migration 0036 admits the capability to this operation's vendor rows and to no other row).
 */
export const ON_BEHALF_OPERATIONS: Readonly<Record<string, 'VENDOR'>> = Object.freeze({
  requestAdditionalDeviceGrant: 'VENDOR',
});

const keptOnBehalf = (scope: IdempotencyScope, context: SecurityContext): boolean =>
  context.principalType === 'SYSTEM' &&
  context.taskCapability === 'authentication' &&
  Object.hasOwn(ON_BEHALF_OPERATIONS, scope.operationId) &&
  ON_BEHALF_OPERATIONS[scope.operationId] === scope.principalType;

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
/** Whether `key` is an `Idempotency-Key` the store can keep: the contract bounds only its length, the store its characters too. */
export const isIdempotencyKey = (key: unknown): key is string =>
  typeof key === 'string' && KEY.test(key);
const FINGERPRINT = /^[0-9a-f]{64}$/;
const PRINCIPAL_TYPES: readonly string[] = ['STAFF', 'RIDER', 'VENDOR'];

const refuse = (field: string): never => {
  throw new IdempotencyRefusedError('IDEMPOTENCY_SCOPE_REFUSED', field);
};

/**
 * The scope as it is stored, or a refusal. The scope must be that of the principal the transaction runs as: a key belongs to its
 * principal, and a transaction that named another's would read or write that principal's records (row-level security refuses
 * it as well, and this refuses it first, with a name). A `SYSTEM` transaction has no principal to key a command by: the stable
 * identity of a `SYSTEM` task principal is defined by its first consumer (OB-48), not here. The one exception is
 * `ON_BEHALF_OPERATIONS`: the authentication capability keying a vendor's own act for it.
 */
export function checkScope(scope: IdempotencyScope, context: SecurityContext): IdempotencyScope {
  if (!PRINCIPAL_TYPES.includes(scope.principalType)) refuse('principalType');
  if (!isUuid(scope.principalId)) refuse('principalId');
  if (typeof scope.operationId !== 'string' || !OPERATION_ID.test(scope.operationId)) {
    refuse('operationId');
  }
  if (!isIdempotencyKey(scope.key)) refuse('key');
  const principalId = scope.principalId.toLowerCase();
  if (
    !keptOnBehalf(scope, context) &&
    (context.principalType === 'SYSTEM' ||
      context.principalType !== scope.principalType ||
      context.principalId.toLowerCase() !== principalId)
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
