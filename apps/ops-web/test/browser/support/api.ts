import type { Page, Route } from '@playwright/test';

import { answerQueueSummary } from './queue-summary';

/**
 * What the browser tests put in place of the API. The shell tests run against the production build served by a static
 * host, which has no API, so the one call the application makes at the start, `GET /api/v1/auth/session` (who is
 * signed in), is answered here. Nothing else is stubbed, and any other request to `/api` is a failure of the test: it
 * is answered with a network error and listed in `unexpected`, which a test asserts is empty.
 *
 * The session is synthetic and says so; no real person or hub is named.
 */
export const SESSION_PATH = '/api/v1/auth/session';

export const SIGNED_IN_SESSION = {
  id: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
  principal_type: 'STAFF',
  principal_id: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  state: 'ACTIVE',
  permissions: ['staff.read'],
  issued_at: '2026-10-23T08:00:00.000Z',
  expires_at: '2026-10-23T16:00:00.000Z',
  last_activity_at: '2026-10-23T08:00:00.000Z',
  termination_reason: null,
  principal_display_name: 'Synthetic Officer',
  authorized_hubs: [{ id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', display_name: 'Synthetic Hub' }],
} as const;

export type SessionAnswer =
  'signed-in' | 'signed-out' | 'unavailable' | 'unavailable-then-signed-in';

/** How `DELETE /auth/session` (sign-out) is answered. The default is that nobody signs out, and a sign-out is then an unexpected request. */
export type SignOutAnswer =
  | 'ok'
  | 'held-ok'
  | 'session-invalid'
  | 'csrf-refused'
  | 'fault'
  | 'no-connection'
  | 'fault-then-ok';

export interface StubbedApi {
  /** The requests to `/api` that were made, as `METHOD path`. */
  readonly requests: string[];
  /** The ones no stub answers. */
  readonly unexpected: string[];
  /** The `X-CSRF-Token` header of each sign-out request, in order (null for none). */
  readonly signOutTokens: (string | null)[];
  /** Lets a `held-ok` sign-out finish: the test looks at the sign-out that is under way for as long as it needs, and releases it when it has. */
  readonly releaseSignOut: () => void;
}

export interface StubOptions {
  readonly signOut?: SignOutAnswer;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function answer(
  route: Route,
  kind: Exclude<SessionAnswer, 'unavailable-then-signed-in'>,
): Promise<void> {
  switch (kind) {
    case 'signed-in':
      return route.fulfill({ status: 200, headers: JSON_HEADERS, json: SIGNED_IN_SESSION });
    case 'signed-out':
      return route.fulfill({
        status: 401,
        headers: JSON_HEADERS,
        json: { code: 'SESSION_INVALID', message: 'Diagnostic text.', request_id: 'req-browser-1' },
      });
    case 'unavailable':
      return route.fulfill({
        status: 503,
        headers: JSON_HEADERS,
        json: { code: 'SETTING_MISSING', message: 'Diagnostic text.', request_id: 'req-browser-2' },
      });
  }
}

function signOutAnswer(
  route: Route,
  kind: SignOutAnswer,
  attempt: number,
  held: Promise<void>,
): Promise<void> {
  switch (kind) {
    case 'ok':
      return route.fulfill({ status: 204, headers: { 'cache-control': 'no-store' } });
    case 'held-ok':
      // Answered when the test says so (`releaseSignOut`) and not after a pause: a pause is a race with the steps the test takes while the sign-out is
      // under way, and on a slow machine the sign-out finished first (review of 7 November 2026).
      return held.then(() => signOutAnswer(route, 'ok', attempt, held));
    case 'session-invalid':
      return route.fulfill({
        status: 401,
        headers: JSON_HEADERS,
        json: { code: 'SESSION_INVALID', message: 'Diagnostic text.', request_id: 'req-browser-3' },
      });
    case 'csrf-refused':
      return route.fulfill({
        status: 403,
        headers: JSON_HEADERS,
        json: {
          code: 'CSRF_VALIDATION_FAILED',
          message: 'Diagnostic text.',
          request_id: 'req-browser-4',
        },
      });
    case 'fault':
      return route.fulfill({
        status: 500,
        headers: JSON_HEADERS,
        json: { code: 'INTERNAL_ERROR', message: 'Diagnostic text.', request_id: 'req-browser-5' },
      });
    case 'no-connection':
      return route.abort('connectionreset');
    case 'fault-then-ok':
      return attempt === 1
        ? signOutAnswer(route, 'fault', attempt, held)
        : signOutAnswer(route, 'ok', attempt, held);
  }
}

/** Answers the session read as the test says, and records every request to the API. Register it after any catch-all route. */
export async function stubApi(
  page: Page,
  session: SessionAnswer = 'signed-in',
  options: StubOptions = {},
): Promise<StubbedApi> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stubbed: StubbedApi = {
    requests: [],
    unexpected: [],
    signOutTokens: [],
    releaseSignOut: () => {
      release();
    },
  };
  let reads = 0;
  let signOuts = 0;
  await page.route('**/api/v1/**', async (route) => {
    if (await answerQueueSummary(route)) return;
    const { pathname } = new URL(route.request().url());
    const line = `${route.request().method()} ${pathname}`;
    stubbed.requests.push(line);
    if (line === `DELETE ${SESSION_PATH}` && options.signOut !== undefined) {
      signOuts += 1;
      stubbed.signOutTokens.push(route.request().headers()['x-csrf-token'] ?? null);
      await signOutAnswer(route, options.signOut, signOuts, held);
      return;
    }
    if (line !== `GET ${SESSION_PATH}`) {
      stubbed.unexpected.push(line);
      await route.abort('failed');
      return;
    }
    reads += 1;
    await answer(
      route,
      session === 'unavailable-then-signed-in'
        ? reads === 1
          ? 'unavailable'
          : 'signed-in'
        : session,
    );
  });
  return stubbed;
}
