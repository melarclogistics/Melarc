import { QueryClient } from '@tanstack/react-query';

/** How many times a failed query is tried again after its first attempt. */
const MAX_QUERY_RETRIES = 2;

function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Retry only what could plausibly succeed on a second attempt: a dropped connection or a server fault,
 * a bounded number of times. A client error (401, 403, 404, 409, 422, 429, ...) is the server's answer
 * and will not change by asking again.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < MAX_QUERY_RETRIES;
}

/**
 * One client per application instance, never shared. Mutations are never retried automatically: a blind
 * replay can repeat a business effect, and the contract protects writes with explicit If-Match and
 * Idempotency-Key headers instead (contracts/openapi.yaml, "Four contract-wide rules").
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetryQuery },
      mutations: { retry: false },
    },
  });
}
