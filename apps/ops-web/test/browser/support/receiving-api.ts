import { createHash } from 'node:crypto';

import type { BrowserContext, Page, Route } from '@playwright/test';

import { MANIFEST_ID, REQUEST_ONE_ID } from '../../../src/test-support/manifest-fixture';
import { PICKUP_HUB_ID } from '../../../src/test-support/pickup-fixture';
import { freezeClock } from './clock';
import { answerQueueSummary } from './queue-summary';
import { answerRuns, parcelRow, type RunRow } from './receiving-runs-api';

/**
 * What the browser tests of the receiving screens (S1.35) put in place of the API: a small, stateful stand-in for the operations the five screens use. It is the real shape of the contract's answers
 * and the real rules the API keeps, as far as a screen can meet them: **an intake that has not been counted has no declaration in any answer** (the read, the list and the lock), a count is committed once
 * (the second receiver of two who count is `409 STATE_CONFLICT` with the rule `already_counted`), the `ETag` of an intake moves with its facts and never with the lock, a condition is recorded once and needs
 * stored evidence for damage or tampering, the adjudication is a key Ops Staff do not hold, and the evidence goes through the three steps (declare, `PUT` of the bytes to an address on the page's own origin,
 * complete). Every request is recorded as the browser sent it, and any other request to `/api` is a failure of the test: it is answered with a network error and listed in `unexpected`.
 *
 * **What is planted is planted where the contract never carries it**, so that a screen which could draw one would: an object key and an address on every record of evidence and on every upload ticket. And
 * `world.leak` turns the stand-in into the server the blind count is built against: it puts the rider's declaration into every answer about an intake that has not been counted (the read, the list and the
 * lock), under the contract's name and nested, so that a test can show the screens refuse such an answer whole and the number is nowhere on the page.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export const IDS = {
  me: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  session: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
  other: '4e709f31-6d82-4eaf-9021-3c4d5e6f7081',
  rider: '3d6f8e20-5c71-4d9e-8f10-2b3c4d5e6f70',
  hub: PICKUP_HUB_ID,
  run: MANIFEST_ID,
  request: REQUEST_ONE_ID,
  /** Waiting to be counted, nobody receiving it. */
  waiting: '1b4d6c0e-3a5f-4b7c-8d9e-0f1a2b3c4d5e',
  /** Waiting to be counted, another receiver holds the lock. */
  held: '2c5e7d1f-4b60-4c8d-9e0f-1a2b3c4d5e6f',
  /** Counted short, in review, with three photos of the collection. */
  short: '5f81a042-7e93-4fb0-8132-4d5e6f708192',
  /** Counted and matched, cleared. */
  matched: '60a2b153-8fa4-40c1-9243-5e6f708192a3',
} as const;

/** The number the rider declared, in the intakes that were counted: a number no screen may show before a count commits. It is no count by chance and no part of any date or identifier of the world. */
export const DECLARED = 137;
export const COUNTED_SHORT = 130;
export const MATCHED_COUNT = 24;

/** What no real answer carries, planted in answers that never do. */
export const PLANTED = {
  objectKey: 'evidence/planted/object-key-77',
  address: 'https://bucket.invalid/planted-address?sig=abc',
  signature: 'planted-upload-signature',
} as const;

/** The keys of an officer who receives, and of a senior officer who also decides. */
export const RECEIVER = ['hub.read', 'hub.intake.count'];
export const SENIOR = ['hub.read', 'hub.intake.count', 'hub.osd.adjudicate'];

export const photoId = (n: number): string =>
  `0c1d2e3f-4a5b-4c6d-8e7f-${n.toString(16).padStart(12, '0')}`;
const nextEvidenceId = (n: number): string =>
  `a4d6f597-c3e8-44a5-b687-${n.toString(16).padStart(12, '0')}`;

type Condition = 'OK' | 'DAMAGED' | 'TAMPERED' | 'OTHER';
type State =
  'AWAITING_COUNT' | 'RECONCILIATION_REQUIRED' | 'READY_FOR_ITEMIZATION' | 'ITEMIZING' | 'CLOSED';

interface Finding {
  id: string;
  kind: 'CONDITION' | 'ADJUDICATION';
  condition: Condition | null;
  outcome: string | null;
  note: string | null;
  evidence_ids: string[];
  recorded_by: string;
  recorded_at: string;
}

interface Row {
  id: string;
  code: string;
  handedOverAt: string;
  state: State;
  version: number;
  /** The declaration the server holds: it is in an answer only once the intake has been counted (or when `world.leak` is on). */
  declared: number;
  physical: number | null;
  condition: Condition;
  findings: Finding[];
  photos: string[];
  receiver: { id: string; at: string } | null;
}

interface EvidenceRow {
  id: string;
  owner: string;
  purpose: string;
  state: 'PENDING_UPLOAD' | 'STORED';
  byteSize: number;
  checksum: string;
  contentType: string;
  bytesReceived: boolean;
}

export interface World {
  permissions: string[];
  intakes: Row[];
  /**
   * The runs of the receiving screens (S1.35c): each a handover of one rider with its vendors, a vendor with door photos holding its parcels. A vendor counted blind is one of `intakes` (the blind count page
   * reads it there), and its state follows that row.
   */
  runs: RunRow[];
  evidence: EvidenceRow[];
  /** After this the holder of a lock has been idle past the hub's idle time, so that the lock is taken over by the next to ask. */
  holderIdle: boolean;
  /** The next count is refused: another receiver counted this intake an instant ago (they are `already_counted`). */
  raceOnCount: boolean;
  /** The server that carries the declaration where the contract never does: every answer about an intake that has not been counted. */
  leak: boolean;
  /** The most a page of the list holds. */
  pageSize: number;
}

export function world(setup: Partial<World> = {}): World {
  const base: World = {
    permissions: RECEIVER,
    intakes: [
      row(IDS.waiting, 'ACC-IN-7KQ2MZ', '2026-11-03T08:00:00Z', 'AWAITING_COUNT', {}),
      {
        ...row(IDS.held, 'ACC-IN-9XM4TQ', '2026-11-03T08:10:00Z', 'AWAITING_COUNT', {}),
        receiver: { id: IDS.other, at: '2026-11-03T08:20:00Z' },
      },
      row(IDS.short, 'ACC-IN-3HT6NC', '2026-11-03T07:40:00Z', 'RECONCILIATION_REQUIRED', {
        physical: COUNTED_SHORT,
        photos: [photoId(1), photoId(2), photoId(3)],
      }),
      row(IDS.matched, 'ACC-IN-5JK8PD', '2026-11-03T07:50:00Z', 'READY_FOR_ITEMIZATION', {
        declared: MATCHED_COUNT,
        physical: MATCHED_COUNT,
      }),
    ],
    runs: defaultRuns(),
    evidence: [],
    holderIdle: false,
    raceOnCount: false,
    leak: false,
    pageSize: 100,
  };
  return { ...base, ...setup };
}

export const RUNS = {
  /** Three vendors: two with door photos (four and two parcels) and one counted blind. Waiting to be checked in. */
  waiting: '8b2c3d4e-5f60-4b7c-8d8e-0f1a2b3c4d01',
  /** One vendor with door photos, finished, one parcel missing: a senior officer's decision. */
  decision: '8b2c3d4e-5f60-4b7c-8d8e-0f1a2b3c4d02',
  kente: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01',
  shea: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02',
  yaw: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c03',
} as const;

/** The runs of a world: the first waits, with a vendor of four parcels, one of two and one counted blind (the old intake that waits); the second was checked in and has a parcel missing. */
function defaultRuns(): RunRow[] {
  return [
    {
      id: RUNS.waiting,
      code: 'ACC-MF-7KQ2MZ',
      riderName: 'Kofi Boateng',
      handedOverAt: '2026-11-03T07:00:00Z',
      hubId: IDS.hub,
      hubName: 'Accra Central',
      vendors: [
        {
          id: RUNS.kente,
          code: 'ACC-IN-3HN7WD',
          name: 'Kente Crafts',
          mode: 'PHOTO_CHECK_IN',
          state: 'AWAITING_COUNT',
          version: 1,
          parcels: [1, 2, 3, 4].map((n) => parcelRow(1, n)),
          lock: null,
          received: null,
          blindCounted: null,
          riderNumber: 0,
        },
        {
          id: RUNS.shea,
          code: 'ACC-IN-9BC2KE',
          name: 'Shea Naturals',
          mode: 'PHOTO_CHECK_IN',
          state: 'AWAITING_COUNT',
          version: 1,
          parcels: [1, 2].map((n) => parcelRow(2, n)),
          lock: null,
          received: null,
          blindCounted: null,
          riderNumber: 0,
        },
        {
          id: IDS.waiting,
          code: 'ACC-IN-7KQ2MZ',
          name: 'Adwoa Stalls',
          mode: 'BLIND_COUNT',
          state: 'AWAITING_COUNT',
          version: 1,
          parcels: [],
          lock: null,
          received: null,
          blindCounted: null,
          riderNumber: DECLARED,
        },
      ],
    },
    {
      id: RUNS.decision,
      code: 'ACC-MF-4PX8RT',
      riderName: 'Efua Sarpong',
      handedOverAt: '2026-11-03T08:00:00Z',
      hubId: IDS.hub,
      hubName: 'Accra Central',
      vendors: [
        {
          id: RUNS.yaw,
          code: 'ACC-IN-6TF5MJ',
          name: 'Yaw Textiles',
          mode: 'PHOTO_CHECK_IN',
          state: 'RECONCILIATION_REQUIRED',
          version: 2,
          parcels: [
            parcelRow(3, 1, {
              state: 'ARRIVED',
              arrivedBy: 'Synthetic Officer',
              arrivedAt: '2026-11-03T08:20:00Z',
            }),
            parcelRow(3, 2, { state: 'MISSING', missingAt: '2026-11-03T08:20:00Z' }),
          ],
          lock: null,
          received: 1,
          blindCounted: null,
          riderNumber: 0,
        },
      ],
    },
  ];
}

function row(
  id: string,
  code: string,
  handedOverAt: string,
  state: State,
  more: Partial<Row>,
): Row {
  return {
    id,
    code,
    handedOverAt,
    state,
    version: 1,
    declared: DECLARED,
    physical: null,
    condition: 'OK',
    findings: [],
    photos: [],
    receiver: null,
    ...more,
  };
}

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly ifMatch: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly cookie: string | undefined;
  readonly body: unknown;
}

export interface ReceivingApi {
  readonly world: World;
  readonly calls: Call[];
  /** The bytes the store was sent: one for each `PUT`, with the headers the browser sent it. */
  readonly uploads: {
    readonly path: string;
    readonly headers: Record<string, string>;
    /** The number of bytes, or `null` where the engine tells a test neither the body nor its length (WebKit). */
    readonly size: number | null;
    /** The digest of the bytes, or `null` where the engine does not hand a test the body of a request that carries a Blob (WebKit). */
    readonly sha256: string | null;
  }[];
  /** The addresses the browser asked the photo store for: one for each photo that was opened, and none before. */
  readonly images: string[];
  readonly unexpected: string[];
}

function parsed(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const error = (status: number, code: string, details?: unknown) => ({
  status,
  headers: JSON_HEADERS,
  json: {
    code,
    message: 'Diagnostic text that must never reach a screen.',
    request_id: 'req-browser-s135',
    ...(details === undefined ? {} : { details }),
  },
});
const ok = (json: unknown, version?: number) => ({
  status: 200,
  headers: { ...JSON_HEADERS, ...(version === undefined ? {} : { etag: `"v${String(version)}"` }) },
  json,
});
const written = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/** The answer about an intake, as the contract shapes it: the base always, and the counted shape only for an intake that has been counted. A leaking server also carries the declaration in the other. */
function intakeWire(w: World, r: Row) {
  const base = {
    id: r.id,
    code: r.code,
    hub_id: IDS.hub,
    pickup_request_id: IDS.request,
    pickup_manifest_id: IDS.run,
    handed_over_by: IDS.rider,
    handed_over_at: r.handedOverAt,
    declaration_captured_at: '2026-11-03T07:30:00Z',
    active_receiver_id: r.receiver?.id ?? null,
    lock_acquired_at: r.receiver?.at ?? null,
    state: r.state,
  };
  if (r.physical === null) {
    return {
      ...base,
      count_phase: 'PRE_COUNT',
      ...(w.leak
        ? {
            rider_declared_count: r.declared,
            extra: { hint: { rider_declared_count: r.declared } },
          }
        : {}),
    };
  }
  return {
    ...base,
    count_phase: 'POST_COUNT',
    rider_declared_count: r.declared,
    physical_count: r.physical,
    count_variance:
      r.physical === r.declared ? 'MATCH' : r.physical < r.declared ? 'SHORT' : 'OVER',
    count_difference: r.physical - r.declared,
    condition: r.condition,
    condition_findings: r.findings,
    parcel_photo_ids: r.photos,
  };
}

function paged<T>(items: readonly T[], query: URLSearchParams, cap: number) {
  const asked = Number(query.get('page_size') ?? '25');
  const size = Math.max(1, Math.min(asked, cap, 100));
  const start = query.get('page_token') === null ? 0 : Number(query.get('page_token'));
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    next_page_token: start + size < items.length ? String(start + size) : null,
  };
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function answer(route: Route, state: ReceivingApi, call: Call): Promise<void> {
  const { world: w } = state;
  const { method, path } = call;
  const query = new URL(route.request().url()).searchParams;
  const body = (call.body ?? {}) as Record<string, unknown>;
  const id = (pattern: RegExp): string | undefined => pattern.exec(path)?.[1];
  const holds = (key: string): boolean => w.permissions.includes(key);

  if (method === 'GET' && path === '/api/v1/auth/session') {
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        id: IDS.session,
        principal_type: 'STAFF',
        principal_id: IDS.me,
        state: 'ACTIVE',
        permissions: w.permissions,
        issued_at: '2026-10-23T08:00:00.000Z',
        expires_at: '2026-10-23T16:00:00.000Z',
        last_activity_at: '2026-10-23T08:00:00.000Z',
        termination_reason: null,
        principal_display_name: 'Synthetic Officer',
        authorized_hubs: [{ id: IDS.hub, display_name: 'Accra Central' }],
      },
    });
  }

  // The runs of the receiving screens: the queue by run, a run's page, the lock of a vendor, a tap, the finish of a vendor, an extra and damage on a parcel. A vendor counted blind is one of the intakes: its state
  // is the intake's, so that the blind count page and the run's page agree.
  for (const run of w.runs) {
    for (const vendor of run.vendors) {
      const intake =
        vendor.mode === 'BLIND_COUNT' ? w.intakes.find((r) => r.id === vendor.id) : undefined;
      if (intake !== undefined) {
        vendor.state = intake.state;
        vendor.blindCounted = intake.physical;
        vendor.version = intake.version;
        vendor.lock = null;
      }
    }
  }
  if (
    await answerRuns(route, call, {
      runs: w.runs,
      holds,
      leak: w.leak,
      stored: (evidenceId, ownerId) =>
        w.evidence.some(
          (record) =>
            record.id === evidenceId && record.owner === ownerId && record.state === 'STORED',
        ),
      me: IDS.me,
      pageSize: w.pageSize,
      note: () => undefined,
    })
  ) {
    return;
  }

  if (method === 'GET' && path === '/api/v1/hub-intakes') {
    if (!holds('hub.read')) return route.fulfill(error(403, 'PERMISSION_DENIED'));
    const wanted = query.get('state');
    const rows = w.intakes
      .filter((r) => wanted === null || r.state === wanted)
      .toSorted((a, b) => a.handedOverAt.localeCompare(b.handedOverAt));
    const page = paged(rows, query, w.pageSize);
    return route.fulfill(ok({ ...page, items: page.items.map((r) => intakeWire(w, r)) }));
  }

  const intakeId = id(/^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})$/);
  if (method === 'GET' && intakeId !== undefined) {
    if (!holds('hub.read')) return route.fulfill(error(403, 'PERMISSION_DENIED'));
    const r = w.intakes.find((candidate) => candidate.id === intakeId);
    return r === undefined
      ? route.fulfill(error(404, 'NOT_FOUND'))
      : route.fulfill(ok(intakeWire(w, r), r.version));
  }

  const lockId = id(/^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})\/lock$/);
  if (method === 'POST' && lockId !== undefined) {
    if (!holds('hub.intake.count')) return route.fulfill(error(403, 'PERMISSION_DENIED'));
    const r = w.intakes.find((candidate) => candidate.id === lockId);
    if (r === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    // Taken when free, refreshed by its holder, taken over once the holder has been idle; otherwise the intake comes back showing the holder and nothing changes. The lock never moves the version.
    if (r.physical === null && (r.receiver === null || r.receiver.id === IDS.me || w.holderIdle)) {
      r.receiver = { id: IDS.me, at: '2026-11-03T08:30:00Z' };
    }
    return route.fulfill(ok(intakeWire(w, r)));
  }

  const countId = id(/^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})\/count$/);
  if (method === 'POST' && countId !== undefined) {
    if (!holds('hub.intake.count')) return route.fulfill(error(403, 'PERMISSION_DENIED'));
    const r = w.intakes.find((candidate) => candidate.id === countId);
    if (r === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
    // The body is the physical count and nothing else: a declaration in it is refused, and nothing is committed.
    const keys = Object.keys(body);
    if (
      keys.length !== 1 ||
      keys[0] !== 'physical_count' ||
      !Number.isInteger(body.physical_count) ||
      (body.physical_count as number) < 0
    ) {
      return route.fulfill(
        error(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'body', pointer: '/', rule: 'additionalProperties' }],
        }),
      );
    }
    if (w.raceOnCount && r.physical === null) {
      // The other receiver counted an instant ago: their count is the one kept.
      r.physical = DECLARED - 1;
      r.state = 'RECONCILIATION_REQUIRED';
      r.version += 1;
      r.photos = [photoId(1)];
    }
    if (r.physical !== null)
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'already_counted' }));
    if (call.ifMatch !== `"v${String(r.version)}"`)
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
    r.physical = body.physical_count as number;
    r.state =
      r.physical === r.declared && r.declared > 0
        ? 'READY_FOR_ITEMIZATION'
        : 'RECONCILIATION_REQUIRED';
    r.photos = [photoId(1), photoId(2), photoId(3)];
    r.receiver = null;
    r.version += 1;
    return route.fulfill(ok(intakeWire(w, r), r.version));
  }

  const conditionId = id(/^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})\/condition$/);
  if (method === 'POST' && conditionId !== undefined) {
    if (!holds('hub.intake.count')) return route.fulfill(error(403, 'PERMISSION_DENIED'));
    const r = w.intakes.find((candidate) => candidate.id === conditionId);
    if (r === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
    if (r.physical === null)
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'intake_not_counted' }));
    if (call.ifMatch !== `"v${String(r.version)}"`)
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
    if (r.findings.some((finding) => finding.kind === 'CONDITION')) {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'condition_already_recorded' }));
    }
    const condition = body.condition as Condition;
    const cited = (body.evidence_ids ?? []) as string[];
    if ((condition === 'DAMAGED' || condition === 'TAMPERED') && cited.length === 0)
      return route.fulfill(error(422, 'REASON_REQUIRED'));
    for (const evidenceId of cited) {
      const record = w.evidence.find((candidate) => candidate.id === evidenceId);
      if (record?.state !== 'STORED' || record.owner !== r.id || record.purpose !== 'CONDITION') {
        return route.fulfill(error(422, 'EVIDENCE_NOT_STORED'));
      }
    }
    r.findings.push({
      id: `60a2b153-8fa4-40c1-9243-${(100 + r.findings.length).toString(16).padStart(12, '0')}`,
      kind: 'CONDITION',
      condition,
      outcome: null,
      note: typeof body.note === 'string' ? body.note : null,
      evidence_ids: cited,
      recorded_by: IDS.me,
      recorded_at: '2026-11-03T08:45:00Z',
    });
    if (condition !== 'OK') {
      r.condition = condition;
      if (r.state === 'READY_FOR_ITEMIZATION') r.state = 'RECONCILIATION_REQUIRED';
    }
    r.version += 1;
    return route.fulfill(ok(intakeWire(w, r), r.version));
  }

  const discrepancyId = id(/^\/api\/v1\/hub-intakes\/([0-9a-f-]{36})\/discrepancy$/);
  if (method === 'POST' && discrepancyId !== undefined) {
    if (!holds('hub.osd.adjudicate')) return route.fulfill(error(403, 'PERMISSION_DENIED'));
    const r = w.intakes.find((candidate) => candidate.id === discrepancyId);
    if (r === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (r.state !== 'RECONCILIATION_REQUIRED')
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'not_awaiting_resolution' }));
    if (call.ifMatch !== `"v${String(r.version)}"`)
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
    if (!written(body.note)) return route.fulfill(error(422, 'REASON_REQUIRED'));
    const condition = (body.condition ?? null) as Condition | null;
    const cited = (body.evidence_ids ?? []) as string[];
    if ((condition === 'DAMAGED' || condition === 'TAMPERED') && cited.length === 0)
      return route.fulfill(error(422, 'REASON_REQUIRED'));
    for (const evidenceId of cited) {
      const record = w.evidence.find((candidate) => candidate.id === evidenceId);
      if (record?.state !== 'STORED' || record.owner !== r.id || record.purpose !== 'OSD')
        return route.fulfill(error(422, 'EVIDENCE_NOT_STORED'));
    }
    r.findings.push({
      id: `60a2b153-8fa4-40c1-9243-${(200 + r.findings.length).toString(16).padStart(12, '0')}`,
      kind: 'ADJUDICATION',
      condition,
      outcome: body.outcome as string,
      note: body.note as string,
      evidence_ids: cited,
      recorded_by: IDS.me,
      recorded_at: '2026-11-03T09:00:00Z',
    });
    if (condition !== null) r.condition = condition;
    if (body.outcome !== 'ESCALATED') r.state = 'READY_FOR_ITEMIZATION';
    r.version += 1;
    return route.fulfill(ok(intakeWire(w, r), r.version));
  }

  // Evidence: declare, complete, and the authorization of one stored photo.
  if (method === 'POST' && path === '/api/v1/evidence') {
    if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
    const intake = w.intakes.find((candidate) => candidate.id === body.owner_id);
    // A vendor of a run that has door photos: its photos (an extra's, a parcel's damage) are the receiver's, under the key of the count, whatever the purpose and wherever the vendor stands.
    const vendor = w.runs
      .flatMap((run) => run.vendors)
      .find((candidate) => candidate.id === body.owner_id && candidate.mode === 'PHOTO_CHECK_IN');
    const r = intake ?? vendor;
    if (r === undefined || body.owner_type !== 'PICKUP_INTAKE')
      return route.fulfill(error(404, 'NOT_FOUND'));
    const needed =
      vendor === undefined && body.purpose === 'OSD' ? 'hub.osd.adjudicate' : 'hub.intake.count';
    if (!holds(needed)) return route.fulfill(error(403, 'PERMISSION_DENIED'));
    if (intake?.physical === null)
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'intake_not_counted' }));
    if (!/^[0-9a-f]{64}$/.test(String(body.checksum_sha256)) || Number(body.byte_size) < 1)
      return route.fulfill(error(400, 'VALIDATION_FAILED'));
    const record: EvidenceRow = {
      id: nextEvidenceId(w.evidence.length + 1),
      owner: r.id,
      purpose: String(body.purpose),
      state: 'PENDING_UPLOAD',
      byteSize: Number(body.byte_size),
      checksum: String(body.checksum_sha256),
      contentType: String(body.content_type),
      bytesReceived: false,
    };
    w.evidence.push(record);
    return route.fulfill({
      status: 200,
      headers: { ...JSON_HEADERS, etag: '"e1"' },
      json: {
        evidence: {
          id: record.id,
          owner_type: 'PICKUP_INTAKE',
          owner_id: r.id,
          purpose: record.purpose,
          captured_at: body.captured_at,
          captured_by_actor: IDS.me,
          state: 'PENDING_UPLOAD',
          access_rule: 'x',
          retention_policy: 'y',
          // Planted: no record of evidence carries an object key or an address.
          object_key: PLANTED.objectKey,
          url: PLANTED.address,
        },
        upload: {
          method: 'PUT',
          url: `/test-evidence-store/upload/${record.id}?sig=${PLANTED.signature}`,
          headers: { 'content-type': record.contentType },
          // An address the platform has just made lives for minutes from now: the portal judges it by the clock.
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          storage_ref: PLANTED.objectKey,
        },
      },
    });
  }
  const completeId = id(/^\/api\/v1\/evidence\/([0-9a-f-]{36})\/complete$/);
  if (method === 'POST' && completeId !== undefined) {
    const record = w.evidence.find((candidate) => candidate.id === completeId);
    if (record === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (call.ifMatch !== '"e1"') return route.fulfill(error(409, 'STATE_CONFLICT'));
    // The server compares what the store holds with what was declared: bytes that never came, or are not the declared ones, leave the record pending.
    const upload = state.uploads.find((candidate) => candidate.path.includes(record.id));
    if (
      upload === undefined ||
      (upload.size !== null && upload.size !== record.byteSize) ||
      (upload.sha256 !== null && upload.sha256 !== record.checksum)
    )
      return route.fulfill(error(400, 'VALIDATION_FAILED'));
    record.state = 'STORED';
    return route.fulfill(
      ok({
        id: record.id,
        owner_type: 'PICKUP_INTAKE',
        owner_id: record.owner,
        purpose: record.purpose,
        captured_at: '2026-11-03T08:30:00Z',
        captured_by_actor: IDS.me,
        state: 'STORED',
        access_rule: 'x',
        retention_policy: 'y',
      }),
    );
  }
  const photo = id(/^\/api\/v1\/evidence\/([0-9a-f-]{36})\/retrieval-authorization$/);
  if (method === 'POST' && photo !== undefined) {
    if (!holds('hub.read')) return route.fulfill(error(403, 'PERMISSION_DENIED'));
    const issued = state.calls.filter((each) =>
      each.path.endsWith('/retrieval-authorization'),
    ).length;
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        method: 'GET',
        url: `/test-evidence-store/photo/${photo}?token=issued-${String(issued)}`,
        expires_at: '2026-11-03T08:36:00Z',
      },
    });
  }

  state.unexpected.push(`${method} ${path}`);
  return route.abort('failed');
}

/** One picture the browser really decodes as an image, so that a photo opened in the dialog is drawn as a photo is. */
const PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#b9c6d8"/><rect x="120" y="140" width="560" height="320" rx="24" fill="#8497b3"/><text x="400" y="540" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#26364d">A synthetic photo</text></svg>`;

export async function stubReceivingApi(
  target: Page | BrowserContext,
  initial: World = world(),
): Promise<ReceivingApi> {
  const state: ReceivingApi = {
    world: initial,
    calls: [],
    uploads: [],
    images: [],
    unexpected: [],
  };
  // The clock of the world: the dates are the world's, whatever day the machine thinks it is.
  await freezeClock(target);
  // The store of the world is the page's own origin (the production policy is `connect-src 'self'` and `img-src 'self'`): the bytes of an upload, and the picture of a photo.
  await target.route('**/test-evidence-store/upload/**', async (route) => {
    const request = route.request();
    // WebKit does not hand a test the body of a request that carries a Blob: the size is then the `content-length` the browser sent, if it sent one, and the digest is not known (an unknown size or digest is not a mismatch).
    const bytes = request.postDataBuffer();
    const length = Number(request.headers()['content-length']);
    state.uploads.push({
      path: new URL(request.url()).pathname,
      headers: request.headers(),
      size: bytes?.length ?? (Number.isFinite(length) ? length : null),
      sha256: bytes === null ? null : sha256(bytes),
    });
    await route.fulfill({ status: 200, headers: { 'cache-control': 'no-store' }, body: '' });
  });
  await target.route('**/test-evidence-store/photo/**', async (route) => {
    state.images.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' },
      body: PICTURE,
    });
  });
  await target.route('**/api/v1/**', async (route) => {
    if (await answerQueueSummary(route)) return;
    const request = route.request();
    const url = new URL(request.url());
    const headers = request.headers();
    const call: Call = {
      method: request.method(),
      path: url.pathname,
      search: url.search,
      ifMatch: headers['if-match'],
      idempotencyKey: headers['idempotency-key'],
      cookie: headers.cookie,
      body: parsed(request.postData()),
    };
    state.calls.push(call);
    await answer(route, state, call);
  });
  return state;
}
