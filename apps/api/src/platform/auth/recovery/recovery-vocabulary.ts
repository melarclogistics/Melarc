/**
 * The closed sets and fixed figures of the recovery request (S0.50; domain-model.md section 6.8 `RecoveryRequest`; credential-recovery.md
 * sections 5.5 and 5.7). The table's CHECKs are written from these, so the code and the table cannot disagree.
 *
 * **Narrower than the entity, on purpose.** The domain model lists `RIDER` as a principal type and `OPS_VERIFIED` as a channel, for a
 * rider path with no token. That path is `reregisterRiderDevice`, which issues a `SetupGrant` (`AC-SLICE-000-108`), and a request
 * "exists only for an eligible principal ... never a rider" (the same section). So a recovery request here is a staff identity's or a
 * vendor account's, always carries a token and always travels by message: the rider values are not admitted until a task builds them.
 */
export const RECOVERY_PRINCIPAL_TYPES = ['STAFF', 'VENDOR'] as const;
export type RecoveryPrincipalType = (typeof RECOVERY_PRINCIPAL_TYPES)[number];

/** How the link travels: a staff member's verified work email; a vendor's registered email or phone (`SMS`), as its approver chose. */
export const RECOVERY_CHANNELS = ['EMAIL', 'SMS'] as const;
export type RecoveryChannel = (typeof RECOVERY_CHANNELS)[number];

/** The channels each principal type may be reached by. */
export const CHANNELS_OF_PRINCIPAL: Readonly<
  Record<RecoveryPrincipalType, readonly RecoveryChannel[]>
> = Object.freeze({
  STAFF: ['EMAIL'],
  VENDOR: ['EMAIL', 'SMS'],
});

/** `PENDING`, then one terminal state. `SUPERSEDED`: ended because a recovery of the same credential completed, or the principal's access ended. */
export const RECOVERY_REQUEST_STATES = ['PENDING', 'CONSUMED', 'EXPIRED', 'SUPERSEDED'] as const;
export type RecoveryRequestState = (typeof RECOVERY_REQUEST_STATES)[number];

/** The SHA-256 of the token's 32 decoded bytes (`TokenService.hash`). */
export const RECOVERY_TOKEN_HASH_BYTES = 32;

/** The lifetime of a link, in minutes (settings.md section 7.5): the one figure, never the store's own. */
export const RECOVERY_LINK_LIFETIME_SETTING = 'recovery_link_ttl_minutes';

/** The window after a live link was issued in which a self-service request issues nothing (settings.md section 7.5; section 5.5). */
export const RECOVERY_GUARD_SETTING = 'recovery_request_supersede_guard_seconds';

/**
 * At most this many unexpired, unconsumed links of one credential, self-service and administrator-initiated combined (Product decision of
 * 8 October 2026). "The cap is a constant of this rule and not a setting."
 */
export const RECOVERY_LIVE_LINK_CAP = 2;

/** The record a delivery job serves when it carries a recovery link, and the job's kind. */
export const RECOVERY_REDEMPTION_TYPE = 'RECOVERY_REQUEST';
export const RECOVERY_DELIVERY_KIND = 'RECOVERY_LINK';
