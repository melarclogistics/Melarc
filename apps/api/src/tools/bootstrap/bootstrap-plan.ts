import {
  BOOTSTRAP_RESUME_CHANNEL,
  RESERVED_SYSTEM_ACTOR_FACT,
} from '../../platform/audit/audit-bootstrap-resumed.js';
import { buildAuditRecord, type AuditRecord } from '../../platform/audit/audit-record.js';
import { canonicalWorkEmail } from '../../platform/auth/credentials/work-email.js';
import { randomUUIDv7 } from '../../platform/auth/crypto/uuid-v7.js';
import type { AuditEventInput } from '../../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../../platform/auth/ports/clock.port.js';
import type { TokenService } from '../../platform/auth/ports/token-service.port.js';
import type { SecurityContext } from '../../platform/database/transaction-context.js';
import { RESERVED_SYSTEM_ACTOR_ID } from '../../staff/reserved-system-actor.js';
import {
  BOOTSTRAP_ADMINISTRATOR_COUNT,
  BOOTSTRAP_BUNDLE_ID,
  BOOTSTRAP_PRINCIPAL_ID,
  BootstrapInputError,
  type BundlePurpose,
  type Custodian,
} from './bootstrap-vocabulary.js';

/**
 * What the bootstrap seed and the resume command hand to the database functions of migration 0019 (S0.30): the rows and the audit
 * events of one act, as one JSON document, built here and checked there. Pure: it reads its inputs, the clock and the token service
 * it is given, and nothing else.
 *
 * **The secrets and the document are apart.** A plan returns each secret beside the document and never inside it: the document holds
 * the SHA-256 of a secret (the only form the table keeps), and neither a secret, a work email nor a name appears in an audit event
 * (audit.md §9: an event states a fact, never a destination or a credential). The caller puts a secret in a custody bundle and
 * nowhere else.
 *
 * **The events are built by the platform's own audit record builder**, under the `bootstrap` capability as `SYSTEM`, so the
 * catalogue, the tier and the facts each event must carry are enforced here before the database sees them, and the database function
 * (and the table's own policy) check the shape once more.
 */

export interface PlanDependencies {
  readonly tokens: Pick<TokenService, 'issue'>;
  readonly clock: Pick<Clock, 'now'>;
  /** One for the whole run: it ties every event of the run together. At most 128 characters, no secret. */
  readonly correlationId: string;
}

/** One administrator the seed will create, with the secret that the plan holds for the custody bundle alone. */
export interface PlannedAdministrator {
  readonly id: string;
  readonly fullName: string;
  /** As the operator entered it. */
  readonly workEmail: string;
  readonly workEmailCanonical: string;
  readonly grantId: string;
  /** The raw setup secret: for the custody bundle, never for the document, a log or an output. */
  readonly secret: string;
}

export interface SeedPlan {
  readonly administrators: readonly PlannedAdministrator[];
  /** The JSON document of `melarc.seed_bootstrap_administrators`: no secret, no email, no name in an event. */
  readonly document: string;
}

const MAX_EMAIL = 320;
const MAX_NAME = 200;
/** A name, an `@` and a domain with a dot, no white space: the form of an address, judged on the canonical text. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH_BYTES = 32;

function contextOf(correlationId: string): SecurityContext {
  return {
    principalType: 'SYSTEM',
    principalId: BOOTSTRAP_PRINCIPAL_ID,
    surface: 'SYSTEM',
    taskCapability: 'bootstrap',
    correlationId,
  };
}

/** The columns of `audit_event` the database function inserts, by their own names. `recorded_at` is the database's. */
function auditRow(record: AuditRecord): Record<string, unknown> {
  return {
    id: record.id,
    event_code: record.eventCode,
    occurred_at: record.occurredAt.toISOString(),
    actor_type: record.actorType,
    actor_id: record.actorId,
    actor_bundle: record.actorBundle,
    surface_context: record.surfaceContext,
    device_context: record.deviceContext,
    vendor_organization_id: record.vendorOrganizationId,
    responsible_hub_id: record.responsibleHubId,
    object_type: record.objectType,
    object_id: record.objectId,
    correlation_id: record.correlationId,
    previous_state: record.previousState,
    resulting_state: record.resultingState,
    reason_code: record.reasonCode,
    reason_label: record.reasonLabel,
    note: record.note,
    approval_id: record.approvalId,
    before_after: record.beforeAfter,
    related_ids: record.relatedIds,
    detail: record.detail,
    outcome: record.outcome,
    enhanced: record.enhanced,
    serialisation_version: record.serialisationVersion,
  };
}

/** A token the way `TokenService` makes it, or a refusal: nothing else is ever written as the hash of a secret. */
function issueSecret(tokens: Pick<TokenService, 'issue'>): { secret: string; hashHex: string } {
  const issued = tokens.issue();
  if (
    typeof issued.token !== 'string' ||
    !TOKEN_SHAPE.test(issued.token) ||
    !(issued.hash instanceof Uint8Array) ||
    issued.hash.length !== TOKEN_HASH_BYTES
  ) {
    throw new TypeError('The token service returned something that is not a 32-byte token.');
  }
  return { secret: issued.token, hashHex: Buffer.from(issued.hash).toString('hex') };
}

interface CheckedCustodian {
  readonly fullName: string;
  readonly workEmail: string;
  readonly workEmailCanonical: string;
}

/** Judges one custodian on the plain fact of the input, in the order the operator can fix it, and never echoes a value. */
function checkedCustodian(custodian: Custodian): CheckedCustodian {
  const fullName: unknown = custodian.fullName;
  const workEmail: unknown = custodian.workEmail;
  if (typeof fullName !== 'string' || fullName.trim() === '' || fullName.length > MAX_NAME) {
    throw new BootstrapInputError('CUSTODIAN_NAME');
  }
  if (typeof workEmail !== 'string') throw new BootstrapInputError('CUSTODIAN_EMAIL');
  const canonical = canonicalWorkEmail(workEmail);
  if (
    !canonical.ok ||
    workEmail.length > MAX_EMAIL ||
    canonical.email.length > MAX_EMAIL ||
    !EMAIL_SHAPE.test(canonical.email)
  ) {
    throw new BootstrapInputError('CUSTODIAN_EMAIL');
  }
  return { fullName: fullName.trim(), workEmail, workEmailCanonical: canonical.email };
}

/**
 * The plan of the seed (MIGRATION_AND_SEEDING.md §3.2). Refuses, before it makes an identifier or a secret, anything but exactly two
 * custodians with two distinct canonical work emails: **two custodians that collapse to one email are one person controlling both
 * identities, and nothing is created for them** (the stop condition of S0.30).
 */
export function planSeed(
  custodians: readonly Custodian[],
  dependencies: PlanDependencies,
): SeedPlan {
  if (!Array.isArray(custodians) || custodians.length !== BOOTSTRAP_ADMINISTRATOR_COUNT) {
    throw new BootstrapInputError('CUSTODIAN_COUNT');
  }
  const checked = custodians.map(checkedCustodian);
  if (new Set(checked.map((entry) => entry.workEmailCanonical)).size !== checked.length) {
    throw new BootstrapInputError('CUSTODIANS_NOT_DISTINCT');
  }

  const { clock, correlationId } = dependencies;
  const context = contextOf(correlationId);
  const at = (): Date => clock.now();
  const audit: Record<string, unknown>[] = [];
  const write = (input: AuditEventInput): void => {
    audit.push(auditRow(buildAuditRecord(input, context, at(), randomUUIDv7(clock))));
  };

  const administrators: PlannedAdministrator[] = [];
  const entries: Record<string, unknown>[] = [];
  for (const custodian of checked) {
    const id = randomUUIDv7(clock);
    const grantId = randomUUIDv7(clock);
    const { secret, hashHex } = issueSecret(dependencies.tokens);
    administrators.push({ id, grantId, secret, ...custodian });
    entries.push({
      id,
      work_email: custodian.workEmail,
      work_email_canonical: custodian.workEmailCanonical,
      full_name: custodian.fullName,
      grant: { id: grantId, token_hash: hashHex },
    });

    write({
      code: 'staff.identity.created',
      enhanced: true,
      enhancedBasis: 'BOOTSTRAP_SEED',
      outcome: 'SUCCEEDED',
      object: { type: 'StaffIdentity', id },
      resultingState: 'ACTIVE',
      beforeAfter: { after: { origin: 'BOOTSTRAP', status: 'ACTIVE' } },
      relatedIds: { created_by: RESERVED_SYSTEM_ACTOR_ID, role_bundle_id: BOOTSTRAP_BUNDLE_ID },
    });
    write({
      code: 'staff.identity.approved',
      enhanced: true,
      outcome: 'SUCCEEDED',
      object: { type: 'StaffIdentity', id },
      resultingState: 'ACTIVE',
      beforeAfter: { after: { status: 'ACTIVE' } },
      relatedIds: { created_by: RESERVED_SYSTEM_ACTOR_ID, approved_by: RESERVED_SYSTEM_ACTOR_ID },
    });
    write(grantIssued(grantId, id, 'BOOTSTRAP_SETUP'));
  }

  return { administrators, document: JSON.stringify({ administrators: entries, audit }) };
}

/** `auth.setup_grant.issued` for a grant handed over the controlled provisioning channel (audit.md §5.4): never the token. */
function grantIssued(grantId: string, identityId: string, purpose: BundlePurpose): AuditEventInput {
  return {
    code: 'auth.setup_grant.issued',
    enhanced: false,
    outcome: 'SUCCEEDED',
    object: { type: 'SetupGrant', id: grantId },
    relatedIds: { principal_id: identityId },
    detail: { purpose, channel: 'PROVISIONING_CHANNEL', principal_type: 'STAFF' },
  };
}

/** A grant of the identity that is still `PENDING` and whose expiry has passed: the re-enrolment ends it as `EXPIRED`. */
export interface LapsedGrant {
  readonly id: string;
  readonly purpose: string;
}

/** What `melarc.bootstrap_identity_state` says of the identity a resume is run for: the facts that decide the path and the events. */
export interface IdentityState {
  readonly id: string;
  readonly credentialEstablished: boolean;
  /** Every `PENDING` factor of the identity: the table does not hold it to one, and the resume revokes each. */
  readonly pendingFactorIds: readonly string[];
  /** The identity's one unconsumed `BOOTSTRAP_SETUP` grant, if it holds one. */
  readonly liveBootstrapGrantId: string | null;
  /**
   * The grants of the identity that had lapsed when the state was read (the re-enrolment ends each as `EXPIRED`, and the summary event
   * names them). The resume function derives the same list from what it ends, under the same lock, and refuses a document that says
   * otherwise: a grant that lapses between the read and the change is a `STATE_CHANGED` refusal, and the command is run again.
   */
  readonly lapsedGrants: readonly LapsedGrant[];
}

const byId = <T extends { readonly id: string }>(items: readonly T[]): T[] =>
  items.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export type ResumePath = 'REENROLMENT' | 'BUNDLE_LOST';

export interface ResumePlan {
  readonly path: ResumePath;
  readonly purpose: BundlePurpose;
  readonly identityId: string;
  readonly grantId: string;
  /** The raw secret: for the custody bundle alone. */
  readonly secret: string;
  readonly document: string;
}

const PURPOSE_OF_PATH: Readonly<Record<ResumePath, BundlePurpose>> = {
  REENROLMENT: 'MFA_REENROLMENT',
  BUNDLE_LOST: 'BOOTSTRAP_SETUP',
};

/**
 * The plan of the resume command (MIGRATION_AND_SEEDING.md §3.3a). **An identity with a password** is stranded after the enrolment
 * and gets a fresh `MFA_REENROLMENT` (a `BOOTSTRAP_SETUP` is never revived: a different purpose is issued) and its stale `PENDING`
 * factor, if it has one, is revoked. **An identity with no password yet** lost its bundle: its unconsumed `BOOTSTRAP_SETUP` is
 * superseded by a new one. The database function judges the six conditions again under the identity's lock; the plan only picks the
 * path the state shows and builds the events for it.
 */
export function planResume(state: IdentityState, dependencies: PlanDependencies): ResumePlan {
  const path: ResumePath = state.credentialEstablished ? 'REENROLMENT' : 'BUNDLE_LOST';
  if (path === 'BUNDLE_LOST' && state.liveBootstrapGrantId === null) {
    // No password and no secret to supersede: the identity is not in a state this command knows. Not an invented one.
    throw new Error('The identity changed while the command read it: nothing was planned.');
  }
  const { clock, correlationId } = dependencies;
  const context = contextOf(correlationId);
  const audit: Record<string, unknown>[] = [];
  const write = (input: AuditEventInput): void => {
    audit.push(auditRow(buildAuditRecord(input, context, clock.now(), randomUUIDv7(clock))));
  };

  const grantId = randomUUIDv7(clock);
  const { secret, hashHex } = issueSecret(dependencies.tokens);
  const purpose = PURPOSE_OF_PATH[path];

  if (path === 'REENROLMENT') {
    for (const factorId of state.pendingFactorIds) {
      write({
        code: 'auth.mfa.revoked',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'MfaFactor', id: factorId },
        previousState: 'PENDING',
        resultingState: 'REVOKED',
        beforeAfter: { status: { before: 'PENDING', after: 'REVOKED' } },
        relatedIds: { principal_id: state.id },
        detail: { cause: 'RESUME_COMMAND' },
      });
    }
  }
  if (path === 'BUNDLE_LOST' && state.liveBootstrapGrantId !== null) {
    write({
      code: 'auth.setup_grant.superseded',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object: { type: 'SetupGrant', id: state.liveBootstrapGrantId },
      previousState: 'PENDING',
      resultingState: 'SUPERSEDED',
      relatedIds: { principal_id: state.id, superseded_by: grantId },
      detail: { purpose: 'BOOTSTRAP_SETUP' },
    });
  }
  write(grantIssued(grantId, state.id, purpose));

  // The summary of the resume (AC-SLICE-000-93; audit.md §5.4, *Facts of `auth.bootstrap.resumed`*): the grants it ended and the one it
  // issued, the factors it revoked, by id, with the before and after of each. The function derives the same facts from what it writes and
  // refuses a document whose summary says otherwise; it is last, beside the detailed events, which it replaces none of.
  const superseded =
    path === 'BUNDLE_LOST' && state.liveBootstrapGrantId !== null
      ? [{ id: state.liveBootstrapGrantId, purpose: 'BOOTSTRAP_SETUP' }]
      : [];
  const expired = path === 'REENROLMENT' ? byId(state.lapsedGrants) : [];
  const revoked = path === 'REENROLMENT' ? state.pendingFactorIds.toSorted() : [];
  const ended = byId([
    ...superseded.map((grant) => ({ ...grant, state: 'SUPERSEDED' })),
    ...expired.map((grant) => ({ ...grant, state: 'EXPIRED' })),
  ]);
  write({
    code: 'auth.bootstrap.resumed',
    enhanced: true,
    outcome: 'SUCCEEDED',
    object: { type: 'StaffIdentity', id: state.id },
    detail: { path, purpose, channel: BOOTSTRAP_RESUME_CHANNEL },
    relatedIds: {
      principal_id: state.id,
      reserved_system_actor_id: RESERVED_SYSTEM_ACTOR_FACT,
      setup_grant_id: grantId,
      superseded_grant_ids: superseded.map((grant) => grant.id),
      expired_grant_ids: expired.map((grant) => grant.id),
      revoked_factor_ids: revoked,
    },
    beforeAfter: {
      grants: {
        before: ended.map((grant) => ({ id: grant.id, purpose: grant.purpose, state: 'PENDING' })),
        after: [
          ...ended.map((grant) => ({ id: grant.id, purpose: grant.purpose, state: grant.state })),
          { id: grantId, purpose, state: 'PENDING' },
        ],
      },
      factors: {
        before: revoked.map((id) => ({ id, status: 'PENDING' })),
        after: revoked.map((id) => ({ id, status: 'REVOKED' })),
      },
    },
  });

  return {
    path,
    purpose,
    identityId: state.id,
    grantId,
    secret,
    document: JSON.stringify({
      identity_id: state.id,
      path,
      grant: { id: grantId, token_hash: hashHex },
      audit,
    }),
  };
}
