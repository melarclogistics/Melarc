/**
 * The closed sets of the vendor's identity records (domain-model.md section 6.8 `VendorAccount`, `VendorCredential`, `RegisteredDevice`;
 * section 6.16 `VendorOrganization`; SECURITY_DESIGN.md section 13.7a). The tables repeat each set as a CHECK, built from these constants,
 * so the code and the database cannot drift apart. They live in `platform/auth` because the credential services read them; the tables
 * themselves are the vendor domain's (`src/vendor/`), which imports these and never the reverse.
 */

/** `VendorOrganization.operational_status` (state-machines.md section 14, the states fixed from section 36.12). */
export const VENDOR_ORGANIZATION_STATUSES = [
  'CREATED_BY_OPS',
  'PENDING_SENIOR_OPS_REVIEW',
  'ACTIVE',
  'REJECTED',
  'SUSPENDED',
  'TERMINATED',
] as const;
export type VendorOrganizationStatus = (typeof VENDOR_ORGANIZATION_STATUSES)[number];

/** The organisation states that have been decided by a reviewer: everything but the two before the decision. */
export const DECIDED_ORGANIZATION_STATUSES = [
  'ACTIVE',
  'REJECTED',
  'SUSPENDED',
  'TERMINATED',
] as const;

/**
 * The organisation states in which its account may recover a credential (credential-recovery.md section 5.7; Product decision of
 * 9 October 2026): `ACTIVE` and `SUSPENDED`. `REJECTED` and `TERMINATED` are terminal, and the two before the decision can hold no
 * credential.
 */
export const RECOVERABLE_ORGANIZATION_STATUSES: readonly VendorOrganizationStatus[] = [
  'ACTIVE',
  'SUSPENDED',
];

/** `VendorAccount.status`: credential and session standing, which is not the organisation's operational approval. */
export const VENDOR_ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type VendorAccountStatus = (typeof VENDOR_ACCOUNT_STATUSES)[number];

/** `VendorCredential.delivery_channel`: the registered channel a setup grant, a recovery link and a device grant go by. */
export const VENDOR_DELIVERY_CHANNELS = ['PHONE', 'EMAIL'] as const;
export type VendorDeliveryChannel = (typeof VENDOR_DELIVERY_CHANNELS)[number];

/**
 * The account identifier (SECURITY_DESIGN.md section 13.7a): eight characters of `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (31 symbols, no 0, O, 1,
 * I or L), stored upper case and compared without regard to case. **Not a secret and not a control.**
 */
export const ACCOUNT_IDENTIFIER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ACCOUNT_IDENTIFIER_LENGTH = 8;
export const ACCOUNT_IDENTIFIER_PATTERN = '^[2-9A-HJKMNP-Z]{8}$';
const ACCOUNT_IDENTIFIER = new RegExp(ACCOUNT_IDENTIFIER_PATTERN);

/**
 * The canonical form of an identifier as a person types it: trimmed and upper-cased, and the identifier only when what is left is one.
 * Nothing else is folded: an `O` typed for a `0` is not an identifier, because neither is in the alphabet.
 */
export function canonicalAccountIdentifier(typed: string): string | undefined {
  const canonical = typed.trim().toUpperCase();
  return ACCOUNT_IDENTIFIER.test(canonical) ? canonical : undefined;
}

/** `RegisteredDevice.status` (domain-model.md section 6.8): both non-active states are terminal, and `REVOKED` never becomes `REPLACED`. */
export const DEVICE_STATUSES = ['ACTIVE', 'REPLACED', 'REVOKED'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/**
 * The device kinds and the principal types that hold one: the vendor's browser credential (S0.47) and the rider's hardware-backed key pair
 * (S0.53, migration 0040). `registered_device` is one table for both, as the domain model has it, and each kind has its own shape.
 */
export const BUILT_DEVICE_KINDS = ['VENDOR_BROWSER_CREDENTIAL', 'RIDER_ANDROID_KEYPAIR'] as const;
export const BUILT_DEVICE_PRINCIPAL_TYPES = ['VENDOR', 'RIDER'] as const;

/** The SHA-256 of a device credential's 32 decoded bytes (`TokenService.hash`): what the table keeps. */
export const DEVICE_CREDENTIAL_HASH_BYTES = 32;
