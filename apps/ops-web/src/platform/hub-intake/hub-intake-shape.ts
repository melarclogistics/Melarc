import type { components } from '@melarc/api-client';

import { OPERATIONAL_CODE } from '../pickup/pickup-shape';
import { instantOf, isOneOf, isRecord, optional, uuidOf } from '../staff/staff-shape';

/**
 * What the receiving screens (S1.35: the awaiting-receive queue, the blind count, the record of an intake, the condition and the adjudication) believe of an answer, judged field by field before
 * anything is drawn, as the pickup, manifest and door screens' are. The types are the contract's, narrowed to the fields a screen reads; a field the contract adds and this does not read goes
 * nowhere, and an answer that is not the API's is refused whole rather than shown in part. `test/hub-intake-contract.test.ts` holds every guard below to the contract.
 *
 * **The blind count is held here, in the one place that decides what an answer is.** An intake that has not been counted is a {@link PreCountIntakeView}: it has no declaration, no count, no
 * comparison, no condition, no finding and no photo, **and an answer that carries any of them, at any depth, is refused whole**, so that a screen cannot be given the rider's declared number by
 * a server that sent it by mistake, and a type that has no place for it cannot draw it. Only an intake that has been counted is a {@link PostCountIntakeView}, and a list never gives a screen
 * more than {@link IntakeSummaryView}: no list shows a declaration, counted or not.
 *
 * An officer is **an officer and never a name**: the answers carry an identifier, the portal has no read of the staff directory or of a rider's name under these keys, and so a person is
 * told by what they did and when.
 */
type BaseBody = components['schemas']['HubIntakeBase'];

export type IntakeState = BaseBody['state'];
/**
 * **The condition and the variance are typed from the lists below, not from the contract's counted schema**: the generator reads the discriminator of `HubIntakePreCount` and `HubIntakePostCount` as the schemas' own
 * names (`count_phase: "HubIntakePostCount"`), which no value can have, so both are `never` in the generated types. `test/hub-intake-contract.test.ts` holds each list to the contract's enumeration.
 */
export type IntakeCondition = (typeof INTAKE_CONDITIONS)[number];
export type CountVariance = (typeof COUNT_VARIANCES)[number];
export type AdjudicationOutcome = components['schemas']['DiscrepancyAdjudication']['outcome'];
/** The two kinds of finding of an intake, as the contract's description of `condition_findings` states them. */
export type FindingKind = 'CONDITION' | 'ADJUDICATION';

export const INTAKE_STATES = [
  'AWAITING_COUNT',
  'COUNTED',
  'RECONCILIATION_REQUIRED',
  'READY_FOR_ITEMIZATION',
  'ITEMIZING',
  'CLOSED',
] as const;
export const INTAKE_CONDITIONS = ['OK', 'DAMAGED', 'TAMPERED', 'OTHER'] as const;
export const COUNT_VARIANCES = ['MATCH', 'SHORT', 'OVER'] as const;
export const COUNT_PHASES = ['PRE_COUNT', 'POST_COUNT'] as const;
export const ADJUDICATION_OUTCOMES = [
  'ACCEPTED',
  'ESCALATED',
  'WRITTEN_OFF',
  'VENDOR_NOTIFIED',
] as const;
export const FINDING_KINDS = ['CONDITION', 'ADJUDICATION'] as const;

/** The most a page of the list can hold (the contract's largest `page_size`). */
export const MAX_PAGE_ITEMS = 100;
const MAX_TOKEN = 2048;
/** The longest note the audit ledger keeps, and so the longest a screen is shown. */
const MAX_NOTE = 1000;
/**
 * The largest count the platform can hold (the database's whole number). It is a bound of representation and not a business limit: the platform sets none on the parcels of an intake (OB-S1-97),
 * and a screen takes a count the server took, so that no count the server accepts is unreadable here.
 */
export const MAX_PARCELS = 2_147_483_647;
const MAX_FINDINGS = 200;
const MAX_PHOTOS = 1000;
const MAX_EVIDENCE_PER_FINDING = 100;
const MAX_DEPTH = 8;

/** A text an officer wrote, as one block: not blank, bounded, and with no control character but a line break or a tab. It is drawn as text and never as markup. */
function noteTextOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_NOTE) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if ((unit < 0x20 && unit !== 0x0a && unit !== 0x09 && unit !== 0x0d) || unit === 0x7f) {
      return undefined;
    }
  }
  return value;
}

const wholeAtLeast = (value: unknown, least: number, most = MAX_PARCELS): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= least && value <= most
    ? value
    : undefined;

const signedWhole = (value: unknown): number | undefined =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= -MAX_PARCELS &&
  value <= MAX_PARCELS
    ? value
    : undefined;

/** The operational code of an intake (`ACC-IN-7KQ2MZ`), as the codes of the other records are. */
const codeOf = (value: unknown): string | undefined =>
  typeof value === 'string' && OPERATIONAL_CODE.test(value) ? value : undefined;

/**
 * What an intake that has not been counted must not carry, by name, at any depth: the rider's declaration, the count, the comparison, the condition and its findings, the dispute and the
 * photos of the collection (their number is the rider's count). The names are the contract's members of the counted shape, and the pattern also takes a word that looks like one, so that a
 * server that renamed the declaration cannot get it past the guard.
 */
const BLIND =
  /declared|declaration_count|physical_count|count_variance|count_difference|parcel_photo|photo_ids|^condition|dispute_state|variance/i;

function carriesWhatIsBlind(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((entry) => carriesWhatIsBlind(entry, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([name, member]) => BLIND.test(name) || carriesWhatIsBlind(member, depth + 1),
  );
}

/** The facts every intake states, counted or not. A person is an identifier: the portal reads no directory. */
export interface IntakeBaseView {
  readonly id: string;
  readonly code: string;
  readonly hub_id: string;
  readonly pickup_request_id: string;
  readonly pickup_manifest_id: string;
  readonly handed_over_by: string;
  readonly handed_over_at: string;
  /** Who holds the advisory receive lock, or nobody. It decides nothing: the server refuses a count only for the intake's facts. */
  readonly active_receiver_id: string | null;
  /** The last time the holder showed it was working: the database's moment, refreshed by the holder. */
  readonly lock_acquired_at: string | null;
  readonly state: IntakeState;
}

/** What a list gives a screen of an intake, counted or not: the base and nothing of the count, so that no list can draw a declaration. */
export interface IntakeSummaryView extends IntakeBaseView {
  readonly count_phase: (typeof COUNT_PHASES)[number];
}

/** An intake that has not been counted: **no declaration, no count, no comparison, no photo** (the type has no place for one). */
export interface PreCountIntakeView extends IntakeBaseView {
  readonly count_phase: 'PRE_COUNT';
  readonly state: 'AWAITING_COUNT';
}

/** One recording of a condition by the receiver, or one adjudication by Senior Ops, as it was made. Evidence is by identifier: a photo is opened one at a time. */
export interface FindingView {
  readonly id: string;
  readonly kind: FindingKind;
  readonly condition: IntakeCondition | null;
  readonly outcome: AdjudicationOutcome | null;
  readonly note: string | null;
  readonly evidence_ids: readonly string[];
  readonly recorded_by: string;
  readonly recorded_at: string;
}

/** An intake that has been counted: the declaration, the count and the comparison **as the server stated them**; the page works out none of it. */
export interface PostCountIntakeView extends IntakeBaseView {
  readonly count_phase: 'POST_COUNT';
  readonly rider_declared_count: number;
  readonly physical_count: number;
  readonly count_variance: CountVariance;
  /** The physical count less the declared one, as the server stated it; absent when it did not. */
  readonly count_difference: number | null;
  readonly condition: IntakeCondition;
  /** In the order they were made. */
  readonly condition_findings: readonly FindingView[];
  /** The photos of the parcels counted at the door, by evidence identifier, in the order they were attached; none when Ops let the stop through without photos. */
  readonly parcel_photo_ids: readonly string[];
}

export type IntakeView = PreCountIntakeView | PostCountIntakeView;

/** The fields each guard reads, held to the contract by `test/hub-intake-contract.test.ts`. */
const BASE_REQUIRED = [
  'id',
  'code',
  'state',
  'hub_id',
  'pickup_request_id',
  'pickup_manifest_id',
  'handed_over_by',
  'handed_over_at',
  'declaration_captured_at',
  'count_phase',
] as const;
export const HUB_INTAKE_FIELDS = {
  HubIntakePreCount: {
    required: BASE_REQUIRED,
    optional: ['active_receiver_id', 'lock_acquired_at'],
    enums: { state: INTAKE_STATES },
  },
  HubIntakePostCount: {
    required: [
      ...BASE_REQUIRED,
      'rider_declared_count',
      'physical_count',
      'count_variance',
      'condition',
    ],
    optional: [
      'active_receiver_id',
      'lock_acquired_at',
      'count_difference',
      'condition_findings',
      'parcel_photo_ids',
    ],
    enums: {
      state: INTAKE_STATES,
      count_variance: COUNT_VARIANCES,
      condition: INTAKE_CONDITIONS,
    },
  },
} as const;

function parseBase(body: Record<string, unknown>): IntakeBaseView | undefined {
  const id = uuidOf(body.id);
  const code = codeOf(body.code);
  const hub = uuidOf(body.hub_id);
  const request = uuidOf(body.pickup_request_id);
  const manifest = uuidOf(body.pickup_manifest_id);
  const by = uuidOf(body.handed_over_by);
  const at = instantOf(body.handed_over_at);
  const captured = instantOf(body.declaration_captured_at);
  const receiver = optional(body.active_receiver_id, uuidOf);
  const lockedAt = optional(body.lock_acquired_at, instantOf);
  if (
    id === undefined ||
    code === undefined ||
    hub === undefined ||
    request === undefined ||
    manifest === undefined ||
    by === undefined ||
    at === undefined ||
    captured === undefined ||
    receiver === undefined ||
    lockedAt === undefined ||
    !isOneOf(INTAKE_STATES, body.state)
  ) {
    return undefined;
  }
  return {
    id,
    code,
    hub_id: hub,
    pickup_request_id: request,
    pickup_manifest_id: manifest,
    handed_over_by: by,
    handed_over_at: at,
    active_receiver_id: receiver,
    lock_acquired_at: lockedAt,
    state: body.state,
  };
}

/** The evidence of a finding: whole identifiers, each once. */
function evidenceIdsOf(value: unknown, most: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > most) return undefined;
  const ids: string[] = [];
  for (const entry of value as unknown[]) {
    const id = uuidOf(entry);
    if (id === undefined || ids.some((seen) => seen.toLowerCase() === id.toLowerCase())) {
      return undefined;
    }
    ids.push(id);
  }
  return ids;
}

export function parseFinding(body: unknown): FindingView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const condition = optional(body.condition, (value) =>
    isOneOf(INTAKE_CONDITIONS, value) ? value : undefined,
  );
  const outcome = optional(body.outcome, (value) =>
    isOneOf(ADJUDICATION_OUTCOMES, value) ? value : undefined,
  );
  const note = optional(body.note, noteTextOf);
  const evidence = evidenceIdsOf(body.evidence_ids ?? [], MAX_EVIDENCE_PER_FINDING);
  const by = uuidOf(body.recorded_by);
  const at = instantOf(body.recorded_at);
  if (
    id === undefined ||
    !isOneOf(FINDING_KINDS, body.kind) ||
    condition === undefined ||
    outcome === undefined ||
    note === undefined ||
    evidence === undefined ||
    by === undefined ||
    at === undefined
  ) {
    return undefined;
  }
  // What the contract states of the two kinds: the receiver's recording of a condition has a condition and no outcome, an adjudication has an outcome.
  if (body.kind === 'CONDITION' && (condition === null || outcome !== null)) return undefined;
  if (body.kind === 'ADJUDICATION' && outcome === null) return undefined;
  return {
    id,
    kind: body.kind,
    condition,
    outcome,
    note,
    evidence_ids: evidence,
    recorded_by: by,
    recorded_at: at,
  };
}

function parseFindings(value: unknown): readonly FindingView[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) return undefined;
  const findings: FindingView[] = [];
  for (const entry of value as unknown[]) {
    const finding = parseFinding(entry);
    const last = findings.at(-1);
    // Each finding once, in the order they were made: a list the other way round is not the one the server keeps.
    if (
      finding === undefined ||
      findings.some((seen) => seen.id.toLowerCase() === finding.id.toLowerCase()) ||
      (last !== undefined && Date.parse(finding.recorded_at) < Date.parse(last.recorded_at))
    ) {
      return undefined;
    }
    findings.push(finding);
  }
  return findings;
}

/** An intake that has not been counted, or nothing: an answer that carries any member of the counted shape is not one the screens may show. */
function parsePreCount(
  body: Record<string, unknown>,
  base: IntakeBaseView,
): PreCountIntakeView | undefined {
  if (carriesWhatIsBlind(body) || base.state !== 'AWAITING_COUNT') return undefined;
  return { ...base, state: 'AWAITING_COUNT', count_phase: 'PRE_COUNT' };
}

function parsePostCount(
  body: Record<string, unknown>,
  base: IntakeBaseView,
): PostCountIntakeView | undefined {
  const declared = wholeAtLeast(body.rider_declared_count, 0);
  const physical = wholeAtLeast(body.physical_count, 0);
  const difference = optional(body.count_difference, signedWhole);
  const findings = parseFindings(body.condition_findings);
  const photos = evidenceIdsOf(body.parcel_photo_ids ?? [], MAX_PHOTOS);
  if (
    declared === undefined ||
    physical === undefined ||
    difference === undefined ||
    findings === undefined ||
    photos === undefined ||
    !isOneOf(COUNT_VARIANCES, body.count_variance) ||
    !isOneOf(INTAKE_CONDITIONS, body.condition) ||
    base.state === 'AWAITING_COUNT'
  ) {
    return undefined;
  }
  // What the contract states of the comparison: the difference is the physical count less the declared one, and the variance says which side of it the count is on.
  const side = physical === declared ? 'MATCH' : physical < declared ? 'SHORT' : 'OVER';
  if (body.count_variance !== side) return undefined;
  if (difference !== null && difference !== physical - declared) return undefined;
  return {
    ...base,
    count_phase: 'POST_COUNT',
    rider_declared_count: declared,
    physical_count: physical,
    count_variance: body.count_variance,
    count_difference: difference,
    condition: body.condition,
    condition_findings: findings,
    parcel_photo_ids: photos,
  };
}

/** One intake, counted or not (`getHubIntake`, `acquireIntakeLock` and the answers of the acts), told apart by `count_phase`. */
export function parseIntake(body: unknown): IntakeView | undefined {
  if (!isRecord(body)) return undefined;
  const base = parseBase(body);
  if (base === undefined) return undefined;
  if (body.count_phase === 'PRE_COUNT') return parsePreCount(body, base);
  if (body.count_phase === 'POST_COUNT') return parsePostCount(body, base);
  return undefined;
}

/** An intake that has been counted, or nothing: the answer of an act that can only be done to one. */
export function parsePostCountIntake(body: unknown): PostCountIntakeView | undefined {
  const intake = parseIntake(body);
  return intake?.count_phase === 'POST_COUNT' ? intake : undefined;
}

/** What a list says of one intake: the base and the phase, and nothing of a count even where the item carries one. */
function parseSummary(entry: unknown): IntakeSummaryView | undefined {
  const intake = parseIntake(entry);
  if (intake === undefined) return undefined;
  const {
    id,
    code,
    hub_id,
    pickup_request_id,
    pickup_manifest_id,
    handed_over_by,
    handed_over_at,
  } = intake;
  return {
    id,
    code,
    hub_id,
    pickup_request_id,
    pickup_manifest_id,
    handed_over_by,
    handed_over_at,
    active_receiver_id: intake.active_receiver_id,
    lock_acquired_at: intake.lock_acquired_at,
    state: intake.state,
    count_phase: intake.count_phase,
  };
}

export interface IntakePageView {
  readonly items: readonly IntakeSummaryView[];
  readonly nextPageToken: string | null;
}

/** A page of `listHubIntakes`. */
export function parseIntakePage(body: unknown): IntakePageView | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const token = body.next_page_token;
  if (token !== null && !(typeof token === 'string' && token !== '' && token.length <= MAX_TOKEN)) {
    return undefined;
  }
  const items: IntakeSummaryView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const item = parseSummary(entry);
    if (item === undefined || seen.has(item.id.toLowerCase())) return undefined;
    seen.add(item.id.toLowerCase());
    items.push(item);
  }
  return { items, nextPageToken: token };
}

/** Whether the person holds the lock, and whether another receiver does: from the intake as the server read it and the session's principal. */
export type ReceiverHold =
  | { readonly kind: 'nobody' }
  | { readonly kind: 'you'; readonly since: string }
  | { readonly kind: 'another'; readonly since: string };

export function receiverHoldOf(
  intake: Pick<IntakeBaseView, 'active_receiver_id' | 'lock_acquired_at'>,
  principalId: string | undefined,
): ReceiverHold {
  if (intake.active_receiver_id === null || intake.lock_acquired_at === null) {
    return { kind: 'nobody' };
  }
  return principalId?.toLowerCase() === intake.active_receiver_id.toLowerCase()
    ? { kind: 'you', since: intake.lock_acquired_at }
    : { kind: 'another', since: intake.lock_acquired_at };
}
