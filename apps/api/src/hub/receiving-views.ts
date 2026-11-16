import { createHash } from 'node:crypto';

import { sql, type SQL } from 'drizzle-orm';

import { timestampOf } from '../platform/database/timestamps.js';
import type { transactionOf } from '../platform/database/transaction-handle.js';
import { hubIntakeEtagOf } from './hub-intake-etag.js';
import {
  hubIntakeViewOf,
  type AfterCount,
  type HubIntakeRow,
  type HubIntakeView,
} from './hub-intake-view.js';

type Tx = ReturnType<typeof transactionOf>;

/**
 * Every column of an intake the receiving side reads (the columns the login can read, migrations 0092 and 0103): the facts of an intake as `HUB_INTAKE_READ_COLUMNS` has them, its receiving mode,
 * the moment the holder of the lock first took it and the receiver of the count. **Never the declaration**: a photo intake shows it through the one function that answers it
 * (`melarc.hub_intake_after_count`), a blind-count intake only after its count.
 */
export const RECEIVING_INTAKE_COLUMNS = sql.raw(
  `id, code, responsible_hub_id, pickup_request_id, pickup_manifest_id, handed_over_by, handed_over_at, declaration_captured_at, state, active_receiver_id, lock_acquired_at, physical_count, count_variance, count_difference, condition, version, receiving_mode, lock_opened_at, counted_at, counted_by`,
);

export interface ReceivingIntakeRow extends HubIntakeRow {
  readonly receiving_mode: 'PHOTO_CHECK_IN' | 'BLIND_COUNT';
  readonly lock_opened_at: string | Date | null;
  readonly counted_at: string | Date | null;
  readonly counted_by: string | null;
}

export interface ParcelRow {
  readonly id: string;
  readonly pickup_intake_id: string;
  readonly ordinal: number;
  readonly origin: 'DOOR_PHOTO' | 'HUB_EXTRA';
  readonly state: 'EXPECTED' | 'ARRIVED' | 'MISSING' | 'VOID';
  readonly door_photo_evidence_id: string | null;
  readonly hub_photo_evidence_id: string | null;
  readonly arrived_by: string | null;
  readonly arrived_at: string | Date | null;
  readonly missing_marked_at: string | Date | null;
}

export interface FindingRow {
  readonly id: string;
  readonly pickup_intake_id: string;
  readonly intake_parcel_id: string | null;
  readonly kind: 'CONDITION' | 'ADJUDICATION';
  readonly condition: string | null;
  readonly outcome: string | null;
  readonly note: string | null;
  readonly evidence_ids: readonly string[];
  readonly recorded_by: string;
  readonly recorded_at: string | Date;
}

/** The names the receiving side says: display names and nothing else (migration 0106). A phone number is never read. */
export interface NameBook {
  readonly vendor: ReadonlyMap<string, string>;
  readonly rider: ReadonlyMap<string, string>;
  readonly staff: ReadonlyMap<string, string>;
}

export interface IntakeParcelView {
  readonly id: string;
  readonly ordinal: number;
  readonly origin: 'DOOR_PHOTO' | 'HUB_EXTRA';
  readonly state: 'EXPECTED' | 'ARRIVED' | 'MISSING' | 'VOID';
  readonly photo_evidence_id: string;
  readonly arrived_by_name: string | null;
  readonly arrived_at: string | null;
  readonly missing_marked_at: string | null;
  readonly condition: {
    readonly condition: string;
    readonly note: string | null;
    readonly evidence_ids: readonly string[];
    readonly recorded_by_name: string;
    readonly recorded_at: string;
  } | null;
}

export interface IntakeFindingNamedView {
  readonly id: string;
  readonly kind: 'CONDITION' | 'ADJUDICATION';
  readonly intake_parcel_id: string | null;
  readonly condition: string | null;
  readonly outcome: string | null;
  readonly note: string | null;
  readonly evidence_ids: readonly string[];
  readonly recorded_by: string;
  readonly recorded_by_name: string;
  readonly recorded_at: string;
}

export interface ReceivingLockView {
  readonly holder_name: string;
  readonly held_by_you: boolean;
  readonly opened_at: string;
  readonly last_seen_at: string;
}

export interface IntakeCountsView {
  readonly parcels_expected: number | null;
  readonly arrived_count: number | null;
  readonly received_count: number | null;
  readonly count_variance: 'MATCH' | 'SHORT' | 'OVER' | null;
  readonly missing_count: number;
  readonly extra_count: number;
  readonly damaged_count: number;
}

export interface HubIntakeCheckInView {
  readonly id: string;
  readonly code: string;
  readonly hub_id: string;
  readonly pickup_request_id: string;
  readonly pickup_manifest_id: string;
  readonly run_code: string;
  readonly state: string;
  readonly count_phase: 'CHECK_IN';
  readonly receiving_mode: 'PHOTO_CHECK_IN';
  readonly vendor_name: string;
  readonly handed_over_by_name: string;
  readonly handed_over_at: string;
  readonly parcels_expected: number;
  readonly rider_declared_count: number;
  readonly arrived_count: number;
  readonly received_count: number | null;
  readonly count_variance: 'MATCH' | 'SHORT' | 'OVER' | null;
  readonly count_difference: number | null;
  readonly counted_at: string | null;
  readonly counted_by_name: string | null;
  readonly lock: ReceivingLockView | null;
  readonly parcels: readonly IntakeParcelView[];
  readonly missing_count: number;
  readonly extra_count: number;
  readonly damaged_count: number;
  readonly condition: string;
  readonly condition_findings: readonly IntakeFindingNamedView[];
}

export interface ReceivingVendorView extends IntakeCountsView {
  readonly intake_id: string;
  readonly intake_code: string;
  readonly intake_etag: string;
  readonly receiving_mode: 'PHOTO_CHECK_IN' | 'BLIND_COUNT';
  readonly state: string;
  readonly vendor_name: string;
  readonly lock: ReceivingLockView | null;
  readonly parcels: readonly IntakeParcelView[];
}

const NOT_AVAILABLE = '(name not available)';

const idList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

const iso = (value: string | Date | null): string | null =>
  value === null ? null : timestampOf(value).toISOString();

/** The display names of the parties of the intakes given: one read of the database's function, which names no one outside the hubs of the caller's grant and never a phone number. */
export async function namesOf(tx: Tx, intakeIds: readonly string[]): Promise<NameBook> {
  const vendor = new Map<string, string>();
  const rider = new Map<string, string>();
  const staff = new Map<string, string>();
  if (intakeIds.length === 0) return { vendor, rider, staff };
  const answered = await tx.execute(
    sql`select party, party_id, intake_id, display_name from melarc.receiving_names(array[${idList(intakeIds)}]::uuid[])`,
  );
  for (const row of answered.rows as unknown as {
    party: string;
    party_id: string | null;
    intake_id: string | null;
    display_name: string;
  }[]) {
    if (row.party === 'VENDOR' && row.intake_id !== null)
      vendor.set(row.intake_id, row.display_name);
    else if (row.party === 'RIDER' && row.party_id !== null)
      rider.set(row.party_id, row.display_name);
    else if (row.party === 'STAFF' && row.party_id !== null)
      staff.set(row.party_id, row.display_name);
  }
  return { vendor, rider, staff };
}

/** The codes of the runs the intakes belong to, by run. */
export async function runCodesOf(
  tx: Tx,
  manifestIds: readonly string[],
): Promise<ReadonlyMap<string, { readonly code: string; readonly serviceDate: string }>> {
  const unique = [...new Set(manifestIds)];
  if (unique.length === 0) return new Map();
  const answered = await tx.execute(
    sql`select manifest_id, run_code, service_date::text as service_date from melarc.receiving_run_codes(array[${idList(unique)}]::uuid[])`,
  );
  return new Map(
    (
      answered.rows as unknown as { manifest_id: string; run_code: string; service_date: string }[]
    ).map((row) => [row.manifest_id, { code: row.run_code, serviceDate: row.service_date }]),
  );
}

/** The parcels of the intakes given, each intake's in the order its parcels are drawn in. */
export async function parcelsOf(
  tx: Tx,
  intakeIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ParcelRow[]>> {
  if (intakeIds.length === 0) return new Map();
  const found = await tx.execute(sql`
    select id, pickup_intake_id, ordinal, origin, state, door_photo_evidence_id, hub_photo_evidence_id, arrived_by, arrived_at, missing_marked_at
      from intake_parcel where pickup_intake_id = any(array[${idList(intakeIds)}]::uuid[]) order by pickup_intake_id, ordinal`);
  const by = new Map<string, ParcelRow[]>();
  for (const row of found.rows as unknown as ParcelRow[]) {
    by.set(row.pickup_intake_id, [...(by.get(row.pickup_intake_id) ?? []), row]);
  }
  return by;
}

/** The findings of the intakes given, with the parcel a condition is a finding of, in the order they were made. */
export async function findingRowsOf(
  tx: Tx,
  intakeIds: readonly string[],
): Promise<ReadonlyMap<string, readonly FindingRow[]>> {
  if (intakeIds.length === 0) return new Map();
  const found = await tx.execute(sql`
    select id, pickup_intake_id, intake_parcel_id, kind, condition, outcome, note, evidence_ids, recorded_by, recorded_at
      from pickup_intake_finding where pickup_intake_id = any(array[${idList(intakeIds)}]::uuid[]) order by recorded_at, id`);
  const by = new Map<string, FindingRow[]>();
  for (const row of found.rows as unknown as FindingRow[]) {
    by.set(row.pickup_intake_id, [...(by.get(row.pickup_intake_id) ?? []), row]);
  }
  return by;
}

/** What `melarc.hub_intake_after_count` answers for the intakes given (a photo intake from the start, a blind-count intake once counted): the rider's declaration and the door photos. */
export async function declarationsOf(
  tx: Tx,
  intakeIds: readonly string[],
): Promise<
  ReadonlyMap<string, { readonly declared: number; readonly photoIds: readonly string[] }>
> {
  if (intakeIds.length === 0) return new Map();
  const answered = await tx.execute(
    sql`select intake_id, rider_declared_count, parcel_photo_ids from melarc.hub_intake_after_count(array[${idList(intakeIds)}]::uuid[])`,
  );
  return new Map(
    (
      answered.rows as unknown as {
        intake_id: string;
        rider_declared_count: number;
        parcel_photo_ids: readonly string[];
      }[]
    ).map((row) => [
      row.intake_id,
      { declared: row.rider_declared_count, photoIds: row.parcel_photo_ids },
    ]),
  );
}

export const staffName = (book: NameBook, id: string | null): string | null =>
  id === null ? null : (book.staff.get(id) ?? NOT_AVAILABLE);

export function findingViewOf(row: FindingRow, book: NameBook): IntakeFindingNamedView {
  return {
    id: row.id,
    kind: row.kind,
    intake_parcel_id: row.intake_parcel_id,
    condition: row.condition,
    outcome: row.outcome,
    note: row.note,
    evidence_ids: [...row.evidence_ids],
    recorded_by: row.recorded_by,
    recorded_by_name: staffName(book, row.recorded_by) ?? NOT_AVAILABLE,
    recorded_at: iso(row.recorded_at) ?? '',
  };
}

export function parcelViewOf(
  parcel: ParcelRow,
  findings: readonly FindingRow[],
  book: NameBook,
): IntakeParcelView {
  const found = findings.find(
    (finding) => finding.kind === 'CONDITION' && finding.intake_parcel_id === parcel.id,
  );
  const photo =
    parcel.origin === 'DOOR_PHOTO' ? parcel.door_photo_evidence_id : parcel.hub_photo_evidence_id;
  if (photo === null) throw new Error('A parcel has the photo of its origin');
  return {
    id: parcel.id,
    ordinal: parcel.ordinal,
    origin: parcel.origin,
    state: parcel.state,
    photo_evidence_id: photo,
    arrived_by_name: staffName(book, parcel.arrived_by),
    arrived_at: iso(parcel.arrived_at),
    missing_marked_at: iso(parcel.missing_marked_at),
    condition:
      found === undefined
        ? null
        : {
            condition: found.condition ?? 'OK',
            note: found.note,
            evidence_ids: [...found.evidence_ids],
            recorded_by_name: staffName(book, found.recorded_by) ?? NOT_AVAILABLE,
            recorded_at: iso(found.recorded_at) ?? '',
          },
  };
}

/** The lock as the screens say it: who opened this check-in, and when. No lock is shown for an intake nobody holds. */
export function lockViewOf(
  row: ReceivingIntakeRow,
  book: NameBook,
  callerId: string,
): ReceivingLockView | null {
  if (row.active_receiver_id === null || row.lock_acquired_at === null) return null;
  const opened = row.lock_opened_at ?? row.lock_acquired_at;
  return {
    holder_name: book.staff.get(row.active_receiver_id) ?? NOT_AVAILABLE,
    held_by_you: row.active_receiver_id.toLowerCase() === callerId.toLowerCase(),
    opened_at: iso(opened) ?? '',
    last_seen_at: iso(row.lock_acquired_at) ?? '',
  };
}

const varianceOf = (value: string | null): 'MATCH' | 'SHORT' | 'OVER' | null =>
  value === 'MATCH' || value === 'SHORT' || value === 'OVER' ? value : null;

/** The counts of one vendor's check-in, derived from its parcels and findings and never typed. A blind-count vendor has no parcels: its expected and live numbers are not given. */
export function countsOf(
  row: ReceivingIntakeRow,
  parcels: readonly ParcelRow[],
  findings: readonly FindingRow[],
): IntakeCountsView {
  const photo = row.receiving_mode === 'PHOTO_CHECK_IN';
  const damaged = findings.filter(
    (finding) =>
      finding.kind === 'CONDITION' && finding.condition !== null && finding.condition !== 'OK',
  ).length;
  return {
    parcels_expected: photo
      ? parcels.filter((parcel) => parcel.origin === 'DOOR_PHOTO').length
      : null,
    arrived_count: photo ? parcels.filter((parcel) => parcel.state === 'ARRIVED').length : null,
    received_count: row.physical_count,
    count_variance: varianceOf(row.count_variance),
    missing_count: parcels.filter((parcel) => parcel.state === 'MISSING').length,
    extra_count: parcels.filter(
      (parcel) => parcel.origin === 'HUB_EXTRA' && parcel.state !== 'VOID',
    ).length,
    damaged_count: damaged,
  };
}

export interface CheckInInput {
  readonly row: ReceivingIntakeRow;
  readonly parcels: readonly ParcelRow[];
  readonly findings: readonly FindingRow[];
  readonly book: NameBook;
  readonly runCode: string;
  readonly declared: number;
  readonly callerId: string;
}

/** The third intake shape, `HubIntakeCheckIn`: a photo intake as the record of the vendor draws it. It hides nothing (D-D1). */
export function checkInViewOf(input: CheckInInput): HubIntakeCheckInView {
  const { row, parcels, findings, book } = input;
  const counts = countsOf(row, parcels, findings);
  return {
    id: row.id,
    code: row.code,
    hub_id: row.responsible_hub_id,
    pickup_request_id: row.pickup_request_id,
    pickup_manifest_id: row.pickup_manifest_id,
    run_code: input.runCode,
    state: row.state,
    count_phase: 'CHECK_IN',
    receiving_mode: 'PHOTO_CHECK_IN',
    vendor_name: book.vendor.get(row.id) ?? NOT_AVAILABLE,
    handed_over_by_name: book.rider.get(row.handed_over_by) ?? NOT_AVAILABLE,
    handed_over_at: iso(row.handed_over_at) ?? '',
    parcels_expected: counts.parcels_expected ?? 0,
    rider_declared_count: input.declared,
    arrived_count: counts.arrived_count ?? 0,
    received_count: row.physical_count,
    count_variance: varianceOf(row.count_variance),
    count_difference: row.count_difference,
    counted_at: iso(row.counted_at),
    counted_by_name: staffName(book, row.counted_by),
    lock: lockViewOf(row, book, input.callerId),
    parcels: parcels.map((parcel) => parcelViewOf(parcel, findings, book)),
    missing_count: counts.missing_count,
    extra_count: counts.extra_count,
    damaged_count: counts.damaged_count,
    condition: row.condition,
    condition_findings: findings.map((finding) => findingViewOf(finding, book)),
  };
}

const CHECK_IN_ETAG_DOMAIN = 'melarc.hub-intake-check-in-etag.v1';

/**
 * The ETag of a photo intake: **an opaque strong validator of the facts a count or a decision rests on** (the intake's durable `version` and the representation without what moves under a receiver's
 * hand): it leaves out the advisory lock, the live counts and the parcels, so that the taps, the untaps and an extra added before the vendor is finished never make the finish stale
 * (`finishCheckIn` takes it back as `If-Match`). The database moves the version for the finish, a found parcel, an extra added after it, a finding, a decision and a correction.
 */
export function checkInEtagOf(view: HubIntakeCheckInView, version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError('A record version is a non-negative safe integer');
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        CHECK_IN_ETAG_DOMAIN,
        version,
        view.id,
        view.code,
        view.state,
        view.hub_id,
        view.pickup_request_id,
        view.pickup_manifest_id,
        view.run_code,
        view.handed_over_at,
        view.parcels_expected,
        view.rider_declared_count,
        view.received_count,
        view.count_variance,
        view.count_difference,
        view.counted_at,
        view.condition,
        view.condition_findings.map((finding) => finding.id),
      ]),
      'utf8',
    )
    .digest('base64url');
  return `"${digest}"`;
}

/** What every read and act of the receiving side loads for the intakes it is about, in two shapes: a photo intake's third shape, and a blind-count intake's own two. */
export interface LoadedIntakes {
  readonly checkIns: ReadonlyMap<
    string,
    { readonly view: HubIntakeCheckInView; readonly etag: string }
  >;
  readonly blind: ReadonlyMap<
    string,
    { readonly view: HubIntakeView; readonly etag: string; readonly after: AfterCount | undefined }
  >;
  readonly parcels: ReadonlyMap<string, readonly ParcelRow[]>;
  readonly findings: ReadonlyMap<string, readonly FindingRow[]>;
  readonly book: NameBook;
}

/**
 * Loads what the shapes of these intakes are made of, in one place for every operation of the receiving side: the parcels, the findings, the names, the codes of the runs and the declaration of
 * a photo intake (or of a blind-count one that has been counted). A photo intake becomes `HubIntakeCheckIn`; a blind-count intake stays `HubIntakePreCount` or `HubIntakePostCount`.
 */
export async function loadIntakes(
  tx: Tx,
  rows: readonly ReceivingIntakeRow[],
  callerId: string,
): Promise<LoadedIntakes> {
  const ids = rows.map((row) => row.id);
  // One statement at a time on the transaction's one connection.
  const parcels = await parcelsOf(tx, ids);
  const findings = await findingRowsOf(tx, ids);
  const book = await namesOf(tx, ids);
  const codes = await runCodesOf(
    tx,
    rows.map((row) => row.pickup_manifest_id),
  );
  const wantsDeclaration = rows
    .filter((row) => row.receiving_mode === 'PHOTO_CHECK_IN' || row.physical_count !== null)
    .map((row) => row.id);
  const declarations = await declarationsOf(tx, wantsDeclaration);
  const checkIns = new Map<string, { view: HubIntakeCheckInView; etag: string }>();
  const blind = new Map<
    string,
    { view: HubIntakeView; etag: string; after: AfterCount | undefined }
  >();
  for (const row of rows) {
    const declaration = declarations.get(row.id);
    if (row.receiving_mode === 'PHOTO_CHECK_IN') {
      if (declaration === undefined) throw new Error('A photo intake is read with its declaration');
      const view = checkInViewOf({
        row,
        parcels: parcels.get(row.id) ?? [],
        findings: findings.get(row.id) ?? [],
        book,
        runCode: codes.get(row.pickup_manifest_id)?.code ?? NOT_AVAILABLE,
        declared: declaration.declared,
        callerId,
      });
      checkIns.set(row.id, { view, etag: checkInEtagOf(view, row.version) });
    } else {
      const after: AfterCount | undefined =
        declaration === undefined
          ? undefined
          : {
              declared: declaration.declared,
              photoIds: declaration.photoIds,
              findings: (findings.get(row.id) ?? []).map((finding) => ({
                id: finding.id,
                kind: finding.kind,
                condition: finding.condition,
                outcome: finding.outcome,
                note: finding.note,
                evidence_ids: [...finding.evidence_ids],
                recorded_by: finding.recorded_by,
                recorded_at: iso(finding.recorded_at) ?? '',
              })),
            };
      const view = hubIntakeViewOf(row, after);
      blind.set(row.id, { view, etag: hubIntakeEtagOf(view, row.version), after });
    }
  }
  return { checkIns, blind, parcels, findings, book };
}

/** One vendor's section of a run's receiving page, from what `loadIntakes` loaded. */
export function vendorViewOf(
  row: ReceivingIntakeRow,
  loaded: LoadedIntakes,
  callerId: string,
): ReceivingVendorView {
  const parcels = loaded.parcels.get(row.id) ?? [];
  const findings = loaded.findings.get(row.id) ?? [];
  const counts = countsOf(row, parcels, findings);
  const photo = loaded.checkIns.get(row.id);
  const etag = photo?.etag ?? loaded.blind.get(row.id)?.etag;
  if (etag === undefined) throw new Error('An intake is loaded in one of its shapes');
  return {
    intake_id: row.id,
    intake_code: row.code,
    intake_etag: etag,
    receiving_mode: row.receiving_mode,
    state: row.state,
    vendor_name: loaded.book.vendor.get(row.id) ?? NOT_AVAILABLE,
    ...counts,
    lock: lockViewOf(row, loaded.book, callerId),
    parcels: parcels.map((parcel) => parcelViewOf(parcel, findings, loaded.book)),
  };
}

/** The answer of the act on one parcel: the parcel as it now is, the vendor's `ETag` and its counts. */
export function parcelAnswerOf(
  view: HubIntakeCheckInView,
  etag: string,
  parcelId: string,
): {
  readonly parcel: IntakeParcelView;
  readonly intake_etag: string;
  readonly counts: IntakeCountsView;
} {
  const parcel = view.parcels.find((each) => each.id === parcelId);
  if (parcel === undefined) throw new Error('A parcel is one of its intake’s parcels');
  return {
    parcel,
    intake_etag: etag,
    counts: {
      parcels_expected: view.parcels_expected,
      arrived_count: view.arrived_count,
      received_count: view.received_count,
      count_variance: view.count_variance,
      missing_count: view.missing_count,
      extra_count: view.extra_count,
      damaged_count: view.damaged_count,
    },
  };
}
