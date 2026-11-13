/**
 * The closed vocabularies of the evidence record (S1.11; domain-model.md section 3.6; state-machines.md section 17). One place, so that the table's checks, the services and
 * the tests read the same lists; a test holds them to the contract's enums.
 */

/** The storage lifecycle: a declared record, a stored one, and an abandoned capture (kept, never deleted). */
export const EVIDENCE_STATES = ['PENDING_UPLOAD', 'STORED', 'EXPIRED'] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

/** The records an evidence record can evidence (`EvidenceCreate.owner_type` of the contract). */
export const EVIDENCE_OWNER_TYPES = [
  'PICKUP_STOP',
  'PICKUP_INTAKE',
  'ORDER',
  'DELIVERY_STOP',
  'THIRD_PARTY_HANDOFF',
  'MOTORCYCLE',
  'FUEL_RECORD',
  'VENDOR_ORGANIZATION',
  'APPROVED_AGENT',
] as const;
export type EvidenceOwnerType = (typeof EVIDENCE_OWNER_TYPES)[number];

/**
 * Why it was captured (`EvidenceCreate.purpose` of the contract). `PARCEL_PHOTO` is the photo of one parcel at the door (D-A10, 12 November 2026): a collection record keeps exactly
 * one for each parcel counted (`collection_parcel_photo`), and it is told from `COLLECTION_PROOF`, the photo a failure or a short count's reason asks for.
 */
export const EVIDENCE_PURPOSES = [
  'COLLECTION_PROOF',
  'PARCEL_PHOTO',
  'CONDITION',
  'OSD',
  'HANDOFF_RECEIPT',
  'DELIVERY_PROOF',
  'RETURN_PROOF',
  'MAINTENANCE',
  'FUEL',
  'COMPLIANCE_DOCUMENT',
] as const;
export type EvidencePurpose = (typeof EVIDENCE_PURPOSES)[number];

/** Who captured it: a staff member, a rider, or a vendor's account. */
export const EVIDENCE_CAPTURE_PRINCIPALS = ['STAFF', 'RIDER', 'VENDOR'] as const;
export type EvidenceCapturePrincipal = (typeof EVIDENCE_CAPTURE_PRINCIPALS)[number];

/**
 * `access_rule` and `retention_policy` are enums that `domain-model.md` section 3.6 names and never lists ("who may retrieve it", "category key; periods are `OQ-028`"). Each has
 * the one value this build needs, defined here and recorded for the Product Owner to confirm: **`SUBJECT_READERS`**, retrievable by those who hold the read permission of the
 * record the evidence is about, within that record's hub (and vendor, where it has one); and **`PICKUP_STOP_EVIDENCE`**, the category of evidence about a pickup stop. No period
 * is stated or invented: retention is the owner's (`OQ-028`, OB-S1-05). A later owner type adds its value in its own migration.
 */
export const EVIDENCE_ACCESS_RULES = ['SUBJECT_READERS'] as const;
export const EVIDENCE_RETENTION_POLICIES = ['PICKUP_STOP_EVIDENCE'] as const;

/** The kind of file a signature check can recognise from the first bytes of an object. */
export const SIGNATURE_KINDS = ['JPEG', 'PNG', 'PDF'] as const;
export type SignatureKind = (typeof SIGNATURE_KINDS)[number];

/** The declared type each kind of file stands for. A declared `image/jpeg` whose bytes are not a JPEG is refused on the bytes (GBT-N14). */
export const CONTENT_TYPE_SIGNATURE: Readonly<Record<string, SignatureKind>> = Object.freeze({
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'application/pdf': 'PDF',
});

/** How many leading bytes the signature check reads from the stored object. */
export const SIGNATURE_BYTES = 8;

/**
 * Which kind of file the first bytes of an object are, or nothing when they are none of the supported kinds. JPEG begins `FF D8 FF`; PNG `89 50 4E 47 0D 0A 1A 0A`; PDF
 * `%PDF-`. Judged on the bytes and never on a header the client chose.
 */
export function signatureOf(head: Uint8Array): SignatureKind | undefined {
  const starts = (prefix: readonly number[]): boolean =>
    head.length >= prefix.length && prefix.every((byte, index) => head[index] === byte);
  if (starts([0xff, 0xd8, 0xff])) return 'JPEG';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'PNG';
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'PDF';
  return undefined;
}

/** The platform settings the evidence operations read (settings.md section 7): there is no default for any of them, and a missing one is `SETTING_MISSING`. */
export const EVIDENCE_SETTINGS = {
  maxBytes: 'evidence_upload_max_bytes',
  allowedMimeTypes: 'evidence_upload_allowed_mime_types',
  uploadTtlMinutes: 'evidence_upload_authorization_ttl_minutes',
  retrievalTtlMinutes: 'evidence_retrieval_authorization_ttl_minutes',
} as const;
