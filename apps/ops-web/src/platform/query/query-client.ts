import { ApiError, BrowserTransportError } from '@melarc/api-client/browser';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

/** How many times a failed query is tried again after its first attempt. */
const MAX_QUERY_RETRIES = 2;

function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Retry only what could plausibly succeed on a second attempt: a dropped connection or a server fault,
 * a bounded number of times. A client error (401, 403, 404, 409, 422, 429, ...) is the server's answer
 * and will not change by asking again, and neither will a request the browser transport refused to send:
 * that is a defect in the page, not a fault in the network.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof BrowserTransportError) return false;
  const status = httpStatusOf(error);
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < MAX_QUERY_RETRIES;
}

export interface QueryClientOptions {
  /**
   * Called when the API says that the session has ended (`SESSION_INVALID`, or `SESSION_SUPERSEDED` for a vendor
   * displaced by a colleague), with that code. The cache has been cleared by then. It may be called more than once
   * when several requests are answered that way together, so what it does must not mind: take the person to sign-in.
   */
  readonly onSessionEnded?: (code: string) => void;
}

/**
 * The end of a session as far as the data on the page goes: what is cached is the previous person's, and what is
 * still on its way would answer into the next person's. Nothing of either may outlive the session.
 */
export function endSession(client: QueryClient): void {
  void client.cancelQueries();
  client.clear();
}

/**
 * One client per application instance, never shared. Mutations are never retried automatically: a blind
 * replay can repeat a business effect, and the contract protects writes with explicit If-Match and
 * Idempotency-Key headers instead (contracts/openapi.yaml, "Four contract-wide rules").
 *
 * Every failure of a query or a mutation passes through here, so this is where the end of a session is noticed:
 * whichever request the API answers first with a session code ends the session for all of them.
 */
export function createQueryClient(options: QueryClientOptions = {}): QueryClient {
  const noticeSessionEnd = (error: unknown): void => {
    if (!(error instanceof ApiError) || !error.endsSession || error.code === undefined) return;
    endSession(client);
    options.onSessionEnded?.(error.code);
  };

  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: noticeSessionEnd }),
    mutationCache: new MutationCache({ onError: noticeSessionEnd }),
    defaultOptions: {
      queries: { retry: shouldRetryQuery },
      mutations: { retry: false },
    },
  });
  return client;
}
