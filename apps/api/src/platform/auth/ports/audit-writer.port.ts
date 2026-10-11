import type { AuditActorType } from '../../database/audit-actor.js';
import type { PortDescriptor } from './port-descriptor.js';
import type { TransactionHandle } from './unit-of-work.port.js';

/** The `outcome` values of audit.md §3. A replay is `REPLAYED`, never `SUCCEEDED`: it is not a second act. */
export const AUDIT_OUTCOMES = [
  'SUCCEEDED',
  'REJECTED',
  'FAILED',
  'REPLAYED',
  'RECONCILED',
] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export type AuditScalar = string | number | boolean | null;
/** Non-secret structured facts: JSON the writer bounds and screens before it is stored. */
export type AuditJson = AuditScalar | readonly AuditJson[] | { readonly [key: string]: AuditJson };
export type AuditJsonObject = Readonly<Record<string, AuditJson>>;

export interface AuditEventInput {
  /** The event code of the catalogue in audit.md §5 (`auth.session.failed`, `auth.mfa.reset`, ...). A code outside it is refused. */
  readonly code: string;
  /**
   * An enhanced event fails closed: if it cannot be written, the act it records does not commit. **The catalogue fixes the tier**
   * (audit.md section 5): an event it makes enhanced is refused with `false`, one it does not is refused with `true`, and only
   * the four whose tier depends on the act (see `enhancedBasis`) are the caller's to state, and then with the basis.
   */
  readonly enhanced: boolean;
  /**
   * For the four events whose tier the catalogue makes depend on a fact of the act (`auth.recovery.requested`,
   * `staff.identity.created`, `delivery.stop.failed`, `vendor.sender_block.created`): which of the catalogue's two cases this is.
   * It fixes the tier, is checked against the transaction where it can be, and is stored nowhere. Refused on any other event.
   */
  readonly enhancedBasis?: string;
  /** How the act ended. A rejected attempt uses the code of the act with `REJECTED`, not a code of its own (audit.md §4). */
  readonly outcome: AuditOutcome;
  /**
   * Who acted, **only where it differs from the transaction's own context** (audit.md §3). Left out, the actor is
   * `auditActorOf(context)`: the staff member, the rider or the vendor account the transaction runs as, and a null id for
   * `SYSTEM`. A transaction of a human principal can record that principal and nobody else; only a `SYSTEM` transaction
   * (sign-in, bootstrap) may name the person it authenticated, and a `SYSTEM` actor never has an id.
   */
  readonly actor?: { readonly type: AuditActorType; readonly id: string | null };
  /** The affected business object, from the closed set of audit.md §3. `id` is null where no object exists to name. */
  readonly object: { readonly type: string; readonly id: string | null };
  /** When the business act happened. The writer's clock when left out; a rider event that syncs hours later passes its own. */
  readonly occurredAt?: Date;
  /** The hub context of the event (audit.md §3; §39.7). */
  readonly responsibleHubId?: string;
  readonly vendorOrganizationId?: string;
  /** The bundle the actor held at the time, snapshotted (bundles are editable). */
  readonly actorBundle?: string;
  readonly deviceContext?: AuditJsonObject;
  readonly previousState?: string;
  readonly resultingState?: string;
  /** The reason with its label as the actor saw it, snapshotted: a timeline never joins to the live catalogue. */
  readonly reason?: { readonly code: string; readonly label: string };
  readonly note?: string;
  readonly approvalId?: string;
  /** Values or a safe diff; never a field dump (audit.md §9). */
  readonly beforeAfter?: AuditJsonObject;
  /** Run, stop, pickup, intake, order, payment, settlement, file: ids, never contents. */
  readonly relatedIds?: AuditJsonObject;
  /**
   * The non-secret facts the catalogue says an event records (the cause of a refusal, the factor, the kind of channel). Never a
   * credential, a token, a code, a credential hash or a destination (an address or a number).
   */
  readonly detail?: Readonly<Record<string, AuditScalar>>;
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
      inputs:
        'the transaction and the event: code, tier (fixed by the catalogue; the basis for the four conditional events), outcome, object, the facts the catalogue names for that event and non-secret detail; the actor, surface and correlation id come from the transaction',
      outputs: 'nothing: the event is part of the transaction',
      outcomes: 'none',
      raises: ['AUDIT_EVENT_CODE_UNKNOWN', 'AUDIT_DETAIL_REFUSED', 'AUDIT_EVENT_REFUSED'],
      transaction: 'inside-callers-transaction',
    },
  },
};
