import type { components } from '@melarc/api-client';

import { instantOf, isOneOf, isRecord, lineOf, optional, uuidOf } from '../staff/staff-shape';

/**
 * What the rider screens (S0.60) believe of an answer, judged field by field before anything is drawn, as the identity and vendor screens'
 * are (`staff-shape.ts`, `vendor-shape.ts`). The contract gives a rider's **identity and readiness only** (name, phone, status, hub, whether a
 * PIN is set and whether a device is `ACTIVE`) and a device's identity and status: never a PIN, a hash, a key or an attestation. The shapes
 * here read those fields and no other, so a field a server should never send has nowhere to go.
 *
 * The one exception to "a screen holds no credential" is the enrolment grant (`parseEnrolmentGrant`): the version-1 URI of a QR code is a
 * short-lived bearer credential that the officer's browser must hold to draw it. Its parser accepts the one exact form, and the page that
 * holds it keeps it in memory only (`useTransientSecret`).
 */
export type RiderView = components['schemas']['RiderSummary'];
export type RiderStatus = RiderView['status'];
export type RiderDeviceView = components['schemas']['RegisteredDevice'];
export type RiderDeviceStatus = RiderDeviceView['status'];

export interface RiderPageView {
  readonly items: readonly RiderView[];
  readonly nextPageToken: string | null;
}

export interface RiderDetailView {
  readonly rider: RiderView;
  readonly devices: readonly RiderDeviceView[];
}

/**
 * What a registration answers: the whole of the QR code and when it lapses. **The URI is a credential**: it is a transient secret, held in
 * memory by the one page that draws it, and written nowhere else (not a query, a storage, the address, a log or an attribute).
 */
export interface EnrolmentGrantView {
  readonly enrolmentUri: string;
  readonly expiresAt: string;
}

export const RIDER_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  'TEMPORARILY_UNAVAILABLE',
  'SUSPENDED',
  'OFFBOARDED',
] as const;

const DEVICE_STATUSES = ['ACTIVE', 'REPLACED', 'REVOKED'] as const;

/** The fields each guard reads, held to the contract by `test/rider-contract.test.ts` (the way `STAFF_FIELDS` is for the identity screens). */
export const RIDER_FIELDS = {
  RiderSummary: {
    required: [
      'id',
      'full_name',
      'phone',
      'status',
      'primary_hub_id',
      'pin_established',
      'has_active_device',
    ],
    optional: [],
    enums: { status: RIDER_STATUSES },
  },
  RiderDetail: {
    required: ['rider', 'devices'],
    optional: [],
    enums: {},
  },
  RegisteredDevice: {
    required: ['id', 'principal_type', 'principal_id', 'device_kind', 'status'],
    optional: ['registered_at', 'registered_by'],
    enums: { status: DEVICE_STATUSES },
  },
  DeviceEnrolmentGrant: {
    required: ['enrolment_uri', 'expires_at'],
    optional: ['rider_id'],
    enums: {},
  },
} as const;

/** A phone number as the rider's records hold it: E.164, nothing folded or completed. */
const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * The version-1 enrolment URI of the contract (`DeviceEnrolmentGrant.enrolment_uri`; SECURITY_DESIGN.md section 13.6): the exact scheme, host
 * and path, one token and one challenge in the fragment, each 32 random bytes as 43 unpadded base64url characters, so exactly 127 ASCII
 * characters. Anything else is not a code the Rider app will take, and is not drawn.
 */
export const ENROLMENT_URI =
  /^melarc-rider:\/\/enrol\/v1#token=[A-Za-z0-9_-]{43}&challenge=[A-Za-z0-9_-]{43}$/;
export const ENROLMENT_URI_LENGTH = 127;

const MAX_PAGE_ITEMS = 100;
/** A rider holds few devices over a career; a list far beyond what a business keeps is not the API's. */
const MAX_DEVICES = 200;
const MAX_TOKEN = 2048;

/** One rider of the roster or the record, or nothing when it is not one the screens may show. */
export function parseRider(body: unknown): RiderView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const name = lineOf(body.full_name);
  const hub = uuidOf(body.primary_hub_id);
  if (
    id === undefined ||
    name === undefined ||
    hub === undefined ||
    typeof body.phone !== 'string' ||
    !E164.test(body.phone) ||
    !isOneOf(RIDER_STATUSES, body.status) ||
    typeof body.pin_established !== 'boolean' ||
    typeof body.has_active_device !== 'boolean'
  ) {
    return undefined;
  }
  return {
    id,
    full_name: name,
    phone: body.phone,
    status: body.status,
    primary_hub_id: hub,
    pin_established: body.pin_established,
    has_active_device: body.has_active_device,
  };
}

/** A page of `listRiders`. */
export function parseRiderPage(body: unknown): RiderPageView | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const items = body.items.map(parseRider);
  const token = body.next_page_token;
  if (items.some((item) => item === undefined)) return undefined;
  if (
    token !== null &&
    (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN)
  ) {
    return undefined;
  }
  return { items: items as RiderView[], nextPageToken: token };
}

/** One device of the rider: its id, its status and when it was registered and by whom. Never a key, a hash or an attestation. */
export function parseRiderDevice(body: unknown, riderId: string): RiderDeviceView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const registeredAt = optional(body.registered_at, instantOf);
  const registeredBy = optional(body.registered_by, uuidOf);
  if (
    id === undefined ||
    body.principal_type !== 'RIDER' ||
    typeof body.principal_id !== 'string' ||
    body.principal_id.toLowerCase() !== riderId.toLowerCase() ||
    body.device_kind !== 'RIDER_ANDROID_KEYPAIR' ||
    !isOneOf(DEVICE_STATUSES, body.status) ||
    registeredAt === undefined ||
    registeredBy === undefined
  ) {
    return undefined;
  }
  return {
    id,
    principal_type: 'RIDER',
    principal_id: body.principal_id,
    device_kind: 'RIDER_ANDROID_KEYPAIR',
    status: body.status,
    ...(registeredAt === null ? {} : { registered_at: registeredAt }),
    registered_by: registeredBy,
  };
}

/** `getRider`: the rider and every device the rider has held. */
export function parseRiderDetail(body: unknown): RiderDetailView | undefined {
  if (!isRecord(body) || !Array.isArray(body.devices) || body.devices.length > MAX_DEVICES) {
    return undefined;
  }
  const rider = parseRider(body.rider);
  if (rider === undefined) return undefined;
  const devices = body.devices.map((device) => parseRiderDevice(device, rider.id));
  if (devices.some((device) => device === undefined)) return undefined;
  return { rider, devices: devices as RiderDeviceView[] };
}

/**
 * The answer of `registerRiderDevice` and `reregisterRiderDevice` for the rider asked for, or nothing when it is not one: the exact version-1
 * URI and the moment it lapses. A grant that names another rider is not the one asked for. The result holds the credential and nothing else.
 */
export function parseEnrolmentGrant(
  body: unknown,
  riderId: string,
): EnrolmentGrantView | undefined {
  if (!isRecord(body)) return undefined;
  const expiresAt = instantOf(body.expires_at);
  const named = optional(body.rider_id, uuidOf);
  if (
    typeof body.enrolment_uri !== 'string' ||
    body.enrolment_uri.length !== ENROLMENT_URI_LENGTH ||
    !ENROLMENT_URI.test(body.enrolment_uri) ||
    expiresAt === undefined ||
    named === undefined ||
    (named !== null && named.toLowerCase() !== riderId.toLowerCase())
  ) {
    return undefined;
  }
  return { enrolmentUri: body.enrolment_uri, expiresAt };
}
