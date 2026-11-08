import { Secret } from './secret.js';

/**
 * The purposes key material is separated by (SECURITY_DESIGN.md §14.9, Product decision of 8 October 2026). Each has its own
 * key, version, access policy and rotation, and no purpose's key decrypts or derives another's.
 */
export const KEY_PURPOSES = [
  'totp_seed',
  'credential_delivery',
  'idempotent_replay',
  'limiter_digest',
  'password_pepper',
] as const;

export type KeyPurpose = (typeof KEY_PURPOSES)[number];

export const KEY_PARTS = ['MATERIAL', 'ACTIVE_VERSION'] as const;
export type KeyPart = (typeof KEY_PARTS)[number];
/** Every setting a purpose has, as a type: `KEY_TOTP_SEED_MATERIAL`, `KEY_TOTP_SEED_ACTIVE_VERSION`, and so on. */
export type KeyEnvName = `KEY_${Uppercase<KeyPurpose>}_${KeyPart}`;

/** `totp_seed` -> `KEY_TOTP_SEED_MATERIAL` or `KEY_TOTP_SEED_ACTIVE_VERSION`. */
export const keyEnvName = (purpose: KeyPurpose, part: KeyPart): KeyEnvName =>
  `KEY_${purpose.toUpperCase() as Uppercase<KeyPurpose>}_${part}`;

/** One value per setting of every purpose, keyed by the setting's name, so a key cannot be left out or misspelt. */
export function perKeySetting<T>(
  valueFor: (purpose: KeyPurpose, part: KeyPart) => T,
): Record<KeyEnvName, T> {
  return Object.fromEntries(
    KEY_PURPOSES.flatMap((purpose) =>
      KEY_PARTS.map((part) => [keyEnvName(purpose, part), valueFor(purpose, part)] as const),
    ),
  ) as Record<KeyEnvName, T>;
}

/** The versions of one purpose a deployment holds, and the one new records are written under. */
export interface PurposeKeys {
  readonly activeVersion: number;
  /** Every version still held, because an old version stays available for the records it must open. */
  readonly versions: Readonly<Record<number, Secret>>;
}

/**
 * The key material a process holds: every purpose (the API) or only those it was given (the delivery worker holds the
 * `credential_delivery` key and no other, SECURITY_DESIGN.md §14.9: each purpose has its own access policy). The full
 * `KeyConfig` of the API is one of these; a configuration made by hand may leave a purpose out.
 */
export type KeyHolding =
  | {
      readonly custody: 'local';
      readonly purposes: Readonly<Partial<Record<KeyPurpose, PurposeKeys>>>;
    }
  | { readonly custody: 'describe' };

/** At most this many versions of one purpose are held at once. An engineering bound, so rotation cannot pile up unnoticed. */
const MAX_VERSIONS = 8;
const ENTRY = /^([1-9]\d{0,5}):([A-Za-z0-9_-]{43})$/;

/**
 * One key: 32 random bytes written as 43 characters of unpadded base64url, the same form as a token (SECURITY_DESIGN.md §14.9).
 * It must also be written in its one canonical way. The last character carries two spare bits, and a spelling with them set
 * decodes to the same bytes, so a key compared as text could differ from itself.
 */
function isCanonicalKey(text: string): boolean {
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === text;
}

/**
 * Reads `<version>:<key>[,<version>:<key>...]`: versions positive, unique and without leading zeros, one to eight of them.
 * Returns undefined for anything else, and never says why, because what failed may be a secret.
 */
export function parseKeyMaterial(text: string): [version: number, key: Secret][] | undefined {
  const entries = text.split(',');
  if (entries.length > MAX_VERSIONS) return undefined;
  const parsed: [number, Secret][] = [];
  for (const entry of entries) {
    const match = ENTRY.exec(entry);
    const version = match?.[1];
    const key = match?.[2];
    if (version === undefined || key === undefined || !isCanonicalKey(key)) return undefined;
    if (parsed.some(([seen]) => seen === Number(version))) return undefined;
    parsed.push([Number(version), new Secret(key)]);
  }
  return parsed;
}
