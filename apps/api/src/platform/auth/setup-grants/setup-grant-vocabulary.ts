/**
 * The closed sets of a setup grant (S0.29; domain-model.md §6.8 `SetupGrant`; state-machines.md §18 and §19; SECURITY_DESIGN.md §13.9).
 * The table repeats every set as a CHECK (migration 0018), and a database test compares the two, so the code and the database cannot
 * drift apart; a unit test holds the sets to the documents.
 */

/** Whose act the grant authorises. Which table the principal's id points into is the type's to say, so no foreign key joins them. */
export const GRANT_PRINCIPAL_TYPES = ['STAFF', 'RIDER', 'VENDOR'] as const;
export type GrantPrincipalType = (typeof GRANT_PRINCIPAL_TYPES)[number];

/**
 * The eight purposes, in the order of domain-model.md §6.8. `VENDOR_CREDENTIAL_RECOVERY` is not one of them: it was withdrawn
 * (R1.3), because replacing a credential somebody already holds is a `RecoveryRequest`, not a grant.
 */
export const SETUP_GRANT_PURPOSES = [
  'STAFF_CREDENTIAL_SETUP',
  'MFA_ENROLMENT',
  'MFA_REENROLMENT',
  'BOOTSTRAP_SETUP',
  'RIDER_DEVICE_ENROLMENT',
  'RIDER_DEVICE_REREGISTRATION',
  'VENDOR_CREDENTIAL_SETUP',
  'VENDOR_DEVICE_ENROLMENT',
] as const;
export type SetupGrantPurpose = (typeof SETUP_GRANT_PURPOSES)[number];

/** The purposes each kind of principal can be given: a purpose belongs to one principal type, and a grant is principal-bound. */
export const PURPOSES_OF_PRINCIPAL: Readonly<
  Record<GrantPrincipalType, readonly SetupGrantPurpose[]>
> = {
  STAFF: ['STAFF_CREDENTIAL_SETUP', 'MFA_ENROLMENT', 'MFA_REENROLMENT', 'BOOTSTRAP_SETUP'],
  RIDER: ['RIDER_DEVICE_ENROLMENT', 'RIDER_DEVICE_REREGISTRATION'],
  VENDOR: ['VENDOR_CREDENTIAL_SETUP', 'VENDOR_DEVICE_ENROLMENT'],
};

/** `PENDING` is the one state a grant can leave; the other three are terminal and are never rewritten (state-machines.md §19). */
export const SETUP_GRANT_STATES = ['PENDING', 'CONSUMED', 'EXPIRED', 'SUPERSEDED'] as const;
export type SetupGrantState = (typeof SETUP_GRANT_STATES)[number];
export const TERMINAL_GRANT_STATES = ['CONSUMED', 'EXPIRED', 'SUPERSEDED'] as const;

/** The one purpose with no expiry: a clock there could strand provisioning into an environment nobody can sign into. */
export const NO_EXPIRY_PURPOSE = 'BOOTSTRAP_SETUP';

/**
 * The lifetime of every other purpose is the existing `recovery_link_ttl_minutes` (30), reused and not a figure of its own
 * (state-machines.md §19): a second security-link interval would be a value nobody approved.
 */
export const SETUP_GRANT_LIFETIME_SETTING = 'recovery_link_ttl_minutes';

/** The three purposes whose consumption creates a `PENDING` factor, and the one whose consumption, with a proven code, activates it. */
export const FACTOR_CREATING_PURPOSES = [
  'STAFF_CREDENTIAL_SETUP',
  'BOOTSTRAP_SETUP',
  'MFA_REENROLMENT',
] as const;
export type FactorCreatingPurpose = (typeof FACTOR_CREATING_PURPOSES)[number];
export const FACTOR_ACTIVATING_PURPOSE = 'MFA_ENROLMENT';

/**
 * The continuation grant: issued when one of the three creating purposes is consumed, and the only purpose that names the grant whose
 * consumption produced it (`continued_from_grant_id`).
 */
export const CONTINUATION_PURPOSE = 'MFA_ENROLMENT';
export const CONTINUED_FROM_PURPOSES: readonly SetupGrantPurpose[] = FACTOR_CREATING_PURPOSES;

/** The grants a reset episode can carry: the re-enrolment an administrative reset issues, and the continuation that follows it. */
export const EPISODE_PURPOSES = ['MFA_REENROLMENT', 'MFA_ENROLMENT'] as const;

/** The two rider grants, each with the hash of the attestation challenge issued beside it and for no other purpose. */
export const RIDER_DEVICE_PURPOSES = [
  'RIDER_DEVICE_ENROLMENT',
  'RIDER_DEVICE_REREGISTRATION',
] as const;

/**
 * The purposes whose grant reaches its principal as a message, through the durable delivery job (SECURITY_DESIGN.md §13.9a). Four do
 * not travel that way and never enter the queue: the two rider grants (shown as a QR), the continuation (returned in the response that
 * created the factor) and the bootstrap secret (the controlled provisioning channel).
 */
export const MESSAGE_PURPOSES = [
  'STAFF_CREDENTIAL_SETUP',
  'VENDOR_CREDENTIAL_SETUP',
  'MFA_REENROLMENT',
  'VENDOR_DEVICE_ENROLMENT',
] as const;

export const isMessagePurpose = (purpose: unknown): boolean =>
  typeof purpose === 'string' && (MESSAGE_PURPOSES as readonly string[]).includes(purpose);

/** A token is stored as the SHA-256 of the 32 bytes it is made of, and never in any other form. */
export const GRANT_TOKEN_HASH_BYTES = 32;
