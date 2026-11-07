import { MutationObserver, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { createQueryClient, endSession, shouldRetryQuery } from './query-client';
import { holdOf } from './read-hold';

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

  // Break caught: a command's answer staying in the cache for minutes after the screen that sent it is gone. A command can
  // answer with a secret (the provisioning of an authenticator, a setup token), and the mutation cache keeps the data of
  // every mutation until it is collected, by default for five minutes. Nothing a command answered is kept longer than
  // the screen that asked for it (plan section 3, Secrets).
  it('keeps no mutation, and so nothing a command answered, once the screen that sent it has let go', async () => {
    const client = createQueryClient();
    const sentinel = 'sentinel-command-answer-6d2f';
    const observer = new MutationObserver(client, {
      mutationFn: () => Promise.resolve({ otpauth_uri: sentinel }),
    });

    await observer.mutate();
    expect(JSON.stringify(observer.getCurrentResult().data)).toContain(sentinel);
    observer.reset();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.getMutationCache().getAll()).toEqual([]);
    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain(sentinel);
  });

  // Break caught: one client shared between tests or users, carrying one session's cached data to another.
  it('creates an independent client each time', () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });
});

describe('a request that was too fast (429; A2 of the audit)', () => {
  const tooFast = () => Object.assign(new Error('HTTP 429'), { status: 429 });

  // Break caught: a 429 replayed by the client, which is the very load the API refused. The page waits (the hold) and sends nothing again by itself.
  it('is never tried again, by a query or by a mutation', async () => {
    const client = createQueryClient();
    const queryFn = vi.fn(() => Promise.reject(tooFast()));
    const mutationFn = vi.fn(() => Promise.reject(tooFast()));

    await settleWithError(
      new QueryObserver(client, { queryKey: ['limited'], queryFn, retryDelay: 1 }),
    );
    await new MutationObserver(client, { mutationFn }).mutate().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(mutationFn).toHaveBeenCalledTimes(1);
  });

  // Break caught: a cached read renewed by the opening of a page while the API has asked the page to wait, or one that is never renewed after it.
  it('keeps the opening of a page from renewing a cached read while the page is holding, and not otherwise', async () => {
    const client = createQueryClient();
    const queryFn = vi.fn(() => Promise.resolve('fresh'));
    client.setQueryData(['cached'], 'old');
    holdOf(client).hold(30);

    const held = new QueryObserver(client, { queryKey: ['cached'], queryFn });
    const stopHeld = held.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(queryFn).not.toHaveBeenCalled();
    stopHeld();

    holdOf(client).clear();
    const free = new QueryObserver(client, { queryKey: ['cached'], queryFn });
    const stopFree = free.subscribe(() => undefined);
    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(1);
    });
    stopFree();
  });

  // Break caught: a read that has no data yet being held back as if it were a renewal: the first read of a page must still be sent.
  it('does not hold back the first read of a query that has no data yet', async () => {
    const client = createQueryClient();
    const queryFn = vi.fn(() => Promise.resolve('first'));
    holdOf(client).hold(30);

    const observer = new QueryObserver(client, { queryKey: ['first'], queryFn });
    const stop = observer.subscribe(() => undefined);
    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(1);
    });
    stop();
    holdOf(client).clear();
  });

  // Break caught: the wait of one person kept for the next one on the same browser.
  it('ends with the session', () => {
    const client = createQueryClient();
    holdOf(client).hold(30);

    endSession(client);

    expect(holdOf(client).held).toBe(false);
  });
});
