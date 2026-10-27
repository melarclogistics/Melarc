import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type pg from 'pg';

import { RESERVED_SYSTEM_ACTOR_ID } from '../../../src/staff/reserved-system-actor.js';
import { HUBS } from '../../../src/tools/seed/hubs.js';

/**
 * Vendor rows arranged **as the administrator**, for the tests that read, judge or change them (S0.47 onward). No operation of this slice
 * creates a vendor organisation or account (`SLICE-008` does), so a test that needs one writes the rows itself, past row-level security, and
 * asserts what the application did from a second connection. A device credential is made here as the product makes one: 32 random bytes,
 * shown as 43 base64url characters, of which only the SHA-256 is stored.
 */
type Query = Pick<pg.Client, 'query'>;

/** The alphabet of an account identifier (SECURITY_DESIGN.md section 13.7a): no 0, O, 1, I or L. */
const IDENTIFIER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function accountIdentifier(): string {
  const bytes = randomBytes(8);
  return [...bytes].map((byte) => IDENTIFIER_ALPHABET[byte % IDENTIFIER_ALPHABET.length]).join('');
}

export interface VendorRow {
  readonly organizationId: string;
  readonly accountId: string;
  readonly accountIdentifier: string;
  readonly hubId: string;
  readonly legalName: string;
  readonly tradingName: string | null;
  readonly organizationStatus: string;
  readonly accountStatus: string;
  readonly secretHash: string | null;
  readonly credentialGeneration: number;
  readonly recoveryEmail: string | null;
  readonly recoveryPhone: string | null;
  readonly deliveryChannel: 'EMAIL' | 'PHONE' | null;
}

/** An `ACTIVE` vendor of an `ACTIVE` organisation at the seeded hub, with a recovery email it is delivered by and no secret yet. */
export function vendorRow(overrides: Partial<VendorRow> = {}): VendorRow {
  const accountId = overrides.accountId ?? randomUUID();
  const row: VendorRow = {
    organizationId: randomUUID(),
    accountId,
    accountIdentifier: accountIdentifier(),
    hubId: HUBS[0]?.id ?? '',
    legalName: `Vendor ${accountId.slice(0, 8)} Ltd`,
    tradingName: null,
    organizationStatus: 'ACTIVE',
    accountStatus: 'ACTIVE',
    secretHash: null,
    credentialGeneration: 0,
    recoveryEmail: `vendor-${accountId.slice(0, 8)}@example.test`,
    recoveryPhone: null,
    deliveryChannel: 'EMAIL',
    ...overrides,
  };
  return overrides.credentialGeneration === undefined && row.secretHash !== null
    ? { ...row, credentialGeneration: 1 }
    : row;
}

/** A stand-in for the encoded hash of a shared secret: what the table holds, never verified by these rows. */
export const SOME_SECRET_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';

const DECIDED = new Set(['ACTIVE', 'REJECTED', 'SUSPENDED', 'TERMINATED']);

export async function insertVendor(client: Query, row: VendorRow): Promise<VendorRow> {
  const decided = DECIDED.has(row.organizationStatus);
  await client.query(
    `insert into vendor_organization (id, responsible_hub_id, legal_name, trading_name, contact_email, operational_status, created_by,
                                      decided_by, decided_at, decision_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      row.organizationId,
      row.hubId,
      row.legalName,
      row.tradingName,
      'contact@example.test',
      row.organizationStatus,
      RESERVED_SYSTEM_ACTOR_ID,
      decided ? RESERVED_SYSTEM_ACTOR_ID : null,
      decided ? new Date() : null,
      row.organizationStatus === 'REJECTED' ? 'Fixture rejection' : null,
    ],
  );
  await client.query(
    `insert into vendor_account (id, vendor_organization_id, account_identifier, status) values ($1, $2, $3, $4)`,
    [row.accountId, row.organizationId, row.accountIdentifier, row.accountStatus],
  );
  await client.query(
    `insert into vendor_credential (vendor_account_id, secret_hash, credential_established_at, credential_generation, recovery_email,
                                    recovery_phone, delivery_channel)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      row.accountId,
      row.secretHash,
      row.secretHash === null ? null : new Date('2026-10-01T09:00:00Z'),
      row.credentialGeneration,
      row.recoveryEmail,
      row.recoveryPhone,
      row.deliveryChannel,
    ],
  );
  return row;
}

/** A device credential as a browser holds it, and the hash the table keeps of it. */
export interface DeviceCredential {
  readonly token: string;
  readonly hash: Buffer;
}

export function deviceCredential(): DeviceCredential {
  const bytes = randomBytes(32);
  return {
    token: bytes.toString('base64url'),
    hash: createHash('sha256').update(bytes).digest(),
  };
}

export interface DeviceRow {
  readonly id: string;
  readonly accountId: string;
  readonly credential: DeviceCredential;
  readonly status: 'ACTIVE' | 'REVOKED' | 'REPLACED';
}

/** A registered browser of `accountId`, `ACTIVE` unless said otherwise. */
export async function insertDevice(
  client: Query,
  accountId: string,
  overrides: Partial<DeviceRow> = {},
): Promise<DeviceRow> {
  const row: DeviceRow = {
    id: overrides.id ?? randomUUID(),
    accountId,
    credential: overrides.credential ?? deviceCredential(),
    status: overrides.status ?? 'ACTIVE',
  };
  await client.query(
    `insert into registered_device (id, principal_type, principal_id, vendor_account_id, device_kind, device_credential_hash, status,
                                    registered_at, ended_at)
     values ($1, 'VENDOR', $2, $2, 'VENDOR_BROWSER_CREDENTIAL', $3, $4, clock_timestamp() - interval '1 hour',
             case when $4 = 'ACTIVE' then null else clock_timestamp() end)`,
    [row.id, accountId, row.credential.hash, row.status],
  );
  return row;
}
