/**
 * The closed vocabularies and bounds of the audit event (audit.md §3), in one place so that the writer, the table's CHECK
 * constraints and the tests read the same lists. `0006_audit_event.sql` repeats the closed sets; a database test inserts every
 * value listed here and refuses one that is not, so the two cannot drift.
 */

/**
 * The version of the canonical serialisation (`canonical-audit-event.ts`) that an event was written under. A checkpoint hashes the
 * canonical form, so a change to that form is a new version and an old event is read under the version it carries (audit.md §2.1).
 */
export const AUDIT_SERIALISATION_VERSION = 1;

/**
 * `object_type` is "a closed set": the identity events use the entity names of domain-model.md §6.8, and `HUB` is admitted for
 * the list-level boundary event of audit.md §5.4, where the object is the foreign hub represented and not a row. Each slice
 * that introduces an event extends the set in the same change (and in the table's CHECK, by a forward migration).
 */
export const AUDIT_OBJECT_TYPES = [
  'StaffIdentity',
  'RiderIdentity',
  'VendorAccount',
  'VendorCredential',
  'Session',
  'MfaFactor',
  'MfaChallenge',
  'RiderSignInChallenge',
  'SetupGrant',
  'RecoveryRequest',
  'RegisteredDevice',
  'HUB',
] as const;

export type AuditObjectType = (typeof AUDIT_OBJECT_TYPES)[number];

export const AUDIT_ACTOR_TYPES = ['STAFF', 'RIDER', 'VENDOR_ACCOUNT', 'SYSTEM'] as const;
export const AUDIT_SURFACES = ['OPS_PORTAL', 'VENDOR_PWA', 'RIDER_ANDROID', 'SYSTEM'] as const;

/**
 * Bounds on what an event may carry. An event is a fact about an act and not a copy of a request, and a ledger that cannot be
 * corrected (it is append-only) must not be able to receive an unbounded or unscreened value. They are engineering limits of
 * this writer, not product values; the table repeats the ones a column can hold.
 */
export const AUDIT_LIMITS = {
  /** Keys in one object of the structured facts. */
  maxKeys: 32,
  /** Nesting of the structured facts (an object in an object counts one). */
  maxDepth: 4,
  maxKeyLength: 64,
  maxStringLength: 512,
  /** The stored size of the structured facts of one field, in bytes of its JSON text. */
  maxJsonBytes: 4096,
  maxNoteLength: 1000,
  maxLabelLength: 200,
  maxStateLength: 64,
  maxBundleLength: 128,
  maxCorrelationLength: 128,
} as const;
