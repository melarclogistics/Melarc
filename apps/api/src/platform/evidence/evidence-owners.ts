import type { EvidenceOwnerType, EvidencePurpose } from './evidence-vocabulary.js';

/**
 * Whose act an evidence record belongs to, and so whose permission its three operations need (S1.11; the contract's `x-permission: owner`; state-machines.md section 17:
 * "holds that act's write permission"). **Evidence holds no authority of its own**: it is captured in the course of another act, so the write permission of that act decides
 * who may declare and complete a record, and the read permission of the subject decides who may be given a way to read it. Each owner type the platform supports has a row here and
 * an arm of the table's policies (migration 0080 for the first); an owner type with no row is denied, never defaulted.
 *
 * The first owner is a pickup stop whose failure the rider reports: `pickup.failure.report` writes (the rider that arrived at the stop), and the staff of the stop's hub read under
 * `pickup.read`, the read of the subject. **One owner type may have more than one act, told apart by the purpose** (D-A10, 12 November 2026): the same stop is also the owner of the
 * photo of each parcel the rider counts at the door (`PARCEL_PHOTO`), which belongs to the count and is written under `pickup.collection.confirm`, so the rider's permission to declare a
 * photo is the count's and not the failure's (the policies of migration 0088 pair each purpose with its key). A later owner (S1.34's handover, S1.36's itemisation) adds its row and its
 * arms in the migration that builds it.
 */
export interface OwnerAct {
  readonly ownerType: EvidenceOwnerType;
  /** The purposes this owner's evidence is captured for. */
  readonly purposes: readonly EvidencePurpose[];
  /** The access rule and the retention category the platform derives for this owner's evidence (never the client's). */
  readonly accessRule: 'SUBJECT_READERS';
  readonly retentionPolicy: 'PICKUP_STOP_EVIDENCE';
  /** Who declares and completes a record, and the key of the act they do it for. */
  readonly write: { readonly principal: 'RIDER' | 'STAFF' | 'VENDOR'; readonly key: string };
  /** Who is given a way to read a stored record, and the key of the read of the subject. */
  readonly read: { readonly principal: 'RIDER' | 'STAFF' | 'VENDOR'; readonly key: string };
}

export const OWNER_ACTS: readonly OwnerAct[] = Object.freeze([
  Object.freeze({
    ownerType: 'PICKUP_STOP',
    purposes: Object.freeze(['COLLECTION_PROOF'] as const),
    accessRule: 'SUBJECT_READERS',
    retentionPolicy: 'PICKUP_STOP_EVIDENCE',
    write: Object.freeze({ principal: 'RIDER', key: 'pickup.failure.report' } as const),
    read: Object.freeze({ principal: 'STAFF', key: 'pickup.read' } as const),
  }),
  Object.freeze({
    ownerType: 'PICKUP_STOP',
    purposes: Object.freeze(['PARCEL_PHOTO'] as const),
    accessRule: 'SUBJECT_READERS',
    retentionPolicy: 'PICKUP_STOP_EVIDENCE',
    write: Object.freeze({ principal: 'RIDER', key: 'pickup.collection.confirm' } as const),
    read: Object.freeze({ principal: 'STAFF', key: 'pickup.read' } as const),
  }),
]);

/**
 * The act an owner type and a purpose belong to, or nothing: an owner with no act is denied. A purpose the owner has no act for is answered with the owner's first act, so that the
 * caller's permission is still asked of before anything else is said (a caller without the key learns nothing of the schema) and the purpose is then refused as not one of the owner's.
 */
export function ownerActOf(ownerType: string, purpose?: string): OwnerAct | undefined {
  const acts = OWNER_ACTS.filter((act) => act.ownerType === ownerType);
  const forPurpose =
    purpose === undefined
      ? undefined
      : acts.find((act) => (act.purposes as readonly string[]).includes(purpose));
  return forPurpose ?? acts[0];
}

/** The acts the caller could be writing evidence for, by principal: every act whose writer is of that kind. */
export const actsWrittenBy = (principal: string): readonly OwnerAct[] =>
  OWNER_ACTS.filter((act) => act.write.principal === principal);

/** The acts whose evidence the caller could be read for, by principal. */
export const actsReadBy = (principal: string): readonly OwnerAct[] =>
  OWNER_ACTS.filter((act) => act.read.principal === principal);
