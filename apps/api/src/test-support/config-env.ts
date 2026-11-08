import { randomBytes } from 'node:crypto';

import { KEY_PURPOSES, keyEnvName } from '../platform/config/key-material.js';

export const RUNTIME_URL = 'postgres://melarc_api_runtime:CHANGE_ME@127.0.0.1:5432/melarc_dev';

/** One key in the form the settings take: 32 random bytes as 43 unpadded base64url characters. */
export const randomKey = (): string => randomBytes(32).toString('base64url');

/**
 * A complete, valid environment for a local run: every required setting, fresh random key material for each purpose (so no two
 * differ by accident or agree by accident), and none of the optional ones. A key mapped to `undefined` is removed, so a test
 * can say "this one absent". Nothing here is a secret: the keys exist for one test and are never written anywhere.
 */
export function validEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const base: Record<string, string> = {
    NODE_ENV: 'development',
    APP_ENV: 'local',
    HTTP_PORT: '3000',
    DATABASE_URL: RUNTIME_URL,
    OPS_ORIGIN: 'http://127.0.0.1:5173',
    VENDOR_ORIGIN: 'http://127.0.0.1:5174',
    KEY_CUSTODY: 'local',
  };
  for (const purpose of KEY_PURPOSES) {
    base[keyEnvName(purpose, 'MATERIAL')] = `1:${randomKey()}`;
    base[keyEnvName(purpose, 'ACTIVE_VERSION')] = '1';
  }
  const merged: Record<string, string | undefined> = { ...base, ...overrides };
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** What a staging or production deployment must set beyond a local one: production mode and https origins. */
export function deployedEnv(
  appEnv: 'staging' | 'production',
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  return validEnv({
    NODE_ENV: 'production',
    APP_ENV: appEnv,
    OPS_ORIGIN: 'https://ops.melarc.example',
    VENDOR_ORIGIN: 'https://vendor.melarc.example',
    ...overrides,
  });
}
