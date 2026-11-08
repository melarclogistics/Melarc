import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import type {
  RiderDeviceStatus,
  RiderDeviceView,
  RiderStatus,
  RiderView,
} from '../../../platform/rider/rider-shape';

/** How the rider screens (S0.60) name what a rider is, in words and never by a code or an id. */
export const RIDER_STATUS_MAP: StatusMap<RiderStatus> = {
  ACTIVE: { tone: 'success', label: 'Active' },
  INACTIVE: { tone: 'neutral', label: 'Inactive' },
  TEMPORARILY_UNAVAILABLE: { tone: 'warning', label: 'Temporarily unavailable' },
  SUSPENDED: { tone: 'warning', label: 'Suspended' },
  OFFBOARDED: { tone: 'neutral', label: 'Offboarded' },
};

export const RIDER_DEVICE_STATUS_MAP: StatusMap<RiderDeviceStatus> = {
  ACTIVE: { tone: 'success', label: 'Active' },
  REVOKED: { tone: 'neutral', label: 'Revoked' },
  REPLACED: { tone: 'neutral', label: 'Replaced' },
};

/** The statuses in the order a filter lists them: the working one first. */
export const RIDER_STATUS_ORDER: readonly RiderStatus[] = [
  'ACTIVE',
  'INACTIVE',
  'TEMPORARILY_UNAVAILABLE',
  'SUSPENDED',
  'OFFBOARDED',
];

/** Whether the rider has set a PIN: said, never shown (a PIN is never represented). */
export const pinSentence = (rider: RiderView): string =>
  rider.pin_established ? 'Set' : 'Not set yet';

/** Whether a device is `ACTIVE`: the rider holds at most one. */
export const deviceSentence = (rider: RiderView): string =>
  rider.has_active_device ? 'One active device' : 'No active device';

/** What the status means for signing in, in a sentence. A status other than `ACTIVE` refuses a sign-in whatever the device and the PIN say. */
export function statusSentence(status: RiderStatus): string {
  switch (status) {
    case 'ACTIVE':
      return 'This rider is active.';
    case 'INACTIVE':
      return 'This rider cannot sign in while they are inactive.';
    case 'TEMPORARILY_UNAVAILABLE':
      return 'This rider cannot sign in while they are temporarily unavailable.';
    case 'SUSPENDED':
      return 'This rider is suspended and cannot sign in.';
    case 'OFFBOARDED':
      return 'This rider has left and cannot sign in.';
  }
}

/**
 * Whether the rider is ready to sign in: active, with a PIN and an `ACTIVE` device (the readiness the roster derives, never stored). Said as a
 * sentence that names what is missing, so that an officer sees what to do next.
 */
export function readinessSentence(rider: RiderView): string {
  if (rider.status !== 'ACTIVE') return 'Not ready: the rider is not active.';
  if (rider.pin_established && rider.has_active_device) return 'Ready to sign in.';
  if (!rider.pin_established && !rider.has_active_device) {
    return 'Not ready: the rider has no device yet and has not set a PIN. Both come with the first device.';
  }
  if (!rider.has_active_device) return 'Not ready: the rider has no active device.';
  return 'Not ready: the rider has not set a PIN.';
}

/**
 * A status at which a device may be bound (the first binding and a replacement): the server refuses the others with `STATE_CONFLICT`. The
 * specifications are silent on it; the build holds the line that costs nothing (plan section 7.47), so the page offers a binding only here.
 */
export function mayBindDevice(status: RiderStatus): boolean {
  return status === 'ACTIVE' || status === 'INACTIVE' || status === 'TEMPORARILY_UNAVAILABLE';
}

/** Who registered a device: an officer's id is never shown, only that Melarc did, in person; a device with no record says so. */
export const registeredBySentence = (device: RiderDeviceView): string =>
  device.registered_by === null || device.registered_by === undefined
    ? 'Not recorded'
    : 'A Melarc officer, in person';
