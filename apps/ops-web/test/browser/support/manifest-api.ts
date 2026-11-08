import type { BrowserContext, Page, Route } from '@playwright/test';

/**
 * What the browser tests of the manifest screens (S1.25) put in place of the API: a small, stateful stand-in for the operations the four screens
 * use. A manifest is made from the pool of confirmed requests under a key, with the reason of each overdue request; its stops are ordered whole
 * on the version read; a rider is assigned to a draft and the manifest is dispatched as a separate act; a cancellation needs a note; a stop is
 * skipped with a reason of the catalogue (a note where the reason says so) on the version of the stop, and the run is completed by System when
 * the last stop to be worked is skipped with nothing collected. The custody handover is **written from the contract** (S1.24) and answered by
 * this stand-in, not by the API (the operations of S1.24 are in the contract, and no run here reached them), so what these tests prove is the screens against
 * the contract and nothing of the server. Every request is recorded as the browser sent it, and any other request to `/api` is a failure of the
 * test: it is answered with a network error and listed in `unexpected`, which a test asserts is empty.
 *
 * Everything in the answers is synthetic and says so. A count of the hub's, which the contract never carries on a handover, is planted in every
 * custody answer (`PLANTED_HUB_COUNT`), so that a screen which could draw one would, and a test looks for it.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export const IDS = {
  me: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  session: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
  hub: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d',
  draft: '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
  run: '1c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
  /** The manifest the stand-in makes when the builder creates one. */
  created: 'f1000000-0000-4000-8000-000000000001',
  riderA: '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a',
  riderB: '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c',
  handover: 'e35e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a',
} as const;

/** The pickups of the world, by the id and the code each is read by. */
export const REQUESTS = {
  one: { id: 'b02b3c4d-5e6f-4a7b-8c8d-9e0f1a2b3c4d', code: 'ACC-PR-7KQ2MZ' },
  two: { id: 'c13c4d5e-6f7a-4b8c-8d9e-0f1a2b3c4d5e', code: 'ACC-PR-9WXH4T' },
  three: { id: 'd24d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', code: 'ACC-PR-ZYU26H' },
  four: { id: 'e35e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f70', code: 'ACC-PR-4VA9B7' },
} as const;

/** The day the stand-in takes for today: a run for an earlier day is never made or sent, as the server's clock says. */
export const TODAY = '2026-11-03';

/** A count of the hub's no custody answer carries. If it is ever drawn, a screen showed what it must not: a handover is not a count. */
export const PLANTED_HUB_COUNT = 4242;

export const EVERYTHING = [
  'pickup.read',
  'pickup.manifest.create',
  'pickup.manifest.assign',
  'pickup.manifest.dispatch',
  'pickup.stop.skip',
  'fleet.custody.read',
  'fleet.custody.initiate',
  'fleet.custody.accept',
  'dispatch.read',
  'settings.reason.read',
  'notification.read',
];

export interface PoolRequest {
  id: string;
  code: string;
  scheduled_service_date: string;
  sender: string;
  address: string;
  /** On a manifest: not in the pool. */
  manifested: boolean;
}

export interface WorldStop {
  id: string;
  requestId: string;
  sequence: number;
  state: 'PENDING' | 'ARRIVED' | 'COLLECTED' | 'SKIPPED';
  skipped?: { reason_code: string; note?: string };
  version: number;
}

export interface WorldManifest {
  id: string;
  code: string;
  state: 'DRAFT' | 'DISPATCHED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  service_date: string;
  riderId: string | null;
  stops: WorldStop[];
  /** The server's own count of changes, which the stand-in turns into the `ETag`. */
  version: number;
}

export interface WorldHandover {
  to: { rider: string } | { hub: true };
  state: 'PENDING' | 'COMPLETED' | 'FAILED';
  parcels: number | null;
  version: number;
}

export interface World {
  permissions: string[];
  pool: PoolRequest[];
  manifests: WorldManifest[];
  riders: { id: string; name: string; hub: string; status: 'ACTIVE' | 'INACTIVE' }[];
  /** The `PICKUP_STOP_SKIP` catalogue (four codes, two of which want a note) and the `PICKUP_CARRYOVER` one, under demo labels. */
  skipReasons: { code: string; label: string; requiresNote: boolean }[];
  carryReasons: { code: string; label: string; requiresNote: boolean }[];
  handover?: WorldHandover;
  /** The connection fails once on the way to the next act, so that the page never has an answer. */
  dropNext?: boolean;
  /** The lists are read this many entries at a time, by a token that is the offset of the next page; the whole list when it is not set. */
  pageSize?: number;
}

export const stop = (
  overrides: Partial<WorldStop> & Pick<WorldStop, 'id' | 'requestId' | 'sequence'>,
): WorldStop => ({
  state: 'PENDING',
  version: 1,
  ...overrides,
});

export function manifest(overrides: Partial<WorldManifest> = {}): WorldManifest {
  return {
    id: IDS.draft,
    code: 'ACC-MF-Q92422',
    state: 'DRAFT',
    service_date: '2026-11-04',
    riderId: null,
    version: 1,
    stops: [
      stop({ id: 'a1000000-0000-4000-8000-000000000001', requestId: REQUESTS.one.id, sequence: 1 }),
      stop({ id: 'a1000000-0000-4000-8000-000000000002', requestId: REQUESTS.two.id, sequence: 2 }),
      stop({
        id: 'a1000000-0000-4000-8000-000000000003',
        requestId: REQUESTS.three.id,
        sequence: 3,
      }),
    ],
    ...overrides,
  };
}

export function world(overrides: Partial<World> = {}): World {
  return {
    permissions: EVERYTHING,
    pool: [
      {
        ...REQUESTS.one,
        scheduled_service_date: '2026-11-04',
        sender: 'Demo Fabrics Ltd',
        address: '14 Demo Lane, Osu',
        manifested: false,
      },
      {
        ...REQUESTS.two,
        scheduled_service_date: '2026-11-02',
        sender: 'Overdue Bakes',
        address: '2 Demo Close, Labone',
        manifested: false,
      },
      {
        ...REQUESTS.three,
        scheduled_service_date: '2026-11-04',
        sender: 'Third Sender',
        address: '5 Demo Road, Tema',
        manifested: false,
      },
      {
        ...REQUESTS.four,
        scheduled_service_date: '2026-11-05',
        sender: 'Fourth Sender',
        address: '8 Demo Street, Spintex',
        manifested: false,
      },
    ],
    manifests: [manifest()],
    riders: [
      { id: IDS.riderA, name: 'Kwame Mensah', hub: IDS.hub, status: 'ACTIVE' },
      { id: IDS.riderB, name: 'Esi Owusu', hub: IDS.hub, status: 'ACTIVE' },
    ],
    skipReasons: [
      { code: 'RUN_CUT_SHORT', label: 'Demo: the run was cut short', requiresNote: false },
      {
        code: 'VENDOR_REQUESTED_SKIP',
        label: 'Demo: the vendor asked to skip',
        requiresNote: false,
      },
      {
        code: 'LOCATION_INACCESSIBLE',
        label: 'Demo: the place cannot be reached',
        requiresNote: true,
      },
      {
        code: 'STOP_RAISED_IN_ERROR',
        label: 'Demo: the stop was raised in error',
        requiresNote: true,
      },
    ],
    carryReasons: [
      { code: 'RUN_WAS_FULL', label: 'Demo: the run was full', requiresNote: false },
      { code: 'VENDOR_ASKED_LATER', label: 'Demo: the vendor asked for later', requiresNote: true },
    ],
    ...overrides,
  };
}

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly ifMatch: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
}

export interface ManifestApi {
  readonly world: World;
  readonly calls: Call[];
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
      request_id: 'req-browser-s125',
      ...(details === undefined ? {} : { details }),
    },
  };
}

const ok = (json: unknown, version?: string) => ({
  status: 200,
  headers: { ...JSON_HEADERS, ...(version === undefined ? {} : { etag: `"${version}"` }) },
  json,
});

const written = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
const requestOf = (w: World, id: string): PoolRequest | undefined =>
  w.pool.find((row) => row.id === id);
const stopsToWork = (m: WorldManifest) =>
  m.stops.filter((s) => s.state === 'PENDING' || s.state === 'ARRIVED');

function requestWire(row: PoolRequest) {
  return {
    id: row.id,
    code: row.code,
    state: 'CONFIRMED',
    responsible_hub_id: IDS.hub,
    pickup_intent: 'OWN_PACKAGES',
    sender_name: row.sender,
    resolved_pickup_location: { address: row.address },
    scheduled_service_date: row.scheduled_service_date,
    declared_package_count: 3,
    default_payer_intent: 'RECIPIENT_PAYS',
    attempt_number: 1,
    created_at: '2026-10-29T08:15:00Z',
  };
}

function stopWire(w: World, m: WorldManifest, s: WorldStop) {
  const row = requestOf(w, s.requestId);
  const sent = m.state === 'DISPATCHED' || m.state === 'IN_PROGRESS' || m.state === 'COMPLETED';
  return {
    id: s.id,
    pickup_manifest_id: m.id,
    pickup_request_id: s.requestId,
    sequence: s.sequence,
    state: s.state,
    arrived_at: null,
    failure_category: null,
    failure: null,
    skipped: s.skipped === undefined ? null : { ...s.skipped, skipped_at: '2026-11-04T09:00:00Z' },
    ...(sent && row !== undefined
      ? {
          pickup_summary: {
            reference: row.code,
            sender_display_name: row.sender,
            declared_package_count: 3,
            resolved_pickup_location: { address: row.address },
            location_note: null,
            contact_phone: '+233201234567',
          },
        }
      : {}),
  };
}

function manifestWire(w: World, m: WorldManifest, withStops = true) {
  return {
    id: m.id,
    code: m.code,
    state: m.state,
    service_date: m.service_date,
    responsible_hub_id: IDS.hub,
    assigned_rider_id: m.riderId,
    assigned_at: m.riderId === null ? null : '2026-11-03T08:00:00Z',
    dispatched_at: m.state === 'DRAFT' || m.state === 'CANCELLED' ? null : '2026-11-03T09:00:00Z',
    started_at:
      m.state === 'IN_PROGRESS' || m.state === 'COMPLETED' ? '2026-11-04T07:30:00Z' : null,
    completed_at: m.state === 'COMPLETED' ? '2026-11-04T10:00:00Z' : null,
    ...(withStops ? { stops: m.stops.map((s) => stopWire(w, m, s)) } : {}),
  };
}

/** The five states of a manifest, as the contract's `state` parameter of the list has them: a filter by any other text is refused. */
const LIST_STATES: readonly string[] = [
  'DRAFT',
  'DISPATCHED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
];

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Whether `YYYY-MM-DD` names a calendar day that exists, as the API judges it (`apps/api/src/pickup/calendar-day.ts`): four digits of year, two
 * of month and two of day, nothing around them, a real month and a day within it, and no year 0.
 */
export function isCalendarDay(text: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (parts === null) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (year < 1 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const length = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  return length !== undefined && day <= length;
}

/**
 * `listPickupManifests` as the contract states it (OB-S1-25), so that a screen is tried against the same rules the API keeps: oldest first; two
 * optional filters, `state` and `service_date`, each **exact** and combined as **"and"**, which narrow what the reader is shown and widen
 * nothing; a value that is not one (a state of another case, an unknown state, a day that does not exist, an empty or a repeated parameter) is a
 * `400 VALIDATION_FAILED` **naming the parameter** (`/state`, `/service_date`) and never an empty list; a page token is a position in the whole
 * order and is used with whatever filters the next request carries. Exported so that `test/manifest-contract.test.ts` holds it to the contract.
 */
export function listManifests(w: World, query: URLSearchParams) {
  const refuse = (name: string, rule: string) =>
    error(400, 'VALIDATION_FAILED', { violations: [{ in: 'query', pointer: `/${name}`, rule }] });
  for (const name of ['state', 'service_date', 'page_token']) {
    if (query.getAll(name).length > 1) return refuse(name, 'type');
  }
  const state = query.get('state');
  if (state !== null && !LIST_STATES.includes(state)) return refuse('state', 'enum');
  const day = query.get('service_date');
  if (day !== null && !isCalendarDay(day)) return refuse('service_date', 'format');
  const token = query.get('page_token');
  if (token !== null && !/^\d+$/.test(token)) return refuse('page_token', 'format');

  const after = token === null ? 0 : Number(token);
  const size = w.pageSize ?? Math.max(w.manifests.length, 1);
  const matching = w.manifests
    .map((m, position) => ({ m, position }))
    .filter(({ position }) => position >= after)
    .filter(({ m }) => state === null || m.state === state)
    .filter(({ m }) => day === null || m.service_date === day);
  const page = matching.slice(0, size);
  const last = page.at(-1);
  return ok({
    items: page.map(({ m }) => manifestWire(w, m, false)),
    next_page_token:
      matching.length > size && last !== undefined ? String(last.position + 1) : null,
  });
}

function handoverWire(h: WorldHandover) {
  return {
    id: IDS.handover,
    manifest_id: IDS.run,
    from_rider_id: IDS.riderA,
    to_rider_id: 'rider' in h.to ? h.to.rider : null,
    to_hub_id: 'hub' in h.to ? IDS.hub : null,
    state: h.state,
    parcel_count_taken: h.parcels,
    initiated_at: '2026-11-04T10:15:00Z',
    resolved_at: h.state === 'PENDING' ? null : '2026-11-04T10:30:00Z',
    // Planted: no real answer carries a count of the hub's.
    hub_count: PLANTED_HUB_COUNT,
    blind_count: PLANTED_HUB_COUNT,
  };
}

function completeIfDone(m: WorldManifest, w: World): void {
  const collected = m.stops.some((s) => s.state === 'COLLECTED');
  const waiting = w.handover?.state === 'PENDING';
  if (m.state === 'IN_PROGRESS' && stopsToWork(m).length === 0 && !collected && !waiting) {
    m.state = 'COMPLETED';
  }
}

function answer(route: Route, state: ManifestApi, call: Call): Promise<void> {
  const { world: w } = state;
  const { method, path } = call;
  const url = new URL(route.request().url());
  const body = (call.body ?? {}) as Record<string, unknown>;
  const etagOf = (version: number, tag: string) => `${tag}${String(version)}`;

  if (method === 'POST' && w.dropNext === true) {
    w.dropNext = false;
    return route.abort('connectionreset');
  }
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
  if (method === 'GET' && path === '/api/v1/reason-definitions') {
    const domain = url.searchParams.get('domain');
    const list =
      domain === 'PICKUP_STOP_SKIP'
        ? w.skipReasons
        : domain === 'PICKUP_CARRYOVER'
          ? w.carryReasons
          : [];
    return route.fulfill(
      ok(
        list.map((reason) => ({
          ...reason,
          domain,
          attribution: 'MELARC',
          active: true,
          consumesDeliveryAttempt: false,
          permittedOperations: null,
        })),
      ),
    );
  }
  if (method === 'GET' && path === '/api/v1/ops/riders') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const items = w.riders
      .filter(
        (rider) =>
          url.searchParams.get('status') === null ||
          rider.status === url.searchParams.get('status'),
      )
      .filter(
        (rider) =>
          url.searchParams.get('hub_id') === null || rider.hub === url.searchParams.get('hub_id'),
      )
      .filter((rider) => q === '' || rider.name.toLowerCase().includes(q))
      .map((rider) => ({
        id: rider.id,
        full_name: rider.name,
        phone: '+233201234567',
        status: rider.status,
        primary_hub_id: rider.hub,
        pin_established: true,
        has_active_device: true,
      }));
    return route.fulfill(ok({ items, next_page_token: null }));
  }
  const riderRead = /^\/api\/v1\/ops\/riders\/([0-9a-f-]+)$/.exec(path);
  if (method === 'GET' && riderRead !== null) {
    const rider = w.riders.find((candidate) => candidate.id === riderRead[1]);
    if (rider === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    return route.fulfill(
      ok(
        {
          rider: {
            id: rider.id,
            full_name: rider.name,
            phone: '+233201234567',
            status: rider.status,
            primary_hub_id: rider.hub,
            pin_established: true,
            has_active_device: true,
          },
          devices: [],
        },
        'rd1',
      ),
    );
  }
  if (method === 'GET' && path === '/api/v1/pickup-requests') {
    const poolOnly = url.searchParams.get('manifested') === 'false';
    const matching = w.pool.filter((row) => !poolOnly || !row.manifested).map(requestWire);
    const start = Number(url.searchParams.get('page_token') ?? '0');
    const size = w.pageSize ?? matching.length;
    return route.fulfill(
      ok({
        items: matching.slice(start, start + size),
        next_page_token: start + size < matching.length ? String(start + size) : null,
      }),
    );
  }
  const requestRead = /^\/api\/v1\/pickup-requests\/([0-9a-f-]+)$/.exec(path);
  if (method === 'GET' && requestRead !== null) {
    const row = requestOf(w, requestRead[1] ?? '');
    return route.fulfill(row === undefined ? error(404, 'NOT_FOUND') : ok(requestWire(row), 'r1'));
  }

  if (method === 'GET' && path === '/api/v1/pickup-manifests') {
    return route.fulfill(listManifests(w, url.searchParams));
  }
  if (method === 'POST' && path === '/api/v1/pickup-manifests') {
    if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
    const ids = (body.pickup_request_ids ?? []) as string[];
    const date = typeof body.service_date === 'string' ? body.service_date : '';
    const carry = (body.carryover ?? []) as {
      pickup_request_id: string;
      reason_code: string;
      note?: string;
    }[];
    if (date < TODAY) {
      return route.fulfill(
        error(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'body', pointer: '/service_date', rule: 'past_day' }],
        }),
      );
    }
    const taken = ids.flatMap((id, position) => {
      const row = requestOf(w, id);
      return row === undefined || row.manifested
        ? [
            {
              in: 'body',
              pointer: `/pickup_request_ids/${String(position)}`,
              rule: 'already_manifested',
            },
          ]
        : [];
    });
    if (taken.length > 0)
      return route.fulfill(error(409, 'ALREADY_MANIFESTED', { violations: taken }));
    const missing = ids.flatMap((id, position) => {
      const row = requestOf(w, id);
      const entry = carry.find((candidate) => candidate.pickup_request_id === id);
      const reason = w.carryReasons.find((candidate) => candidate.code === entry?.reason_code);
      const overdue = row !== undefined && row.scheduled_service_date < date;
      if (!overdue) return [];
      if (reason === undefined || (reason.requiresNote && !written(entry?.note))) {
        return [
          {
            in: 'body',
            pointer: `/pickup_request_ids/${String(position)}`,
            rule: 'carryover_reason_required',
          },
        ];
      }
      return [];
    });
    if (missing.length > 0)
      return route.fulfill(error(422, 'REASON_REQUIRED', { violations: missing }));
    for (const id of ids) {
      const row = requestOf(w, id);
      if (row !== undefined) row.manifested = true;
    }
    const made = manifest({
      id: IDS.created,
      code: 'ACC-MF-N7R4PX',
      service_date: date,
      stops: ids.map((id, index) =>
        stop({
          id: `a2000000-0000-4000-8000-00000000000${String(index + 1)}`,
          requestId: id,
          sequence: index + 1,
        }),
      ),
    });
    w.manifests.push(made);
    return route.fulfill({ ...ok(manifestWire(w, made), etagOf(made.version, 'm')), status: 201 });
  }

  const manifestPath =
    /^\/api\/v1\/pickup-manifests\/([0-9a-f-]+)(?:\/([a-z-]+(?:\/[a-z]+)?))?$/.exec(path);
  if (manifestPath !== null) {
    const found = w.manifests.find((m) => m.id === manifestPath[1]);
    const act = manifestPath[2];
    if (found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    const current = etagOf(found.version, 'm');
    const stale = call.ifMatch !== `"${current}"`;
    if (method === 'GET' && act === undefined)
      return route.fulfill(ok(manifestWire(w, found), current));
    if (method === 'PUT' && act === 'stops') {
      if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
      if (stale || found.state !== 'DRAFT') return route.fulfill(error(409, 'STATE_CONFLICT'));
      const order = (body.ordered_stop_ids ?? []) as string[];
      const known = found.stops.map((s) => s.id);
      if (order.length !== known.length || order.some((id) => !known.includes(id))) {
        return route.fulfill(
          error(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'body', pointer: '/ordered_stop_ids', rule: 'incomplete' }],
          }),
        );
      }
      found.stops = order.flatMap((id, index) => {
        const s = found.stops.find((candidate) => candidate.id === id);
        return s === undefined ? [] : [{ ...s, sequence: index + 1 }];
      });
      found.version += 1;
      return route.fulfill(ok(manifestWire(w, found), etagOf(found.version, 'm')));
    }
    if (method === 'POST' && act === 'assign-rider') {
      if (stale || found.state !== 'DRAFT') return route.fulfill(error(409, 'STATE_CONFLICT'));
      const rider = w.riders.find(
        (candidate) => candidate.id === body.rider_id && candidate.status === 'ACTIVE',
      );
      if (rider === undefined) return route.fulfill(error(422, 'RIDER_UNAVAILABLE'));
      found.riderId = rider.id;
      found.version += 1;
      return route.fulfill(ok(manifestWire(w, found), etagOf(found.version, 'm')));
    }
    if (method === 'POST' && act === 'dispatch') {
      if (stale || found.state !== 'DRAFT') return route.fulfill(error(409, 'STATE_CONFLICT'));
      if (found.service_date < TODAY)
        return route.fulfill(
          error(409, 'STATE_CONFLICT', {
            rule: 'service_date_passed',
            service_date: found.service_date,
          }),
        );
      if (found.riderId === null) return route.fulfill(error(422, 'RIDER_UNAVAILABLE'));
      found.state = 'DISPATCHED';
      found.version += 1;
      return route.fulfill(ok(manifestWire(w, found), etagOf(found.version, 'm')));
    }
    if (method === 'POST' && act === 'cancel') {
      if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
      if (!written(body.note)) return route.fulfill(error(422, 'REASON_REQUIRED'));
      if (found.state === 'IN_PROGRESS') return route.fulfill(error(422, 'RUN_ALREADY_STARTED'));
      if (stale || (found.state !== 'DRAFT' && found.state !== 'DISPATCHED'))
        return route.fulfill(error(409, 'STATE_CONFLICT'));
      found.state = 'CANCELLED';
      for (const s of found.stops) {
        const row = requestOf(w, s.requestId);
        if (row !== undefined) row.manifested = false;
        if (s.state === 'PENDING' || s.state === 'ARRIVED') {
          s.state = 'SKIPPED';
          s.skipped = { reason_code: 'MANIFEST_CANCELLED' };
        }
      }
      found.version += 1;
      return route.fulfill(ok(manifestWire(w, found), etagOf(found.version, 'm')));
    }
    if (method === 'POST' && act === 'custody-handover') {
      if (stale || found.state !== 'IN_PROGRESS' || w.handover?.state === 'PENDING') {
        return route.fulfill(error(409, 'STATE_CONFLICT'));
      }
      if (!written(body.note)) return route.fulfill(error(422, 'REASON_REQUIRED'));
      const toRider = body.to_rider_id as string | undefined;
      const toHub = body.to_hub_id as string | undefined;
      if ((toRider === undefined) === (toHub === undefined))
        return route.fulfill(error(400, 'VALIDATION_FAILED'));
      if (
        toRider !== undefined &&
        !w.riders.some((rider) => rider.id === toRider && rider.status === 'ACTIVE')
      ) {
        return route.fulfill(error(422, 'RIDER_UNAVAILABLE'));
      }
      w.handover = {
        to: toRider === undefined ? { hub: true } : { rider: toRider },
        state: 'PENDING',
        parcels: null,
        version: 1,
      };
      return route.fulfill(ok(handoverWire(w.handover), etagOf(w.handover.version, 'h')));
    }
    if (
      method === 'POST' &&
      (act === 'custody-handover/accept' || act === 'custody-handover/fail')
    ) {
      const handover = w.handover;
      if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
      if (handover?.state !== 'PENDING') return route.fulfill(error(409, 'STATE_CONFLICT'));
      if (call.ifMatch !== `"${etagOf(handover.version, 'h')}"`)
        return route.fulfill(error(409, 'STATE_CONFLICT'));
      if (act === 'custody-handover/accept') {
        if (!('hub' in handover.to)) return route.fulfill(error(403, 'PERMISSION_DENIED'));
        if (typeof body.parcel_count_taken !== 'number' || body.parcel_count_taken < 0)
          return route.fulfill(error(400, 'VALIDATION_FAILED'));
        handover.state = 'COMPLETED';
        handover.parcels = body.parcel_count_taken;
        completeIfDone(found, w);
      } else {
        if (!written(body.note)) return route.fulfill(error(422, 'REASON_REQUIRED'));
        handover.state = 'FAILED';
        completeIfDone(found, w);
      }
      handover.version += 1;
      found.version += 1;
      return route.fulfill(ok(handoverWire(handover), etagOf(handover.version, 'h')));
    }
  }

  if (method === 'GET' && path === '/api/v1/run-custody-handovers') {
    const wanted = url.searchParams.get('state');
    const items =
      w.handover !== undefined && (wanted === null || w.handover.state === wanted)
        ? [handoverWire(w.handover)]
        : [];
    return route.fulfill(ok({ items, next_page_token: null }));
  }
  if (
    method === 'GET' &&
    path === `/api/v1/run-custody-handovers/${IDS.handover}` &&
    w.handover !== undefined
  ) {
    return route.fulfill(ok(handoverWire(w.handover), etagOf(w.handover.version, 'h')));
  }

  const stopPath = /^\/api\/v1\/pickup-stops\/([0-9a-f-]+)(\/skip)?$/.exec(path);
  if (stopPath !== null) {
    const owner = w.manifests.find((m) => m.stops.some((s) => s.id === stopPath[1]));
    const found = owner?.stops.find((s) => s.id === stopPath[1]);
    if (owner === undefined || found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (method === 'GET' && stopPath[2] === undefined)
      return route.fulfill(ok(stopWire(w, owner, found), etagOf(found.version, 's')));
    if (method === 'POST' && stopPath[2] === '/skip') {
      if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
      const reason = w.skipReasons.find((candidate) => candidate.code === body.reason_code);
      if (reason === undefined) return route.fulfill(error(422, 'REASON_NOT_ACTIVE'));
      if (reason.requiresNote && !written(body.note))
        return route.fulfill(error(422, 'REASON_REQUIRED'));
      if (
        call.ifMatch !== `"${etagOf(found.version, 's')}"` ||
        (found.state !== 'PENDING' && found.state !== 'ARRIVED')
      ) {
        return route.fulfill(error(409, 'STATE_CONFLICT'));
      }
      found.state = 'SKIPPED';
      found.skipped = {
        reason_code: reason.code,
        ...(written(body.note) ? { note: String(body.note) } : {}),
      };
      found.version += 1;
      owner.version += 1;
      completeIfDone(owner, w);
      return route.fulfill(ok(stopWire(w, owner, found), etagOf(found.version, 's')));
    }
  }

  state.unexpected.push(`${method} ${path}`);
  return route.abort('failed');
}

/**
 * Answers the manifest operations from a small world and records every request to the API. Given a context it answers for every page opened in
 * it, so that a request opened in a new tab has an API in that tab too.
 */
export async function stubManifestApi(
  target: Page | BrowserContext,
  initial: World = world(),
): Promise<ManifestApi> {
  const state: ManifestApi = { world: initial, calls: [], unexpected: [] };
  await target.route('**/api/v1/**', async (route) => {
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
