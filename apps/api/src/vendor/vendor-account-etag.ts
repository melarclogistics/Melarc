import { createHash } from 'node:crypto';

import type { RegisteredDeviceView, VendorAccountView } from './vendor-account-view.js';

/**
 * The ETag of a vendor account (`getVendorAccount`; the `If-Match` that `reissueVendorCredentialSetup` and `recoverVendorCredential` take):
 * an **opaque strong validator of what the read returned**, in the form of the staff identity's (`staff-identity-etag.ts`). It is the digest
 * of the complete representation (every field of the account's view and of each browser it has held, in the read's order) and of the
 * credential's **generation**, which moves when the secret is set or replaced and which no read shows. So it changes when the account's
 * status, its credential or its set of browsers changes, and never for a failed sign-in, a lock or a rehash of the secret at a new cost,
 * which neither the representation nor the generation holds. A mutation compares it under the credential's lock, recomputed from the same
 * facts in that transaction.
 */
const DOMAIN = 'melarc.vendor-account-etag.v1';

/** The fields in the order hashed. The record types have exactly the keys of the views, so a field added there stops this file building. */
function accountFields(view: VendorAccountView): readonly unknown[] {
  const fields: Record<keyof VendorAccountView, unknown> = {
    id: view.id,
    account_identifier: view.account_identifier,
    vendor_organization_id: view.vendor_organization_id,
    legal_name: view.legal_name,
    responsible_hub_id: view.responsible_hub_id,
    status: view.status,
    credential_established: view.credential_established,
    active_device_count: view.active_device_count,
    has_recovery_email: view.has_recovery_email,
    has_recovery_phone: view.has_recovery_phone,
    delivery_channel: view.delivery_channel,
  };
  return Object.values(fields);
}

function deviceFields(view: RegisteredDeviceView): readonly unknown[] {
  const fields: Record<keyof RegisteredDeviceView, unknown> = {
    id: view.id,
    principal_type: view.principal_type,
    principal_id: view.principal_id,
    device_kind: view.device_kind,
    status: view.status,
    registered_at: view.registered_at,
    registered_by: view.registered_by,
  };
  return Object.values(fields);
}

const VENDOR_ETAG = /^"[A-Za-z0-9_-]{43}"$/;

export function vendorAccountEtagOf(
  account: VendorAccountView,
  devices: readonly RegisteredDeviceView[],
  generation: number,
): string {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError('A credential generation is a non-negative safe integer');
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        DOMAIN,
        generation,
        accountFields(account),
        devices.map((device) => deviceFields(device)),
      ]),
      'utf8',
    )
    .digest('base64url');
  return `"${digest}"`;
}

/** Whether the header is exactly the current ETag. Missing, weak, a list, unquoted, another form and different all answer `false`. */
export function vendorAccountEtagMatches(header: string | undefined, current: string): boolean {
  return typeof header === 'string' && VENDOR_ETAG.test(header) && header === current;
}
