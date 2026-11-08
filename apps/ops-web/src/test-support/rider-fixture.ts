import type { components } from '@melarc/api-client';

/**
 * Real-shaped answers of the rider reads and acts, for tests (S0.60). Every field the contract requires is present and each value is synthetic.
 * The types are the contract's: nothing here describes the wire a second time.
 */
type RiderBody = components['schemas']['RiderSummary'];
type RiderDeviceBody = components['schemas']['RegisteredDevice'];
type EnrolmentGrantBody = components['schemas']['DeviceEnrolmentGrant'];

export const RIDER_ID = '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a';
export const OTHER_RIDER_ID = '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c';
/** The hub of `sessionFixture`, so that a session's hubs name it. */
export const RIDER_HUB_ID = '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d';
export const RIDER_DEVICE_ID = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
export const RIDER_OFFICER_ID = '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e';

/** The two halves of a sentinel enrolment code: 43 base64url characters each, as the contract has them, and recognisable wherever they turn up. */
export const ENROLMENT_TOKEN = 'SentinelEnrolmentToken'.padEnd(43, 'x');
export const ENROLMENT_CHALLENGE = 'SentinelEnrolmentChallenge'.padEnd(43, 'y');
/** The whole of a version-1 code: 127 ASCII characters. */
export const ENROLMENT_URI = `melarc-rider://enrol/v1#token=${ENROLMENT_TOKEN}&challenge=${ENROLMENT_CHALLENGE}`;

/** Every form in which the code can turn up on a page, in a cache or in a request: whole, encoded, and each half alone. */
export const ENROLMENT_FORMS = [
  ENROLMENT_URI,
  encodeURIComponent(ENROLMENT_URI),
  ENROLMENT_TOKEN,
  ENROLMENT_CHALLENGE,
] as const;

export function riderFixture(overrides: Partial<RiderBody> = {}): RiderBody {
  return {
    id: RIDER_ID,
    full_name: 'Kwame Mensah',
    phone: '+233201234567',
    status: 'ACTIVE',
    primary_hub_id: RIDER_HUB_ID,
    pin_established: true,
    has_active_device: true,
    ...overrides,
  };
}

export function riderDeviceFixture(overrides: Partial<RiderDeviceBody> = {}): RiderDeviceBody {
  return {
    id: RIDER_DEVICE_ID,
    principal_type: 'RIDER',
    principal_id: RIDER_ID,
    device_kind: 'RIDER_ANDROID_KEYPAIR',
    status: 'ACTIVE',
    registered_at: '2026-10-20T09:00:00Z',
    registered_by: RIDER_OFFICER_ID,
    ...overrides,
  };
}

/** A rider with no device at all: neither a PIN nor a device, as a rider is before the first binding. */
export const unboundRider = (overrides: Partial<RiderBody> = {}): RiderBody =>
  riderFixture({ pin_established: false, has_active_device: false, ...overrides });

/** `getRider` answers: the rider and the devices the rider has held. */
export function riderDetailFixture(
  rider: RiderBody = riderFixture(),
  devices: RiderDeviceBody[] = [riderDeviceFixture({ principal_id: rider.id })],
): { rider: RiderBody; devices: RiderDeviceBody[] } {
  return { rider, devices };
}

/** The answer to a registration. It lapses `lifetimeMs` after it is made, as the server's does. */
export function enrolmentGrantFixture(
  overrides: Partial<EnrolmentGrantBody> = {},
  lifetimeMs = 5 * 60 * 1000,
): EnrolmentGrantBody {
  return {
    enrolment_uri: ENROLMENT_URI,
    expires_at: new Date(Date.now() + lifetimeMs).toISOString(),
    rider_id: RIDER_ID,
    ...overrides,
  };
}
