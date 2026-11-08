import { createHash } from 'node:crypto';

import type { RegisteredDeviceRecord } from '../registered-device-store.js';

/**
 * The version of a vendor account's device set (`listVendorDevices`'s `ETag`, the `If-Match` of `revokeVendorDevice`; domain-model.md
 * section 6.8, "A vendor account's device set: a browser is registered or revoked"): an opaque strong validator, the digest of every
 * browser the account has held as the list answers it, in its order. It changes when a browser is registered or ended, and with nothing
 * else (a sign-in, a lock and a session change none of it).
 */
const DOMAIN = 'melarc.vendor-device-set-etag.v1';
const DEVICE_SET_ETAG = /^"[A-Za-z0-9_-]{43}"$/;

export function deviceSetEtagOf(devices: readonly RegisteredDeviceRecord[]): string {
  const fields = devices.map((device) => {
    const each: Record<keyof RegisteredDeviceRecord, unknown> = {
      id: device.id,
      principal_type: device.principal_type,
      principal_id: device.principal_id,
      device_kind: device.device_kind,
      status: device.status,
      registered_at: device.registered_at,
      registered_by: device.registered_by,
    };
    return Object.values(each);
  });
  const digest = createHash('sha256')
    .update(JSON.stringify([DOMAIN, fields]), 'utf8')
    .digest('base64url');
  return `"${digest}"`;
}

/** Whether the header is exactly the current version. Missing, weak, a list, unquoted, another form and different all answer `false`. */
export function deviceSetEtagMatches(header: string | undefined, current: string): boolean {
  return typeof header === 'string' && DEVICE_SET_ETAG.test(header) && header === current;
}
