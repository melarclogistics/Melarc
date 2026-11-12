import type { Page, Route } from '@playwright/test';

import { answerQueueSummary } from './queue-summary';

/**
 * What the browser tests of the pre-sign-in screens put in place of the API (S0.43). Each of the operations a person reaches with no session (the five of S0.43 and the two recovery operations of S0.52a) is
 * answered as the test says, every request is recorded as the browser sent it (method, path, the headers that matter and the body), and any other
 * request to `/api` is a failure of the test: it is answered with a network error and listed in `unexpected`, which a test asserts is empty.
 *
 * Everything in the answers is synthetic and says so. No real credential, grant or authenticator seed exists anywhere in these tests.
 */
export const OPERATIONS = {
  signIn: 'POST /api/v1/auth/staff/sign-in',
  secondStep: 'POST /api/v1/auth/staff/sign-in/mfa',
  credentialSetup: 'POST /api/v1/auth/staff/setup/credential',
  beginReenrolment: 'POST /api/v1/auth/staff/setup/mfa/begin',
  enrolment: 'POST /api/v1/auth/staff/setup/mfa',
  // The two recovery screens of the same family (S0.52a).
  recoveryRequest: 'POST /api/v1/auth/recovery/request',
  recoveryComplete: 'POST /api/v1/auth/recovery/complete',
} as const;

export type OperationName = keyof typeof OPERATIONS;

export interface Answer {
  readonly status: number;
  readonly json?: unknown;
}

/** An answer, or `no-connection` for a request that gets none. A function is given the number of this request to this operation. */
export type Handler = Answer | 'no-connection' | ((attempt: number) => Answer | 'no-connection');

export interface RecordedRequest {
  readonly operation: OperationName;
  readonly method: string;
  readonly path: string;
  readonly search: string;
  /** `origin`, `referer` and `x-csrf-token` as the browser sent them (undefined when absent). */
  readonly origin: string | undefined;
  readonly referer: string | undefined;
  readonly csrfToken: string | undefined;
  readonly authorization: string | undefined;
  readonly cookie: string | undefined;
  readonly body: unknown;
}

export interface PreSignInApi {
  readonly requests: RecordedRequest[];
  readonly unexpected: string[];
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export function errorAnswer(status: number, code: string): Answer {
  return {
    status,
    json: {
      code,
      message: 'Diagnostic text that must never reach a screen.',
      request_id: 'req-browser-9',
    },
  };
}

async function fulfil(route: Route, answer: Answer | 'no-connection'): Promise<void> {
  if (answer === 'no-connection') {
    await route.abort('connectionreset');
    return;
  }
  await route.fulfill({
    status: answer.status,
    headers: JSON_HEADERS,
    ...(answer.json === undefined ? {} : { json: answer.json }),
  });
}

function parsed(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Answers the pre-sign-in operations as the test says and records every request to the API. Register it after any catch-all route. */
export async function stubPreSignInApi(
  page: Page,
  answers: Partial<Record<OperationName, Handler>>,
): Promise<PreSignInApi> {
  const api: PreSignInApi = { requests: [], unexpected: [] };
  const attempts = new Map<OperationName, number>();

  await page.route('**/api/v1/**', async (route) => {
    // The shell of the signed-in screen a sign-in lands on reads the queue summary for the menu (task C1): no queue, and not a request of the test.
    if (await answerQueueSummary(route)) return;
    const request = route.request();
    const url = new URL(request.url());
    const line = `${request.method()} ${url.pathname}`;
    const operation = (Object.keys(OPERATIONS) as OperationName[]).find(
      (name) => OPERATIONS[name] === line,
    );
    if (operation === undefined) {
      api.unexpected.push(line);
      await route.abort('failed');
      return;
    }
    const headers = request.headers();
    api.requests.push({
      operation,
      method: request.method(),
      path: url.pathname,
      search: url.search,
      origin: headers.origin,
      referer: headers.referer,
      csrfToken: headers['x-csrf-token'],
      authorization: headers.authorization,
      cookie: headers.cookie,
      body: parsed(request.postData()),
    });
    const attempt = (attempts.get(operation) ?? 0) + 1;
    attempts.set(operation, attempt);
    const handler = answers[operation];
    if (handler === undefined) {
      api.unexpected.push(`${line} (no answer given)`);
      await route.abort('failed');
      return;
    }
    await fulfil(route, typeof handler === 'function' ? handler(attempt) : handler);
  });
  return api;
}
