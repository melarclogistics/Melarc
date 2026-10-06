import { ApiError, BrowserTransportError } from '@melarc/api-client/browser';
import { MutationObserver, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { createQueryClient, endSession, shouldRetryQuery } from './query-client';

const refusal = (code: string | undefined, status = 401) =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });

/** Waits until a query or mutation of the client has failed. */
async function failure(run: () => Promise<unknown>): Promise<void> {
  await run().catch(() => undefined);
}

describe('the end of a session', () => {
  // Break caught: nobody owning what happens when the API says the session has ended. A page that is open when the
  // session is terminated (by another device, an administrator, an expiry) kept showing the cached data of the
  // person it was signed in as, and the next person to sign in on that browser tab saw it before it was replaced.
  it.each(['SESSION_INVALID', 'SESSION_SUPERSEDED'])(
    'is noticed when a query fails with %s: the cache is cleared and the application is told once per failure',
    async (code) => {
      const onSessionEnded = vi.fn();
      const client = createQueryClient({ onSessionEnded });
      client.setQueryData(['someone-elses', 'data'], { secret: 'visible' });

      await failure(() =>
        client.query({
          queryKey: ['me'],
          queryFn: () => Promise.reject(refusal(code)),
          retry: false,
        }),
      );

      expect(onSessionEnded).toHaveBeenCalledOnce();
      expect(onSessionEnded).toHaveBeenCalledWith(code);
      expect(client.getQueryData(['someone-elses', 'data'])).toBeUndefined();
    },
  );

  // The same for a command: a mutation is as likely to be the first request after the session ended.
  it('is noticed when a mutation fails with SESSION_INVALID', async () => {
    const onSessionEnded = vi.fn();
    const client = createQueryClient({ onSessionEnded });
    client.setQueryData(['cached'], 1);

    await failure(() =>
      new MutationObserver(client, {
        mutationFn: () => Promise.reject(refusal('SESSION_INVALID')),
      }).mutate(),
    );

    expect(onSessionEnded).toHaveBeenCalledWith('SESSION_INVALID');
    expect(client.getQueryData(['cached'])).toBeUndefined();
  });

  // Break caught: every 401 or 403 being taken for the end of a session. A refused permission is not one, and
  // signing the person out for it would throw away what they were doing.
  it.each([
    ['a refused permission', refusal('PERMISSION_DENIED', 403)],
    ['a wrong sign-in', refusal('INVALID_CREDENTIALS')],
    ['an error with no code', refusal(undefined, 401)],
    ['a server fault', refusal('SESSION_INVALID_BUT_NOT_REALLY', 500)],
    ["an error that is not the API's", new Error('SESSION_INVALID')],
  ])('is not noticed for %s', async (_label, error) => {
    const onSessionEnded = vi.fn();
    const client = createQueryClient({ onSessionEnded });
    client.setQueryData(['kept'], 1);

    await failure(() =>
      client.query({ queryKey: ['x'], queryFn: () => Promise.reject(error), retry: false }),
    );

    expect(onSessionEnded).not.toHaveBeenCalled();
    expect(client.getQueryData(['kept'])).toBe(1);
  });

  it('needs no callback: the cache is cleared all the same', async () => {
    const client = createQueryClient();
    client.setQueryData(['cached'], 1);

    await failure(() =>
      client.query({
        queryKey: ['x'],
        queryFn: () => Promise.reject(refusal('SESSION_SUPERSEDED')),
        retry: false,
      }),
    );

    expect(client.getQueryData(['cached'])).toBeUndefined();
  });

  // Break caught: a sign-out that leaves the previous person's data in the cache, or a request that is still on its
  // way answering into it afterwards.
  it('endSession clears what is cached and cancels what is in flight', async () => {
    const client = createQueryClient();
    client.setQueryData(['cached'], 1);
    let finish: (value: string) => void = () => undefined;
    const observer = new QueryObserver(client, {
      queryKey: ['in-flight'],
      queryFn: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });
    const unsubscribe = observer.subscribe(() => undefined);

    endSession(client);
    finish('answer for the previous person');
    await Promise.resolve();

    expect(client.getQueryData(['cached'])).toBeUndefined();
    expect(client.getQueryData(['in-flight'])).toBeUndefined();
    unsubscribe();
  });
});

describe('shouldRetryQuery with the errors the client raises', () => {
  // Break caught: a refusal of the transport (a request the browser may not make) being retried: it is a defect in
  // the page, and asking again asks the same thing.
  it('never retries a request the transport refused', () => {
    expect(shouldRetryQuery(0, new BrowserTransportError('Refusing to send'))).toBe(false);
  });

  it("retries an answer that did not come, and one that was not the API's, twice", () => {
    for (const kind of ['network', 'unexpected-response'] as const) {
      const error = new ApiError({ kind, ...(kind === 'network' ? {} : { status: 200 }) });
      expect(shouldRetryQuery(0, error)).toBe(true);
      expect(shouldRetryQuery(1, error)).toBe(true);
      expect(shouldRetryQuery(2, error)).toBe(false);
    }
  });

  it.each([400, 401, 403, 404, 409, 422, 429])(
    'never retries an ApiError with status %i',
    (status) => {
      expect(shouldRetryQuery(0, new ApiError({ kind: 'http', status }))).toBe(false);
    },
  );

  it.each([500, 502, 503, 504])('retries an ApiError with status %i', (status) => {
    expect(shouldRetryQuery(0, new ApiError({ kind: 'http', status }))).toBe(true);
  });
});
