import { BrowserTransportError } from '@melarc/api-client/browser';
import { QueryClient } from '@tanstack/react-query';

import { StaleSessionError } from '../session/session-boundary';
import { holdOf } from './read-hold';

/** How many times a failed query is tried again after its first attempt. */
const MAX_QUERY_RETRIES = 2;

/** `429`: the API said the request was too fast. It is never tried again by the query client; the hold is how the page waits (`read-hold.ts`). */
const TOO_FAST = 429;

function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Retry only what could plausibly succeed on a second attempt: a dropped connection or a server fault,
 * a bounded number of times. A client error (401, 403, 404, 409, 422, 429, ...) is the server's answer
 * and will not change by asking again, and neither will a request the browser transport refused to send:
 * that is a defect in the page, not a fault in the network. An answer refused because the session changed is not retried either:
 * the retry would be sent for whichever session is current, which is not the one the query was asked for.
 *
 * **A `429` is never retried, whatever else is decided about client errors** (A2 of the audit): a retry is the very load the API refused. The
 * page waits for the wait the API asked for instead (the hold, `read-hold.ts`), and sends nothing again by itself.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof BrowserTransportError || error instanceof StaleSessionError) return false;
  const status = httpStatusOf(error);
  if (status === TOO_FAST) return false;
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < MAX_QUERY_RETRIES;
}

/**
 * The end of a session as far as the data on the page goes: what is cached is the previous person's, and what is
 * still on its way would answer into the next person's. The cache is emptied and the queries in flight are cancelled.
 *
 * That is all this does. It does not cancel a mutation that is running (TanStack Query has no way to), and a query whose
 * function ignores its abort signal still runs to the end. What keeps such an answer from reaching the next person is not
 * here: every call goes through the session boundary (`SessionBoundary`), which refuses an answer to a request sent for a
 * session that has ended, whatever the cache holds.
 */
export function endSession(client: QueryClient): void {
  void client.cancelQueries();
  client.clear();
  // The wait was the previous person's, and so are the reads that waited for it.
  holdOf(client).clear();
}

/**
 * One client per application instance, never shared. Mutations are never retried automatically: a blind
 * replay can repeat a business effect, and the contract protects writes with explicit If-Match and
 * Idempotency-Key headers instead (contracts/openapi.yaml, "Four contract-wide rules"). A mutation is not kept after
 * its screen lets go of it; an answer that is itself a secret is not fetched through the cache at all
 * (`useTransientSecret`).
 *
 * It does not notice the end of a session or a `429`: those are the session boundary's, which sees every call, those made outside the
 * cache included (`AppProviders` wires its `onEnded` to `endSession` and its `onRateLimited` to the client's hold).
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        // Opening a page renews a cached read that has gone stale; while the API has asked the page to wait, it does not (the hold, `read-hold.ts`).
        // A read that has no data yet is not a renewal and is sent, and so is every read the person asks for.
        refetchOnMount: () => !holdOf(client).held,
      },
      // `gcTime: 0` removes a mutation, and the answer it holds, as soon as the screen that sent it lets go of it. The
      // default is five minutes, and a command can answer with a secret. It removes the record of the mutation; it does not
      // erase a string, and it does not stop a mutation that is running.
      mutations: { retry: false, gcTime: 0 },
    },
  });
  return client;
}
