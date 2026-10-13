import { createHash, randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { BundleSnapshot } from '../../../src/platform/auth/ports/session-store.port.js';
import { BUNDLE_IDS } from '../../../src/tools/seed/bundles.js';

/**
 * Rows of `staff_identity` and `session` arranged **as the administrator**, for the tests that read, judge or end them (S0.24).
 * Nothing in the application inserts either yet: the bootstrap seed and the staff operations do, in the tasks after this one, so a
 * test that needs an identity or a session writes the row itself, past row-level security, and asserts what the application did
 * from `observe()`. The sessions a test of the issue protocol needs are issued by the protocol itself (`personas.ts`), not here.
 */
type Query = Pick<pg.Client, 'query'>;

/** A well-formed maker, and a checker who is not the maker: the two actors of an approved profile. */
export const MAKER_ID = '4d414b45-0000-4000-8000-000000000001';
export const CHECKER_ID = '43484b52-0000-4000-8000-000000000001';

export interface StaffRow {
  readonly id: string;
  readonly workEmail: string;
  readonly workEmailCanonical: string;
  readonly fullName: string;
  readonly status: string;
  readonly roleBundleId: string;
  readonly primaryHubId: string | null;
  readonly credentialHash: string | null;
  readonly credentialEstablishedAt: Date | null;
  /** 0 with no credential, 1 for the first one; raised by one on a replacement. */
  readonly credentialGeneration: number;
  readonly createdBy: string;
  readonly approvedBy: string | null;
  readonly origin: string;
}

/** An `ACTIVE` Ops Staff member with an established credential, whose maker and checker differ: the identity that can sign in. */
export function staffRow(overrides: Partial<StaffRow> = {}): StaffRow {
  const id = overrides.id ?? randomUUID();
  const email = `staff-${id.slice(0, 8)}@example.test`;
  const row: StaffRow = {
    id,
    workEmail: email,
    workEmailCanonical: email,
    fullName: 'Ama Mensah',
    status: 'ACTIVE',
    roleBundleId: BUNDLE_IDS.opsStaff,
    primaryHubId: null,
    credentialHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
    credentialEstablishedAt: new Date('2026-10-01T09:00:00Z'),
    credentialGeneration: 1,
    createdBy: MAKER_ID,
    approvedBy: CHECKER_ID,
    origin: 'MAKER_CHECKER',
    ...overrides,
  };
  // A row arranged with no credential has generation zero unless a test says otherwise (the table holds the two together).
  return overrides.credentialGeneration === undefined && row.credentialHash === null
    ? { ...row, credentialGeneration: 0 }
    : row;
}

export async function insertStaff(client: Query, row: StaffRow): Promise<StaffRow> {
  await client.query(
    `insert into staff_identity (id, work_email, work_email_canonical, full_name, status, role_bundle_id, primary_hub_id,
                                 credential_hash, credential_established_at, credential_generation, created_by, approved_by, origin)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      row.id,
      row.workEmail,
      row.workEmailCanonical,
      row.fullName,
      row.status,
      row.roleBundleId,
      row.primaryHubId,
      row.credentialHash,
      row.credentialEstablishedAt,
      row.credentialGeneration,
      row.createdBy,
      row.approvedBy,
      row.origin,
    ],
  );
  return row;
}

/** The SHA-256 of some text: a stand-in for the hash of a token, 32 bytes as the table requires. */
export const hashOf = (text: string): Buffer => createHash('sha256').update(text).digest();

export const OPS_STAFF_SNAPSHOT: BundleSnapshot = {
  format: 1,
  name: 'Ops Staff',
  audience: 'STAFF',
  privileged: false,
  grants: [],
};

export interface SessionRow {
  readonly id: string;
  readonly principalType: 'STAFF' | 'RIDER' | 'VENDOR';
  readonly principalId: string;
  readonly snapshot: BundleSnapshot;
  readonly bundleId: string;
  readonly bundleRevision: number;
  readonly policyRevision: number | null;
  readonly authorizedHubIds: readonly string[];
  readonly registeredDeviceId: string | null;
  readonly clientRootSignal: string | null;
  readonly tokenHash: Buffer;
  readonly csrfTokenHash: Buffer | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly lastActivityAt: Date;
  readonly terminatedAt: Date | null;
  readonly terminationReason: string | null;
}

/**
 * A live staff session, issued a moment ago to an Ops Staff member, valid for twelve hours. A browser session (staff, vendor) holds
 * the hash of a synchronizer token and a rider's session holds none, as the table requires; an override says otherwise.
 */
export function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  const id = overrides.id ?? randomUUID();
  const issuedAt = overrides.issuedAt ?? new Date(Date.now() - 60_000);
  return {
    id,
    principalType: 'STAFF',
    principalId: randomUUID(),
    snapshot: OPS_STAFF_SNAPSHOT,
    bundleId: BUNDLE_IDS.opsStaff,
    bundleRevision: 1,
    policyRevision: null,
    authorizedHubIds: [],
    registeredDeviceId: null,
    clientRootSignal: null,
    tokenHash: hashOf(`token:${id}`),
    csrfTokenHash: overrides.principalType === 'RIDER' ? null : hashOf(`csrf:${id}`),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 12 * 60 * 60_000),
    lastActivityAt: issuedAt,
    terminatedAt: null,
    terminationReason: null,
    ...overrides,
  };
}

export async function insertSessionRow(client: Query, row: SessionRow): Promise<SessionRow> {
  await client.query(
    `insert into session (id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, policy_revision,
                          authorized_hub_ids, registered_device_id, client_root_signal, token_hash, csrf_token_hash,
                          issued_at, expires_at, last_activity_at, terminated_at, termination_reason)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::uuid[], $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      row.id,
      row.principalType,
      row.principalId,
      JSON.stringify(row.snapshot),
      row.bundleId,
      row.bundleRevision,
      row.policyRevision,
      row.authorizedHubIds,
      row.registeredDeviceId,
      row.clientRootSignal,
      row.tokenHash,
      row.csrfTokenHash,
      row.issuedAt,
      row.expiresAt,
      row.lastActivityAt,
      row.terminatedAt,
      row.terminationReason,
    ],
  );
  return row;
}
