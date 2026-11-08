import { ApiError, BrowserTransportError } from '@melarc/api-client/browser';
import { QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { StaleSessionError } from '../session/session-boundary';
import { createQueryClient, endSession, shouldRetryQuery } from './query-client';

describe('the end of a session, as far as the query layer goes', () => {
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

  // Break caught: an answer refused because the session changed being asked for again, which would send the request for the next person.
  it('never retries an answer refused because the session changed', () => {
    expect(shouldRetryQuery(0, new StaleSessionError())).toBe(false);
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
