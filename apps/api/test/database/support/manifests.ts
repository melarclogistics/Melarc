import { randomInt, randomUUID } from 'node:crypto';

import type pg from 'pg';

import { backendPidOf } from './lock-wait.js';
import { ARRANGER } from './pickups.js';
import { clientFor, type TestDatabase } from './test-database.js';

/**
 * Manifest and stop rows arranged **as the administrator**, for the tests that read, judge or change them (S1.20 onward). The operation
 * that makes a manifest is under test through the route; these rows are what a test needs to exist first: another hub's manifest, a
 * dispatched one assigned to a rider (no operation of S1.20 dispatches), a stop that was skipped or failed. Past row-level security, as
 * `pickups.ts` is, and asserted from a second connection. The table's own constraints still hold: a row cannot say a state its moments
 * contradict, so the moments are derived from the state here.
 */
type Query = Pick<pg.Client, 'query'>;

/** The alphabet of an operational code (MSC-DEC-202): no 0, O, 1, I or L. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function manifestCode(prefix = 'ACC'): string {
  let tail = '';
  for (let at = 0; at < 6; at += 1) tail += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
  return `${prefix}-MF-${tail}`;
}

export type ManifestState = 'DRAFT' | 'DISPATCHED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface ManifestRow {
  readonly id: string;
  readonly code: string;
  readonly hubId: string;
  readonly serviceDate: string;
  readonly state: ManifestState;
  readonly assignedRiderId: string | null;
  /** Whether a `CANCELLED` manifest was dispatched before it was cancelled; the other states say it themselves. */
  readonly dispatchedBeforeCancel?: boolean;
  readonly createdBy: string;
  /** The moment a run in progress (or completed) was started (a fixed one when left out), for a test of which run has been out the longest. */
  readonly startedAt?: Date;
}

/** A `DRAFT` manifest of the hub for a day, assigned to nobody. */
export function manifestRow(hubId: string, overrides: Partial<ManifestRow> = {}): ManifestRow {
  return {
    id: randomUUID(),
    code: manifestCode(),
    hubId,
    serviceDate: '2026-11-03',
    state: 'DRAFT',
    assignedRiderId: null,
    createdBy: ARRANGER,
    ...overrides,
  };
}

export async function insertManifest(client: Query, row: ManifestRow): Promise<ManifestRow> {
  const dispatched =
    ['DISPATCHED', 'IN_PROGRESS', 'COMPLETED'].includes(row.state) ||
    (row.state === 'CANCELLED' && row.dispatchedBeforeCancel === true);
  const started = row.state === 'IN_PROGRESS' || row.state === 'COMPLETED';
  await client.query(
    `insert into pickup_manifest (id, code, responsible_hub_id, service_date, state, assigned_rider_id, assigned_at, dispatched_at,
                                  started_at, completed_at, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      row.id,
      row.code,
      row.hubId,
      row.serviceDate,
      row.state,
      row.assignedRiderId,
      row.assignedRiderId === null ? null : new Date('2026-11-02T10:00:00Z'),
      dispatched ? new Date('2026-11-02T11:00:00Z') : null,
      started ? (row.startedAt ?? new Date('2026-11-03T08:00:00Z')) : null,
      row.state === 'COMPLETED' ? new Date('2026-11-03T17:00:00Z') : null,
      row.createdBy,
    ],
  );
  return row;
}

export type StopState =
  'PENDING' | 'ARRIVED' | 'COLLECTED' | 'PARTIALLY_COLLECTED' | 'FAILED' | 'SKIPPED';

export interface StopRow {
  readonly id: string;
  readonly manifestId: string;
  readonly requestId: string;
  readonly hubId: string;
  readonly sequence: number;
  readonly state: StopState;
  /** The moment the claim was released; an unreleased stop (the default) holds its request. */
  readonly releasedAt: Date | null;
  /** Why the request was carried over, set with the stop and never changed (migration 0059); none for a request on its own day. */
  readonly carryoverSnapshot?: {
    readonly reason_code: string;
    readonly label: string;
    readonly note: string | null;
  };
  /**
   * What the dispatch gave the stop for the rider (the contract's `PickupStopSummary`). It is written with the stop and never by an update,
   * because the guard of a stop lets only the dispatch key make it: a run arranged as already dispatched carries it from its insert.
   */
  readonly pickupSummary?: Record<string, unknown>;
}

/** A `PENDING` stop of a manifest for a request, holding the claim. */
export function stopRow(
  manifest: Pick<ManifestRow, 'id' | 'hubId'>,
  requestId: string,
  sequence: number,
  overrides: Partial<StopRow> = {},
): StopRow {
  return {
    id: randomUUID(),
    manifestId: manifest.id,
    requestId,
    hubId: manifest.hubId,
    sequence,
    state: 'PENDING',
    releasedAt: null,
    ...overrides,
  };
}

/**
 * Inserts the stop with the facts its state implies: a stop that has been arrived at has the moment, a failed one its category and
 * snapshot, a skipped one its snapshot, and a resolved one the moment of its resolution.
 */
export async function insertStop(client: Query, row: StopRow): Promise<StopRow> {
  const arrived = row.state !== 'PENDING' && row.state !== 'SKIPPED';
  const resolved = !['PENDING', 'ARRIVED'].includes(row.state);
  const withSummary = row.pickupSummary !== undefined;
  await client.query(
    `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence, state, arrived_at, resolved_at,
                              failure_category, failure_reason_snapshot, skip_snapshot, released_at, carryover_snapshot${withSummary ? ', pickup_summary' : ''})
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb${withSummary ? ', $14::jsonb' : ''})`,
    [
      row.id,
      row.manifestId,
      row.requestId,
      row.hubId,
      row.sequence,
      row.state,
      arrived ? new Date('2026-11-03T09:00:00Z') : null,
      resolved ? new Date('2026-11-03T09:30:00Z') : null,
      row.state === 'FAILED' ? 'VENDOR_UNAVAILABLE' : null,
      row.state === 'FAILED'
        ? JSON.stringify({
            reason_code: 'CLOSED',
            note: 'The shop was shut',
            reported_at: '2026-11-03T09:30:00.000Z',
          })
        : null,
      row.state === 'SKIPPED'
        ? JSON.stringify({
            reason_code: 'ROAD',
            note: 'The road was flooded',
            skipped_at: '2026-11-03T09:30:00.000Z',
          })
        : null,
      row.releasedAt,
      row.carryoverSnapshot === undefined ? null : JSON.stringify(row.carryoverSnapshot),
      ...(row.pickupSummary === undefined ? [] : [JSON.stringify(row.pickupSummary)]),
    ],
  );
  return row;
}

/**
 * A transaction of its own that has **claimed** a request, as a creation that is competing for it would, and has not ended (a race on the
 * claim, `lock-wait.ts`): the manifest and its one stop are inserted and not committed, so that a creation that names the request meets the
 * unique index of the claim and has to wait for this transaction to say whether the claim stands. The test starts the creation, waits until
 * the server reports it waiting for this backend (`waitUntilBlockedBy`), commits or rolls back here, and the creation then sees what this one
 * left, which is what the index is for. The caller ends the connection.
 */
export async function holdingClaim(
  database: TestDatabase,
  hubId: string,
  requestId: string,
): Promise<{ readonly client: pg.Client; readonly pid: number; readonly manifest: ManifestRow }> {
  const client = clientFor(database.urlFor('postgres'));
  await client.connect();
  await client.query('begin');
  const manifest = manifestRow(hubId);
  await insertManifest(client, manifest);
  await insertStop(client, stopRow(manifest, requestId, 1));
  return { client, pid: await backendPidOf(client), manifest };
}
