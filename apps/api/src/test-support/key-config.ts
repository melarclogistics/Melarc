import {
  KEY_PURPOSES,
  type KeyPurpose,
  type PurposeKeys,
} from '../platform/config/key-material.js';
import type { KeyConfig } from '../platform/config/load-config.js';
import { Secret } from '../platform/config/secret.js';
import { randomKey } from './config-env.js';

/** The local custody: the shape of `KeyConfig` that holds keys. */
export type LocalKeys = Extract<KeyConfig, { readonly custody: 'local' }>;

/**
 * Fresh random keys for the given versions of one purpose, the largest version active unless one is named. Nothing here is a
 * secret: the keys exist for one test and are written nowhere.
 */
export function purposeKeys(versions: readonly number[], activeVersion?: number): PurposeKeys {
  const held: Record<number, Secret> = {};
  for (const version of versions) held[version] = new Secret(randomKey());
  return { activeVersion: activeVersion ?? Math.max(...versions), versions: held };
}

/**
 * The local key custody with a fresh random version-1 key for every purpose, and the purposes named in `overrides` replaced.
 * `without` leaves purposes out altogether, as a configuration that never held them would.
 */
export function localKeys(
  overrides: Partial<Record<KeyPurpose, PurposeKeys>> = {},
  without: readonly KeyPurpose[] = [],
): LocalKeys {
  const purposes = Object.fromEntries(
    KEY_PURPOSES.filter((purpose) => !without.includes(purpose)).map((purpose) => [
      purpose,
      overrides[purpose] ?? purposeKeys([1]),
    ]),
  ) as Record<KeyPurpose, PurposeKeys>;
  return { custody: 'local', purposes };
}

/** The key material of one version, as the 32 bytes it spells. */
export function keyBytes(keys: PurposeKeys, version: number): Buffer {
  const secret = keys.versions[version];
  if (secret === undefined)
    throw new Error(`the test configuration holds no version ${String(version)}`);
  return Buffer.from(secret.reveal(), 'base64url');
}
