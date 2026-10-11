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

/**
 * The secret fields of the one operation that replays a secret (`registerRiderDevice`, SECURITY_DESIGN.md §14.16), kept apart from
 * the rest of its response. The store seals `plaintext`; `expiresAt` is the end of the window in which it may be disclosed (the
 * grant's own expiry), and the store judges it on the database's clock, on every read.
 */
export interface SealedReplay {
  readonly plaintext: Uint8Array;
  readonly expiresAt: Date;
}

export type IdempotencyStart =
  /** The command may run. `recordId` names the record (a grant that must erase its sealed replay keeps it). */
  | { readonly outcome: 'NEW'; readonly recordId: string }
  /** The original answer, byte for byte; `sealed` carries the secret fields for the one operation that replays them. */
  | {
      readonly outcome: 'REPLAY';
      readonly response: StoredResponse;
      readonly sealed?: Uint8Array;
    }
  /**
   * The command ran, and its secret can no longer be disclosed (the grant expired, was consumed, superseded or revoked): the use
   * case answers `STATE_CONFLICT`, discloses nothing and executes nothing again.
   */
  | { readonly outcome: 'REPLAY_UNAVAILABLE' }
  | { readonly outcome: 'IN_PROGRESS' }
  | { readonly outcome: 'CONFLICT' };

/**
 * Principal- and operation-bound idempotency (SECURITY_DESIGN.md §14.16). `begin` and `complete` are part of the business
 * transaction, so a command's effect and its recorded answer commit together or not at all. The one bounded exception, the
 * replay of `registerRiderDevice`'s encrypted secret, is carried by `complete` and `begin` and by `eraseSealedReplay`, and no
 * other operation can use it.
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
    sealed?: SealedReplay,
  ): Promise<void>;
  /**
   * Erases the sealed fields of a record and leaves its *replay unavailable* tombstone, in the caller's transaction. The
   * transaction that consumes, supersedes or revokes the grant calls it, so the window closes in the same commit. Reports
   * whether anything was erased.
   */
  eraseSealedReplay(transaction: TransactionHandle, recordId: string): Promise<boolean>;
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
        'NEW when the command may run, REPLAY with the original answer, REPLAY_UNAVAILABLE when a replayed secret may no longer be disclosed, IN_PROGRESS while another request holds the key, CONFLICT when the key was used with a different request',
      outcomes: ['REPLAY', 'REPLAY_UNAVAILABLE', 'IN_PROGRESS', 'CONFLICT'],
      raises: ['IDEMPOTENCY_SCOPE_REFUSED'],
      transaction: 'inside-callers-transaction',
    },
    complete: {
      inputs:
        'the transaction, the scope, the answer to keep and, for the one operation that replays a secret, the sealed secret fields with their window',
      outputs: 'nothing: the answer is recorded with the command',
      outcomes: 'none',
      raises: ['SCOPE_NOT_OPEN', 'IDEMPOTENCY_SCOPE_REFUSED', 'SEALED_REPLAY_REFUSED'],
      transaction: 'inside-callers-transaction',
    },
    eraseSealedReplay: {
      inputs: 'the transaction and the id of the record whose sealed fields end',
      outputs: 'whether sealed fields were erased; the record keeps its tombstone',
      outcomes: 'none',
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
  },
};
