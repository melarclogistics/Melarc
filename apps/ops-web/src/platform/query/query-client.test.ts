import { MutationObserver, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { createQueryClient, shouldRetryQuery } from './query-client';

const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${String(status)}`), { status });

describe('shouldRetryQuery', () => {
  // Break caught: retrying a refusal that cannot change. A 401 needs a new sign-in, a 409 a fresh read,
  // a 429 a pause: replaying them only adds load and hides the real answer.
  it.each([400, 401, 403, 404, 409, 422, 429])('never retries HTTP %i', (status) => {
    expect(shouldRetryQuery(0, httpError(status))).toBe(false);
  });

  // Break caught: giving up on a transient server fault at the first failure, or never giving up.
  it.each([500, 502, 503, 504])('retries HTTP %i twice and then stops', (status) => {
    expect(shouldRetryQuery(0, httpError(status))).toBe(true);
    expect(shouldRetryQuery(1, httpError(status))).toBe(true);
    expect(shouldRetryQuery(2, httpError(status))).toBe(false);
  });

  // Break caught: a dropped connection (no HTTP status at all) treated as permanent, or retried forever.
  it('retries a failure that has no HTTP status, twice', () => {
    const offline = new TypeError('Failed to fetch');
    expect(shouldRetryQuery(0, offline)).toBe(true);
    expect(shouldRetryQuery(1, offline)).toBe(true);
    expect(shouldRetryQuery(2, offline)).toBe(false);
    expect(shouldRetryQuery(0, null)).toBe(true);
  });
});

/** Anything that reports query results, whatever its data and key types are. */
interface ResultSource {
  subscribe(listener: (result: { status: string }) => void): () => void;
}

/** Waits for the observer to settle into an error, without relying on the default retry delays. */
async function settleWithError(observer: ResultSource): Promise<void> {
  await new Promise<void>((resolve) => {
    const unsubscribe = observer.subscribe((result) => {
      if (result.status === 'error') {
        unsubscribe();
        resolve();
      }
    });
  });
}

describe('createQueryClient', () => {
  // Break caught: the retry policy not being wired into the client, so a 404 is fetched three times.
  it('fetches a query that fails with a client error exactly once', async () => {
    const client = createQueryClient();
    const queryFn = vi.fn(() => Promise.reject(httpError(404)));
    await settleWithError(new QueryObserver(client, { queryKey: ['a'], queryFn, retryDelay: 1 }));
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('fetches a query that fails with a server fault three times, then reports the error', async () => {
    const client = createQueryClient();
    const queryFn = vi.fn(() => Promise.reject(httpError(503)));
    await settleWithError(new QueryObserver(client, { queryKey: ['b'], queryFn, retryDelay: 1 }));
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  // Break caught: a failed mutation replayed automatically. A silent replay can duplicate a business
  // effect; the contract's protection is an explicit If-Match or Idempotency-Key, not a blind retry.
  it('never retries a failed mutation', async () => {
    const client = createQueryClient();
    const mutationFn = vi.fn(() => Promise.reject(httpError(503)));
    const observer = new MutationObserver(client, { mutationFn });

    await observer.mutate().catch(() => undefined);

    expect(mutationFn).toHaveBeenCalledTimes(1);
  });

  // Break caught: one client shared between tests or users, carrying one session's cached data to another.
  it('creates an independent client each time', () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });
});
