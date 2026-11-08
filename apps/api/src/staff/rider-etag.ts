import { createHash } from 'node:crypto';

import type { RiderDeviceView, RiderView } from './rider-view.js';

/**
 * The ETag of a rider (`getRider`; the `If-Match` that `reregisterRiderDevice` takes): an **opaque strong validator of what the read
 * returned**, in the form of the vendor account's (`vendor-account-etag.ts`). It is the digest of the complete representation (every field
 * of the rider's view and of each device the rider has held, in the read's order) and of the PIN's **generation**, which moves when the PIN
 * is set or replaced and which no read shows. So it changes when the rider's status, name, number or hub changes, when the PIN is
 * established or replaced, and when the device set changes (a registration, a replacement, a revocation), and **never for a failed
 * sign-in, a lock or a rehash of the PIN at a new cost**, which neither the representation nor the generation holds. A mutation compares it
 * under the rider's lock, recomputed from the same facts in that transaction.
 */
const DOMAIN = 'melarc.rider-etag.v1';

/** The fields in the order hashed. The record types have exactly the keys of the views, so a field added there stops this file building. */
function riderFields(view: RiderView): readonly unknown[] {
  const fields: Record<keyof RiderView, unknown> = {
    id: view.id,
    full_name: view.full_name,
    phone: view.phone,
    status: view.status,
    primary_hub_id: view.primary_hub_id,
    pin_established: view.pin_established,
    has_active_device: view.has_active_device,
  };
  return Object.values(fields);
}

function deviceFields(view: RiderDeviceView): readonly unknown[] {
  const fields: Record<keyof RiderDeviceView, unknown> = {
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

const RIDER_ETAG = /^"[A-Za-z0-9_-]{43}"$/;

export function riderEtagOf(
  rider: RiderView,
  devices: readonly RiderDeviceView[],
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
        riderFields(rider),
        devices.map((device) => deviceFields(device)),
      ]),
      'utf8',
    )
    .digest('base64url');
  return `"${digest}"`;
}

/** Whether the header is exactly the current ETag. Missing, weak, a list, unquoted, another form and different all answer `false`. */
export function riderEtagMatches(header: string | undefined, current: string): boolean {
  return typeof header === 'string' && RIDER_ETAG.test(header) && header === current;
}
