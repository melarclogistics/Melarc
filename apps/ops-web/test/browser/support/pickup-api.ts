import type { BrowserContext, Page, Route } from '@playwright/test';

import { freezeClock } from './clock';
import { answerQueueSummary } from './queue-summary';

/**
 * What the browser tests of the pickup screens (S1.19) put in place of the API: a small, stateful stand-in for the operations the five screens
 * use. A booking is created `PENDING` with an estimate; a confirmation needs the version read and moves the request; a cancellation needs a
 * reason of the catalogue and a key; the late-booking decision, the escalation, the extension and the waiver each need what their schema
 * makes mandatory; the approval of an exception takes the id alone and refuses the person who asked (`SELF_APPROVAL_FORBIDDEN`), as the
 * server does. Every request is recorded as the browser sent it (method, path, query, the headers that matter, the body), and any other
 * request to `/api` is a failure of the test: it is answered with a network error and listed in `unexpected`, which a test asserts is empty.
 *
 * Everything in the answers is synthetic and says so. A price the contract never carries is planted in every request it answers
 * (`PLANTED_PRICE_MINOR`), so that a screen which could display a price would, and a test looks for it.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export const IDS = {
  me: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  colleague: '9b2e3d4f-5a61-4b7c-8d8e-0f1a2b3c4d5e',
  session: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
  hub: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d',
  pending: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d',
  confirmed: '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e',
  booked: '2c3d4e5f-6a7b-4c8d-8e9f-0a1b2c3d4e5f',
  single: '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b',
  exception: '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d',
  vendor: '8d9e0f1a-2b3c-4d4e-8f5a-6b7c8d9e0f1a',
  account: '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
  location: '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a',
} as const;

/** A price no answer of these operations carries. If it is ever drawn, a screen showed what it must not: the booking stores no price. */
export const PLANTED_PRICE_MINOR = 98_765;
export const PLANTED_PRICE_TEXT = 'GH₵987.65';

export const EVERYTHING = [
  'pickup.read',
  'pickup.request.create',
  'pickup.request.confirm',
  'pickup.request.cancel',
  'pickup.request.cancel_chargeable',
  'pickup.exception.request',
  'pickup.exception.approve',
  'pickup.failure.resolve',
  'pickup.attempt.extend',
  'pickup.cancellation_charge.waive',
  'settings.reason.read',
  'vendor.read',
  'vendor.pickup_location.manage',
];

export interface PickupRow {
  id: string;
  code: string;
  state: 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'CANCELLED';
  scheduled_service_date: string;
  declared_package_count: number;
  cutoff_exception_state: 'PENDING_OPS_REVIEW' | 'SAME_DAY_APPROVED' | 'RESCHEDULED' | null;
  cancellation_charge_outcome:
    'APPLIED' | 'WAIVED' | 'NOT_APPLIED' | 'UNAVAILABLE' | 'EXEMPT' | null;
  /** The one-package exception the request carries, by who asked and where it is; none when it has none. */
  exception?: { requested_by: string; state: 'REQUESTED' | 'APPROVED' | 'REJECTED' };
  /** The sender's name and the pickup address the queue shows; a demo vendor and a demo lane when a test does not say. */
  sender?: string;
  address?: string;
  /** Not part of the wire: the server's own count of changes, which the stand-in turns into the `ETag`. */
  version: number;
}

export function pickup(overrides: Partial<PickupRow> = {}): PickupRow {
  return {
    id: IDS.pending,
    code: 'ACC-PR-7KQ2MZ',
    state: 'PENDING',
    scheduled_service_date: '2026-11-03',
    declared_package_count: 3,
    cutoff_exception_state: null,
    cancellation_charge_outcome: null,
    version: 1,
    ...overrides,
  };
}

export interface World {
  permissions: string[];
  requests: PickupRow[];
  /** The `PICKUP_CANCELLATION` catalogue: empty until the Product Owner's codes are seeded, as it is today. */
  cancellationReasons: {
    code: string;
    label: string;
    attribution: 'CUSTOMER' | 'MELARC' | 'EXTERNAL';
  }[];
  /** The connection fails once on the way to the next act, so that the page never has an answer. */
  dropNext?: boolean;
  /** The queue is read this many requests at a time, by a token that is the offset of the next page; the whole list at once when it is not set. */
  pageSize?: number;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    permissions: EVERYTHING,
    requests: [
      pickup(),
      pickup({
        id: IDS.confirmed,
        code: 'ACC-PR-9WXH4T',
        state: 'CONFIRMED',
        scheduled_service_date: '2026-11-04',
        cutoff_exception_state: 'PENDING_OPS_REVIEW',
      }),
    ],
    cancellationReasons: [],
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

export interface PickupApi {
  readonly world: World;
  readonly calls: Call[];
  readonly unexpected: string[];
}

const ESTIMATE = {
  status: 'AVAILABLE',
  provisional: true,
  total: { amount_minor: 4500, currency: 'GHS' },
  assumes_size_class: 'SMALL',
  excludes: ['SIZE_SURCHARGE'],
  components: [
    {
      kind: 'SERVICE_AREA_BASE_FEE',
      hub_id: IDS.hub,
      setting_key: 'service_area_base_fee',
      effective_version: '1',
      quantity: 3,
      amount: { amount_minor: 4500, currency: 'GHS' },
    },
  ],
};

/** The exception as the request reads it: the recipient it carries, and no fee (the stand-in plants one where none may be shown). */
function exceptionOf(row: PickupRow): Record<string, unknown> | null {
  if (row.exception === undefined) return null;
  const approved = row.exception.state === 'APPROVED';
  return {
    id: IDS.exception,
    state: row.exception.state,
    requested_by: row.exception.requested_by,
    requested_at: '2026-10-29T08:20:00Z',
    approved_by: approved ? IDS.me : null,
    decided_at: approved ? '2026-10-29T09:00:00Z' : null,
    note: 'Bridal gown, urgent',
    recipient: {
      name: 'Abena Demo',
      phone: '+233240000000',
      location: { address: '9 Demo Street, Tema' },
    },
    single_package_fee: null,
  };
}

/** What goes on the wire: the request without the stand-in's count of changes, and with a price no real answer carries. */
function wire(row: PickupRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    state: row.state,
    responsible_hub_id: IDS.hub,
    pickup_intent: 'OWN_PACKAGES',
    vendor_organization_id: IDS.vendor,
    sender_name: row.sender ?? 'Demo Fabrics Ltd',
    resolved_pickup_location: {
      address: row.address ?? '14 Demo Lane, Osu',
      landmark: 'Demo bakery',
    },
    scheduled_service_date: row.scheduled_service_date,
    declared_package_count: row.declared_package_count,
    default_payer_intent: 'RECIPIENT_PAYS',
    attempt_number: 1,
    replaces_request_id: null,
    replacement_request_id: null,
    one_package_exception_id: row.exception?.state === 'APPROVED' ? IDS.exception : null,
    one_package_exception: exceptionOf(row),
    cutoff_exception_state: row.cutoff_exception_state,
    cancellation_charge_outcome: row.cancellation_charge_outcome,
    cancellation_charge:
      row.cancellation_charge_outcome === 'APPLIED'
        ? { amount_minor: 2000, currency: 'GHS' }
        : null,
    created_at: '2026-10-29T08:15:00Z',
    primary_phone: '+233201234567',
    price: { amount_minor: PLANTED_PRICE_MINOR, currency: 'GHS' },
    total_minor: PLANTED_PRICE_MINOR,
    ...extra,
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

function error(status: number, errorCode: string, details?: unknown) {
  return {
    status,
    headers: JSON_HEADERS,
    json: {
      code: errorCode,
      message: 'Diagnostic text that must never reach a screen.',
      request_id: 'req-browser-s119',
      ...(details === undefined ? {} : { details }),
    },
  };
}

const record = (row: PickupRow, extra: Record<string, unknown> = {}) => ({
  status: 200,
  headers: { ...JSON_HEADERS, etag: `"v${String(row.version)}"` },
  json: wire(row, extra),
});

/** A mandatory text of an act: something other than blanks. */
const written = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

function answer(route: Route, state: PickupApi, call: Call): Promise<void> {
  const { world: w } = state;
  const { method, path } = call;
  const url = new URL(route.request().url());
  const body = (call.body ?? {}) as Record<string, unknown>;

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
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json:
        url.searchParams.get('domain') === 'PICKUP_CANCELLATION'
          ? w.cancellationReasons.map((reason) => ({
              ...reason,
              domain: 'PICKUP_CANCELLATION',
              active: true,
              consumesDeliveryAttempt: false,
              requiresNote: false,
              permittedOperations: null,
            }))
          : [],
    });
  }
  if (method === 'GET' && path === '/api/v1/pickup-requests') {
    const stateFilter = url.searchParams.get('state');
    const date = url.searchParams.get('service_date');
    const exceptionState = url.searchParams.get('one_package_exception_state');
    const cutoffState = url.searchParams.get('cutoff_exception_state');
    const matching = w.requests
      .filter((row) => stateFilter === null || row.state === stateFilter)
      .filter((row) => date === null || row.scheduled_service_date === date)
      .filter((row) => exceptionState === null || row.exception?.state === exceptionState)
      .filter((row) => cutoffState === null || row.cutoff_exception_state === cutoffState)
      .map((row) => wire(row));
    const start = Number(url.searchParams.get('page_token') ?? '0');
    const size = w.pageSize ?? matching.length;
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        items: matching.slice(start, start + size),
        next_page_token: start + size < matching.length ? String(start + size) : null,
      },
    });
  }
  if (method === 'GET' && path === '/api/v1/ops/vendors') {
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        items: [
          {
            id: IDS.account,
            account_identifier: 'K7M2Q9X4',
            vendor_organization_id: IDS.vendor,
            legal_name: 'Demo Fabrics Ltd',
            responsible_hub_id: IDS.hub,
            status: 'ACTIVE',
            credential_established: true,
            active_device_count: 1,
            has_recovery_email: true,
            has_recovery_phone: false,
            delivery_channel: 'EMAIL',
          },
        ],
        next_page_token: null,
      },
    });
  }
  if (method === 'GET' && path === `/api/v1/vendor-organizations/${IDS.vendor}/pickup-locations`) {
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        items: [
          {
            id: IDS.location,
            vendor_organization_id: IDS.vendor,
            label: 'Demo shop front',
            location: { address: '14 Demo Lane, Osu' },
            is_default: true,
            active: true,
          },
        ],
      },
    });
  }
  if (method === 'POST' && path === '/api/v1/pickup-requests') {
    if (call.idempotencyKey === undefined) return route.fulfill(error(400, 'VALIDATION_FAILED'));
    const row = pickup({
      id: IDS.booked,
      code: 'ACC-PR-3RTY8N',
      scheduled_service_date: String(body.scheduled_service_date),
      declared_package_count: Number(body.declared_package_count),
    });
    w.requests.push(row);
    return route.fulfill({
      status: 201,
      headers: { ...JSON_HEADERS, etag: '"v1"' },
      json: wire(row, { indicative_estimate: ESTIMATE }),
    });
  }

  const one = /^\/api\/v1\/pickup-requests\/([^/]+)(?:\/(.+))?$/.exec(path);
  const found = w.requests.find((row) => row.id === one?.[1]);
  if (one !== null && found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
  if (one !== null && found !== undefined) {
    const act = one[2];
    if (method === 'GET' && act === undefined) return route.fulfill(record(found));
    if (method === 'POST') {
      // The checker's half takes nothing but the id: no body, no version, no key. The maker-checker rule is the server's.
      if (act === 'one-package-exception/approve') {
        if (
          call.body !== undefined ||
          call.ifMatch !== undefined ||
          call.idempotencyKey !== undefined
        ) {
          return route.fulfill(error(400, 'VALIDATION_FAILED'));
        }
        if (found.exception?.state !== 'REQUESTED')
          return route.fulfill(error(409, 'STATE_CONFLICT'));
        if (found.exception.requested_by === IDS.me) {
          return route.fulfill(error(422, 'SELF_APPROVAL_FORBIDDEN'));
        }
        found.exception.state = 'APPROVED';
        found.version += 1;
        return route.fulfill({
          status: 200,
          headers: JSON_HEADERS,
          json: {
            id: IDS.exception,
            state: 'APPROVED',
            requested_by: found.exception.requested_by,
            approved_by: IDS.me,
            note: 'Bridal gown, urgent',
          },
        });
      }
      // Every act on a request takes the version read, but the exception, which takes none.
      if (act !== 'one-package-exception' && call.ifMatch !== `"v${String(found.version)}"`) {
        return route.fulfill(error(409, 'STATE_CONFLICT'));
      }
      if (act === 'confirm') {
        found.state = 'CONFIRMED';
        found.version += 1;
        return route.fulfill(record(found, { indicative_estimate: ESTIMATE }));
      }
      if (act === 'cancel') {
        const known = w.cancellationReasons.some((reason) => reason.code === body.reason_code);
        if (call.idempotencyKey === undefined || !known) {
          return route.fulfill(error(422, 'REASON_NOT_ACTIVE'));
        }
        found.state = 'CANCELLED';
        found.version += 1;
        return route.fulfill(record(found));
      }
      if (act === 'cutoff-exception' || act === 'escalate' || act === 'attempt-extension') {
        if (call.idempotencyKey === undefined)
          return route.fulfill(error(400, 'VALIDATION_FAILED'));
        if (!written(act === 'attempt-extension' ? body.reason : body.note)) {
          return route.fulfill(error(422, 'REASON_REQUIRED'));
        }
        if (act === 'cutoff-exception') found.cutoff_exception_state = 'SAME_DAY_APPROVED';
        found.version += 1;
        return route.fulfill(record(found));
      }
      if (act === 'cancellation-charge/waiver') {
        if (found.cancellation_charge_outcome !== 'APPLIED') {
          return route.fulfill(error(422, 'NO_CHARGE_APPLIED'));
        }
        found.cancellation_charge_outcome = 'WAIVED';
        found.version += 1;
        return route.fulfill(record(found));
      }
    }
  }

  state.unexpected.push(`${method} ${path}`);
  return route.abort('failed');
}

/**
 * Answers the pickup operations from a small world and records every request to the API. Given a context it answers for every page opened in
 * it, so that a request opened in a new tab (a modifier-click) has an API in that tab too.
 */
export async function stubPickupApi(
  target: Page | BrowserContext,
  initial: World = world(),
): Promise<PickupApi> {
  const state: PickupApi = { world: initial, calls: [], unexpected: [] };
  // The clock of the world: "today or later" and "last checked" are the world's, whatever day the machine thinks it is.
  await freezeClock(target);
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
