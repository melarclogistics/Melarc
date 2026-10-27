import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from 'node:crypto';

import type pg from 'pg';

import { HUBS } from '../../../src/tools/seed/hubs.js';

/**
 * Rider rows arranged **as the administrator**, for the tests that read, judge or change them (S0.53 onward). No operation of this slice
 * creates a rider (SLICE-009 does), so a test that needs one writes the rows itself, past row-level security, and asserts what the
 * application did from a second connection. A rider's device is a real P-256 key pair: the test holds the private half, as the handset
 * does, and the table gets the canonical standard base64 of the DER SubjectPublicKeyInfo of the public half.
 */
type Query = Pick<pg.Client, 'query'>;

export interface RiderRow {
  readonly id: string;
  readonly phone: string;
  readonly fullName: string;
  readonly status: string;
  readonly hubId: string;
  readonly pinHash: string | null;
  readonly credentialGeneration: number;
}

/** A phone of the ITU-reserved +999 range, which no operator assigns: no real person holds one. */
export function riderPhone(): string {
  return `+999${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}

/** An `ACTIVE` rider of the seeded hub with no PIN and no device, as the fixture leaves one. */
export function riderRow(overrides: Partial<RiderRow> = {}): RiderRow {
  const id = overrides.id ?? randomUUID();
  const row: RiderRow = {
    id,
    phone: riderPhone(),
    fullName: `Rider ${id.slice(0, 8)}`,
    status: 'ACTIVE',
    hubId: HUBS[0]?.id ?? '',
    pinHash: null,
    credentialGeneration: 0,
    ...overrides,
  };
  return overrides.credentialGeneration === undefined && row.pinHash !== null
    ? { ...row, credentialGeneration: 1 }
    : row;
}

/** A stand-in for the encoded hash of a PIN: what the table holds, never verified by these rows. */
export const SOME_PIN_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';

export async function insertRider(client: Query, row: RiderRow): Promise<RiderRow> {
  await client.query(
    `insert into rider_identity (id, phone, full_name, status, primary_hub_id, pin_hash, pin_established_at, credential_generation)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.id,
      row.phone,
      row.fullName,
      row.status,
      row.hubId,
      row.pinHash,
      row.pinHash === null ? null : new Date('2026-10-01T09:00:00Z'),
      row.credentialGeneration,
    ],
  );
  return row;
}

/** A device key as the handset holds it: the private half, and the registered form of the public half. */
export interface DeviceKey {
  readonly privateKey: KeyObject;
  /** The canonical standard base64 of the 91-byte DER SPKI: 124 characters. */
  readonly publicKey: string;
}

export function deviceKey(): DeviceKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

export interface RiderDeviceRow {
  readonly id: string;
  readonly riderId: string;
  readonly key: DeviceKey;
  readonly status: 'ACTIVE' | 'REVOKED' | 'REPLACED';
}

/** A registered device of `riderId`, `ACTIVE` unless said otherwise. */
export async function insertRiderDevice(
  client: Query,
  riderId: string,
  overrides: Partial<RiderDeviceRow> = {},
): Promise<RiderDeviceRow> {
  const row: RiderDeviceRow = {
    id: overrides.id ?? randomUUID(),
    riderId,
    key: overrides.key ?? deviceKey(),
    status: overrides.status ?? 'ACTIVE',
  };
  await client.query(
    `insert into registered_device (id, principal_type, principal_id, rider_identity_id, device_kind, public_key, status,
                                    registered_at, ended_at)
     values ($1, 'RIDER', $2, $2, 'RIDER_ANDROID_KEYPAIR', $3, $4, clock_timestamp() - interval '1 hour',
             case when $4 = 'ACTIVE' then null else clock_timestamp() end)`,
    [row.id, riderId, row.key.publicKey, row.status],
  );
  return row;
}

/** A challenge or a token as the product makes one: 32 random bytes, 43 base64url characters, and the SHA-256 the table keeps. */
export function randomToken(): { readonly token: string; readonly hash: Buffer } {
  const bytes = randomBytes(32);
  return { token: bytes.toString('base64url'), hash: createHash('sha256').update(bytes).digest() };
}
