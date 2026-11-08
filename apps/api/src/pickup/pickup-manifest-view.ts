import { sql, type SQL } from 'drizzle-orm';

import type { PickupFailureCategory } from './pickup-vocabulary.js';

/**
 * The pickup manifest and its stops as a read answers them (S1.20; domain-model.md sections 6.3 and 6.4, the contract's `PickupManifest`
 * and `PickupStop`), made from rows of `pickup_manifest` and `pickup_stop`. Nothing here is derived from the client.
 *
 * **`pickup_summary`**, what a rider is shown at the door, is made once by `dispatchManifest` (S1.21; OB-S1-21, the Product Owner's decision
 * of 2 November 2026) from the request and kept on the stop, and is absent from a stop of a manifest that has not been dispatched and from a
 * stop that was already resolved when it was (a cancelled request is never sent to a rider). It is a closed projection: the six members the
 * contract names, copied one by one, so that nothing else the row holds can reach a representation. `arrived_at` is the moment of the rider's
 * arrival (`arriveAtPickupStop`, S1.22; `pickup-run-execution.service.ts`). The members `failure_category` and `failure` are null unless the stop failed (`reportPickupFailure`, S1.28), and `skipped` unless it
 * was skipped, which Ops does or the cancellation of a request does to the stop that holds it (`pickup-stop-resolution.ts`).
 */
export type PickupManifestState =
  'DRAFT' | 'DISPATCHED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export type PickupStopState =
  'PENDING' | 'ARRIVED' | 'COLLECTED' | 'PARTIALLY_COLLECTED' | 'FAILED' | 'SKIPPED';

/**
 * The failure of a stop as reported (the contract's `failure`): the reason's code, the rider's note where the reason asked for one, and the
 * moment, which is the database's own (`reportPickupFailure`, S1.28).
 */
export interface StopFailureView {
  readonly reason_code: string;
  readonly note?: string;
  readonly reported_at: string;
}

/**
 * A contact attempt the rider made before it failed the stop: how (a call, a text, in person), when (an instant in UTC), what came of it and, where the rider adds one, a note. How long the rider
 * had waited is not reported by the device: it is the moment of the attempt less the stop's `arrived_at`, which the server recorded.
 */
export interface StopContactAttempt {
  readonly method: 'PHONE_CALL' | 'SMS' | 'IN_PERSON';
  readonly attempted_at: string;
  readonly outcome: string;
  readonly note?: string;
}

/**
 * What the table keeps of a failure: the members above, the label and the attribution the reason had when it was given (the catalogue's, held by the
 * stop's guard) and the contact attempts. The representation carries the first three members only, so that what the table keeps beside them is
 * never on the wire.
 */
export interface StopFailureSnapshot extends StopFailureView {
  readonly label: string;
  readonly attribution: string;
  readonly contact_attempts?: readonly StopContactAttempt[];
}

/**
 * The skip of a stop, snapshotted (the contract's `skipped`): written by the act that skips it (S1.23) or, for the stop of a request that
 * was cancelled, by the cancellation (`pickup-stop-resolution.ts`, whose skip has the code `REQUEST_CANCELLED` and no note: the note of a
 * cancellation is Ops's own and is not a rider's to read).
 */
export interface StopSkipView {
  readonly reason_code: string;
  readonly note?: string;
  readonly skipped_at: string;
}

/** What the table keeps of a skip: the members above and the label the reason had when it was given, which the representation does not carry. */
export interface StopSkipSnapshot extends StopSkipView {
  readonly label?: string;
}

/** The place in a summary: the contract's `Location`, a member left out where the request has none of it (never null). */
export interface SummaryLocationView {
  readonly address: string;
  readonly landmark?: string;
  readonly map_link?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

/**
 * What a rider is shown for a stop (the contract's `PickupStopSummary`): the pickup's reference (the request's code, the one the sender is
 * texted), the vendor or sender as booked, the packages **as declared**, the place the rider is sent to, the pickup's note and the primary
 * contact. It carries no payer, price, destination, recipient or other request.
 */
export interface PickupStopSummaryView {
  readonly reference: string;
  readonly sender_display_name: string;
  readonly declared_package_count: number;
  readonly resolved_pickup_location: SummaryLocationView;
  /** Null until a pickup-instructions field is defined on the request; never the landmark, and never made from a location override. */
  readonly location_note: string | null;
  readonly contact_phone: string | null;
}

export interface PickupStopView {
  readonly id: string;
  readonly pickup_manifest_id: string;
  readonly pickup_request_id: string;
  readonly sequence: number;
  readonly state: PickupStopState;
  readonly arrived_at: string | null;
  readonly failure_category: PickupFailureCategory | null;
  readonly failure: StopFailureView | null;
  readonly skipped: StopSkipView | null;
  /** Present once the manifest is dispatched, for the stops that were to be worked then; absent, not null, otherwise (the contract's type is the object). */
  readonly pickup_summary?: PickupStopSummaryView;
}

export interface PickupManifestView {
  readonly id: string;
  readonly code: string;
  readonly state: PickupManifestState;
  readonly service_date: string;
  readonly responsible_hub_id: string;
  readonly assigned_rider_id: string | null;
  readonly assigned_at: string | null;
  readonly dispatched_at: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  /** The stops in their order, present on a read of one manifest and on its creation; a list of manifests carries none. */
  readonly stops?: readonly PickupStopView[];
}

/** A `pickup_manifest` row as the columns below return it. A date is text and a moment a date; `created_at_text` is the page position. */
export interface PickupManifestRow {
  readonly id: string;
  readonly code: string;
  readonly state: PickupManifestState;
  readonly service_date: string;
  readonly responsible_hub_id: string;
  readonly assigned_rider_id: string | null;
  readonly assigned_at: string | Date | null;
  readonly dispatched_at: string | Date | null;
  readonly started_at: string | Date | null;
  readonly completed_at: string | Date | null;
  readonly version: number;
  readonly created_at: string | Date;
  readonly created_at_text: string;
}

export interface PickupStopRow {
  readonly id: string;
  readonly pickup_manifest_id: string;
  readonly pickup_request_id: string;
  readonly sequence: number;
  readonly state: PickupStopState;
  readonly arrived_at: string | Date | null;
  readonly failure_category: PickupFailureCategory | null;
  readonly failure_reason_snapshot: StopFailureSnapshot | null;
  readonly skip_snapshot: StopSkipSnapshot | null;
  readonly pickup_summary: PickupStopSummaryView | null;
}

/**
 * The columns of a manifest read. The date is text, so that no time zone touches a calendar day, and the creation moment is also read as
 * text because it is the position of a page: the database prints it with its microseconds, which a JavaScript date cannot hold.
 */
export const MANIFEST_COLUMNS: SQL = sql.raw(`
  id, code, state, service_date::text as service_date, responsible_hub_id, assigned_rider_id, assigned_at, dispatched_at, started_at,
  completed_at, version, created_at, created_at::text as created_at_text`);

/**
 * The columns of a stop read. **The note of a skip is Ops's own text and only staff read it** (S1.23; the contract's `skipped.note`): for any
 * other principal the column comes back without it, whatever statement reads the stop (a read, the rider's arrival, the manifest the rider
 * starts), so that no representation of a stop and no `ETag` made from one can carry it to a rider. A staff reader is told by the context of the
 * statement itself, not by the code that asked.
 */
export const STOP_COLUMNS: SQL = sql.raw(`
  id, pickup_manifest_id, pickup_request_id, sequence, state, arrived_at, failure_category, failure_reason_snapshot,
  CASE WHEN melarc.principal_type() = 'STAFF' THEN skip_snapshot ELSE skip_snapshot - 'note' END AS skip_snapshot,
  pickup_summary`);

const iso = (value: string | Date | null): string | null =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

/** The failure as the contract states it: the members it names and no other (the label, the attribution and the contact attempts stay in the table). */
function failureViewOf(snapshot: StopFailureSnapshot | null): StopFailureView | null {
  if (snapshot === null) return null;
  return {
    reason_code: snapshot.reason_code,
    ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
    reported_at: snapshot.reported_at,
  };
}

/** The skip as the contract states it: the members it names and no other, so that what the table keeps beside them is never on the wire. */
function skipViewOf(snapshot: StopSkipSnapshot | null): StopSkipView | null {
  if (snapshot === null) return null;
  return {
    reason_code: snapshot.reason_code,
    ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
    skipped_at: snapshot.skipped_at,
  };
}

/** The place of a summary as the contract states it: the members of its `Location` that are there, copied one by one and no other. */
function locationViewOf(place: SummaryLocationView): SummaryLocationView {
  return {
    address: place.address,
    ...(place.landmark === undefined ? {} : { landmark: place.landmark }),
    ...(place.map_link === undefined ? {} : { map_link: place.map_link }),
    ...(place.latitude === undefined ? {} : { latitude: place.latitude }),
    ...(place.longitude === undefined ? {} : { longitude: place.longitude }),
  };
}

/** The summary as the contract states it: the six members, copied one by one, so that nothing else the column holds can reach the wire. */
function summaryViewOf(summary: PickupStopSummaryView): PickupStopSummaryView {
  return {
    reference: summary.reference,
    sender_display_name: summary.sender_display_name,
    declared_package_count: summary.declared_package_count,
    resolved_pickup_location: locationViewOf(summary.resolved_pickup_location),
    location_note: summary.location_note,
    contact_phone: summary.contact_phone,
  };
}

/** A stop as the contract states it: the members of later acts are null until those acts are built. */
export function stopViewOf(row: PickupStopRow): PickupStopView {
  return {
    id: row.id,
    pickup_manifest_id: row.pickup_manifest_id,
    pickup_request_id: row.pickup_request_id,
    sequence: row.sequence,
    state: row.state,
    arrived_at: iso(row.arrived_at),
    failure_category: row.failure_category,
    failure: failureViewOf(row.failure_reason_snapshot),
    skipped: skipViewOf(row.skip_snapshot),
    ...(row.pickup_summary === null ? {} : { pickup_summary: summaryViewOf(row.pickup_summary) }),
  };
}

/** A manifest as the contract states it, with its stops where they are given (always in the order of their sequence). */
export function manifestViewOf(
  row: PickupManifestRow,
  stops?: readonly PickupStopRow[],
): PickupManifestView {
  const base = {
    id: row.id,
    code: row.code,
    state: row.state,
    service_date: row.service_date,
    responsible_hub_id: row.responsible_hub_id,
    assigned_rider_id: row.assigned_rider_id,
    assigned_at: iso(row.assigned_at),
    dispatched_at: iso(row.dispatched_at),
    started_at: iso(row.started_at),
    completed_at: iso(row.completed_at),
  };
  return stops === undefined
    ? base
    : {
        ...base,
        stops: stops.toSorted((a, b) => a.sequence - b.sequence).map((stop) => stopViewOf(stop)),
      };
}
