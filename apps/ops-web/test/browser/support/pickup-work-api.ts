import type { BrowserContext, Page, Route } from '@playwright/test';

import {
  manifestFixture,
  MANIFEST_ID,
  REQUEST_ONE_ID,
  STOP_ONE_ID,
  stopFixture,
  summaryFixture,
} from '../../../src/test-support/manifest-fixture';
import { PICKUP_HUB_ID, pickupRequestFixture } from '../../../src/test-support/pickup-fixture';
import {
  disputeFixture,
  evidenceItemFixture,
  exceptionFixture,
  failureFixture,
  handshakeFixture,
  opsHandshakeFixture,
  shortfallFixture,
} from '../../../src/test-support/pickup-work-fixture';
import { freezeClock } from './clock';
import { answerQueueSummary } from './queue-summary';

/**
 * What the browser tests of the screens of the door and the failure (S1.30) put in place of the API: a small, stateful stand-in for the operations the six screens use. The failure queue lists
 * what its `open` filter says; an escalation is sent on the version of the request as it was read and a stale one is a `409 STATE_CONFLICT`; the handshake queue settles an override; a stop's
 * evidence is read a page at a time by the position the stand-in gives, with the progress counted from the photos it holds; the authorization of one photo is an address on the **page's own
 * origin** (the content-security policy of the production build is `img-src 'self'`), and the image behind it is a real picture that the browser loads. Every request is recorded as the browser
 * sent it, and any other request to `/api` is a failure of the test: it is answered with a network error and listed in `unexpected`, which a test asserts is empty.
 *
 * **Everything planted is planted in fields the contract never carries**, so that a screen which could draw one would: a handshake's code and digest and the note of its override, a failure's
 * phone number, and an object key and an address on every piece of evidence. A test looks for them in what was drawn and in every request that was made. The answers are the contract's
 * own (`src/test-support`): nothing here describes the wire a second time.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export const IDS = {
  me: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  session: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
  hub: PICKUP_HUB_ID,
  run: MANIFEST_ID,
  stop: STOP_ONE_ID,
  request: REQUEST_ONE_ID,
  otherRequest: '5bdf4a5b-6c7d-4e8f-8a9b-0c1d2e3f4a5b',
  otherStop: '4ace3f4a-5b6c-4d7e-8f8a-9b0c1d2e3f4a',
  replacement: '6c0e5b6c-7d8e-4f9a-8b0c-1d2e3f4a5b6c',
  handshakeA: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d',
  handshakeB: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0f',
  handshakeSettled: '8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e10',
} as const;

/** What no real answer carries, planted in answers that never do. */
export const PLANTED = {
  code: '483920',
  digest: 'sha256:9f2c1d4e7a',
  overrideNote: 'Called the owner on 0201234567 to check',
  phone: '+233209876543',
  objectKey: 'evidence/planted/object-key-77',
  address: 'https://bucket.invalid/planted-address?sig=abc',
} as const;

export const EVERYTHING = [
  'pickup.read',
  'pickup.failure.resolve',
  'pickup.request.cancel',
  'pickup.attempt.extend',
  'pickup.handshake.override',
  'pickup.handshake.resolve',
];

/** An identifier of the nth photo of the stop: a valid one, so that the guard accepts it. */
export const photoId = (n: number): string =>
  `0c1d2e3f-4a5b-4c6d-8e7f-${n.toString(16).padStart(12, '0')}`;

type Failure = ReturnType<typeof failureFixture>;
type OpsHandshake = ReturnType<typeof opsHandshakeFixture>;
type Photo = ReturnType<typeof evidenceItemFixture>;

interface FailureRow {
  item: Failure;
  /** The version of the failure's request, which an act is sent on. */
  version: number;
}

export interface World {
  permissions: string[];
  failures: FailureRow[];
  handshakes: OpsHandshake[];
  shortfalls: ReturnType<typeof shortfallFixture>[];
  disputes: ReturnType<typeof disputeFixture>[];
  /** The evidence of the stop of the world, oldest first. */
  photos: Photo[];
  exception: ReturnType<typeof exceptionFixture> | null;
  stopState: 'PENDING' | 'ARRIVED' | 'COLLECTED';
  /** The most a page of anything holds; the request's own `page_size` can ask for fewer. */
  pageSize: number;
  /** The next read of the evidence at this position is refused with a 500 (once). */
  failEvidenceAfter?: string;
}

/** A parcel photo that is stored, clean and has the moment it was made. */
export const stored = (n: number): Photo =>
  evidenceItemFixture({
    id: photoId(n),
    captured_at: `2026-11-04T09:${String(10 + (n % 40)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z`,
    uploaded_at: '2026-11-04T10:30:00Z',
  });

export const waiting = (n: number): Photo =>
  evidenceItemFixture({
    id: photoId(n),
    state: 'PENDING_UPLOAD',
    uploaded_at: null,
    scanned_clean: false,
  });

export function world(setup: Partial<World> = {}): World {
  const base: World = {
    permissions: EVERYTHING,
    failures: [
      {
        version: 1,
        item: failureFixture({
          note: 'Gate locked and nobody answered.',
          photo_count: 2,
          contact_attempts: [
            { method: 'PHONE_CALL', attempted_at: '2026-11-04T09:10:00Z', outcome: 'No answer' },
            { method: 'SMS', attempted_at: '2026-11-04T09:11:00Z', outcome: 'Sent', note: 'Twice' },
          ],
        }),
      },
      {
        version: 1,
        item: failureFixture({
          pickup_stop_id: IDS.otherStop,
          pickup_request_id: IDS.otherRequest,
          request_code: 'ACC-PR-9XM4TQ',
          sender_name: 'Kente Traders',
          category: 'ACCESS_DENIED',
          reason: { code: 'GATE_CLOSED', label: 'The gate was closed', attribution: 'VENDOR' },
          decision: 'ESCALATED',
          waiting_seconds: 90_000,
          escalated_at: '2026-11-05T09:00:00Z',
          escalation: { by: 'BACKSTOP', threshold_hours: 24, waited_seconds: 86_400 },
          attempt_number: 2,
          attempt_extended: true,
        }),
      },
      {
        version: 3,
        item: failureFixture({
          pickup_stop_id: '9d1f6c7d-8e9f-4a0b-8c1d-2e3f4a5b6c7d',
          pickup_request_id: '0e2a7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
          request_code: 'ACC-PR-3HT6NC',
          sender_name: 'Adwoa Bakery',
          decision: 'RESCHEDULED',
          request_state: 'CANCELLED',
          decided_at: '2026-11-04T12:00:00Z',
          replacement_request_id: IDS.replacement,
          waiting_seconds: 10_800,
        }),
      },
    ],
    handshakes: [
      opsHandshakeFixture(),
      opsHandshakeFixture({
        id: IDS.handshakeB,
        pickup_stop_id: IDS.otherStop,
        pickup_request_id: IDS.otherRequest,
        request_code: 'ACC-PR-9XM4TQ',
        sender_name: 'Kente Traders',
        state: 'EXHAUSTED',
        routed_because: 'ATTEMPTS_EXHAUSTED',
        attempts: 5,
        attempt_limit: null,
        fallback_sends: 3,
      }),
      opsHandshakeFixture({
        id: IDS.handshakeSettled,
        pickup_stop_id: '9d1f6c7d-8e9f-4a0b-8c1d-2e3f4a5b6c7d',
        pickup_request_id: '0e2a7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
        request_code: 'ACC-PR-3HT6NC',
        sender_name: 'Adwoa Bakery',
        state: 'MANUALLY_RESOLVED',
        stop_state: 'COLLECTED',
        routed_because: null,
        channel: 'OPS_OVERRIDE',
        confirmed_at: '2026-11-04T10:00:00Z',
        authorised_by: IDS.me,
      }),
    ],
    shortfalls: [
      shortfallFixture(),
      shortfallFixture({
        id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8caa',
        pickup_stop_id: IDS.otherStop,
        pickup_request_id: IDS.otherRequest,
        request_code: 'ACC-PR-9XM4TQ',
        sender_name: 'Kente Traders',
        declared_count: 8,
        collected_count: 7,
        shortfall_count: 1,
        note: null,
        run_state: 'COMPLETED',
      }),
    ],
    disputes: [
      disputeFixture({
        note: 'The rider took three parcels and I handed over five. <b>Please check</b>.',
      }),
    ],
    photos: Array.from({ length: 40 }, (_, index) => stored(index + 1)),
    exception: null,
    stopState: 'ARRIVED',
    pageSize: 100,
  };
  return { ...base, ...setup };
}

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly ifMatch: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
}

export interface PickupWorkApi {
  readonly world: World;
  readonly calls: Call[];
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

function error(status: number, code: string, details?: unknown) {
  return {
    status,
    headers: JSON_HEADERS,
    json: {
      code,
      message: 'Diagnostic text that must never reach a screen.',
      request_id: 'req-browser-s130',
      ...(details === undefined ? {} : { details }),
    },
  };
}

const ok = (json: unknown, version?: number) => ({
  status: 200,
  headers: { ...JSON_HEADERS, ...(version === undefined ? {} : { etag: `"v${String(version)}"` }) },
  json,
});

const written = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/** A page of a list by the position the stand-in gives (an index): the contract's `items` and `next_page_token`. */
function paged<T>(
  items: readonly T[],
  query: URLSearchParams,
  cap: number,
  plant?: (item: T) => unknown,
) {
  const asked = Number(query.get('page_size') ?? '25');
  const size = Math.max(1, Math.min(asked, cap, 100));
  const start = query.get('page_token') === null ? 0 : Number(query.get('page_token'));
  const slice = items.slice(start, start + size);
  const more = start + size < items.length;
  return {
    items: plant === undefined ? slice : slice.map(plant),
    next_page_token: more ? String(start + size) : null,
  };
}

function openOf(query: URLSearchParams): boolean | undefined {
  const open = query.get('open');
  return open === null ? undefined : open === 'true';
}

/** The request of a failure as `getPickupRequest` answers it: confirmed while the failure waits, cancelled once it is decided. */
function requestWire(row: FailureRow) {
  const decided = row.item.decision === 'RESCHEDULED' || row.item.decision === 'CANCELLED';
  return pickupRequestFixture({
    id: row.item.pickup_request_id,
    code: row.item.request_code,
    sender_name: row.item.sender_name,
    state: decided ? 'CANCELLED' : 'CONFIRMED',
    escalated_at: row.item.escalated_at,
    attempt_number: row.item.attempt_number,
    rider_assigned: true,
  });
}

function evidenceWire(w: World, query: URLSearchParams) {
  const purpose = query.get('purpose');
  const rows = w.photos.filter((photo) => purpose === null || photo.purpose === purpose);
  const parcel = w.photos.filter((photo) => photo.purpose === 'PARCEL_PHOTO');
  const count = (state: Photo['state']) => parcel.filter((photo) => photo.state === state).length;
  const page = paged(rows, query, w.pageSize, (photo) => ({
    ...photo,
    // Planted: no piece of evidence carries an object key or an address.
    object_key: PLANTED.objectKey,
    url: PLANTED.address,
  }));
  return {
    ...page,
    parcel_photos: {
      declared: count('STORED') + count('PENDING_UPLOAD'),
      stored: count('STORED'),
      pending: count('PENDING_UPLOAD'),
      expired: count('EXPIRED'),
    },
    parcel_photo_exception: w.exception,
  };
}

function answer(route: Route, state: PickupWorkApi, call: Call): Promise<void> {
  const { world: w } = state;
  const { method, path } = call;
  const url = new URL(route.request().url());
  const query = url.searchParams;
  const body = (call.body ?? {}) as Record<string, unknown>;
  const id = (pattern: RegExp): string | undefined => pattern.exec(path)?.[1];

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

  // The failure queue and the acts of the office on the request behind a failure.
  if (method === 'GET' && path === '/api/v1/pickup-failures') {
    const open = openOf(query);
    const rows = w.failures.filter(
      (row) =>
        open === undefined ||
        open === (row.item.decision === 'PENDING' || row.item.decision === 'ESCALATED'),
    );
    return route.fulfill(
      ok(
        paged(rows, query, w.pageSize, (row) => ({
          ...row.item,
          // Planted: no failure carries a phone number.
          contact_phone: PLANTED.phone,
        })),
      ),
    );
  }
  const requestId = id(/^\/api\/v1\/pickup-requests\/([0-9a-f-]{36})$/);
  if (method === 'GET' && requestId !== undefined) {
    const row = w.failures.find((candidate) => candidate.item.pickup_request_id === requestId);
    return row === undefined
      ? route.fulfill(error(404, 'NOT_FOUND'))
      : route.fulfill(ok(requestWire(row), row.version));
  }
  const escalated = id(/^\/api\/v1\/pickup-requests\/([0-9a-f-]{36})\/escalate$/);
  if (method === 'POST' && escalated !== undefined) {
    const row = w.failures.find((candidate) => candidate.item.pickup_request_id === escalated);
    if (row === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
    if (call.ifMatch !== `"v${String(row.version)}"`)
      return route.fulfill(error(409, 'STATE_CONFLICT'));
    if (!written(body.note)) return route.fulfill(error(422, 'REASON_REQUIRED'));
    row.item = {
      ...row.item,
      decision: 'ESCALATED',
      escalated_at: '2026-11-04T11:00:00Z',
      escalation: { by: 'PERSON', threshold_hours: null, waited_seconds: null },
    };
    row.version += 1;
    return route.fulfill(ok(requestWire(row), row.version));
  }

  // The handshakes that need Ops, and the override.
  if (method === 'GET' && path === '/api/v1/handshakes-for-ops') {
    const open = openOf(query);
    const rows = w.handshakes.filter(
      (handshake) =>
        open === undefined ||
        open === (handshake.state !== 'MANUALLY_RESOLVED' && handshake.channel !== 'OPS_OVERRIDE'),
    );
    return route.fulfill(
      ok(
        paged(rows, query, w.pageSize, (handshake) => ({
          ...handshake,
          // Planted: no handshake of the list carries a code, a digest or the note of an override.
          code: PLANTED.code,
          code_digest: PLANTED.digest,
          verification_note: PLANTED.overrideNote,
        })),
      ),
    );
  }
  const overridden = id(/^\/api\/v1\/pickup-stops\/([0-9a-f-]{36})\/handshake\/ops-override$/);
  if (method === 'POST' && overridden !== undefined) {
    const handshake = w.handshakes.find((candidate) => candidate.pickup_stop_id === overridden);
    if (handshake === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
    if (!written(body.verification_note)) return route.fulfill(error(422, 'REASON_REQUIRED'));
    Object.assign(handshake, {
      state: 'MANUALLY_RESOLVED',
      stop_state: 'COLLECTED',
      routed_because: null,
      channel: 'OPS_OVERRIDE',
      confirmed_at: '2026-11-04T11:00:00Z',
      authorised_by: IDS.me,
    });
    return route.fulfill(ok(handshakeFixture({ stop_id: overridden })));
  }

  // The short counts and the disputes.
  if (method === 'GET' && path === '/api/v1/collection-shortfalls') {
    const open = openOf(query);
    const rows = w.shortfalls.filter(
      (item) => open === undefined || open === (item.run_state === 'IN_PROGRESS'),
    );
    return route.fulfill(ok(paged(rows, query, w.pageSize)));
  }
  if (method === 'GET' && path === '/api/v1/collection-disputes') {
    const open = openOf(query);
    const rows = w.disputes.filter(
      (item) => open === undefined || open === (item.state === 'OPEN'),
    );
    return route.fulfill(ok(paged(rows, query, w.pageSize)));
  }

  // The stop, its run, its evidence, the picture of one photo, and the exception.
  if (method === 'GET' && path === `/api/v1/pickup-stops/${IDS.stop}`) {
    return route.fulfill(
      ok(
        stopFixture({
          id: IDS.stop,
          state: w.stopState,
          arrived_at: w.stopState === 'PENDING' ? null : '2026-11-04T09:00:00Z',
          pickup_summary: summaryFixture('ACC-PR-7KQ2MZ'),
        }),
        1,
      ),
    );
  }
  if (method === 'GET' && path === `/api/v1/pickup-manifests/${IDS.run}`) {
    return route.fulfill(
      ok(
        manifestFixture({
          state: 'DISPATCHED',
          stops: [
            stopFixture({
              id: IDS.stop,
              state: w.stopState,
              pickup_summary: summaryFixture('ACC-PR-7KQ2MZ'),
            }),
          ],
        }),
        1,
      ),
    );
  }
  if (method === 'GET' && path === `/api/v1/pickup-stops/${IDS.stop}/evidence`) {
    if (w.failEvidenceAfter !== undefined && query.get('page_token') === w.failEvidenceAfter) {
      w.failEvidenceAfter = undefined;
      return route.fulfill(error(500, 'INTERNAL_ERROR'));
    }
    return route.fulfill(ok(evidenceWire(w, query)));
  }
  const photo = id(/^\/api\/v1\/evidence\/([0-9a-f-]{36})\/retrieval-authorization$/);
  if (method === 'POST' && photo !== undefined) {
    const found = w.photos.find((candidate) => candidate.id === photo);
    if (found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (found.state !== 'STORED') return route.fulfill(error(409, 'EVIDENCE_NOT_STORED'));
    const issued = state.calls.filter((each) =>
      each.path.endsWith('/retrieval-authorization'),
    ).length;
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        method: 'GET',
        url: `/test-evidence-store/${photo}?token=issued-${String(issued)}`,
        expires_at: '2026-11-04T10:36:00Z',
      },
    });
  }
  if (method === 'POST' && path === `/api/v1/pickup-stops/${IDS.stop}/parcel-photo-exception`) {
    if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
    if (!written(body.note)) return route.fulfill(error(422, 'REASON_REQUIRED'));
    if (w.stopState !== 'ARRIVED')
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stop_not_arrived' }));
    if (w.exception !== null)
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'exception_exists' }));
    w.exception = exceptionFixture({
      pickup_stop_id: IDS.stop,
      authorised_by: IDS.me,
      authorised_at: '2026-11-04T11:00:00Z',
      note: String(body.note),
    });
    return route.fulfill({ status: 201, headers: JSON_HEADERS, json: w.exception });
  }

  state.unexpected.push(`${method} ${path}`);
  return route.abort('failed');
}

/** One picture the browser really decodes as an image, with a size of its own (800 x 600), so that a photo opened in the dialog is drawn as a photo is. */
const PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#b9c6d8"/><rect x="120" y="140" width="560" height="320" rx="24" fill="#8497b3"/><circle cx="400" cy="300" r="90" fill="#e8eef7"/><text x="400" y="540" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#26364d">A synthetic photo of a parcel</text></svg>`;

export async function stubPickupWorkApi(
  target: Page | BrowserContext,
  initial: World = world(),
): Promise<PickupWorkApi> {
  const state: PickupWorkApi = { world: initial, calls: [], images: [], unexpected: [] };
  // The clock of the world: the wait and the dates are the world's, whatever day the machine thinks it is.
  await freezeClock(target);
  // The photo store of the world is the page's own origin: the production build's policy is `img-src 'self'`.
  await target.route('**/test-evidence-store/**', async (route) => {
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
      body: parsed(request.postData()),
    };
    state.calls.push(call);
    await answer(route, state, call);
  });
  return state;
}
