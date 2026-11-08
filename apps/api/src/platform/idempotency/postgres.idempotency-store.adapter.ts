import { sql } from 'drizzle-orm';

import { randomUUIDv7 } from '../auth/crypto/uuid-v7.js';
import { sealedContext } from '../auth/crypto/sealed-context.js';
import type { Clock } from '../auth/ports/clock.port.js';
import type {
  IdempotencyScope,
  IdempotencyStart,
  IdempotencyStore,
  SealedReplay,
  StoredResponse,
} from '../auth/ports/idempotency-store.port.js';
import type { SecretCipher } from '../auth/ports/secret-cipher.port.js';
import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { isUuid } from '../database/transaction-context.js';
import { securityContextOf, transactionOf } from '../database/transaction-handle.js';
import {
  IdempotencyRefusedError,
  checkFingerprint,
  checkScope,
  isSealedReplayOperation,
  scopeKey,
} from './idempotency-scope.js';

/** What a stored record holds that a decision needs. Binary columns arrive as `Buffer`. */
interface StoredRecord {
  readonly id: string;
  readonly fingerprint: string;
  readonly state: 'IN_PROGRESS' | 'COMPLETED';
  readonly response_status: number | null;
  readonly response_body: Buffer | null;
  readonly sealed_ciphertext: Buffer | null;
  readonly sealed_nonce: Buffer | null;
  readonly sealed_key_version: number | null;
  readonly sealed_envelope_version: number | null;
  /** Whether the sealed fields may still be disclosed, judged on the database's clock when the row was read. */
  readonly sealed_live: boolean;
  readonly tombstoned: boolean;
}

/** What each open transaction has begun, so that `complete` completes only a command this transaction is running. */
const begun = new WeakMap<object, Map<string, string>>();

const bytes = (value: Buffer): Uint8Array => new Uint8Array(value);

/** The principal as the sealed envelope names it: the type and the id, so a record of one type never opens as another's. */
const principalOf = (scope: IdempotencyScope): string =>
  `${scope.principalType}:${scope.principalId}`;

/**
 * The idempotency store over PostgreSQL (S0.12; SECURITY_DESIGN.md §14.16). A key belongs to **one principal and one operation**:
 * the record is unique on `principal_type + principal_id + operation_id + idempotency_key`, so another principal's identical text
 * key is a separate record that is not even visible to this one, and the same text key on another operation is another command.
 * Inside that identity the request's fingerprint decides: the same replays the saved answer, another is a conflict.
 *
 * - **`begin` is one insert or one find.** It inserts the record `IN_PROGRESS` with `ON CONFLICT DO NOTHING`: a row back means this
 *   transaction owns the command (`NEW`). Otherwise it reads the existing record. Two transactions that begin one key at the
 *   same moment cannot both own it: the second waits on the unique index until the first ends, then finds the first's answer
 *   (and if the first rolled back, it owns the command itself). A committed record still `IN_PROGRESS` (the command began in a
 *   transaction that did not finish together with its answer) is reported as `IN_PROGRESS`, and a different fingerprint is a
 *   `CONFLICT` in either state.
 * - **The answer is part of the business transaction.** `complete` writes the status and the body, byte for byte, in the caller's
 *   transaction, beside the effect it records, and only for a command this transaction began (`SCOPE_NOT_OPEN` otherwise). A
 *   failed command rolls its record back with it, so a retry runs the command again.
 * - **One operation replays a secret.** For `registerRiderDevice` alone, `complete` takes the secret fields apart from the rest of
 *   the response and seals them (AES-256-GCM under the `idempotent_replay` purpose, with the principal, the operation, the record
 *   and the envelope version as associated data), with the window in which they may be disclosed. `begin` returns them only while
 *   the window is open **on the database's clock, read at the time** (so a delayed cleanup never extends it), and otherwise
 *   `REPLAY_UNAVAILABLE`, erasing them on the spot. `eraseSealedReplay` is the end of the window for the other causes: the
 *   transaction that consumes, supersedes or revokes the grant calls it. A tombstone stays, so the command never runs twice while the
 *   record lives. No other operation can seal, and this one cannot complete without.
 * - **Nothing secret is logged or put in an error.** A refusal names the field and never a key, a fingerprint or a payload.
 * - **An unknown commit is never retried here.** The store sends statements in the caller's transaction and retries nothing: if a
 *   commit's outcome is unknown, the caller's retry under the same key meets the record the commit left (or did not), and that is
 *   what the key is for.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  readonly #cipher: SecretCipher;
  readonly #clock: Pick<Clock, 'now'>;

  constructor(cipher: SecretCipher, clock: Pick<Clock, 'now'>) {
    this.#cipher = cipher;
    this.#clock = clock;
  }

  async begin(
    transaction: TransactionHandle,
    scope: IdempotencyScope,
    fingerprint: string,
  ): Promise<IdempotencyStart> {
    const own = checkScope(scope, securityContextOf(transaction));
    const print = checkFingerprint(fingerprint);
    const tx = transactionOf(transaction);
    const id = randomUUIDv7(this.#clock);

    const inserted = await tx.execute(sql`
      insert into idempotency_record (id, principal_type, principal_id, operation_id, idempotency_key, fingerprint, state)
      values (${id}, ${own.principalType}, ${own.principalId}, ${own.operationId}, ${own.key}, ${print}, 'IN_PROGRESS')
      on conflict (principal_type, principal_id, operation_id, idempotency_key) do nothing
      returning id`);
    if (inserted.rows.length === 1) {
      const open = begun.get(tx) ?? new Map<string, string>();
      open.set(scopeKey(own), id);
      begun.set(tx, open);
      return { outcome: 'NEW', recordId: id };
    }

    const found = await tx.execute(sql`
      select id, fingerprint, state, response_status, response_body,
             sealed_ciphertext, sealed_nonce, sealed_key_version, sealed_envelope_version,
             (sealed_expires_at is not null and sealed_expires_at > clock_timestamp()) as sealed_live,
             (replay_unavailable_at is not null) as tombstoned
        from idempotency_record
       where principal_type = ${own.principalType} and principal_id = ${own.principalId}
         and operation_id = ${own.operationId} and idempotency_key = ${own.key}`);
    const record = found.rows[0] as unknown as StoredRecord | undefined;
    // The conflict named a record that this principal cannot see: the identity is its own, so this cannot happen.
    if (record === undefined)
      throw new Error('The idempotency record that the key names cannot be read');

    if (record.fingerprint !== print) return { outcome: 'CONFLICT' };
    if (record.state === 'IN_PROGRESS') return { outcome: 'IN_PROGRESS' };

    const response: StoredResponse = {
      status: record.response_status ?? 0,
      body: bytes(record.response_body ?? Buffer.alloc(0)),
    };
    if (!isSealedReplayOperation(own.operationId)) return { outcome: 'REPLAY', response };

    if (record.sealed_ciphertext !== null && record.sealed_live) {
      const sealed = await this.#cipher.open(
        'REPLAY_SECRET',
        {
          envelopeVersion: record.sealed_envelope_version ?? 0,
          keyVersion: record.sealed_key_version ?? 0,
          nonce: bytes(record.sealed_nonce ?? Buffer.alloc(0)),
          ciphertext: bytes(record.sealed_ciphertext),
        },
        sealedContext({
          principal: principalOf(own),
          operation: own.operationId,
          record: record.id,
        }),
      );
      return { outcome: 'REPLAY', response, sealed };
    }
    // The window is closed. An expired envelope that was never erased is erased now: expiry is enforced on the read, and the
    // ciphertext does not wait for a cleanup to go.
    if (record.sealed_ciphertext !== null) await this.#erase(tx, record.id);
    return { outcome: 'REPLAY_UNAVAILABLE' };
  }

  async complete(
    transaction: TransactionHandle,
    scope: IdempotencyScope,
    response: StoredResponse,
    sealed?: SealedReplay,
  ): Promise<void> {
    const own = checkScope(scope, securityContextOf(transaction));
    const tx = transactionOf(transaction);
    const recordId = begun.get(tx)?.get(scopeKey(own));
    if (recordId === undefined) throw new IdempotencyRefusedError('SCOPE_NOT_OPEN', 'scope');

    if (
      !Number.isInteger(response.status) ||
      response.status < 100 ||
      response.status > 599 ||
      !(response.body instanceof Uint8Array)
    ) {
      throw new IdempotencyRefusedError('IDEMPOTENCY_SCOPE_REFUSED', 'response');
    }
    const body = Buffer.from(response.body);

    const mayReplaySecret = isSealedReplayOperation(own.operationId);
    if (sealed !== undefined && !mayReplaySecret) {
      // The exception is for one operation. A second one appearing to need it is a contract change, not a call.
      throw new IdempotencyRefusedError('SEALED_REPLAY_REFUSED', 'operation');
    }
    if (sealed === undefined && mayReplaySecret) {
      throw new IdempotencyRefusedError('SEALED_REPLAY_REFUSED', 'sealed');
    }

    if (sealed === undefined) {
      const done = await tx.execute(sql`
        update idempotency_record
           set state = 'COMPLETED', response_status = ${response.status}, response_body = ${body}, completed_at = now()
         where id = ${recordId} and state = 'IN_PROGRESS'
        returning id`);
      if (done.rows.length !== 1) throw new IdempotencyRefusedError('SCOPE_NOT_OPEN', 'scope');
      return;
    }

    if (
      !(sealed.plaintext instanceof Uint8Array) ||
      sealed.plaintext.length === 0 ||
      !(sealed.expiresAt instanceof Date) ||
      !Number.isFinite(sealed.expiresAt.getTime()) ||
      sealed.expiresAt.getTime() <= this.#clock.now().getTime()
    ) {
      throw new IdempotencyRefusedError('SEALED_REPLAY_REFUSED', 'sealed');
    }
    const envelope = await this.#cipher.seal(
      'REPLAY_SECRET',
      sealed.plaintext,
      sealedContext({ principal: principalOf(own), operation: own.operationId, record: recordId }),
    );
    const done = await tx.execute(sql`
      update idempotency_record
         set state = 'COMPLETED', response_status = ${response.status}, response_body = ${body}, completed_at = now(),
             sealed_ciphertext = ${Buffer.from(envelope.ciphertext)}, sealed_nonce = ${Buffer.from(envelope.nonce)},
             sealed_key_version = ${envelope.keyVersion}, sealed_envelope_version = ${envelope.envelopeVersion},
             sealed_expires_at = ${sealed.expiresAt}
       where id = ${recordId} and state = 'IN_PROGRESS'
      returning id`);
    if (done.rows.length !== 1) throw new IdempotencyRefusedError('SCOPE_NOT_OPEN', 'scope');
  }

  async eraseSealedReplay(transaction: TransactionHandle, recordId: string): Promise<boolean> {
    // The transaction handle is required so that the erasure is part of the caller's transaction and commits with it.
    securityContextOf(transaction);
    if (!isUuid(recordId))
      throw new IdempotencyRefusedError('IDEMPOTENCY_SCOPE_REFUSED', 'recordId');
    return this.#erase(transactionOf(transaction), recordId.toLowerCase());
  }

  async #erase(tx: DatabaseTransaction, recordId: string): Promise<boolean> {
    const erased = await tx.execute(sql`
      update idempotency_record
         set sealed_ciphertext = null, sealed_nonce = null, sealed_key_version = null,
             sealed_envelope_version = null, sealed_expires_at = null, replay_unavailable_at = now()
       where id = ${recordId} and sealed_ciphertext is not null
      returning id`);
    return erased.rows.length === 1;
  }
}
