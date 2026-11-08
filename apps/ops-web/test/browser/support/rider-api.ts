import type { Page, Route } from '@playwright/test';

/**
 * What the browser tests of the rider screens (S0.60) put in place of the API. A small, stateful stand-in for the operations the four screens
 * use: registering a first device makes a grant and nothing else (the rider's record changes only when the handset finishes, which a test says
 * with `finishEnrolment`), replacing needs the version read, and a revoke ends the device. Every request is recorded as the browser sent it
 * (method, path, query, the headers that matter, the body), and any other request to `/api` is a failure of the test: it is answered with a
 * network error and listed in `unexpected`, which a test asserts is empty.
 *
 * Everything in the answers is synthetic and says so. Where a test needs to prove that a credential cannot reach a screen, the stand-in plants
 * one in an answer that never carries it (a PIN hash, a key, an attestation), and the test looks for it. The enrolment codes are sentinels: each
 * is a well-formed version-1 code, so that the page draws it, and recognisable wherever it might turn up.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export const IDS = {
  me: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  session: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
  hub: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d',
  otherHub: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a',
  kwame: '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a',
  ama: '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c',
  esi: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  farAway: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
  device: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
  officer: '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e',
} as const;

/** A credential-shaped value that no real answer carries on these screens: if it is ever seen, a screen displayed what it must not. */
export const PLANTED = 'PLANTED-RIDER-CREDENTIAL-a8f3d2c1b7e94056';

const code = (token: string, challenge: string): string =>
  `melarc-rider://enrol/v1#token=${token.padEnd(43, 'x')}&challenge=${challenge.padEnd(43, 'y')}`;

/** The codes the stand-in hands out, in the order it is asked: a first binding, then a replacement, then each later one. */
export const CODES = {
  first: code('FirstEnrolmentToken', 'FirstEnrolmentChallenge'),
  second: code('SecondEnrolmentToken', 'SecondEnrolmentChallenge'),
  replacement: code('ReplacementEnrolmentToken', 'ReplacementEnrolmentChallenge'),
} as const;

/** Every part of the codes that could turn up on a page, in storage or in an address: the whole of each, encoded, and each half. */
export const CODE_FORMS: readonly string[] = Object.values(CODES).flatMap((uri) => {
  const [, fragment = ''] = uri.split('#');
  return [
    uri,
    encodeURIComponent(uri),
    ...fragment.split('&').map((part) => part.split('=')[1] ?? ''),
  ];
});

export const EVERYTHING = [
  'dispatch.read',
  'staff.device.register',
  'staff.device.reregister',
  'staff.device.revoke',
  'settings.reason.read',
];

export type RiderStatus =
  'ACTIVE' | 'INACTIVE' | 'TEMPORARILY_UNAVAILABLE' | 'SUSPENDED' | 'OFFBOARDED';

export interface Rider {
  id: string;
  full_name: string;
  phone: string;
  status: RiderStatus;
  primary_hub_id: string;
  pin_established: boolean;
  has_active_device: boolean;
  /** Not part of the wire: the server's own count of changes, which the stand-in turns into the `ETag`. */
  version: number;
}

export interface Device {
  id: string;
  status: 'ACTIVE' | 'REPLACED' | 'REVOKED';
  registered_at: string;
  registered_by: string | null;
}

export function rider(overrides: Partial<Rider> = {}): Rider {
  return {
    id: IDS.kwame,
    full_name: 'Kwame Mensah',
    phone: '+233201234567',
    status: 'ACTIVE',
    primary_hub_id: IDS.hub,
    pin_established: true,
    has_active_device: true,
    version: 1,
    ...overrides,
  };
}

/** A rider who has never held a device: no PIN yet either, as a rider is before the first binding. */
export function newcomer(overrides: Partial<Rider> = {}): Rider {
  return rider({
    id: IDS.esi,
    full_name: 'Esi Owusu',
    phone: '+233245556666',
    pin_established: false,
    has_active_device: false,
    ...overrides,
  });
}

export function device(overrides: Partial<Device> = {}): Device {
  return {
    id: IDS.device,
    status: 'ACTIVE',
    registered_at: '2026-10-20T09:00:00.000Z',
    registered_by: IDS.officer,
    ...overrides,
  };
}

export interface World {
  permissions: string[];
  riders: Rider[];
  /** The devices each rider has held, by the rider's id. */
  devices: Record<string, Device[]>;
  /** How long a code made now lasts, in milliseconds. */
  codeLifetimeMs: number;
  /** The largest page of the roster; a longer roster is paged with a token. */
  pageSize: number;
  /** How the next act is answered, once: a status and a code instead of the act being done. */
  refuseNext?: { status: number; code: string };
  /** The connection fails once on the way to the next act, so that the page never has an answer: the act is not done, and nobody knows it. */
  dropNext?: boolean;
  /** The person has signed out: the session is gone. */
  signedOut: boolean;
}

export function world(overrides: Partial<World> = {}): World {
  const kwame = rider();
  const ama = rider({
    id: IDS.ama,
    full_name: 'Ama Boateng',
    phone: '+233241112222',
    status: 'SUSPENDED',
    has_active_device: false,
    pin_established: false,
  });
  return {
    permissions: EVERYTHING,
    riders: [kwame, newcomer(), ama],
    devices: { [kwame.id]: [device()], [ama.id]: [] },
    codeLifetimeMs: 5 * 60 * 1000,
    pageSize: 100,
    signedOut: false,
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

export interface RiderApi {
  readonly world: World;
  readonly calls: Call[];
  readonly unexpected: string[];
  /** The handset has scanned the code and finished: the rider has a PIN and an `ACTIVE` device, and the record has moved. */
  finishEnrolment(riderId: string): void;
}

/** What goes on the wire: the rider without the stand-in's own count of changes, and with what a real server never sends planted in it. */
function wire(row: Rider): Record<string, unknown> {
  return {
    id: row.id,
    full_name: row.full_name,
    phone: row.phone,
    status: row.status,
    primary_hub_id: row.primary_hub_id,
    pin_established: row.pin_established,
    has_active_device: row.has_active_device,
    pin_hash: PLANTED,
    public_key: PLANTED,
  };
}

function deviceWire(row: Device, riderId: string): Record<string, unknown> {
  return {
    id: row.id,
    principal_type: 'RIDER',
    principal_id: riderId,
    device_kind: 'RIDER_ANDROID_KEYPAIR',
    status: row.status,
    registered_at: row.registered_at,
    registered_by: row.registered_by,
    public_key: PLANTED,
    attestation: { chain: [PLANTED] },
  };
}

function parsed(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const REASONS: Record<string, { code: string; label: string }[]> = {
  revokeRiderDevice: [{ code: 'DEVICE_LOST', label: 'The device was lost or stolen' }],
  reregisterRiderDevice: [{ code: 'HANDSET_REPLACED', label: 'The handset was replaced' }],
};

function error(status: number, errorCode: string, details?: unknown) {
  return {
    status,
    headers: JSON_HEADERS,
    json: {
      code: errorCode,
      message: 'Diagnostic text that must never reach a screen.',
      request_id: 'req-browser-s060',
      ...(details === undefined ? {} : { details }),
    },
  };
}

/** The grants made so far by key: a request sent again under the same key is answered with the same grant, as the real one does. */
type Issued = Map<string, Record<string, unknown>>;

async function answer(
  route: Route,
  state: RiderApi,
  call: Call,
  issued: Issued,
  now: () => Promise<number>,
): Promise<void> {
  const { world: w } = state;
  const { method, path } = call;
  const url = new URL(route.request().url());
  const find = (id: string): Rider | undefined => w.riders.find((candidate) => candidate.id === id);
  const heldBy = (id: string): Device[] => (w.devices[id] ??= []);
  const refusedNow = () => {
    if (w.refuseNext === undefined) return undefined;
    const { status, code: refusal } = w.refuseNext;
    w.refuseNext = undefined;
    return error(status, refusal);
  };
  // A lost connection on the way to an act: nothing was done and the browser has no answer.
  if (
    method === 'POST' &&
    w.dropNext === true &&
    /\/device\/(register|reregister|revoke)$/.test(path)
  ) {
    w.dropNext = false;
    return route.abort('connectionreset');
  }

  if (method === 'GET' && path === '/api/v1/auth/session') {
    if (w.signedOut) return route.fulfill(error(401, 'SESSION_INVALID'));
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
  if (method === 'DELETE' && path === '/api/v1/auth/session') {
    w.signedOut = true;
    return route.fulfill({ status: 204, headers: { 'cache-control': 'no-store' } });
  }
  if (method === 'GET' && path === '/api/v1/reason-definitions') {
    const operation = url.searchParams.get('operation') ?? '';
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: (REASONS[operation] ?? []).map((reason) => ({
        code: reason.code,
        domain: 'IDENTITY',
        label: reason.label,
        attribution: 'MELARC',
        active: true,
        consumesDeliveryAttempt: false,
        requiresNote: false,
        permittedOperations: [{ operationId: operation, branch: null }],
      })),
    });
  }
  if (method === 'GET' && path === '/api/v1/ops/riders') {
    const status = url.searchParams.get('status');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const start = Number(url.searchParams.get('page_token') ?? '0');
    const all = w.riders
      .filter((candidate) => candidate.primary_hub_id === IDS.hub)
      .filter((candidate) => status === null || candidate.status === status)
      .filter(
        (candidate) =>
          q === '' || candidate.full_name.toLowerCase().includes(q) || candidate.phone.includes(q),
      );
    const items = all.slice(start, start + w.pageSize).map(wire);
    const next = start + w.pageSize < all.length ? String(start + w.pageSize) : null;
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: { items, next_page_token: next },
    });
  }

  const one = /^\/api\/v1\/ops\/riders\/([^/]+)$/.exec(path);
  if (method === 'GET' && one) {
    const found = find(one[1] ?? '');
    if (found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (found.primary_hub_id !== IDS.hub) return route.fulfill(error(403, 'HUB_SCOPE_VIOLATION'));
    return route.fulfill({
      status: 200,
      headers: { ...JSON_HEADERS, etag: `"v${String(found.version)}"` },
      json: {
        rider: wire(found),
        devices: heldBy(found.id).map((held) => deviceWire(held, found.id)),
      },
    });
  }

  const register = /^\/api\/v1\/ops\/riders\/([^/]+)\/device\/register$/.exec(path);
  if (method === 'POST' && register) {
    const found = find(register[1] ?? '');
    if (found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    const refusal = refusedNow();
    if (refusal !== undefined) return route.fulfill(refusal);
    if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
    if (
      heldBy(found.id).length > 0 ||
      found.status === 'SUSPENDED' ||
      found.status === 'OFFBOARDED'
    ) {
      return route.fulfill(error(409, 'STATE_CONFLICT'));
    }
    const replay = issued.get(call.idempotencyKey);
    // The first grant is the first code and every later one the second: a request the connection lost makes none.
    const grant = replay ?? {
      enrolment_uri: issued.size === 0 ? CODES.first : CODES.second,
      expires_at: new Date((await now()) + w.codeLifetimeMs).toISOString(),
      rider_id: found.id,
    };
    issued.set(call.idempotencyKey, grant);
    return route.fulfill({ status: 200, headers: JSON_HEADERS, json: grant });
  }

  const reregister = /^\/api\/v1\/ops\/riders\/([^/]+)\/device\/reregister$/.exec(path);
  if (method === 'POST' && reregister) {
    const found = find(reregister[1] ?? '');
    if (found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    const refusal = refusedNow();
    if (refusal !== undefined) return route.fulfill(refusal);
    const body = call.body as { reason_code?: string; verification_note?: string } | undefined;
    const note = body?.verification_note ?? '';
    // One line, as the contract's note is: a control character (a line break among them) is refused.
    const hasControl = Array.from(note).some((character) => (character.codePointAt(0) ?? 0) < 0x20);
    if (body?.reason_code === undefined || note.trim() === '' || hasControl) {
      return route.fulfill(
        error(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'body', pointer: '/verification_note', rule: 'format' }],
        }),
      );
    }
    if (call.ifMatch !== `"v${String(found.version)}"`)
      return route.fulfill(error(409, 'STATE_CONFLICT'));
    if (heldBy(found.id).length === 0) return route.fulfill(error(409, 'STATE_CONFLICT'));
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        enrolment_uri: CODES.replacement,
        expires_at: new Date((await now()) + w.codeLifetimeMs).toISOString(),
        rider_id: found.id,
      },
    });
  }

  const revoke = /^\/api\/v1\/ops\/riders\/([^/]+)\/device\/revoke$/.exec(path);
  if (method === 'POST' && revoke) {
    const found = find(revoke[1] ?? '');
    if (found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    const refusal = refusedNow();
    if (refusal !== undefined) return route.fulfill(refusal);
    const active = heldBy(found.id).find((held) => held.status === 'ACTIVE');
    if (active !== undefined) {
      active.status = 'REVOKED';
      found.has_active_device = false;
      found.version += 1;
    }
    return route.fulfill({ status: 204, headers: { 'cache-control': 'no-store' } });
  }

  state.unexpected.push(`${method} ${path}`);
  return route.abort('failed');
}

/** Answers the rider operations from a small world and records every request to the API. */
export async function stubRiderApi(page: Page, initial: World = world()): Promise<RiderApi> {
  const issued: Issued = new Map();
  // A real server's clock is near the browser's: a code lasts from the browser's now, so that a test which moves the browser's clock
  // (`page.clock`) gets a code that is good for as long as the server says, whatever the clock of this process is.
  const browserNow = async (): Promise<number> => {
    try {
      return await page.evaluate(() => Date.now());
    } catch {
      return Date.now();
    }
  };
  const state: RiderApi = {
    world: initial,
    calls: [],
    unexpected: [],
    finishEnrolment: (riderId) => {
      const found = initial.riders.find((candidate) => candidate.id === riderId);
      if (found === undefined) throw new Error(`The stand-in has no rider ${riderId}`);
      const held = (initial.devices[riderId] ??= []);
      for (const each of held) if (each.status === 'ACTIVE') each.status = 'REPLACED';
      held.unshift(device({ id: crypto.randomUUID() }));
      found.has_active_device = true;
      found.pin_established = true;
      found.version += 1;
    },
  };
  await page.route('**/api/v1/**', async (route) => {
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
    await answer(route, state, call, issued, browserNow);
  });
  return state;
}
