import type { components } from '@melarc/api-client';
import type { Page, Route } from '@playwright/test';

/**
 * What the browser tests of the message log (S1.12e) put in place of the API: a small stand-in for the three operations the log and the link to
 * it use (the session, `listNotifications`, and the read of one pickup request). The list is filtered and paged as the contract says (by status,
 * audience, channel and the record, by the opaque token it gave), refuses a value the contract does not have with the `400` the server gives, and
 * can be held, or made to fail. Every request is recorded as the browser sent it (method, path, query), and any other request to `/api` is a
 * failure of the test: it is answered with a network error and listed in `unexpected`, which a test asserts is empty.
 *
 * Everything in the answers is synthetic and says so. **A number in clear, a message's text and a code are planted in every entry the stand-in
 * answers** (`PLANTED`), in fields the contract does not name, so that a screen which could draw one would, and a test looks for them in what
 * was drawn and in what was sent.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export const IDS = {
  me: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  session: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
  hub: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d',
  request: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d',
  otherRequest: '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e',
} as const;

/** A number in clear, the words of a message and a code, none of which an entry of the log carries. If any is drawn or sent, the screen did what it must not. */
export const PLANTED_NUMBER = '+233209998877';
export const PLANTED_TEXT = 'Planted words of a message: your pickup is confirmed';
export const PLANTED_CODE = 'PLANTED-CODE-4821';
export const PLANTED = [PLANTED_NUMBER, '233209998877', PLANTED_TEXT, PLANTED_CODE] as const;

/** An entry of the log as the contract describes it: the type is the generated client's, so the stand-in cannot drift from the contract. */
export type Entry = components['schemas']['NotificationLogEntry'];

let counter = 0;

/** A confirmation texted to an ad-hoc sender, delivered, about the request: the resting value of an entry. */
export function entry(overrides: Partial<Entry> = {}): Entry {
  counter += 1;
  return {
    id: `e0a8d4e2-71b3-4f5a-8c60-${counter.toString(16).padStart(12, '0')}`,
    message_kind: 'PICKUP_CONFIRMED_SENDER',
    template_version: 1,
    audience: 'AD_HOC_SENDER',
    channel: 'SMS',
    state: 'DELIVERED',
    suppression_reason: null,
    outcome_class: 'ACCEPTED',
    provider_outcome_class: null,
    destination_hint: '+233******567',
    attempt_count: 1,
    subject: { type: 'PICKUP_REQUEST', id: IDS.request },
    responsible_hub_id: IDS.hub,
    expires_at: '2026-10-30T09:30:00.000Z',
    created_at: '2026-10-29T09:30:00.000Z',
    ...overrides,
  };
}

const at = (time: string): string => `2026-10-29T${time}:00.000Z`;

/** Eleven messages, newest first, one in each state, one held back for each of two reasons, a feed entry, and a kind the screen has no words for. */
export function entries(): Entry[] {
  return [
    entry({ created_at: at('09:30') }),
    entry({
      created_at: at('09:20'),
      message_kind: 'PICKUP_CONFIRMED_VENDOR_FEED',
      audience: 'VENDOR_FEED',
      channel: 'FEED',
      outcome_class: null,
      destination_hint: null,
      attempt_count: 0,
    }),
    entry({
      created_at: at('09:10'),
      state: 'SENT',
      destination_hint: '+233******234',
      subject: { type: 'PICKUP_REQUEST', id: IDS.otherRequest },
    }),
    entry({
      created_at: at('09:00'),
      state: 'RETRYABLE',
      outcome_class: 'UNKNOWN',
      attempt_count: 2,
      destination_hint: '+233******111',
      subject: { type: 'PICKUP_REQUEST', id: IDS.otherRequest },
    }),
    entry({
      created_at: at('08:50'),
      state: 'FAILED',
      outcome_class: 'REJECTED',
      provider_outcome_class: 'REQUEST_INVALID',
      subject: { type: 'PICKUP_REQUEST', id: IDS.otherRequest },
    }),
    entry({
      created_at: at('08:40'),
      state: 'SUPPRESSED',
      suppression_reason: 'DAY_LIMIT',
      outcome_class: null,
      attempt_count: 0,
    }),
    entry({
      created_at: at('08:30'),
      state: 'SUPPRESSED',
      suppression_reason: 'KILL_SWITCH',
      outcome_class: null,
      attempt_count: 0,
      subject: { type: 'PICKUP_REQUEST', id: IDS.otherRequest },
    }),
    entry({
      created_at: at('08:20'),
      state: 'QUEUED',
      outcome_class: null,
      attempt_count: 0,
      subject: { type: 'PICKUP_REQUEST', id: IDS.otherRequest },
    }),
    entry({
      created_at: at('08:10'),
      state: 'LEASED',
      outcome_class: null,
      subject: { type: 'PICKUP_REQUEST', id: IDS.otherRequest },
    }),
    entry({
      created_at: at('08:00'),
      state: 'EXPIRED',
      outcome_class: 'EXPIRED',
      attempt_count: 0,
    }),
    entry({
      created_at: at('07:50'),
      message_kind: 'RIDER_BONUS_PAID',
      audience: 'RIDER',
      subject: { type: 'PICKUP_REQUEST', id: IDS.otherRequest },
    }),
  ];
}

/** A read that waits until the test lets it go, so that the screen can be looked at while it loads. */
export interface Hold {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

export function hold(): Hold {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export interface World {
  permissions: string[];
  entries: Entry[];
  /** How many messages a page holds: small enough for a test to reach a second page. */
  pageSize: number;
  /** The list fails with this status and code until it is taken off. */
  listFails?: { status: number; code: string } | undefined;
  /** The list waits for this before it answers. */
  hold?: Hold | undefined;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    permissions: ['pickup.read', 'notification.read'],
    entries: entries(),
    pageSize: 25,
    ...overrides,
  };
}

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
}

export interface MessagesApi {
  readonly world: World;
  readonly calls: Call[];
  readonly unexpected: string[];
  /** How many entries were answered with a number, a text and a code planted in them. */
  planted: number;
}

const STATES = [
  'QUEUED',
  'LEASED',
  'RETRYABLE',
  'SENT',
  'DELIVERED',
  'FAILED',
  'SUPPRESSED',
  'EXPIRED',
];
const AUDIENCES = [
  'AD_HOC_SENDER',
  'VENDOR_NUMBER',
  'RIDER',
  'RECIPIENT',
  'VENDOR_FEED',
  'OPS_FEED',
];
const CHANNELS = ['SMS', 'FEED'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function error(status: number, code: string, details?: unknown) {
  return {
    status,
    headers: JSON_HEADERS,
    json: {
      code,
      message: 'Diagnostic text that must never reach a screen.',
      request_id: 'req-browser-s112e',
      ...(details === undefined ? {} : { details }),
    },
  };
}

/** What goes on the wire: the entry the contract describes, with what it never carries planted beside it. */
function wire(row: Entry): Record<string, unknown> {
  return {
    ...row,
    // When the provider took the text and when the network said it arrived: neither for a message that never left, nor for a feed entry.
    sent_at:
      row.channel === 'SMS' && !['QUEUED', 'SUPPRESSED'].includes(row.state)
        ? row.created_at
        : null,
    delivered_at: row.state === 'DELIVERED' && row.channel === 'SMS' ? row.created_at : null,
    destination: PLANTED_NUMBER,
    destination_digest: 'a'.repeat(64),
    recipient_phone: PLANTED_NUMBER,
    text: PLANTED_TEXT,
    body: PLANTED_TEXT,
    code: PLANTED_CODE,
    handshake_code: PLANTED_CODE,
    provider_message_ref: PLANTED_CODE,
  };
}

/** The request the log links to, as a page about one request reads it: no phone, no price, nothing the log is not about. */
function requestWire(): Record<string, unknown> {
  return {
    id: IDS.request,
    code: 'ACC-PR-7KQ2MZ',
    state: 'CONFIRMED',
    responsible_hub_id: IDS.hub,
    pickup_intent: 'OWN_PACKAGES',
    sender_name: 'Demo Fabrics Ltd',
    resolved_pickup_location: { address: '14 Demo Lane, Osu', landmark: 'Demo bakery' },
    scheduled_service_date: '2026-11-03',
    declared_package_count: 3,
    default_payer_intent: 'RECIPIENT_PAYS',
    attempt_number: 1,
    created_at: '2026-10-29T08:15:00Z',
    confirmed_at: '2026-10-29T08:16:00Z',
    rider_assigned: false,
  };
}

/** The filters that take a word of the contract's, and the words each takes. */
const WORD_FILTERS: readonly (readonly [string, readonly string[]])[] = [
  ['state', STATES],
  ['audience', AUDIENCES],
  ['channel', CHANNELS],
];

async function list(route: Route, state: MessagesApi): Promise<void> {
  const { world: w } = state;
  const query = new URL(route.request().url()).searchParams;
  if (w.hold !== undefined) await w.hold.promise;
  if (w.listFails !== undefined) {
    return route.fulfill(error(w.listFails.status, w.listFails.code));
  }

  // The server refuses a value the contract does not have, as it does: a screen that sent a made-up filter would be told.
  const subject = query.get('subject_id');
  const token = query.get('page_token');
  const refused =
    WORD_FILTERS.find(([name, allowed]) => {
      const value = query.get(name);
      return value !== null && !allowed.includes(value);
    })?.[0] ??
    (subject !== null && !UUID.test(subject) ? 'subject_id' : undefined) ??
    (token !== null && !/^p\d+$/.test(token) ? 'page_token' : undefined);
  if (refused !== undefined) {
    return route.fulfill(
      error(400, 'VALIDATION_FAILED', {
        violations: [{ in: 'query', pointer: `/${refused}`, rule: 'enum' }],
      }),
    );
  }

  const matching = w.entries.filter(
    (row) =>
      (query.get('state') === null || row.state === query.get('state')) &&
      (query.get('audience') === null || row.audience === query.get('audience')) &&
      (query.get('channel') === null || row.channel === query.get('channel')) &&
      (subject === null || row.subject.id === subject),
  );
  const start = token === null ? 0 : Number(token.slice(1));
  const items = matching.slice(start, start + w.pageSize).map(wire);
  state.planted += items.length;
  return route.fulfill({
    status: 200,
    headers: JSON_HEADERS,
    json: {
      items,
      next_page_token:
        start + w.pageSize < matching.length ? `p${String(start + w.pageSize)}` : null,
    },
  });
}

async function answer(route: Route, state: MessagesApi, call: Call): Promise<void> {
  const { world: w } = state;
  const { method, path } = call;

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
  if (method === 'GET' && path === '/api/v1/notifications') return list(route, state);
  if (method === 'GET' && path === `/api/v1/pickup-requests/${IDS.request}`) {
    return route.fulfill({
      status: 200,
      headers: { ...JSON_HEADERS, etag: '"v1"' },
      json: requestWire(),
    });
  }

  state.unexpected.push(`${method} ${path}`);
  return route.abort('failed');
}

/** Answers the operations of the message log from a small world and records every request to the API. */
export async function stubMessagesApi(page: Page, initial: World = world()): Promise<MessagesApi> {
  const state: MessagesApi = { world: initial, calls: [], unexpected: [], planted: 0 };
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const call: Call = { method: route.request().method(), path: url.pathname, search: url.search };
    state.calls.push(call);
    await answer(route, state, call);
  });
  return state;
}
