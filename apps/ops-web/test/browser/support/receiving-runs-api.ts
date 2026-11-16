import type { Route } from '@playwright/test';

/**
 * The receiving screens of a run (S1.35c; D-D1, D-D2) as the browser tests meet them: the part of the stand-in that answers `listReceivingRuns`, `getReceivingRun`, `recordParcelArrival`, `finishCheckIn`,
 * `addExtraParcel` and the lock of a vendor. **It keeps the rules the API keeps, as far as a screen can meet them** (errors-and-enums.md section 5.3a): a tap states a parcel's desired state and moves no token; a
 * vendor is finished once, on the token it was read at (`stale` otherwise), and "All N here" must carry the number of door photos (`count_changed`) and is refused while an extra stands (`has_extra_parcels`); a
 * parcel not tapped is missing once the vendor is finished as tapped; a missing parcel is found only while the case is open; a vendor with a missing parcel or an extra goes to a senior officer
 * (`RECONCILIATION_REQUIRED`). **A vendor counted blind has no parcel and none of the rider's number in any answer**, and `leak` turns the stand-in into the server it is built against: the number is put into
 * the answer under the contract's name, so that a test can show the page refuses it whole. Every parcel carries an object key planted where the contract never has one.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export type ParcelState = 'EXPECTED' | 'ARRIVED' | 'MISSING' | 'VOID';
export type VendorState =
  'AWAITING_COUNT' | 'RECONCILIATION_REQUIRED' | 'READY_FOR_ITEMIZATION' | 'ITEMIZING' | 'CLOSED';

export interface ParcelRow {
  id: string;
  ordinal: number;
  origin: 'DOOR_PHOTO' | 'HUB_EXTRA';
  state: ParcelState;
  photo: string;
  arrivedBy: string | null;
  arrivedAt: string | null;
  missingAt: string | null;
  condition: {
    condition: 'OK' | 'DAMAGED' | 'TAMPERED' | 'OTHER';
    note: string | null;
    evidence_ids: string[];
    recorded_by_name: string;
    recorded_at: string;
  } | null;
}

export interface VendorRow {
  id: string;
  code: string;
  name: string;
  mode: 'PHOTO_CHECK_IN' | 'BLIND_COUNT';
  state: VendorState;
  version: number;
  parcels: ParcelRow[];
  /** Another officer's lock, as the read shows it. */
  lock: { holder: string; heldByYou: boolean; openedAt: string } | null;
  received: number | null;
  /** A blind vendor's counted number (the old record's `physical`), which is shown after the count. */
  blindCounted: number | null;
  /** The rider's number of a blind vendor: planted where the contract never carries it. */
  riderNumber: number;
  /** What a senior officer decided about the vendor, in the order it was decided (the decisions are findings of the vendor). */
  decisions?: { id: string; outcome: string; note: string; at: string }[];
}

export interface RunRow {
  id: string;
  code: string;
  riderName: string;
  handedOverAt: string;
  hubId: string;
  hubName: string;
  vendors: VendorRow[];
}

export interface RunsContext {
  readonly runs: RunRow[];
  readonly holds: (key: string) => boolean;
  /** The server that carries the rider's number where the contract never does: every answer about a vendor counted blind. */
  readonly leak: boolean;
  /** Evidence declared for an intake and stored: an extra's photo must be one. */
  readonly stored: (evidenceId: string, ownerId: string) => boolean;
  readonly me: string;
  readonly pageSize: number;
  /** Notes what the stand-in did the page could not see (a lock taken). */
  readonly note: (text: string) => void;
}

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown;
}

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  headers: JSON_HEADERS,
  json: {
    code,
    message: 'Diagnostic text that must never reach a screen.',
    request_id: 'req-browser-run',
    ...(details === undefined ? {} : { details }),
  },
});
const conflict = (rule: string): Answer => error(409, 'STATE_CONFLICT', { rule });
const ok = (json: unknown, etag?: string): Answer => ({
  status: 200,
  headers: { ...JSON_HEADERS, ...(etag === undefined ? {} : { etag }) },
  json,
});
const tokenOf = (vendor: VendorRow): string => `"r${String(vendor.version)}"`;

/** The counts of a vendor, derived from its parcels as the database derives them: never typed. */
export function countsOf(vendor: VendorRow) {
  if (vendor.mode === 'BLIND_COUNT') {
    return {
      parcels_expected: null,
      arrived_count: null,
      missing_count: 0,
      extra_count: 0,
      damaged_count: 0,
    };
  }
  const door = vendor.parcels.filter((parcel) => parcel.origin === 'DOOR_PHOTO');
  return {
    parcels_expected: door.length,
    arrived_count: vendor.parcels.filter((parcel) => parcel.state === 'ARRIVED').length,
    missing_count: vendor.parcels.filter((parcel) => parcel.state === 'MISSING').length,
    extra_count: vendor.parcels.filter(
      (parcel) => parcel.origin === 'HUB_EXTRA' && parcel.state !== 'VOID',
    ).length,
    damaged_count: vendor.parcels.filter(
      (parcel) => parcel.condition !== null && parcel.condition.condition !== 'OK',
    ).length,
  };
}

function varianceOf(vendor: VendorRow): 'MATCH' | 'SHORT' | 'OVER' | null {
  if (vendor.received === null) return null;
  const expected = vendor.parcels.filter((parcel) => parcel.origin === 'DOOR_PHOTO').length;
  return vendor.received === expected ? 'MATCH' : vendor.received < expected ? 'SHORT' : 'OVER';
}

const parcelWire = (parcel: ParcelRow) => ({
  id: parcel.id,
  ordinal: parcel.ordinal,
  origin: parcel.origin,
  state: parcel.state,
  photo_evidence_id: parcel.photo,
  arrived_by_name: parcel.arrivedBy,
  arrived_at: parcel.arrivedAt,
  missing_marked_at: parcel.missingAt,
  condition: parcel.condition,
});

const lockWire = (vendor: VendorRow) =>
  vendor.lock === null
    ? null
    : {
        holder_name: vendor.lock.holder,
        held_by_you: vendor.lock.heldByYou,
        opened_at: vendor.lock.openedAt,
        last_seen_at: vendor.lock.openedAt,
      };

/** One vendor's section of the run's page. A vendor counted blind carries no parcel and none of the rider's number, until the leak is switched on. */
function vendorWire(vendor: VendorRow, leak: boolean) {
  const counts = countsOf(vendor);
  const blind = vendor.mode === 'BLIND_COUNT';
  const counted = vendor.state !== 'AWAITING_COUNT';
  return {
    intake_id: vendor.id,
    intake_code: vendor.code,
    intake_etag: tokenOf(vendor),
    receiving_mode: vendor.mode,
    state: vendor.state,
    vendor_name: vendor.name,
    ...counts,
    received_count: blind ? (counted ? vendor.blindCounted : null) : vendor.received,
    count_variance: blind
      ? counted && vendor.blindCounted !== null
        ? vendor.blindCounted === vendor.riderNumber
          ? 'MATCH'
          : vendor.blindCounted < vendor.riderNumber
            ? 'SHORT'
            : 'OVER'
        : null
      : varianceOf(vendor),
    lock: lockWire(vendor),
    parcels: vendor.parcels.map(parcelWire),
    ...(blind && !counted && leak
      ? {
          parcels_expected: vendor.riderNumber,
          extra: { hint: { rider_declared_count: vendor.riderNumber } },
        }
      : {}),
  };
}

export const runWire = (run: RunRow, leak: boolean) => ({
  run: {
    id: run.id,
    code: run.code,
    hub_id: run.hubId,
    hub_name: run.hubName,
    service_date: '2026-11-03',
  },
  rider_name: run.riderName,
  handed_over_at: run.handedOverAt,
  vendors: run.vendors.map((vendor) => vendorWire(vendor, leak)),
});

export function summaryWire(run: RunRow) {
  const photo = run.vendors.filter((vendor) => vendor.mode === 'PHOTO_CHECK_IN');
  return {
    run_id: run.id,
    run_code: run.code,
    hub_id: run.hubId,
    hub_name: run.hubName,
    rider_name: run.riderName,
    vendor_names: run.vendors.map((vendor) => vendor.name),
    vendors_total: run.vendors.length,
    vendors_waiting: run.vendors.filter((vendor) => vendor.state === 'AWAITING_COUNT').length,
    vendors_needing_decision: run.vendors.filter(
      (vendor) => vendor.state === 'RECONCILIATION_REQUIRED',
    ).length,
    blind_count_vendors: run.vendors.filter((vendor) => vendor.mode === 'BLIND_COUNT').length,
    parcels_expected: photo.reduce(
      (total, vendor) => total + vendor.parcels.filter((p) => p.origin === 'DOOR_PHOTO').length,
      0,
    ),
    missing_searching: run.vendors.reduce(
      (total, vendor) =>
        vendor.state === 'RECONCILIATION_REQUIRED'
          ? total + vendor.parcels.filter((parcel) => parcel.state === 'MISSING').length
          : total,
      0,
    ),
    handed_over_at: run.handedOverAt,
    checking_in: run.vendors.flatMap((vendor) =>
      vendor.lock === null ? [] : [{ name: vendor.lock.holder, is_you: vendor.lock.heldByYou }],
    ),
  };
}

/** The state a finished vendor goes to: a missing parcel or an extra that stands, or a condition other than `OK`, is a senior officer's decision. */
function stateAfterFinish(vendor: VendorRow): VendorState {
  const counts = countsOf(vendor);
  return counts.missing_count > 0 || counts.extra_count > 0 || counts.damaged_count > 0
    ? 'RECONCILIATION_REQUIRED'
    : 'READY_FOR_ITEMIZATION';
}

/** The findings of a vendor, in the order they were made: the damage recorded on its parcels, then the decisions of a senior officer. */
function findingsOf(vendor: VendorRow) {
  const damage = vendor.parcels.flatMap((parcel, index) =>
    parcel.condition === null
      ? []
      : [
          {
            id: `f0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            kind: 'CONDITION',
            intake_parcel_id: parcel.id,
            condition: parcel.condition.condition,
            outcome: null,
            note: parcel.condition.note,
            evidence_ids: parcel.condition.evidence_ids,
            recorded_by_name: parcel.condition.recorded_by_name,
            recorded_at: parcel.condition.recorded_at,
          },
        ],
  );
  const decided = (vendor.decisions ?? []).map((decision) => ({
    id: decision.id,
    kind: 'ADJUDICATION',
    intake_parcel_id: null,
    condition: null,
    outcome: decision.outcome,
    note: decision.note,
    evidence_ids: [],
    recorded_by_name: 'Synthetic Officer',
    recorded_at: decision.at,
  }));
  return [...damage, ...decided];
}

/** The vendor's record as the finish answers it (`HubIntakeCheckIn`, the third shape). */
export function checkInWire(run: RunRow, vendor: VendorRow) {
  const counts = countsOf(vendor);
  const expected = counts.parcels_expected ?? 0;
  return {
    id: vendor.id,
    code: vendor.code,
    hub_id: run.hubId,
    pickup_request_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    pickup_manifest_id: run.id,
    run_code: run.code,
    state: vendor.state,
    count_phase: 'CHECK_IN',
    receiving_mode: vendor.mode,
    vendor_name: vendor.name,
    handed_over_by_name: run.riderName,
    handed_over_at: run.handedOverAt,
    rider_declared_count: expected,
    received_count: vendor.received,
    count_variance: varianceOf(vendor),
    count_difference: vendor.received === null ? null : vendor.received - expected,
    counted_at: vendor.received === null ? null : '2026-11-03T08:40:00Z',
    counted_by_name: vendor.received === null ? null : 'Synthetic Officer',
    lock: lockWire(vendor),
    parcels: vendor.parcels.map(parcelWire),
    ...counts,
    condition: counts.damaged_count > 0 ? 'DAMAGED' : 'OK',
    condition_findings: findingsOf(vendor),
  };
}

/**
 * Answers one request of the run screens, or says it is not one of theirs (`false`). The vendors and parcels are the world's and change as the officer acts, so that a second read shows what the first
 * act did.
 */
export async function answerRuns(
  route: Route,
  call: {
    readonly method: string;
    readonly path: string;
    readonly ifMatch: string | undefined;
    readonly idempotencyKey: string | undefined;
    readonly body: unknown;
  },
  context: RunsContext,
): Promise<boolean> {
  const { method, path } = call;
  const body = (call.body ?? {}) as Record<string, unknown>;
  const query = new URL(route.request().url()).searchParams;
  const send = async (answer: Answer): Promise<boolean> => {
    await route.fulfill(answer);
    return true;
  };
  const vendorOf = (id: string) => {
    for (const run of context.runs) {
      const vendor = run.vendors.find((candidate) => candidate.id === id);
      if (vendor !== undefined) return { run, vendor };
    }
    return undefined;
  };

  if (method === 'GET' && path === '/api/v1/receiving-runs') {
    if (!context.holds('hub.read')) return send(error(403, 'PERMISSION_DENIED'));
    const view = query.get('view') ?? 'waiting';
    const lookup = (query.get('q') ?? '').trim().toLowerCase();
    const rows = context.runs
      .filter((run) =>
        view === 'all'
          ? true
          : view === 'needs_decision'
            ? run.vendors.some((vendor) => vendor.state === 'RECONCILIATION_REQUIRED')
            : run.vendors.some((vendor) => vendor.state === 'AWAITING_COUNT'),
      )
      .filter(
        (run) =>
          lookup === '' ||
          run.code.toLowerCase().includes(lookup) ||
          run.vendors.some((vendor) => vendor.name.toLowerCase().includes(lookup)),
      )
      .toSorted((a, b) => a.handedOverAt.localeCompare(b.handedOverAt));
    const start = query.get('page_token') === null ? 0 : Number(query.get('page_token'));
    const items = rows.slice(start, start + context.pageSize).map(summaryWire);
    return send(
      ok({
        items,
        next_page_token:
          start + context.pageSize < rows.length ? String(start + context.pageSize) : null,
      }),
    );
  }

  const runId = /^\/api\/v1\/receiving-runs\/([0-9a-f-]{36})$/.exec(path)?.[1];
  if (method === 'GET' && runId !== undefined) {
    if (!context.holds('hub.read')) return send(error(403, 'PERMISSION_DENIED'));
    const run = context.runs.find((candidate) => candidate.id === runId);
    return send(run === undefined ? error(404, 'NOT_FOUND') : ok(runWire(run, context.leak)));
  }

  // A vendor's record (the third shape of an intake), with its findings, on its token. A vendor counted blind is the intake page's.
  const recordId = /^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})$/.exec(path)?.[1];
  if (method === 'GET' && recordId !== undefined) {
    const found = vendorOf(recordId);
    if (found === undefined || found.vendor.mode === 'BLIND_COUNT') return false;
    if (!context.holds('hub.read')) return send(error(403, 'PERMISSION_DENIED'));
    return send(ok(checkInWire(found.run, found.vendor), tokenOf(found.vendor)));
  }

  // The senior officer's decision about a vendor with door photos: on the vendor's token and under no key. Still searching leaves the case open; accepting or writing off closes it; "vendor told" is a record
  // that follows a write-off, once, and moves no state.
  const decideId = /^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})\/discrepancy$/.exec(path)?.[1];
  if (method === 'POST' && decideId !== undefined) {
    const found = vendorOf(decideId);
    if (found === undefined || found.vendor.mode === 'BLIND_COUNT') return false;
    const { run, vendor } = found;
    if (!context.holds('hub.osd.adjudicate')) return send(error(403, 'PERMISSION_DENIED'));
    if (call.ifMatch !== tokenOf(vendor)) return send(conflict('stale'));
    const outcome = String(body.outcome);
    const decisions = vendor.decisions ?? [];
    if (outcome === 'VENDOR_NOTIFIED') {
      if (!decisions.some((decision) => decision.outcome === 'WRITTEN_OFF')) {
        return send(conflict('not_written_off'));
      }
      if (decisions.some((decision) => decision.outcome === 'VENDOR_NOTIFIED')) {
        return send(conflict('vendor_already_told'));
      }
    } else if (vendor.state !== 'RECONCILIATION_REQUIRED') {
      return send(conflict('not_awaiting_resolution'));
    }
    if (typeof body.note !== 'string' || body.note.trim() === '') {
      return send(error(422, 'REASON_REQUIRED'));
    }
    const cited = Array.isArray(body.evidence_ids) ? (body.evidence_ids as string[]) : [];
    if (!cited.every((evidence) => context.stored(evidence, vendor.id))) {
      return send(error(422, 'EVIDENCE_NOT_STORED'));
    }
    vendor.decisions = [
      ...decisions,
      {
        id: `d0000000-0000-4000-8000-${String(decisions.length + 1).padStart(12, '0')}`,
        outcome,
        note: body.note,
        at: '2026-11-03T09:00:00Z',
      },
    ];
    if (outcome === 'ACCEPTED' || outcome === 'WRITTEN_OFF') vendor.state = 'READY_FOR_ITEMIZATION';
    vendor.version += 1;
    return send(ok(checkInWire(run, vendor), tokenOf(vendor)));
  }

  // A senior officer's correction of a check-in: a reason, and the parcels that change, on the vendor's token and under a key.
  const correctId = /^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})\/correction$/.exec(path)?.[1];
  if (method === 'POST' && correctId !== undefined) {
    const found = vendorOf(correctId);
    if (found === undefined || found.vendor.mode === 'BLIND_COUNT') return false;
    const { run, vendor } = found;
    if (!context.holds('hub.osd.adjudicate')) return send(error(403, 'PERMISSION_DENIED'));
    if (call.idempotencyKey === undefined) return send(error(400, 'VALIDATION_FAILED'));
    if (vendor.state === 'ITEMIZING' || vendor.state === 'CLOSED') {
      return send(conflict('itemization_started'));
    }
    if (call.ifMatch !== tokenOf(vendor)) return send(conflict('stale'));
    if (typeof body.reason !== 'string' || body.reason.trim() === '') {
      return send(error(422, 'REASON_REQUIRED'));
    }
    if (!Array.isArray(body.parcel_changes) || body.parcel_changes.length === 0) {
      return send(error(400, 'VALIDATION_FAILED'));
    }
    for (const change of body.parcel_changes as { parcel_id: string; state: ParcelState }[]) {
      const parcel = vendor.parcels.find((candidate) => candidate.id === change.parcel_id);
      if (parcel === undefined) return send(error(404, 'NOT_FOUND'));
      parcel.state = change.state;
      if (change.state === 'ARRIVED') {
        parcel.arrivedBy = 'Synthetic Officer';
        parcel.arrivedAt = '2026-11-03T08:55:00Z';
        parcel.missingAt = null;
      } else if (change.state === 'MISSING') {
        parcel.arrivedBy = null;
        parcel.arrivedAt = null;
        parcel.missingAt = '2026-11-03T08:55:00Z';
      }
    }
    vendor.received = countsOf(vendor).arrived_count;
    vendor.state = stateAfterFinish(vendor);
    vendor.version += 1;
    return send(ok(checkInWire(run, vendor), tokenOf(vendor)));
  }

  // The parcels being searched for (the missing parcels of a vendor whose case is open), and the written-off ones whose vendor is not yet recorded as told, oldest first.
  if (method === 'GET' && path === '/api/v1/missing-parcels') {
    if (!context.holds('hub.read')) return send(error(403, 'PERMISSION_DENIED'));
    const view = query.get('view') ?? 'searching';
    const items = context.runs
      .flatMap((run) =>
        run.vendors.flatMap((vendor) => {
          if (vendor.mode !== 'PHOTO_CHECK_IN') return [];
          const decisions = vendor.decisions ?? [];
          const writtenOff = decisions.find((decision) => decision.outcome === 'WRITTEN_OFF');
          const told = decisions.some((decision) => decision.outcome === 'VENDOR_NOTIFIED');
          const listed =
            view === 'vendor_to_tell'
              ? writtenOff !== undefined && !told
              : vendor.state === 'RECONCILIATION_REQUIRED';
          if (!listed) return [];
          return vendor.parcels
            .filter((parcel) => parcel.state === 'MISSING')
            .map((parcel) => ({
              parcel_id: parcel.id,
              photo_evidence_id: parcel.photo,
              intake_id: vendor.id,
              intake_code: vendor.code,
              run_id: run.id,
              run_code: run.code,
              vendor_name: vendor.name,
              missing_since: parcel.missingAt ?? '2026-11-03T08:20:00Z',
              written_off_at: writtenOff?.at ?? null,
            }));
        }),
      )
      .toSorted((a, b) => a.missing_since.localeCompare(b.missing_since));
    return send(ok({ items, next_page_token: null }));
  }

  // The lock of a vendor of a run: taken when free, kept by its holder; it moves no token.
  const lockId = /^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})\/lock$/.exec(path)?.[1];
  if (method === 'POST' && lockId !== undefined) {
    const found = vendorOf(lockId);
    // A vendor counted blind is one of the intakes: its lock is the blind count page's, answered by the intake's own handler.
    if (found === undefined || found.vendor.mode === 'BLIND_COUNT') return false;
    if (!context.holds('hub.intake.count')) return send(error(403, 'PERMISSION_DENIED'));
    if (found.vendor.lock === null || found.vendor.lock.heldByYou) {
      found.vendor.lock = {
        holder: 'Synthetic Officer',
        heldByYou: true,
        openedAt: '2026-11-03T08:30:00Z',
      };
      context.note(`lock ${lockId}`);
    }
    return send(ok(checkInWire(found.run, found.vendor)));
  }

  const arrivalId = /^\/api\/v1\/intake-parcels\/([0-9a-f-]{36})\/arrival$/.exec(path)?.[1];
  if (method === 'PUT' && arrivalId !== undefined) {
    if (!context.holds('hub.intake.count')) return send(error(403, 'PERMISSION_DENIED'));
    for (const run of context.runs) {
      for (const vendor of run.vendors) {
        const parcel = vendor.parcels.find((candidate) => candidate.id === arrivalId);
        if (parcel === undefined) continue;
        if (typeof body.arrived !== 'boolean' || Object.keys(body).length !== 1) {
          return send(error(400, 'VALIDATION_FAILED'));
        }
        if (vendor.mode === 'BLIND_COUNT') return send(conflict('blind_count_intake'));
        if (body.arrived) {
          if (parcel.state === 'EXPECTED' && vendor.state === 'AWAITING_COUNT') {
            parcel.state = 'ARRIVED';
            parcel.arrivedBy = 'Synthetic Officer';
            parcel.arrivedAt = '2026-11-03T08:35:00Z';
          } else if (parcel.state === 'MISSING' && vendor.state === 'RECONCILIATION_REQUIRED') {
            parcel.state = 'ARRIVED';
            parcel.arrivedBy = 'Synthetic Officer';
            parcel.arrivedAt = '2026-11-03T08:50:00Z';
            parcel.missingAt = null;
            vendor.received = (vendor.received ?? 0) + 1;
          } else if (parcel.state !== 'ARRIVED') {
            return send(conflict('check_in_finished'));
          }
        } else if (vendor.state !== 'AWAITING_COUNT') {
          return send(conflict('check_in_finished'));
        } else if (parcel.state === 'ARRIVED') {
          if (parcel.origin === 'HUB_EXTRA') {
            parcel.state = 'VOID';
          } else {
            parcel.state = 'EXPECTED';
          }
          parcel.arrivedBy = null;
          parcel.arrivedAt = null;
        }
        return send(
          ok({
            parcel: parcelWire(parcel),
            intake_etag: tokenOf(vendor),
            counts: {
              ...countsOf(vendor),
              received_count: vendor.received,
              count_variance: varianceOf(vendor),
            },
          }),
        );
      }
    }
    return send(error(404, 'NOT_FOUND'));
  }

  const finishId = /^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})\/check-in$/.exec(path)?.[1];
  if (method === 'POST' && finishId !== undefined) {
    const found = vendorOf(finishId);
    if (found === undefined) return false;
    const { run, vendor } = found;
    if (!context.holds('hub.intake.count')) return send(error(403, 'PERMISSION_DENIED'));
    if (call.idempotencyKey === undefined) return send(error(400, 'VALIDATION_FAILED'));
    if (vendor.mode === 'BLIND_COUNT') return send(conflict('blind_count_intake'));
    if (vendor.state !== 'AWAITING_COUNT') return send(conflict('check_in_finished'));
    if (call.ifMatch !== tokenOf(vendor)) return send(conflict('stale'));
    const counts = countsOf(vendor);
    if (body.all_arrived === true) {
      if (!Number.isInteger(body.confirmed_count) || (body.confirmed_count as number) < 1) {
        return send(error(400, 'VALIDATION_FAILED'));
      }
      if (counts.extra_count > 0) return send(conflict('has_extra_parcels'));
      if (body.confirmed_count !== counts.parcels_expected) return send(conflict('count_changed'));
      for (const parcel of vendor.parcels) {
        if (parcel.state === 'EXPECTED') {
          parcel.state = 'ARRIVED';
          parcel.arrivedBy = 'Synthetic Officer';
          parcel.arrivedAt = '2026-11-03T08:40:00Z';
        }
      }
    } else if (body.all_arrived === false && body.confirmed_count === undefined) {
      for (const parcel of vendor.parcels) {
        if (parcel.state === 'EXPECTED') {
          parcel.state = 'MISSING';
          parcel.missingAt = '2026-11-03T08:40:00Z';
        }
      }
    } else {
      return send(error(400, 'VALIDATION_FAILED'));
    }
    vendor.received = countsOf(vendor).arrived_count;
    vendor.state = stateAfterFinish(vendor);
    vendor.version += 1;
    vendor.lock = null;
    return send(ok(checkInWire(run, vendor), tokenOf(vendor)));
  }

  const extraId = /^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})\/extra-parcels$/.exec(path)?.[1];
  if (method === 'POST' && extraId !== undefined) {
    const found = vendorOf(extraId);
    if (found === undefined) return false;
    const { vendor } = found;
    if (!context.holds('hub.intake.count')) return send(error(403, 'PERMISSION_DENIED'));
    if (call.idempotencyKey === undefined) return send(error(400, 'VALIDATION_FAILED'));
    if (vendor.mode === 'BLIND_COUNT') return send(conflict('blind_count_intake'));
    if (vendor.state !== 'AWAITING_COUNT' && vendor.state !== 'RECONCILIATION_REQUIRED') {
      return send(conflict('check_in_finished'));
    }
    const photo = String(body.photo_evidence_id);
    if (!context.stored(photo, vendor.id)) return send(error(422, 'EVIDENCE_NOT_STORED'));
    const parcel: ParcelRow = {
      id: `e${String(vendor.parcels.length + 1).padStart(7, '0')}-5a6b-4c7d-8e9f-0a1b2c3d4e5f`,
      ordinal: vendor.parcels.length + 1,
      origin: 'HUB_EXTRA',
      state: 'ARRIVED',
      photo,
      arrivedBy: 'Synthetic Officer',
      arrivedAt: '2026-11-03T08:38:00Z',
      missingAt: null,
      condition: null,
    };
    vendor.parcels.push(parcel);
    if (vendor.state === 'RECONCILIATION_REQUIRED') vendor.version += 1;
    const answer = {
      parcel: parcelWire(parcel),
      intake_etag: tokenOf(vendor),
      counts: {
        ...countsOf(vendor),
        received_count: vendor.received,
        count_variance: varianceOf(vendor),
      },
    };
    return send(ok(answer));
  }

  // Damage on one parcel of a vendor with door photos: recorded once for each parcel, on a parcel that is checked in, with stored photos of this vendor, on the vendor's token.
  const conditionId = /^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})\/condition$/.exec(path)?.[1];
  if (method === 'POST' && conditionId !== undefined) {
    const found = vendorOf(conditionId);
    // A vendor counted blind is one of the intakes: its condition is the intake page's, answered by the intake's own handler.
    if (found === undefined || found.vendor.mode === 'BLIND_COUNT') return false;
    const { run, vendor } = found;
    if (!context.holds('hub.intake.count')) return send(error(403, 'PERMISSION_DENIED'));
    if (call.idempotencyKey === undefined) return send(error(400, 'VALIDATION_FAILED'));
    if (vendor.state === 'ITEMIZING' || vendor.state === 'CLOSED') {
      return send(conflict('itemization_started'));
    }
    if (call.ifMatch !== tokenOf(vendor)) return send(conflict('stale'));
    if (typeof body.parcel_id !== 'string') {
      return send(error(400, 'VALIDATION_FAILED', { rule: 'parcel_required' }));
    }
    const parcel = vendor.parcels.find((candidate) => candidate.id === body.parcel_id);
    if (parcel === undefined) return send(error(404, 'NOT_FOUND'));
    if (parcel.state !== 'ARRIVED') return send(conflict('parcel_not_arrived'));
    if (parcel.condition !== null) return send(conflict('condition_already_recorded'));
    const cited = Array.isArray(body.evidence_ids) ? (body.evidence_ids as string[]) : [];
    const condition = String(body.condition) as 'OK' | 'DAMAGED' | 'TAMPERED' | 'OTHER';
    if (condition !== 'OK' && cited.length === 0) return send(error(422, 'REASON_REQUIRED'));
    if (!cited.every((evidence) => context.stored(evidence, vendor.id))) {
      return send(error(422, 'EVIDENCE_NOT_STORED'));
    }
    parcel.condition = {
      condition,
      note: typeof body.note === 'string' ? body.note : null,
      evidence_ids: cited,
      recorded_by_name: 'Synthetic Officer',
      recorded_at: '2026-11-03T08:45:00Z',
    };
    // A parcel with damage sends a vendor that was cleared back to a senior officer's decision.
    if (condition !== 'OK' && vendor.state === 'READY_FOR_ITEMIZATION') {
      vendor.state = 'RECONCILIATION_REQUIRED';
    }
    vendor.version += 1;
    return send(ok(checkInWire(run, vendor), tokenOf(vendor)));
  }

  // The platform's limits on a file of evidence: configuration, read once for the session.
  if (method === 'GET' && path === '/api/v1/evidence-limits') {
    return send(
      ok({ allowed_content_types: ['image/jpeg', 'image/png'], max_byte_size: 10 * 1024 * 1024 }),
    );
  }

  return false;
}

/** A parcel of a vendor: the nth door photo, not yet checked in. */
export function parcelRow(
  vendorNumber: number,
  ordinal: number,
  over: Partial<ParcelRow> = {},
): ParcelRow {
  return {
    id: `c${String(vendorNumber)}0000${String(ordinal).padStart(2, '0')}-1a2b-4c3d-8e4f-5a6b7c8d9e0f`,
    ordinal,
    origin: 'DOOR_PHOTO',
    state: 'EXPECTED',
    photo: `d${String(vendorNumber)}0000${String(ordinal).padStart(2, '0')}-2b3c-4d4e-8f5a-6b7c8d9e0f1a`,
    arrivedBy: null,
    arrivedAt: null,
    missingAt: null,
    condition: null,
    ...over,
  };
}
