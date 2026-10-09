import type { PortDescriptor } from './port-descriptor.js';
import type { TransactionHandle } from './unit-of-work.port.js';

/** Whose command it was, which command, and the caller's `Idempotency-Key`. A key is never shared across any of the three. */
export interface IdempotencyScope {
  readonly principalType: 'STAFF' | 'RIDER' | 'VENDOR';
  readonly principalId: string;
  readonly operationId: string;
  readonly key: string;
}

export interface StoredResponse {
  readonly status: number;
  /** The original body, byte for byte, so a replay is identical to the first answer. */
  readonly body: Uint8Array;
}

export type IdempotencyStart =
  | { readonly outcome: 'NEW' }
  | { readonly outcome: 'REPLAY'; readonly response: StoredResponse }
  | { readonly outcome: 'IN_PROGRESS' }
  | { readonly outcome: 'CONFLICT' };

/**
 * Principal- and operation-bound idempotency (SECURITY_DESIGN.md §14.16). `begin` and `complete` are part of the business
 * transaction, so a command's effect and its recorded answer commit together or not at all. The one bounded exception, the
 * replay of `registerRiderDevice`'s encrypted secret, is added by the task that builds the store.
 */
export interface IdempotencyStore {
  begin(
    transaction: TransactionHandle,
    scope: IdempotencyScope,
    fingerprint: string,
  ): Promise<IdempotencyStart>;
  complete(
    transaction: TransactionHandle,
    scope: IdempotencyScope,
    response: StoredResponse,
  ): Promise<void>;
}

export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

export const IDEMPOTENCY_STORE_DESCRIPTOR: PortDescriptor<IdempotencyStore> = {
  port: 'IdempotencyStore',
  owner: { kind: 'platform', area: 'idempotency' },
  operations: {
    begin: {
      inputs:
        'the transaction, the scope (principal, operation, key) and the fingerprint of the request',
      outputs:
        'NEW when the command may run, REPLAY with the original answer, IN_PROGRESS while another request holds the key, CONFLICT when the key was used with a different request',
      outcomes: ['REPLAY', 'IN_PROGRESS', 'CONFLICT'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    complete: {
      inputs: 'the transaction, the scope and the answer to keep',
      outputs: 'nothing: the answer is recorded with the command',
      outcomes: 'none',
      raises: ['SCOPE_NOT_OPEN'],
      transaction: 'inside-callers-transaction',
    },
  },
};
