import type { PrincipalType, SecurityContext } from './transaction-context.js';

/** The `actor_type` values of audit.md §3. */
export type AuditActorType = 'STAFF' | 'RIDER' | 'VENDOR_ACCOUNT' | 'SYSTEM';

export interface AuditActor {
  readonly actorType: AuditActorType;
  /** Null for `SYSTEM`, as audit.md records it. */
  readonly actorId: string | null;
}

const ACTOR_TYPE: Readonly<Record<PrincipalType, AuditActorType>> = {
  STAFF: 'STAFF',
  RIDER: 'RIDER',
  VENDOR: 'VENDOR_ACCOUNT',
  SYSTEM: 'SYSTEM',
};

/**
 * The actor an audit event records for a security context (SECURITY_DESIGN.md §14.1b). A `SYSTEM` context carries
 * the stable technical identifier of its capability, which an idempotency record needs as its principal; the audit
 * records a `SYSTEM` actor with a null `actor_id`, and this mapping is where that is made. The audit writer calls it
 * and never copies `principalId` into an event itself. It takes a context that was accepted, and refuses a principal
 * type it does not know rather than calling it `SYSTEM`.
 */
export function auditActorOf(context: SecurityContext): AuditActor {
  const actorType = Object.hasOwn(ACTOR_TYPE, context.principalType)
    ? ACTOR_TYPE[context.principalType]
    : undefined;
  if (actorType === undefined) throw new Error('No audit actor for this principal type');
  return {
    actorType,
    actorId: actorType === 'SYSTEM' ? null : context.principalId.toLowerCase(),
  };
}
