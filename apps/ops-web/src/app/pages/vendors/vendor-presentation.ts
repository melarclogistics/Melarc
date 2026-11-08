import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import type {
  RegisteredDeviceView,
  VendorAccountStatus,
  VendorAccountView,
} from '../../../platform/vendor/vendor-shape';

/** How the vendor screens (S0.52b) name what an account is, in words and never by a code or an id. */
export const VENDOR_STATUS_MAP: StatusMap<VendorAccountStatus> = {
  ACTIVE: { tone: 'success', label: 'Active' },
  SUSPENDED: { tone: 'warning', label: 'Suspended' },
};

export const DEVICE_STATUS_MAP: StatusMap<RegisteredDeviceView['status']> = {
  ACTIVE: { tone: 'success', label: 'Active' },
  REVOKED: { tone: 'neutral', label: 'Revoked' },
  REPLACED: { tone: 'neutral', label: 'Replaced' },
};

/** Whether the vendor has set its shared secret: said, never shown (the secret is never represented). */
export const secretSentence = (account: VendorAccountView): string =>
  account.credential_established ? 'Set' : 'Not set yet';

/** Where its links go, by kind: never the address (the screen has nowhere to show one). */
export function channelSentence(account: VendorAccountView): string {
  if (account.delivery_channel === 'EMAIL') return 'Its registered email';
  if (account.delivery_channel === 'PHONE') return 'Its registered phone';
  return 'None chosen yet';
}

/**
 * Who registered a browser (AC-SLICE-000-15): a browser the vendor registered itself is the organisation's act, never a person's, because the
 * account is shared; one an officer registered is Melarc's. No screen names an individual of the vendor.
 */
export const registeredBySentence = (
  device: RegisteredDeviceView,
  account: VendorAccountView,
): string =>
  device.registered_by === null || device.registered_by === undefined
    ? account.legal_name
    : 'Melarc';
