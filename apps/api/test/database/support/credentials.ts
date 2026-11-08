import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import { hashOf } from './identities.js';

/**
 * Rows of `setup_grant` and `mfa_factor` arranged **as the administrator** (S0.29), for the tests that read, judge or end them.
 * Nothing in the application issues a grant to a person yet (the bootstrap seed, `createStaffIdentity` and the credential operations
 * do, in the tasks after this one), so a test that needs a grant or a factor writes the row itself, past row-level security, and
 * asserts what the application did from `observe()`. The administrator is not exempt from the tables' own rules: a grant is
 * inserted `PENDING` and reaches any other state by the transition the machine allows (`setGrantState`), and a factor likewise, so
 * a fixture cannot arrange a history the database would refuse to let happen.
 */
type Query = Pick<pg.Client, 'query'>;

export interface GrantRow {
  readonly id: string;
  readonly principalType: 'STAFF' | 'RIDER' | 'VENDOR';
  readonly principalId: string;
  readonly purpose: string;
  readonly tokenHash: Buffer;
  readonly issuedAt: Date;
  /** Null for `BOOTSTRAP_SETUP` alone. */
  readonly expiresAt: Date | null;
  readonly issuedBy: string | null;
  readonly episodeId: string | null;
  readonly supersedesGrantId: string | null;
  readonly continuedFromGrantId: string | null;
  readonly attestationChallengeHash: Buffer | null;
}

const minutesFromNow = (minutes: number): Date => new Date(Date.now() + minutes * 60_000);

/** A `PENDING` staff credential-setup grant issued a minute ago and valid for another 29, to a staff identity that need not exist. */
export function grantRow(overrides: Partial<GrantRow> = {}): GrantRow {
  const id = overrides.id ?? randomUUID();
  const purpose = overrides.purpose ?? 'STAFF_CREDENTIAL_SETUP';
  const issuedAt = overrides.issuedAt ?? minutesFromNow(-1);
  return {
    id,
    principalType: 'STAFF',
    principalId: randomUUID(),
    purpose,
    tokenHash: hashOf(`grant:${id}`),
    issuedAt,
    expiresAt:
      overrides.expiresAt !== undefined
        ? overrides.expiresAt
        : purpose === 'BOOTSTRAP_SETUP'
          ? null
          : new Date(issuedAt.getTime() + 30 * 60_000),
    issuedBy: null,
    episodeId: null,
    supersedesGrantId: null,
    continuedFromGrantId: null,
    attestationChallengeHash: null,
    ...overrides,
  };
}

export async function insertGrant(client: Query, row: GrantRow): Promise<GrantRow> {
  await client.query(
    `insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by,
                              episode_id, supersedes_grant_id, continued_from_grant_id, attestation_challenge_hash)
     values ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10, $11, $12)`,
    [
      row.id,
      row.principalType,
      row.principalId,
      row.purpose,
      row.tokenHash,
      row.issuedAt,
      row.expiresAt,
      row.issuedBy,
      row.episodeId,
      row.supersedesGrantId,
      row.continuedFromGrantId,
      row.attestationChallengeHash,
    ],
  );
  return row;
}

/** Moves a `PENDING` grant to `state` by the one update the machine allows for it (a consumption records when). */
export async function setGrantState(
  client: Query,
  id: string,
  state: 'CONSUMED' | 'EXPIRED' | 'SUPERSEDED',
): Promise<void> {
  await client.query(
    `update setup_grant set state = $2, consumed_at = case when $2 = 'CONSUMED' then clock_timestamp() end where id = $1`,
    [id, state],
  );
}

export interface FactorRow {
  readonly id: string;
  readonly staffIdentityId: string;
  readonly factorType: string;
  readonly secretCiphertext: Buffer;
  readonly secretNonce: Buffer;
  readonly secretKeyVersion: number;
  readonly secretEnvelopeVersion: number;
  readonly createdByPurpose: string;
  readonly createdEpisodeId: string | null;
}

/** A `PENDING` factor of a staff identity, created by a staff credential setup, holding a sealed secret that is not a real one. */
export function factorRow(staffIdentityId: string, overrides: Partial<FactorRow> = {}): FactorRow {
  return {
    id: randomUUID(),
    staffIdentityId,
    factorType: 'TOTP',
    secretCiphertext: Buffer.alloc(40, 7),
    secretNonce: Buffer.alloc(12, 3),
    secretKeyVersion: 1,
    secretEnvelopeVersion: 1,
    createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
    createdEpisodeId: null,
    ...overrides,
  };
}

/** Inserts a factor, which is created `PENDING` and in no other state. */
export async function insertFactor(client: Query, row: FactorRow): Promise<FactorRow> {
  await client.query(
    `insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version,
                             secret_envelope_version, created_by_purpose, created_episode_id)
     values ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8, $9)`,
    [
      row.id,
      row.staffIdentityId,
      row.factorType,
      row.secretCiphertext,
      row.secretNonce,
      row.secretKeyVersion,
      row.secretEnvelopeVersion,
      row.createdByPurpose,
      row.createdEpisodeId,
    ],
  );
  return row;
}

/** Proves a `PENDING` factor: it becomes `ACTIVE` at the database's time, with the step of the code that proved it. */
export async function activateFactor(client: Query, id: string, counter = '1000'): Promise<void> {
  await client.query(
    `update mfa_factor set status = 'ACTIVE', enrolled_at = clock_timestamp(), last_verified_counter = $2 where id = $1`,
    [id, counter],
  );
}

export interface ChallengeRow {
  readonly id: string;
  readonly staffIdentityId: string;
  readonly credentialGeneration: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/** A `PENDING` MFA challenge issued a minute ago on the credential of generation 1 and valid for another four, for an identity that need not exist. */
export function challengeRow(
  staffIdentityId: string,
  overrides: Partial<ChallengeRow> = {},
): ChallengeRow {
  const issuedAt = overrides.issuedAt ?? minutesFromNow(-1);
  return {
    id: randomUUID(),
    staffIdentityId,
    credentialGeneration: 1,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 5 * 60_000),
    ...overrides,
  };
}

/** Inserts a challenge, which is created `PENDING` with no wrong code and in no other state. */
export async function insertChallenge(client: Query, row: ChallengeRow): Promise<ChallengeRow> {
  await client.query(
    `insert into mfa_challenge (id, staff_identity_id, credential_generation, issued_at, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [row.id, row.staffIdentityId, row.credentialGeneration, row.issuedAt, row.expiresAt],
  );
  return row;
}
