import type pg from 'pg';

import { Sha256TokenService } from '../../../src/platform/auth/crypto/sha256.token-service.adapter.js';
import type { AuditWriter } from '../../../src/platform/auth/ports/audit-writer.port.js';
import type { IdentityDirectory } from '../../../src/platform/auth/ports/identity-directory.port.js';
import type { SessionStore } from '../../../src/platform/auth/ports/session-store.port.js';
import { PostgresSessionStore } from '../../../src/platform/auth/sessions/postgres.session-store.adapter.js';
import {
  SessionIssuer,
  type CompiledFixedPolicy,
  type IssuedSession,
} from '../../../src/platform/auth/sessions/session-issuer.js';
import { PostgresAuditWriter } from '../../../src/platform/audit/postgres.audit-writer.adapter.js';
import { PostgresUnitOfWork } from '../../../src/platform/database/postgres.unit-of-work.adapter.js';
import { PolicyCoordinator } from '../../../src/platform/database/policy-lock/coordinate.js';
import { SettingsReader } from '../../../src/platform/settings/settings-reader.js';
import { PostgresStaffIdentityDirectory } from '../../../src/staff/postgres.staff-identity-directory.adapter.js';
import { ManualClock } from '../../../src/test-support/manual-clock.js';
import { insertStaff, staffRow, type StaffRow } from './identities.js';
import type { BuiltService } from './service.js';

/**
 * The assembled session machinery over a real database, and the staff persona factory (S0.24): a staff member who exists (arranged
 * as the administrator, because nothing in the application inserts one yet) and holds a session that the real issue protocol
 * issued, so that a test of what a session does starts from a session issued the way the product issues it.
 *
 * The collaborators are the product's own. `overrides` replaces one to put a test double in a seam (an identity directory that
 * reassigns a bundle between discovery and lock, a session store that counts what it is asked to write).
 */
export interface Machinery {
  readonly clock: ManualClock;
  readonly unitOfWork: PostgresUnitOfWork;
  readonly sessions: SessionStore;
  readonly identities: IdentityDirectory;
  readonly tokens: Sha256TokenService;
  readonly audit: AuditWriter;
  readonly settings: SettingsReader;
  readonly coordinator: PolicyCoordinator;
  readonly issuer: SessionIssuer;
}

export function assemble(
  built: BuiltService,
  overrides: {
    readonly identities?: IdentityDirectory;
    readonly sessions?: SessionStore;
    readonly audit?: AuditWriter;
    readonly compiledPolicy?: CompiledFixedPolicy;
    readonly totalDeadlineMs?: number;
    readonly maxAttempts?: number;
  } = {},
): Machinery {
  const clock = new ManualClock(new Date());
  const unitOfWork = new PostgresUnitOfWork(built.service);
  const sessions = overrides.sessions ?? new PostgresSessionStore(clock);
  const identities = overrides.identities ?? new PostgresStaffIdentityDirectory();
  const tokens = new Sha256TokenService();
  const audit = overrides.audit ?? new PostgresAuditWriter(clock);
  const settings = new SettingsReader();
  const coordinator = new PolicyCoordinator(built.service, {
    clock,
    totalDeadlineMs: overrides.totalDeadlineMs ?? 30_000,
    ...(overrides.maxAttempts === undefined ? {} : { maxAttempts: overrides.maxAttempts }),
  });
  const issuer = new SessionIssuer({
    coordinator,
    unitOfWork,
    identities,
    sessions,
    tokens,
    audit,
    settings,
    ...(overrides.compiledPolicy === undefined ? {} : { compiledPolicy: overrides.compiledPolicy }),
  });
  return { clock, unitOfWork, sessions, identities, tokens, audit, settings, coordinator, issuer };
}

export interface StaffPersona {
  readonly identity: StaffRow;
  readonly issued: IssuedSession;
  /** The `Cookie` header a browser holding this session sends. */
  readonly cookie: string;
}

let sequence = 0;

/** An `ACTIVE` staff member with an established credential, and a session issued to them by the protocol. */
export async function staffPersona(
  machinery: Pick<Machinery, 'issuer'>,
  admin: Pick<pg.Client, 'query'>,
  overrides: Partial<StaffRow> = {},
): Promise<StaffPersona> {
  sequence += 1;
  const identity = await insertStaff(admin, staffRow(overrides));
  const issued = await machinery.issuer.issue({
    principal: { type: 'STAFF', id: identity.id },
    correlationId: `persona-${String(sequence)}`,
    // The sign-in of a persona has verified the credential the identity holds.
    verifiedCredentialGeneration: Math.max(1, identity.credentialGeneration),
  });
  return {
    identity,
    issued,
    cookie: `melarc_session=${issued.token}${issued.csrfToken === null ? '' : `; melarc_csrf=${issued.csrfToken}`}`,
  };
}
