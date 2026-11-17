import type { components } from '@melarc/api-client';

import { OPERATIONAL_CODE } from '../pickup/pickup-shape';
import { instantOf, isOneOf, isRecord, optional, uuidListOf, uuidOf } from '../staff/staff-shape';
import {
  COUNT_VARIANCES,
  INTAKE_CONDITIONS,
  INTAKE_STATES,
  MAX_PARCELS,
  type CountVariance,
  type IntakeCondition,
  type IntakeState,
} from '../hub-intake/hub-intake-shape';

/**
 * What the receiving screens of a run (S1.35c: the queue by run, the run page, the missing list) believe of an answer, judged field by field before anything is drawn, as the other screens' guards are
 * (`hub-intake-shape.ts`, `pickup-work-shape.ts`). The types are the contract's narrowed to what a screen reads; a member the contract adds and this does not read goes nowhere, and an answer that is not
 * the API's is refused whole rather than shown in part. `test/hub-receiving-contract.test.ts` holds every guard below to the contract.
 *
 * **What is held here, because here is where an answer is judged:**
 * - **A blind-count vendor carries none of the rider's number** (D-D3): its `parcels_expected` and `arrived_count` are null, it has no parcel, and before its count it has no received count and no variance. An
 *   answer in which one has any of them is refused whole, so that a server that leaks the number by mistake cannot get it onto a screen.
 * - **A person is a name and nothing else**: a display name is short text with no control character, and **one that reads as a telephone number is refused** (no phone number is ever drawn: OB-S1-106).
 * - **A picture is an evidence identifier**: no key, no address, no path is in any answer, and none is accepted.
 */
export type VendorMode = components['schemas']['ReceivingMode'];
export type ParcelState = components['schemas']['IntakeParcelState'];
export type ParcelOrigin = components['schemas']['IntakeParcelOrigin'];

export const RECEIVING_MODES = ['PHOTO_CHECK_IN', 'BLIND_COUNT'] as const;
export const PARCEL_STATES = ['EXPECTED', 'ARRIVED', 'MISSING', 'VOID'] as const;
export const PARCEL_ORIGINS = ['DOOR_PHOTO', 'HUB_EXTRA'] as const;
export const RUN_VIEWS = ['waiting', 'needs_decision', 'all'] as const;
export const MISSING_VIEWS = ['searching', 'vendor_to_tell'] as const;
export type RunView = (typeof RUN_VIEWS)[number];
export type MissingView = (typeof MISSING_VIEWS)[number];

/** The most a page of either list can hold (the contract's largest `page_size`). */
export const MAX_PAGE_ITEMS = 100;
const MAX_TOKEN = 2048;
const MAX_NAME = 120;
const MAX_NOTE = 1000;
/**
 * A run holds at most 64 stops (the manifest's ceiling, `MAX_STOPS`) and one vendor's check-in is opened for each stop that was collected, so this is a bound no run can reach, kept so that a list
 * that is not a run's vendors is refused. **It is the only count of things in this file with a bound**: the parcels of a vendor, the evidence of a parcel or of a finding and the findings of a check-in
 * are as many as the server holds, and are judged for their shape, their identifiers, their order and their repeats, never for their number (the contract and the API set no `maxItems` on them, and
 * the platform sets no limit on the parcels of a pickup: OB-S1-97).
 */
const MAX_VENDORS = 500;

/**
 * A display name: one line of text, bounded, with no control character, and **never a number that could be dialled**. A name is told by what the screens draw of a person, and a telephone number
 * in its place would be a number drawn (OB-S1-106: no phone number on the receiving side), so an answer whose name carries seven digits in a run, separators allowed, is refused.
 */
export function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '' || text.length > MAX_NAME) return undefined;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return undefined;
  }
  if (/(?:\+?\d[\s().-]?){7,}/.test(text)) return undefined;
  return text;
}

/** A text an officer wrote, as one block: bounded, with no control character but a line break or a tab. It is drawn as text and never as markup. */
function noteOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_NOTE) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if ((unit < 0x20 && unit !== 0x0a && unit !== 0x09 && unit !== 0x0d) || unit === 0x7f) {
      return undefined;
    }
  }
  return value;
}

const whole = (value: unknown, least = 0, most = MAX_PARCELS): number | undefined =>
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

const codeOf = (value: unknown): string | undefined =>
  typeof value === 'string' && OPERATIONAL_CODE.test(value) ? value : undefined;

/** An `ETag` as the API sends it: opaque, quoted or not, bounded. It is given back as `If-Match` exactly as it came. */
const etagOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' && value.length <= 256 ? value : undefined;

const dateOf = (value: unknown): string | undefined =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;

// ---- the parcel and the lock ------------------------------------------------------------------------------------------------------------------------------------------------------

/** What was found on one parcel (`IntakeParcelCondition`): recorded once for each parcel; a parcel with none reads *Not checked yet*. */
export interface ParcelConditionView {
  readonly condition: IntakeCondition;
  readonly note: string | null;
  readonly evidence_ids: readonly string[];
  readonly recorded_by_name: string;
  readonly recorded_at: string;
}

/** One physical parcel as the hub checks it: the door photo's evidence identifier (never an address) and where the check stands. */
export interface ParcelView {
  readonly id: string;
  readonly ordinal: number;
  readonly origin: ParcelOrigin;
  readonly state: ParcelState;
  readonly photo_evidence_id: string;
  readonly arrived_by_name: string | null;
  readonly arrived_at: string | null;
  readonly missing_marked_at: string | null;
  readonly condition: ParcelConditionView | null;
}

/** The advisory receive lock as the screens say it: who opened the check-in and when. It stops nobody. */
export interface LockView {
  readonly holder_name: string;
  readonly held_by_you: boolean;
  readonly opened_at: string;
  readonly last_seen_at: string;
}

function parseCondition(body: unknown): ParcelConditionView | null | undefined {
  if (body === null || body === undefined) return null;
  if (!isRecord(body)) return undefined;
  const note = optional(body.note, noteOf);
  const evidence = uuidListOf(body.evidence_ids ?? []);
  const by = nameOf(body.recorded_by_name);
  const at = instantOf(body.recorded_at);
  if (
    note === undefined ||
    evidence === undefined ||
    by === undefined ||
    at === undefined ||
    !isOneOf(INTAKE_CONDITIONS, body.condition)
  ) {
    return undefined;
  }
  return {
    condition: body.condition,
    note,
    evidence_ids: evidence,
    recorded_by_name: by,
    recorded_at: at,
  };
}

export function parseParcel(body: unknown): ParcelView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const ordinal = whole(body.ordinal, 1);
  const photo = uuidOf(body.photo_evidence_id);
  const by = optional(body.arrived_by_name, nameOf);
  const arrivedAt = optional(body.arrived_at, instantOf);
  const missingAt = optional(body.missing_marked_at, instantOf);
  const condition = parseCondition(body.condition);
  if (
    id === undefined ||
    ordinal === undefined ||
    photo === undefined ||
    by === undefined ||
    arrivedAt === undefined ||
    missingAt === undefined ||
    condition === undefined ||
    !isOneOf(PARCEL_ORIGINS, body.origin) ||
    !isOneOf(PARCEL_STATES, body.state)
  ) {
    return undefined;
  }
  // What the contract states of a parcel: an arrived parcel says who and when, and an extra is never expected or missing and is never a door parcel's photo.
  if ((by === null) !== (arrivedAt === null)) return undefined;
  if (body.state === 'ARRIVED' && arrivedAt === null) return undefined;
  if (body.origin === 'HUB_EXTRA' && (body.state === 'EXPECTED' || body.state === 'MISSING')) {
    return undefined;
  }
  if (body.state === 'VOID' && body.origin !== 'HUB_EXTRA') return undefined;
  return {
    id,
    ordinal,
    origin: body.origin,
    state: body.state,
    photo_evidence_id: photo,
    arrived_by_name: by,
    arrived_at: arrivedAt,
    missing_marked_at: missingAt,
    condition,
  };
}

function parseParcels(value: unknown): readonly ParcelView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parcels: ParcelView[] = [];
  const seen = new Set<string>();
  const photos = new Set<string>();
  for (const entry of value as unknown[]) {
    const parcel = parseParcel(entry);
    if (parcel === undefined) return undefined;
    // Each parcel once, and each photo once: a list that repeats either is not the one the server keeps. The order is the order the photos were taken.
    if (seen.has(parcel.id.toLowerCase()) || photos.has(parcel.photo_evidence_id.toLowerCase())) {
      return undefined;
    }
    seen.add(parcel.id.toLowerCase());
    photos.add(parcel.photo_evidence_id.toLowerCase());
    const last = parcels.at(-1);
    if (last !== undefined && parcel.ordinal <= last.ordinal) return undefined;
    parcels.push(parcel);
  }
  return parcels;
}

export function parseLock(body: unknown): LockView | null | undefined {
  if (body === null || body === undefined) return null;
  if (!isRecord(body)) return undefined;
  const holder = nameOf(body.holder_name);
  const opened = instantOf(body.opened_at);
  const seen = instantOf(body.last_seen_at);
  if (
    holder === undefined ||
    opened === undefined ||
    seen === undefined ||
    typeof body.held_by_you !== 'boolean'
  ) {
    return undefined;
  }
  return {
    holder_name: holder,
    held_by_you: body.held_by_you,
    opened_at: opened,
    last_seen_at: seen,
  };
}

// ---- the vendor's section and the run's page --------------------------------------------------------------------------------------------------------------------------------------

/** The counts of a vendor's check-in, derived by the database from its parcels and never typed. */
export interface CountsView {
  readonly parcels_expected: number | null;
  readonly arrived_count: number | null;
  readonly received_count: number | null;
  readonly count_variance: CountVariance | null;
  readonly missing_count: number;
  readonly extra_count: number;
  readonly damaged_count: number;
}

function parseCounts(body: Record<string, unknown>): CountsView | undefined {
  const expected = optional(body.parcels_expected, (value) => whole(value));
  const arrived = optional(body.arrived_count, (value) => whole(value));
  const received = optional(body.received_count, (value) => whole(value));
  const variance = optional(body.count_variance, (value) =>
    isOneOf(COUNT_VARIANCES, value) ? value : undefined,
  );
  const missing = whole(body.missing_count);
  const extra = whole(body.extra_count);
  const damaged = whole(body.damaged_count);
  if (
    expected === undefined ||
    arrived === undefined ||
    received === undefined ||
    variance === undefined ||
    missing === undefined ||
    extra === undefined ||
    damaged === undefined
  ) {
    return undefined;
  }
  return {
    parcels_expected: expected,
    arrived_count: arrived,
    received_count: received,
    count_variance: variance,
    missing_count: missing,
    extra_count: extra,
    damaged_count: damaged,
  };
}

/** One vendor's section of a run's receiving page: the intake it is, its mode, its state, its counts and, for a photo vendor, its parcels. */
export interface VendorView extends CountsView {
  readonly intake_id: string;
  readonly intake_code: string;
  /** The vendor's `ETag`: the `If-Match` of its acts. It does not move with the lock, a tap, an untap or an extra added before the vendor is finished. */
  readonly intake_etag: string;
  readonly receiving_mode: VendorMode;
  readonly state: IntakeState;
  readonly vendor_name: string;
  readonly lock: LockView | null;
  readonly parcels: readonly ParcelView[];
}

/**
 * **The blind count, held where an answer is judged** (D-D3). A blind-count vendor has no parcel, and none of the rider's number: its expected and arrived counts are null always, and before its count it has no
 * received count and no variance either. A photo vendor hides nothing and is checked the other way: its counts must follow from its parcels.
 */
function blindProblem(vendor: VendorView): boolean {
  if (vendor.receiving_mode !== 'BLIND_COUNT') return false;
  if (vendor.parcels.length > 0) return true;
  if (vendor.parcels_expected !== null || vendor.arrived_count !== null) return true;
  if (
    vendor.state === 'AWAITING_COUNT' &&
    (vendor.received_count !== null || vendor.count_variance !== null)
  ) {
    return true;
  }
  return vendor.missing_count !== 0 || vendor.extra_count !== 0;
}

/** What a photo vendor's counts say must follow from its parcels: the page states none of it, it only refuses an answer that contradicts itself. */
function photoProblem(vendor: VendorView): boolean {
  if (vendor.receiving_mode !== 'PHOTO_CHECK_IN') return false;
  const door = vendor.parcels.filter((parcel) => parcel.origin === 'DOOR_PHOTO').length;
  const arrived = vendor.parcels.filter((parcel) => parcel.state === 'ARRIVED').length;
  const missing = vendor.parcels.filter((parcel) => parcel.state === 'MISSING').length;
  const extra = vendor.parcels.filter(
    (parcel) => parcel.origin === 'HUB_EXTRA' && parcel.state !== 'VOID',
  ).length;
  return (
    vendor.parcels_expected !== door ||
    vendor.arrived_count !== arrived ||
    vendor.missing_count !== missing ||
    vendor.extra_count !== extra
  );
}

export function parseVendor(body: unknown): VendorView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.intake_id);
  const code = codeOf(body.intake_code);
  const etag = etagOf(body.intake_etag);
  const vendor = nameOf(body.vendor_name);
  const counts = parseCounts(body);
  const lock = parseLock(body.lock);
  const parcels = parseParcels(body.parcels);
  if (
    id === undefined ||
    code === undefined ||
    etag === undefined ||
    vendor === undefined ||
    counts === undefined ||
    lock === undefined ||
    parcels === undefined ||
    !isOneOf(RECEIVING_MODES, body.receiving_mode) ||
    !isOneOf(INTAKE_STATES, body.state)
  ) {
    return undefined;
  }
  const view: VendorView = {
    ...counts,
    intake_id: id,
    intake_code: code,
    intake_etag: etag,
    receiving_mode: body.receiving_mode,
    state: body.state,
    vendor_name: vendor,
    lock,
    parcels,
  };
  if (blindProblem(view) || photoProblem(view)) return undefined;
  return view;
}

export interface RunFactsView {
  readonly id: string;
  readonly code: string;
  readonly hub_id: string;
  readonly hub_name: string;
  readonly service_date: string;
}

/** A run's receiving page (`getReceivingRun`): the run, the rider by name and one section for each vendor, in the order the handover opened them. */
export interface RunPageView {
  readonly run: RunFactsView;
  readonly rider_name: string;
  readonly handed_over_at: string;
  readonly vendors: readonly VendorView[];
}

export function parseRunPage(body: unknown): RunPageView | undefined {
  if (!isRecord(body) || !isRecord(body.run) || !Array.isArray(body.vendors)) return undefined;
  const id = uuidOf(body.run.id);
  const code = codeOf(body.run.code);
  const hub = uuidOf(body.run.hub_id);
  const hubName = nameOf(body.run.hub_name);
  const day = dateOf(body.run.service_date);
  const rider = nameOf(body.rider_name);
  const handed = instantOf(body.handed_over_at);
  if (
    id === undefined ||
    code === undefined ||
    hub === undefined ||
    hubName === undefined ||
    day === undefined ||
    rider === undefined ||
    handed === undefined ||
    body.vendors.length > MAX_VENDORS
  ) {
    return undefined;
  }
  const vendors: VendorView[] = [];
  const seen = new Set<string>();
  for (const entry of body.vendors as unknown[]) {
    const vendor = parseVendor(entry);
    if (vendor === undefined || seen.has(vendor.intake_id.toLowerCase())) return undefined;
    seen.add(vendor.intake_id.toLowerCase());
    vendors.push(vendor);
  }
  return {
    run: { id, code, hub_id: hub, hub_name: hubName, service_date: day },
    rider_name: rider,
    handed_over_at: handed,
    vendors,
  };
}

// ---- the queue, by run -------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One row of the receiving queue: a run named by its code, its rider and its vendors, with what waits. No phone number, no declared count, no photo. */
export interface RunSummaryView {
  readonly run_id: string;
  readonly run_code: string;
  readonly hub_id: string;
  readonly hub_name: string;
  readonly rider_name: string;
  readonly vendor_names: readonly string[];
  readonly vendors_total: number;
  readonly vendors_waiting: number;
  readonly vendors_needing_decision: number;
  readonly blind_count_vendors: number;
  readonly parcels_expected: number;
  readonly missing_searching: number;
  readonly handed_over_at: string;
  readonly checking_in: readonly { readonly name: string; readonly is_you: boolean }[];
}

function parseChecking(
  value: unknown,
): readonly { readonly name: string; readonly is_you: boolean }[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_VENDORS) return undefined;
  const people: { readonly name: string; readonly is_you: boolean }[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const name = nameOf(entry.name);
    if (name === undefined || typeof entry.is_you !== 'boolean') return undefined;
    people.push({ name, is_you: entry.is_you });
  }
  return people;
}

export function parseRunSummary(body: unknown): RunSummaryView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.run_id);
  const code = codeOf(body.run_code);
  const hub = uuidOf(body.hub_id);
  const hubName = nameOf(body.hub_name);
  const rider = nameOf(body.rider_name);
  const handed = instantOf(body.handed_over_at);
  const total = whole(body.vendors_total, 1);
  const waiting = whole(body.vendors_waiting);
  const deciding = whole(body.vendors_needing_decision);
  const blind = whole(body.blind_count_vendors);
  const expected = whole(body.parcels_expected);
  const searching = whole(body.missing_searching);
  const checking = parseChecking(body.checking_in);
  if (
    id === undefined ||
    code === undefined ||
    hub === undefined ||
    hubName === undefined ||
    rider === undefined ||
    handed === undefined ||
    total === undefined ||
    waiting === undefined ||
    deciding === undefined ||
    blind === undefined ||
    expected === undefined ||
    searching === undefined ||
    checking === undefined ||
    !Array.isArray(body.vendor_names) ||
    body.vendor_names.length > MAX_VENDORS
  ) {
    return undefined;
  }
  const names: string[] = [];
  for (const entry of body.vendor_names as unknown[]) {
    const name = nameOf(entry);
    if (name === undefined) return undefined;
    names.push(name);
  }
  // What the contract states of a row: the vendors that wait, need a decision or are counted blind are among the run's vendors, and every vendor is named.
  if (waiting > total || deciding > total || blind > total || names.length !== total) {
    return undefined;
  }
  return {
    run_id: id,
    run_code: code,
    hub_id: hub,
    hub_name: hubName,
    rider_name: rider,
    vendor_names: names,
    vendors_total: total,
    vendors_waiting: waiting,
    vendors_needing_decision: deciding,
    blind_count_vendors: blind,
    parcels_expected: expected,
    missing_searching: searching,
    handed_over_at: handed,
    checking_in: checking,
  };
}

export interface RunListPageView {
  readonly items: readonly RunSummaryView[];
  readonly nextPageToken: string | null;
}

function tokenOf(body: Record<string, unknown>): string | null | undefined {
  const token = body.next_page_token;
  if (token === null) return null;
  return typeof token === 'string' && token !== '' && token.length <= MAX_TOKEN ? token : undefined;
}

/** A page of `listReceivingRuns`. */
export function parseRunListPage(body: unknown): RunListPageView | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const token = tokenOf(body);
  if (token === undefined) return undefined;
  const items: RunSummaryView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const item = parseRunSummary(entry);
    if (item === undefined || seen.has(item.run_id.toLowerCase())) return undefined;
    seen.add(item.run_id.toLowerCase());
    items.push(item);
  }
  return { items, nextPageToken: token };
}

// ---- the missing list --------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One parcel of the list *Missing — being searched for*: its picture (an evidence identifier), the vendor, the run and how long it has been missing. */
export interface MissingParcelView {
  readonly parcel_id: string;
  readonly photo_evidence_id: string;
  readonly intake_id: string;
  readonly intake_code: string;
  readonly run_id: string;
  readonly run_code: string;
  readonly vendor_name: string;
  readonly missing_since: string;
  readonly written_off_at: string | null;
}

export function parseMissingParcel(body: unknown): MissingParcelView | undefined {
  if (!isRecord(body)) return undefined;
  const parcel = uuidOf(body.parcel_id);
  const photo = uuidOf(body.photo_evidence_id);
  const intake = uuidOf(body.intake_id);
  const intakeCode = codeOf(body.intake_code);
  const run = uuidOf(body.run_id);
  const runCode = codeOf(body.run_code);
  const vendor = nameOf(body.vendor_name);
  const since = instantOf(body.missing_since);
  const writtenOff = optional(body.written_off_at, instantOf);
  if (
    parcel === undefined ||
    photo === undefined ||
    intake === undefined ||
    intakeCode === undefined ||
    run === undefined ||
    runCode === undefined ||
    vendor === undefined ||
    since === undefined ||
    writtenOff === undefined
  ) {
    return undefined;
  }
  return {
    parcel_id: parcel,
    photo_evidence_id: photo,
    intake_id: intake,
    intake_code: intakeCode,
    run_id: run,
    run_code: runCode,
    vendor_name: vendor,
    missing_since: since,
    written_off_at: writtenOff,
  };
}

export interface MissingPageView {
  readonly items: readonly MissingParcelView[];
  readonly nextPageToken: string | null;
}

/** A page of `listMissingParcels`. */
export function parseMissingPage(body: unknown): MissingPageView | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const token = tokenOf(body);
  if (token === undefined) return undefined;
  const items: MissingParcelView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const item = parseMissingParcel(entry);
    if (item === undefined || seen.has(item.parcel_id.toLowerCase())) return undefined;
    seen.add(item.parcel_id.toLowerCase());
    items.push(item);
  }
  return { items, nextPageToken: token };
}

// ---- the answers of the acts and the evidence limits -------------------------------------------------------------------------------------------------------------------------------

/** The answer of `recordParcelArrival` and `addExtraParcel`: the parcel as it now is, the vendor's token for its next act, and its counts. */
export interface ParcelAnswerView {
  readonly parcel: ParcelView;
  readonly intake_etag: string;
  readonly counts: CountsView;
}

export function parseParcelAnswer(body: unknown): ParcelAnswerView | undefined {
  if (!isRecord(body) || !isRecord(body.counts)) return undefined;
  const parcel = parseParcel(body.parcel);
  const etag = etagOf(body.intake_etag);
  const counts = parseCounts(body.counts);
  if (parcel === undefined || etag === undefined || counts === undefined) return undefined;
  return { parcel, intake_etag: etag, counts };
}

/** One finding of an intake, as `HubIntakeCheckIn` carries it (`IntakeFinding`): a recording of a condition or a decision, by display name. */
export interface FindingView {
  readonly id: string;
  readonly kind: 'CONDITION' | 'ADJUDICATION';
  readonly intake_parcel_id: string | null;
  readonly condition: IntakeCondition | null;
  readonly outcome: components['schemas']['IntakeFinding']['outcome'];
  readonly note: string | null;
  readonly evidence_ids: readonly string[];
  readonly recorded_by_name: string;
  readonly recorded_at: string;
}

const OUTCOMES = ['ACCEPTED', 'ESCALATED', 'WRITTEN_OFF', 'VENDOR_NOTIFIED'] as const;

export function parseFinding(body: unknown): FindingView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const parcel = optional(body.intake_parcel_id, uuidOf);
  const condition = optional(body.condition, (value) =>
    isOneOf(INTAKE_CONDITIONS, value) ? value : undefined,
  );
  const outcome = optional(body.outcome, (value) => (isOneOf(OUTCOMES, value) ? value : undefined));
  const note = optional(body.note, noteOf);
  const evidence = uuidListOf(body.evidence_ids ?? []);
  const by = nameOf(body.recorded_by_name);
  const at = instantOf(body.recorded_at);
  if (
    id === undefined ||
    parcel === undefined ||
    condition === undefined ||
    outcome === undefined ||
    note === undefined ||
    evidence === undefined ||
    by === undefined ||
    at === undefined ||
    (body.kind !== 'CONDITION' && body.kind !== 'ADJUDICATION')
  ) {
    return undefined;
  }
  if (body.kind === 'CONDITION' && (condition === null || outcome !== null)) return undefined;
  if (body.kind === 'ADJUDICATION' && (outcome === null || parcel !== null)) return undefined;
  return {
    id,
    kind: body.kind,
    intake_parcel_id: parcel,
    condition,
    outcome,
    note,
    evidence_ids: evidence,
    recorded_by_name: by,
    recorded_at: at,
  };
}

/**
 * The vendor's record as `HubIntakeCheckIn` gives it (the third intake shape, `count_phase` `CHECK_IN`): the vendor's section, plus what the record of a vendor and the senior's decision read: the run's code, the
 * rider by name, **the rider's declaration shown as a recorded fact** (a photo intake hides nothing, D-D1), the comparison, who finished it and the findings. The `ETag` is the answer's header, given by the caller.
 */
export interface CheckInView extends CountsView {
  readonly id: string;
  readonly code: string;
  readonly hub_id: string;
  readonly pickup_manifest_id: string;
  readonly run_code: string;
  readonly state: IntakeState;
  readonly vendor_name: string;
  readonly handed_over_by_name: string;
  readonly handed_over_at: string;
  readonly rider_declared_count: number;
  readonly count_difference: number | null;
  readonly counted_at: string | null;
  readonly counted_by_name: string | null;
  readonly lock: LockView | null;
  readonly parcels: readonly ParcelView[];
  readonly condition: IntakeCondition;
  readonly condition_findings: readonly FindingView[];
}

export function parseCheckIn(body: unknown): CheckInView | undefined {
  if (
    !isRecord(body) ||
    body.count_phase !== 'CHECK_IN' ||
    body.receiving_mode !== 'PHOTO_CHECK_IN'
  ) {
    return undefined;
  }
  const id = uuidOf(body.id);
  const code = codeOf(body.code);
  const hub = uuidOf(body.hub_id);
  const manifest = uuidOf(body.pickup_manifest_id);
  const runCode = codeOf(body.run_code);
  const vendor = nameOf(body.vendor_name);
  const rider = nameOf(body.handed_over_by_name);
  const handed = instantOf(body.handed_over_at);
  const declared = whole(body.rider_declared_count);
  const difference = optional(body.count_difference, signedWhole);
  const countedAt = optional(body.counted_at, instantOf);
  const countedBy = optional(body.counted_by_name, nameOf);
  const counts = parseCounts(body);
  const lock = parseLock(body.lock);
  const parcels = parseParcels(body.parcels);
  const findingsRaw = body.condition_findings;
  if (
    id === undefined ||
    code === undefined ||
    hub === undefined ||
    manifest === undefined ||
    runCode === undefined ||
    vendor === undefined ||
    rider === undefined ||
    handed === undefined ||
    declared === undefined ||
    difference === undefined ||
    countedAt === undefined ||
    countedBy === undefined ||
    counts === undefined ||
    lock === undefined ||
    parcels === undefined ||
    !Array.isArray(findingsRaw) ||
    !isOneOf(INTAKE_STATES, body.state) ||
    !isOneOf(INTAKE_CONDITIONS, body.condition)
  ) {
    return undefined;
  }
  const findings: FindingView[] = [];
  const seenFindings = new Set<string>();
  for (const entry of findingsRaw as unknown[]) {
    const finding = parseFinding(entry);
    // Each finding once, found with a set: the history of a long case is as long as it is.
    if (finding === undefined || seenFindings.has(finding.id.toLowerCase())) return undefined;
    seenFindings.add(finding.id.toLowerCase());
    findings.push(finding);
  }
  const view: CheckInView = {
    ...counts,
    id,
    code,
    hub_id: hub,
    pickup_manifest_id: manifest,
    run_code: runCode,
    state: body.state,
    vendor_name: vendor,
    handed_over_by_name: rider,
    handed_over_at: handed,
    rider_declared_count: declared,
    count_difference: difference,
    counted_at: countedAt,
    counted_by_name: countedBy,
    lock,
    parcels,
    condition: body.condition,
    condition_findings: findings,
  };
  // A photo intake's counts follow from its parcels, as a vendor's section's do.
  const section: VendorView = {
    ...counts,
    intake_id: id,
    intake_code: code,
    intake_etag: 'check-in',
    receiving_mode: 'PHOTO_CHECK_IN',
    state: view.state,
    vendor_name: vendor,
    lock,
    parcels,
  };
  if (photoProblem(section)) return undefined;
  return view;
}

/** The fields each guard reads, held to the contract by `test/hub-receiving-contract.test.ts`. */
export const RECEIVING_FIELDS = {
  IntakeParcelCondition: {
    required: ['condition', 'note', 'evidence_ids', 'recorded_by_name', 'recorded_at'],
    enums: { condition: INTAKE_CONDITIONS },
  },
  IntakeParcel: {
    required: [
      'id',
      'ordinal',
      'origin',
      'state',
      'photo_evidence_id',
      'arrived_by_name',
      'arrived_at',
      'missing_marked_at',
      'condition',
    ],
    enums: { origin: PARCEL_ORIGINS, state: PARCEL_STATES },
  },
  ReceivingLock: {
    required: ['holder_name', 'held_by_you', 'opened_at', 'last_seen_at'],
    enums: {},
  },
  IntakeCounts: {
    required: [
      'parcels_expected',
      'arrived_count',
      'received_count',
      'count_variance',
      'missing_count',
      'extra_count',
      'damaged_count',
    ],
    enums: { count_variance: COUNT_VARIANCES },
  },
  ReceivingVendor: {
    required: [
      'intake_id',
      'intake_code',
      'intake_etag',
      'receiving_mode',
      'state',
      'vendor_name',
      'parcels_expected',
      'arrived_count',
      'received_count',
      'count_variance',
      'lock',
      'missing_count',
      'extra_count',
      'damaged_count',
      'parcels',
    ],
    enums: {
      receiving_mode: RECEIVING_MODES,
      state: INTAKE_STATES,
      count_variance: COUNT_VARIANCES,
    },
  },
  ReceivingRun: {
    required: ['run', 'rider_name', 'handed_over_at', 'vendors'],
    enums: {},
  },
  ReceivingRunSummary: {
    required: [
      'run_id',
      'run_code',
      'hub_id',
      'hub_name',
      'rider_name',
      'vendor_names',
      'vendors_total',
      'vendors_waiting',
      'vendors_needing_decision',
      'blind_count_vendors',
      'parcels_expected',
      'missing_searching',
      'handed_over_at',
      'checking_in',
    ],
    enums: {},
  },
  MissingParcel: {
    required: [
      'parcel_id',
      'photo_evidence_id',
      'intake_id',
      'intake_code',
      'run_id',
      'run_code',
      'vendor_name',
      'missing_since',
      'written_off_at',
    ],
    enums: {},
  },
  IntakeParcelAnswer: { required: ['parcel', 'intake_etag', 'counts'], enums: {} },
  IntakeFinding: {
    required: [
      'id',
      'kind',
      'intake_parcel_id',
      'condition',
      'outcome',
      'note',
      'evidence_ids',
      'recorded_by',
      'recorded_by_name',
      'recorded_at',
    ],
    enums: { kind: ['CONDITION', 'ADJUDICATION'], condition: INTAKE_CONDITIONS, outcome: OUTCOMES },
  },
  HubIntakeCheckIn: {
    required: [
      'id',
      'code',
      'hub_id',
      'pickup_request_id',
      'pickup_manifest_id',
      'run_code',
      'state',
      'count_phase',
      'receiving_mode',
      'vendor_name',
      'handed_over_by_name',
      'handed_over_at',
      'parcels_expected',
      'rider_declared_count',
      'arrived_count',
      'received_count',
      'count_variance',
      'count_difference',
      'counted_at',
      'counted_by_name',
      'lock',
      'parcels',
      'missing_count',
      'extra_count',
      'damaged_count',
      'condition',
      'condition_findings',
    ],
    enums: { state: INTAKE_STATES, condition: INTAKE_CONDITIONS, count_variance: COUNT_VARIANCES },
  },
} as const;
