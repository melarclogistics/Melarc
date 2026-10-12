import { isUuid, type SecurityContext } from '../../database/transaction-context.js';
import { PolicyCoordinator } from '../../database/policy-lock/coordinate.js';
import { bundleLock, fixedLock, type PolicyLockRequest } from '../../database/policy-lock/plan.js';
import type { AuditWriter } from '../ports/audit-writer.port.js';
import type {
  IdentityDirectory,
  PrincipalRef,
  PrincipalSummary,
} from '../ports/identity-directory.port.js';
import {
  CLIENT_ROOT_SIGNALS,
  SESSION_PRINCIPAL_TYPES,
  type ClientRootSignal,
  type SessionPrincipalType,
  type SessionStore,
  type StoredSession,
} from '../ports/session-store.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import type { SettingsReader } from '../../settings/settings-reader.js';
import { readBundle, readFixedPolicy } from './bundle-reader.js';
import type { CompiledFixedPolicy } from './session-authority.js';
import { FixedPolicyUnavailableError, SessionIssueRefusedError } from './session-errors.js';
import {
  AUTHENTICATION_PRINCIPAL_ID,
  SESSION_LIFETIME_SETTING,
  tierOf,
} from './session-parameters.js';

export type { CompiledFixedPolicy };

export interface SessionIssuerOptions {
  readonly coordinator: Pick<PolicyCoordinator, 'run'>;
  readonly unitOfWork: Pick<UnitOfWork, 'databaseNow'>;
  readonly identities: Pick<IdentityDirectory, 'readIdentity' | 'lockIdentity'>;
  readonly sessions: Pick<SessionStore, 'create' | 'terminate'>;
  readonly tokens: Pick<TokenService, 'issue'>;
  readonly audit: AuditWriter;
  readonly settings: Pick<SettingsReader, 'object'>;
  /**
   * The fixed-policy revision this build was compiled with, per audience. A build that declares none for an audience cannot issue
   * to it (and the Vendor and Rider sign-ins that need one declare it when they are built). Nothing here supplies a default.
   */
  readonly compiledPolicy?: CompiledFixedPolicy;
}

/**
 * A write that belongs to the sign-in and must stand or fall with the session it issues: the consumption of an **identity proof**
 * (an MFA challenge, a one-time code, a setup grant, a recovery row), the reset of a failure counter. The sign-in has **one**
 * transaction owner, the issue, and a step runs inside it, on its handle, after every refusal has been decided (the status, the
 * credential, the bundle, the fixed policy) and **before** the earlier session of a Vendor or a Rider is ended and the new session
 * is inserted. That is the lock order of SECURITY_DESIGN.md §13.10a: a principal's credential, factor, challenge, grant and recovery
 * rows sit at the identity-lock level, before any session row. Whatever a step wrote is rolled back with the transaction when it, or
 * anything after it, fails, so a proof is never spent on a sign-in that did not happen, and never left unspent by one that did.
 *
 * A step is for identity proofs and nothing else: a row of a later slice's business does not belong here, before the session rows
 * are locked. It is meant to be database work, and that is a convention and a review boundary, not a sandbox: the type is a name and
 * a function, and nothing stops a function from calling another system. The transaction can be restarted before the work runs, and a
 * call to another system is not undone by a rollback, so each first consumer is inspected for it and for taking no policy lock (the
 * issue holds them, in their order), and is tested for rollback and for concurrency. A step that refuses throws; a step that is
 * asked to run twice for one proof refuses the second time by what it writes (a conditional `UPDATE` that finds the proof spent).
 */
export interface SignInStep {
  /** For the error that names it when it fails; never shown to a client. */
  readonly name: string;
  readonly run: (handle: TransactionHandle, locked: PrincipalSummary) => Promise<void>;
}

/** At most this many steps: a sign-in spends a proof or two, and a long list is a defect. */
const MAX_STEPS = 4;

const isSignInStep = (value: unknown): value is SignInStep => {
  if (typeof value !== 'object' || value === null) return false;
  const { name, run } = value as { name?: unknown; run?: unknown };
  return typeof name === 'string' && name !== '' && typeof run === 'function';
};

export interface IssueSessionRequest {
  readonly principal: PrincipalRef;
  /** The id of the request or command this issues for: the audit and the logs correlate on it. */
  readonly correlationId: string;
  /**
   * The credential the caller verified, by its generation (`PrincipalSummary.credentialGeneration` as the sign-in read it, one or
   * more). A sign-in verifies in a transaction of its own and issues afterwards; a credential replaced in between ends every
   * session of the principal, and a session issued on the strength of the old one would outlive that. The protocol compares this with
   * the credential the identity holds **under the identity lock**, and refuses (`CREDENTIAL_CHANGED`) when they differ. A generation
   * and not a moment: two credentials can carry the same instant, and a rehash of one credential does not change its generation.
   */
  readonly verifiedCredentialGeneration: number;
  /** The registered device of a Vendor or a Rider session; never for staff. */
  readonly registeredDeviceId?: string;
  /** A Rider's own root-detection result, recorded as a risk signal; never for staff or a Vendor. */
  readonly clientRootSignal?: ClientRootSignal;
  /** The writes of the sign-in that commit with the session (see `SignInStep`), in the order they run. */
  readonly steps?: readonly SignInStep[];
}

export interface IssuedSession {
  readonly session: StoredSession;
  /** The opaque session secret, shown once: 32 random bytes as 43 base64url characters. Only its hash is stored. */
  readonly token: string;
  /** The synchronizer token of a browser session (staff, vendor), shown once; null for a rider, whose bearer credential needs none. */
  readonly csrfToken: string | null;
  /** The ids of the earlier sessions of a Vendor or a Rider that this sign-in ended, in the same transaction; empty for staff. */
  readonly displacedSessionIds: readonly string[];
}

/**
 * A Vendor or a Rider holds one live session, and a sign-in ends the earlier one in the transaction that issues the new one
 * (domain-model.md section 6.8; state-machines.md section 13; the database refuses a second live session with a unique index). The
 * reasons are not interchangeable: the vendor's is the colleague's displacement, which the displaced client is told
 * (`SESSION_SUPERSEDED`), and the rider's is an ordinary invalid session.
 */
const DISPLACEMENT_REASON = {
  VENDOR: 'SUPERSEDED_BY_NEW_LOGIN',
  RIDER: 'REPLACED_BY_NEW_SESSION',
} as const;

const AUDIT_ACTOR = { STAFF: 'STAFF', RIDER: 'RIDER', VENDOR: 'VENDOR_ACCOUNT' } as const;

const sameHubs = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((hub, index) => hub === right[index]);

/** What a restart compares: everything the plan, and the decision after it, rest on. */
const unchanged = (before: PrincipalSummary | null, after: PrincipalSummary | null): boolean =>
  before !== null &&
  after !== null &&
  before.ref.type === after.ref.type &&
  before.ref.id === after.ref.id &&
  before.status === after.status &&
  before.credentialGeneration === after.credentialGeneration &&
  before.bundleId === after.bundleId &&
  sameHubs(before.authorizedHubIds, after.authorizedHubIds);

function checked(request: IssueSessionRequest): void {
  const { principal } = request;
  if (
    !(SESSION_PRINCIPAL_TYPES as readonly string[]).includes(principal.type) ||
    !isUuid(principal.id)
  ) {
    throw new TypeError('A session is issued to a principal of a known type, by its id (a UUID)');
  }
  if (principal.type === 'STAFF') {
    if (request.registeredDeviceId !== undefined) {
      throw new TypeError('A staff session has no registered device');
    }
  } else if (request.registeredDeviceId === undefined || !isUuid(request.registeredDeviceId)) {
    throw new TypeError('A vendor or rider session is issued to a registered device (a UUID)');
  }
  if (
    typeof request.verifiedCredentialGeneration !== 'number' ||
    !Number.isSafeInteger(request.verifiedCredentialGeneration) ||
    request.verifiedCredentialGeneration < 1
  ) {
    throw new TypeError(
      'A session is issued on a credential the caller verified, by its generation (a whole number, one or more)',
    );
  }
  if (request.steps !== undefined) {
    const steps: unknown = request.steps;
    if (!Array.isArray(steps) || steps.length > MAX_STEPS || !steps.every(isSignInStep)) {
      throw new TypeError(
        `The steps of a sign-in are at most ${String(MAX_STEPS)}, each with a name and a function that runs in the transaction`,
      );
    }
  }
  if (request.clientRootSignal !== undefined) {
    if (principal.type !== 'RIDER' || !CLIENT_ROOT_SIGNALS.includes(request.clientRootSignal)) {
      throw new TypeError('Only a rider session records a client root signal, one of the three');
    }
  }
}

/**
 * The session-issue protocol (S0.24; SECURITY_DESIGN.md §13.10a, "Who takes which mode" and "Discovery, the planned set and
 * restart"), on the S0.7 toolkit and nothing of its own. It is what every sign-in that creates a session calls once the credential
 * (and for a privileged identity the second factor) has been judged, and it runs the five steps of the specification:
 *
 * 1. **Discover**, in a transaction of its own, without a lock: which bundle the principal's authority comes from.
 * 2. **Plan** the shared lock on that bundle and, for a Vendor and a Rider, the shared lock on the fixed policy of the audience.
 * 3. **Lock** them first, in canonical order, then take the **identity lock** and **revalidate**: read the principal again under it
 *    (status, credential, bundle, hubs) and compare with what the plan was built on.
 * 4. **If anything changed**, roll back the whole transaction and restart from step 1, at most `POLICY_MAX_ATTEMPTS` attempts, all
 *    inside one total deadline; then the platform's generic failure (`PolicyCoordinationError`). **Nothing is written before the
 *    revalidation passes**: no session, no audit event, no token is issued.
 * 5. **Act**, in the same transaction, holding the locks: judge the principal's eligibility on the revalidated state, copy the bundle
 *    and (for a Vendor and Rider) check the fixed policy against this build's, take **one fresh database time** and the lifetime of
 *    the session's tier, issue the token(s), insert the session and write `auth.session.issued`. They commit together or not at all.
 *
 * The shared bundle lock is held while the bundle is read and the session inserted, so a reduction of that bundle either commits
 * first (the session copies the reduced content) or waits for this transaction and then ends the session it finds (§13.10a
 * obligation 2, exercised against a real reduction by S0.27). The lock order is policy, identity, session: this takes them in that
 * order and never the reverse, and holds no policy lock for the sake of a target's sessions.
 *
 * It runs under the `authentication` capability (the only context row-level security lets read the identity before a principal
 * exists), and the audit event names the principal it authenticated as its actor. The secret leaves only in the returned value.
 */
export class SessionIssuer {
  readonly #options: SessionIssuerOptions;

  constructor(options: SessionIssuerOptions) {
    this.#options = options;
  }

  async issue(request: IssueSessionRequest): Promise<IssuedSession> {
    checked(request);
    const { principal } = request;
    const {
      coordinator,
      unitOfWork,
      identities,
      sessions,
      tokens,
      audit,
      settings,
      compiledPolicy = {},
    } = this.#options;
    const context: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: AUTHENTICATION_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId: request.correlationId,
    };
    const type: SessionPrincipalType = principal.type;

    return coordinator.run<PrincipalSummary | null, IssuedSession>(context, {
      discover: async (_tx, handle) => {
        const found = await identities.readIdentity(handle, principal);
        if (found === null) throw new SessionIssueRefusedError('PRINCIPAL_NOT_FOUND');
        return found;
      },

      plan: (discovered) => {
        if (discovered === null) return [];
        const locks: PolicyLockRequest[] = [bundleLock(discovered.bundleId, 'shared')];
        if (type !== 'STAFF') locks.push(fixedLock(type, 'shared'));
        return locks;
      },

      revalidate: (_tx, _discovered, handle) => identities.lockIdentity(handle, principal),

      unchanged,

      work: async (_tx, locked, handle) => {
        if (locked === null) throw new SessionIssueRefusedError('PRINCIPAL_NOT_FOUND');
        if (locked.status !== 'ACTIVE') throw new SessionIssueRefusedError('PRINCIPAL_NOT_ACTIVE');
        if (locked.credentialGeneration === 0) {
          throw new SessionIssueRefusedError('CREDENTIAL_NOT_ESTABLISHED');
        }
        // The credential the caller verified is the one the identity holds now, under its lock.
        if (locked.credentialGeneration !== request.verifiedCredentialGeneration) {
          throw new SessionIssueRefusedError('CREDENTIAL_CHANGED');
        }

        // The bundle is copied from a read made under the shared lock on its key.
        const bundle = await readBundle(handle, locked.bundleId);
        if (bundle === null) throw new SessionIssueRefusedError('BUNDLE_MISSING');
        if (bundle.snapshot.audience !== type) {
          throw new SessionIssueRefusedError('BUNDLE_AUDIENCE_MISMATCH');
        }

        // A Vendor and a Rider also rest on the compiled fixed policy: an instance below the floor, or one that knows no revision,
        // serves nothing of the type, and the session records the revision of the build that issued it.
        let policyRevision: number | null = null;
        if (type !== 'STAFF') {
          const compiled = compiledPolicy[type];
          if (compiled === undefined) throw new FixedPolicyUnavailableError(type, 'NOT_COMPILED');
          const stored = await readFixedPolicy(handle, type);
          if (stored === null) throw new FixedPolicyUnavailableError(type, 'NOT_SEEDED');
          if (compiled < stored.minimumRevision) {
            throw new FixedPolicyUnavailableError(type, 'BELOW_FLOOR');
          }
          policyRevision = compiled;
        }

        // One fresh database time, after the locks: the session begins now and ends one lifetime of its tier later.
        const issuedAt = await unitOfWork.databaseNow(handle);
        const tier = tierOf(type, bundle.snapshot);
        const lifetimes = await settings.object(handle, SESSION_LIFETIME_SETTING);
        const minutes = lifetimes[tier];
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1) {
          throw new RangeError(
            `The ${SESSION_LIFETIME_SETTING} of the ${tier} tier is not a positive whole number`,
          );
        }

        // The proofs the sign-in spends, then the earlier session of a Vendor or a Rider, then the new session: one transaction, so a
        // failure at any point leaves the proofs unspent, the earlier session as it was and no new session (the identity lock is held,
        // so no other sign-in of this principal interleaves; the unique index of the table is the backstop, not the mechanism).
        for (const step of request.steps ?? []) await step.run(handle, locked);
        const displaced =
          type === 'STAFF'
            ? []
            : await sessions.terminate(
                handle,
                { by: 'principal', principalType: type, principalId: principal.id },
                DISPLACEMENT_REASON[type],
              );

        const session = tokens.issue();
        const csrf = type === 'RIDER' ? undefined : tokens.issue();
        const stored = await sessions.create(handle, {
          principalType: type,
          principalId: principal.id,
          tokenHash: session.hash,
          authority: {
            bundleId: bundle.id,
            bundleRevision: bundle.revision,
            policyRevision,
            snapshot: bundle.snapshot,
            authorizedHubIds: locked.authorizedHubIds,
          },
          issuedAt,
          expiresAt: new Date(issuedAt.getTime() + minutes * 60_000),
          ...(request.registeredDeviceId === undefined
            ? {}
            : { registeredDeviceId: request.registeredDeviceId }),
          ...(request.clientRootSignal === undefined
            ? {}
            : { clientRootSignal: request.clientRootSignal }),
          ...(csrf === undefined ? {} : { csrfTokenHash: csrf.hash }),
        });

        // Records the principal, the device and the hub set, and never the token (audit.md §5.4). It commits with the session.
        await audit.write(handle, {
          code: 'auth.session.issued',
          enhanced: false,
          outcome: 'SUCCEEDED',
          actor: { type: AUDIT_ACTOR[type], id: principal.id },
          object: { type: 'Session', id: stored.id },
          actorBundle: bundle.snapshot.name,
          relatedIds: { bundle_id: bundle.id, authorized_hub_ids: [...locked.authorizedHubIds] },
          ...(request.registeredDeviceId === undefined
            ? {}
            : { deviceContext: { registered_device_id: request.registeredDeviceId } }),
          ...(request.clientRootSignal === undefined
            ? {}
            : { detail: { client_root_signal: request.clientRootSignal } }),
        });

        // What ended the earlier session, named by the catalogue (audit.md section 5.4): the vendor's displacement is
        // `auth.session.superseded` and the rider's replacement is an ordinary termination with its reason. Both commit with the
        // session that caused them.
        for (const displacedId of displaced) {
          const actor = { type: AUDIT_ACTOR[type], id: principal.id };
          const object = { type: 'Session', id: displacedId };
          if (type === 'VENDOR') {
            await audit.write(handle, {
              code: 'auth.session.superseded',
              enhanced: false,
              outcome: 'SUCCEEDED',
              actor,
              object,
              actorBundle: bundle.snapshot.name,
              relatedIds: { superseded_by_session_id: stored.id },
            });
          } else {
            await audit.write(handle, {
              code: 'auth.session.terminated',
              enhanced: false,
              enhancedBasis: 'ROUTINE_TERMINATION',
              outcome: 'SUCCEEDED',
              actor,
              object,
              actorBundle: bundle.snapshot.name,
              reason: { code: 'REPLACED_BY_NEW_SESSION', label: 'Replaced by a new session' },
              relatedIds: { replaced_by_session_id: stored.id },
            });
          }
        }

        return {
          session: stored,
          token: session.token,
          csrfToken: csrf?.token ?? null,
          displacedSessionIds: displaced,
        };
      },
    });
  }
}
