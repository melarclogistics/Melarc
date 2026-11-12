import type { Page, Route } from '@playwright/test';

import { answerQueueSummary } from './queue-summary';

/**
 * What the browser tests of the identity screens (S0.44) put in place of the API. It is a small, stateful stand-in for the ten operations the
 * six screens use: an act changes what the next read says (approving a profile makes it active and moves its version), so a test can follow
 * a person through a screen and see the page say what happened. Every request is recorded as the browser sent it (method, path, query, the
 * headers that matter, the body), and any other request to `/api` is a failure of the test: it is answered with a network error and listed in
 * `unexpected`, which a test asserts is empty.
 *
 * Everything in the answers is synthetic and says so. Where a test needs to prove that a credential cannot reach a screen, the stand-in plants
 * one in the answer (a token a real server never sends there), and the test looks for it.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export const IDS = {
  me: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  session: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
  hub: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d',
  kofi: '11111111-2222-4333-8444-555555555555',
  ama: '66666666-7777-4888-9999-aaaaaaaaaaaa',
  maker: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  ops: 'b0000000-0000-4000-8000-000000000001',
  senior: 'b0000000-0000-4000-8000-000000000002',
  mine: 'c0000000-0000-4000-8000-000000000001',
  other: 'c0000000-0000-4000-8000-000000000002',
} as const;

/** A credential-shaped value that no real answer carries on these screens: if it is ever seen, a screen displayed what it must not. */
export const PLANTED = 'PLANTED-CREDENTIAL-a8f3d2c1b7e94056';

export const EVERYTHING = [
  'staff.read',
  'staff.identity.create',
  'staff.identity.approve',
  'staff.mfa.reset',
  'staff.session.revoke',
  'permission.assignable_bundle.read',
  'settings.reason.read',
];

export interface Identity {
  id: string;
  work_email: string;
  full_name: string;
  phone: string | null;
  status: 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED' | 'OFFBOARDED';
  role_bundle_id: string;
  primary_hub_id: string | null;
  mfa_enrolled: boolean;
  mfa_reset_state: 'FACTOR_ACTIVE' | 'ENROLMENT_UNFINISHED' | 'NOT_ELIGIBLE';
  created_by: string;
  approved_by: string | null;
  /** Not part of the wire: the server's own count of changes, which the stand-in turns into the `ETag`. */
  version: number;
}

export function kofi(overrides: Partial<Identity> = {}): Identity {
  return {
    id: IDS.kofi,
    work_email: 'kofi.boateng@example.test',
    full_name: 'Kofi Boateng',
    phone: '+233240000000',
    status: 'PENDING_APPROVAL',
    role_bundle_id: IDS.ops,
    primary_hub_id: IDS.hub,
    mfa_enrolled: false,
    mfa_reset_state: 'NOT_ELIGIBLE',
    created_by: IDS.maker,
    approved_by: null,
    version: 1,
    ...overrides,
  };
}

export function ama(overrides: Partial<Identity> = {}): Identity {
  return kofi({
    id: IDS.ama,
    work_email: 'ama.mensah@example.test',
    full_name: 'Ama Mensah',
    phone: null,
    role_bundle_id: IDS.senior,
    ...overrides,
  });
}

export interface SessionRow {
  id: string;
  issued_at: string;
  last_activity_at: string;
  expires_at: string;
}

export interface BrowserRow {
  id: string;
  label: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

export interface World {
  permissions: string[];
  identities: Identity[];
  sessions: SessionRow[];
  /** The trusted browsers of the signed-in person (the first is the browser asking) and of Ama, whom an administrator reads. */
  ownBrowsers: BrowserRow[];
  amaBrowsers: BrowserRow[];
  /** How the next act on a profile is answered, once: a status and a code instead of the act being done. */
  refuseNext?: { status: number; code: string };
  /** The version a profile has when the browser next asks to act on it, as if somebody else had changed it in between. */
  moveVersionBeforeNextAct?: boolean;
}

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly ifMatch: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
}

export interface StaffApi {
  readonly world: World;
  readonly calls: Call[];
  readonly unexpected: string[];
}

export function world(overrides: Partial<World> = {}): World {
  return {
    permissions: EVERYTHING,
    identities: [
      kofi(),
      ama({
        status: 'ACTIVE',
        approved_by: IDS.me,
        mfa_reset_state: 'FACTOR_ACTIVE',
        mfa_enrolled: true,
      }),
    ],
    ownBrowsers: [
      {
        id: IDS.mine,
        label: 'Chrome on Windows',
        created_at: '2026-10-23T08:00:00.000Z',
        expires_at: '2026-10-30T08:00:00.000Z',
        last_used_at: '2026-10-24T07:30:00.000Z',
      },
      {
        id: IDS.other,
        label: 'Safari on macOS',
        created_at: '2026-10-22T09:00:00.000Z',
        expires_at: '2026-10-29T09:00:00.000Z',
        last_used_at: null,
      },
    ],
    amaBrowsers: [
      {
        id: IDS.mine,
        label: 'Firefox on Linux',
        created_at: '2026-10-23T08:00:00.000Z',
        expires_at: '2026-10-30T08:00:00.000Z',
        last_used_at: null,
      },
      {
        id: IDS.other,
        label: 'Edge on Windows',
        created_at: '2026-10-22T09:00:00.000Z',
        expires_at: '2026-10-29T09:00:00.000Z',
        last_used_at: '2026-10-23T10:00:00.000Z',
      },
    ],
    sessions: [
      {
        id: IDS.mine,
        issued_at: '2026-10-23T08:00:00.000Z',
        last_activity_at: '2026-10-23T09:15:00.000Z',
        expires_at: '2026-10-23T16:00:00.000Z',
      },
      {
        id: IDS.other,
        issued_at: '2026-10-22T07:05:00.000Z',
        last_activity_at: '2026-10-22T10:30:00.000Z',
        expires_at: '2026-10-22T15:05:00.000Z',
      },
    ],
    ...overrides,
  };
}

/** What goes on the wire: the profile without the stand-in's own count of changes. */
function wire(identity: Identity): Omit<Identity, 'version'> {
  const {
    id,
    work_email,
    full_name,
    phone,
    status,
    role_bundle_id,
    primary_hub_id,
    mfa_enrolled,
    mfa_reset_state,
    created_by,
    approved_by,
  } = identity;
  return {
    id,
    work_email,
    full_name,
    phone,
    status,
    role_bundle_id,
    primary_hub_id,
    mfa_enrolled,
    mfa_reset_state,
    created_by,
    approved_by,
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

const REASONS: Record<string, { code: string; label: string; branch: string | null }[]> = {
  approveStaffIdentity: [
    { code: 'NOT_A_REAL_HIRE', label: 'Not a real hire', branch: 'APPROVAL_REJECTED' },
  ],
  reissueStaffCredentialSetup: [
    { code: 'EMAIL_LOST', label: 'The first email was lost', branch: null },
  ],
  resetStaffMfa: [{ code: 'PHONE_LOST', label: 'The phone was lost', branch: null }],
  revokeSession: [{ code: 'DEVICE_LOST', label: 'The device was lost', branch: null }],
};

function error(status: number, code: string) {
  return {
    status,
    headers: JSON_HEADERS,
    json: {
      code,
      message: 'Diagnostic text that must never reach a screen.',
      request_id: 'req-browser-s044',
    },
  };
}

async function answer(route: Route, state: StaffApi, call: Call): Promise<void> {
  const { world: w } = state;
  const { method, path } = call;
  const url = new URL(route.request().url());
  const find = (id: string): Identity | undefined =>
    w.identities.find((candidate) => candidate.id === id);

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
  if (method === 'DELETE' && path === '/api/v1/auth/session') {
    return route.fulfill({ status: 204, headers: { 'cache-control': 'no-store' } });
  }
  if (method === 'GET' && path === '/api/v1/staff-role-bundles/assignable') {
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        items: [
          { id: IDS.ops, name: 'Ops Staff', requires_platform_admin_approval: false },
          { id: IDS.senior, name: 'Senior Ops', requires_platform_admin_approval: true },
        ],
      },
    });
  }
  if (method === 'GET' && path === '/api/v1/reason-definitions') {
    const operation = url.searchParams.get('operation') ?? '';
    const branch = url.searchParams.get('branch');
    const reasons = (REASONS[operation] ?? []).filter(
      (reason) => reason.branch === null || branch === null || reason.branch === branch,
    );
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: reasons.map((reason) => ({
        code: reason.code,
        domain: 'IDENTITY',
        label: reason.label,
        attribution: 'MELARC',
        active: true,
        consumesDeliveryAttempt: false,
        requiresNote: false,
        permittedOperations: [{ operationId: operation, branch: reason.branch }],
      })),
    });
  }
  if (method === 'GET' && path === '/api/v1/staff-identities') {
    const status = url.searchParams.get('status');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const items = w.identities
      .filter((candidate) => status === null || candidate.status === status)
      .filter(
        (candidate) =>
          q === '' ||
          candidate.full_name.toLowerCase().includes(q) ||
          candidate.work_email.toLowerCase().includes(q),
      )
      // A credential a real server never sends on this read either: the list, as a table or as cards, would show it if the screen could (the security review of run 5, Stage 5.1:
      // only the profile read was planted, so a look for it on the list could not have failed).
      .map((each) => ({ ...wire(each), password_hash: PLANTED }));
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: { items, next_page_token: null },
    });
  }
  if (method === 'POST' && path === '/api/v1/staff-identities') {
    const body = call.body as Record<string, string | undefined>;
    const made = kofi({
      id: '99999999-aaaa-4bbb-8ccc-dddddddddddd',
      work_email: body.work_email ?? '',
      full_name: body.full_name ?? '',
      phone: body.phone ?? null,
      role_bundle_id: body.role_bundle_id ?? IDS.ops,
      primary_hub_id: body.primary_hub_id ?? null,
      created_by: IDS.me,
    });
    w.identities.push(made);
    return route.fulfill({
      status: 200,
      headers: { ...JSON_HEADERS, etag: `"v${String(made.version)}"` },
      json: wire(made),
    });
  }

  const profile = /^\/api\/v1\/staff-identities\/([^/]+)$/.exec(path);
  if (method === 'GET' && profile) {
    const found = find(profile[1] ?? '');
    if (found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    return route.fulfill({
      status: 200,
      headers: { ...JSON_HEADERS, etag: `"v${String(found.version)}"` },
      json: {
        ...wire(found),
        // A credential a real server never sends on this read: a screen that could show one would show this.
        password_hash: PLANTED,
      },
    });
  }

  const act =
    /^\/api\/v1\/(?:staff-identities\/([^/]+)\/approve|ops\/staff\/([^/]+)\/credential\/setup\/reissue|ops\/staff\/([^/]+)\/mfa\/reset)$/.exec(
      path,
    );
  if (method === 'POST' && act) {
    const found = find(act[1] ?? act[2] ?? act[3] ?? '');
    if (found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (w.moveVersionBeforeNextAct === true) {
      found.version += 1;
      found.status = 'ACTIVE';
      w.moveVersionBeforeNextAct = false;
    }
    if (w.refuseNext !== undefined) {
      const { status, code } = w.refuseNext;
      w.refuseNext = undefined;
      return route.fulfill(error(status, code));
    }
    if (call.ifMatch !== `"v${String(found.version)}"`)
      return route.fulfill(error(409, 'STATE_CONFLICT'));
    if (act[1] !== undefined) {
      const body = call.body as { approved?: boolean };
      found.status = body.approved === true ? 'ACTIVE' : 'REJECTED';
      found.approved_by = IDS.me;
      found.version += 1;
      return route.fulfill({
        status: 200,
        headers: { ...JSON_HEADERS, etag: `"v${String(found.version)}"` },
        json: wire(found),
      });
    }
    if (act[2] !== undefined) {
      return route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        json: {
          id: 'd0000000-0000-4000-8000-000000000001',
          principal_type: 'STAFF',
          principal_id: found.id,
          purpose: 'STAFF_CREDENTIAL_SETUP',
          state: 'PENDING',
          issued_at: '2026-10-23T08:00:00Z',
          expires_at: '2026-10-23T08:30:00Z',
          token: PLANTED,
        },
      });
    }
    found.mfa_reset_state = 'ENROLMENT_UNFINISHED';
    found.version += 1;
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        sessions_terminated: 2,
        reenrolment_grant_issued: true,
        grant_expires_at: '2026-10-23T08:30:00Z',
        setup_token: PLANTED,
        mfa_setup_token: PLANTED,
      },
    });
  }

  if (method === 'GET' && path === '/api/v1/auth/sessions') {
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        items: w.sessions.map((row) => ({
          ...row,
          principal_type: url.searchParams.get('principal_type'),
          principal_id: url.searchParams.get('principal_id'),
          state: 'ACTIVE',
          termination_reason: null,
          token_hash: PLANTED,
        })),
      },
    });
  }
  const revoke = /^\/api\/v1\/auth\/sessions\/([^/]+)\/revoke$/.exec(path);
  if (method === 'POST' && revoke) {
    const before = w.sessions.length;
    w.sessions = w.sessions.filter((row) => row.id !== revoke[1]);
    if (w.sessions.length === before) return route.fulfill(error(404, 'NOT_FOUND'));
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        id: revoke[1],
        principal_type: 'STAFF',
        state: 'TERMINATED',
        expires_at: '2026-10-23T16:00:00.000Z',
        termination_reason: 'ADMIN_REVOKED',
      },
    });
  }

  // The trusted browsers (staff-authentication.md section 5.8). A credential is planted in each answer, which no real one carries.
  if (method === 'GET' && path === '/api/v1/auth/staff/trusted-browsers') {
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        items: w.ownBrowsers.map((row, index) => ({
          ...row,
          current: index === 0,
          token: PLANTED,
          token_hash: PLANTED,
        })),
      },
    });
  }
  const removeOwn = /^\/api\/v1\/auth\/staff\/trusted-browsers\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && removeOwn) {
    const before = w.ownBrowsers.length;
    w.ownBrowsers = w.ownBrowsers.filter((row) => row.id !== removeOwn[1]);
    if (w.ownBrowsers.length === before) return route.fulfill(error(404, 'NOT_FOUND'));
    return route.fulfill({ status: 204, headers: { 'cache-control': 'no-store' } });
  }
  const listOf = /^\/api\/v1\/ops\/staff\/([^/]+)\/trusted-browsers$/.exec(path);
  if (method === 'GET' && listOf) {
    return route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        items: (listOf[1] === IDS.ama ? w.amaBrowsers : []).map((row) => ({
          ...row,
          current: false,
          token: PLANTED,
          token_hash: PLANTED,
        })),
      },
    });
  }
  const removeAll = /^\/api\/v1\/ops\/staff\/([^/]+)\/trusted-browsers\/revoke$/.exec(path);
  if (method === 'POST' && removeAll) {
    const revoked = removeAll[1] === IDS.ama ? w.amaBrowsers.length : 0;
    if (removeAll[1] === IDS.ama) w.amaBrowsers = [];
    return route.fulfill({ status: 200, headers: JSON_HEADERS, json: { revoked } });
  }

  state.unexpected.push(`${method} ${path}`);
  return route.abort('failed');
}

/**
 * The queues the staff stand-in's server would count for its session: the profiles waiting for approval, for a session that holds the key of the
 * staff list and the decision key (the only queue of the identity screens), counted from the same world the list reads.
 */
function summaryOf(w: World): Record<string, unknown>[] {
  if (!w.permissions.includes('staff.read') || !w.permissions.includes('staff.identity.approve')) {
    return [];
  }
  const waiting = w.identities.filter((identity) => identity.status === 'PENDING_APPROVAL');
  return [
    waiting.length === 0
      ? { queue: 'STAFF_AWAITING_APPROVAL', count: 0 }
      : {
          queue: 'STAFF_AWAITING_APPROVAL',
          count: waiting.length,
          oldest_at: '2026-10-30T09:00:00.000Z',
        },
  ];
}

/** Answers the identity operations from a small world and records every request to the API. */
export async function stubStaffApi(page: Page, initial: World = world()): Promise<StaffApi> {
  const state: StaffApi = { world: initial, calls: [], unexpected: [] };
  await page.route('**/api/v1/**', async (route) => {
    if (await answerQueueSummary(route, summaryOf(state.world))) return;
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
