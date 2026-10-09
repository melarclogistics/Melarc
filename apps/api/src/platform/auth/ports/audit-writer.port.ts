import type { PrincipalType } from '../../database/transaction-context.js';
import type { PortDescriptor } from './port-descriptor.js';
import type { TransactionHandle } from './unit-of-work.port.js';

export interface AuditEventInput {
  /** The event code of audit.md (`auth.session.failed`, `auth.mfa.reset`, ...). */
  readonly code: string;
  /** An enhanced event fails closed: if it cannot be written, the act it records does not commit. */
  readonly enhanced: boolean;
  /** The actor, or a null id for the system. */
  readonly actor: { readonly type: PrincipalType; readonly id: string | null };
  readonly object: { readonly type: string; readonly id: string | null };
  /** Non-secret facts of the event. Never a credential, a token, a code, a hash or an address. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Append-only audit (audit.md §2). An event is written in the transaction of the act it records, so the act and its record
 * commit together. Authentication bookkeeping that must survive a refusal (a failed sign-in's counter and its event) is
 * committed by the use case and the error is answered after the commit, outside the transaction.
 */
export interface AuditWriter {
  write(transaction: TransactionHandle, event: AuditEventInput): Promise<void>;
}

export const AUDIT_WRITER = Symbol('AUDIT_WRITER');

export const AUDIT_WRITER_DESCRIPTOR: PortDescriptor<AuditWriter> = {
  port: 'AuditWriter',
  owner: { kind: 'platform', area: 'audit' },
  operations: {
    write: {
      inputs: 'the transaction and the event: code, tier, actor, object and non-secret detail',
      outputs: 'nothing: the event is part of the transaction',
      outcomes: 'none',
      raises: ['AUDIT_EVENT_CODE_UNKNOWN', 'AUDIT_DETAIL_REFUSED'],
      transaction: 'inside-callers-transaction',
    },
  },
};
