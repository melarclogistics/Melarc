import type {
  EvidenceOwnerType,
  EvidencePurpose,
  EvidenceRetentionPolicy,
} from './evidence-vocabulary.js';

/**
 * Whose act an evidence record belongs to, and so whose permission its three operations need (S1.11; the contract's `x-permission: owner`; state-machines.md section 17:
 * "holds that act's write permission"). **Evidence holds no authority of its own**: it is captured in the course of another act, so the write permission of that act decides
 * who may declare and complete a record, and the read permission of the subject decides who may be given a way to read it. Each owner type the platform supports has a row here and
 * an arm of the table's policies (migration 0080 for the first); an owner type with no row is denied, never defaulted.
 *
 * The first owner is a pickup stop whose failure the rider reports: `pickup.failure.report` writes (the rider that arrived at the stop), and the staff of the stop's hub read under
 * `pickup.read`, the read of the subject. **One owner type may have more than one act, told apart by the purpose** (D-A10, 12 November 2026): the same stop is also the owner of the
 * photo of each parcel the rider counts at the door (`PARCEL_PHOTO`), which belongs to the count and is written under `pickup.collection.confirm`, so the rider's permission to declare a
 * photo is the count's and not the failure's (the policies of migration 0088 pair each purpose with its key). **The second owner is a pickup intake** (S1.34, migration 0095), whose
 * evidence is declared by staff: the photos of a condition (`CONDITION`) are the receiver's act, written under `hub.intake.count`, and the photos of an adjudication (`OSD`) are Senior
 * Ops's, written under `hub.osd.adjudicate` (and the photo of an extra parcel, Run D, is the receiver's, the same purpose written under `hub.intake.count` for a photo intake); the staff of the intake's hub
 * holding `hub.read` read all of it. **The itemisation of S1.36 is a third act of the same owner**, for the purpose `ITEMIZATION`, written under `hub.intake.itemize` (the evidence a high-value parcel needs and the
 * photograph of a carrier's waybill). A later owner adds its row and its arms in the migration that builds it.
 */
export interface OwnerAct {
  readonly ownerType: EvidenceOwnerType;
  /** The purposes this owner's evidence is captured for. */
  readonly purposes: readonly EvidencePurpose[];
  /** The access rule and the retention category the platform derives for this owner's evidence (never the client's). */
  readonly accessRule: 'SUBJECT_READERS';
  readonly retentionPolicy: EvidenceRetentionPolicy;
  /** Who declares and completes a record, and the key of the act they do it for. */
  readonly write: { readonly principal: 'RIDER' | 'STAFF' | 'VENDOR'; readonly key: string };
  /** Who is given a way to read a stored record, and the key of the read of the subject. */
  readonly read: { readonly principal: 'RIDER' | 'STAFF' | 'VENDOR'; readonly key: string };
  /**
   * The act is done for an intake that is checked in against door photos and for no other (the photo of an extra parcel, `addExtraParcel`, Run D): the intake of any other kind is no place for it, and a
   * declaration for one is `PERMISSION_DENIED` as it is for a session that does not hold the key.
   */
  readonly photoIntakeOnly?: boolean;
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
  Object.freeze({
    ownerType: 'PICKUP_INTAKE',
    purposes: Object.freeze(['CONDITION'] as const),
    accessRule: 'SUBJECT_READERS',
    retentionPolicy: 'PICKUP_INTAKE_EVIDENCE',
    write: Object.freeze({ principal: 'STAFF', key: 'hub.intake.count' } as const),
    read: Object.freeze({ principal: 'STAFF', key: 'hub.read' } as const),
  }),
  Object.freeze({
    ownerType: 'PICKUP_INTAKE',
    purposes: Object.freeze(['OSD'] as const),
    accessRule: 'SUBJECT_READERS',
    retentionPolicy: 'PICKUP_INTAKE_EVIDENCE',
    write: Object.freeze({ principal: 'STAFF', key: 'hub.osd.adjudicate' } as const),
    read: Object.freeze({ principal: 'STAFF', key: 'hub.read' } as const),
  }),
  // Run D (S1.35b, `addExtraParcel`): the photo of a parcel on the table that has no door photo is the receiver's own act (`hub.intake.count`), declared with the purpose the contract and the database name for it,
  // `OSD` (an overage; the policies of migration 0104 let the key write it). It is a second act for the purpose: a session is asked for the key of the first act it holds (`ownerActsOf`), and a receiver without the
  // key of the adjudication declares it for an intake checked in against door photos and for no other.
  Object.freeze({
    ownerType: 'PICKUP_INTAKE',
    purposes: Object.freeze(['OSD'] as const),
    accessRule: 'SUBJECT_READERS',
    retentionPolicy: 'PICKUP_INTAKE_EVIDENCE',
    write: Object.freeze({ principal: 'STAFF', key: 'hub.intake.count' } as const),
    read: Object.freeze({ principal: 'STAFF', key: 'hub.read' } as const),
    photoIntakeOnly: true,
  }),
  // S1.36 (`itemizeOrder`, migration 0110): the evidence an officer attaches when itemizing a parcel (the verification a high-value parcel needs, the photograph of a carrier's waybill) is evidence of the intake, which
  // exists when the order does not yet, declared and completed under the key of the act that cites it and read under `hub.read` like the rest of the intake's.
  Object.freeze({
    ownerType: 'PICKUP_INTAKE',
    purposes: Object.freeze(['ITEMIZATION'] as const),
    accessRule: 'SUBJECT_READERS',
    retentionPolicy: 'PICKUP_INTAKE_EVIDENCE',
    write: Object.freeze({ principal: 'STAFF', key: 'hub.intake.itemize' } as const),
    read: Object.freeze({ principal: 'STAFF', key: 'hub.read' } as const),
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

/**
 * Every act an owner type and a purpose belong to, in the order of the registry: a purpose has one act, or more when two keys write it (an intake's `OSD`: the adjudication's evidence under
 * `hub.osd.adjudicate`, the photo of an extra parcel under `hub.intake.count`). A purpose the owner has no act for is answered with the owner's first act alone, as `ownerActOf` answers it.
 */
export function ownerActsOf(ownerType: string, purpose?: string): readonly OwnerAct[] {
  const acts = OWNER_ACTS.filter((act) => act.ownerType === ownerType);
  const forPurpose =
    purpose === undefined
      ? []
      : acts.filter((act) => (act.purposes as readonly string[]).includes(purpose));
  return forPurpose.length > 0 ? forPurpose : acts.slice(0, 1);
}

/**
 * The keys of the acts each kind of principal could be doing, for one side of the operations (the write of `createEvidence` and `completeEvidenceUpload`, the read of
 * `createEvidenceRetrievalAuthorization`): what the guard asks of a session before the body is read (`AuthenticatedRouteOptions.ownerKeys`). Built from the acts, so a new owner adds no line here.
 */
export function ownerKeysOf(
  side: 'write' | 'read',
): Readonly<Partial<Record<'STAFF' | 'VENDOR' | 'RIDER', readonly string[]>>> {
  const keys: Partial<Record<'STAFF' | 'VENDOR' | 'RIDER', string[]>> = {};
  for (const act of OWNER_ACTS) {
    const { principal, key } = act[side];
    const held = (keys[principal] ??= []);
    if (!held.includes(key)) held.push(key);
  }
  return Object.freeze(keys);
}

/** The acts the caller could be writing evidence for, by principal: every act whose writer is of that kind. */
export const actsWrittenBy = (principal: string): readonly OwnerAct[] =>
  OWNER_ACTS.filter((act) => act.write.principal === principal);

/** The acts whose evidence the caller could be read for, by principal. */
export const actsReadBy = (principal: string): readonly OwnerAct[] =>
  OWNER_ACTS.filter((act) => act.read.principal === principal);
