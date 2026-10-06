import { useQuery } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '../test-support/render-app';

/** A server that fails until it is fixed, as an outage does. */
const server = { failing: true, calls: 0 };

function DataPage() {
  const { data } = useQuery({
    queryKey: ['retry-test'],
    queryFn: () => {
      server.calls += 1;
      return server.failing
        ? Promise.reject(new Error('upstream down'))
        : Promise.resolve('fresh data');
    },
    // A page that lets its failure reach the route's error page, as pages built on a query will.
    throwOnError: true,
    retry: false,
  });
  return <h1 tabIndex={-1}>{data ?? 'Loading'}</h1>;
}

const route = [{ path: 'data', element: <DataPage /> }];

beforeEach(() => {
  server.failing = true;
  server.calls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a page whose query fails', () => {
  // Break caught: a "Try again" that does nothing. A query that throws its failure to the route keeps that failure
  // in its cache entry, so the page that is rendered again reads the same failure and throws it again without
  // asking the server, unless the retry also resets what the query has recorded.
  it('asks the server again when the user tries again, and shows the data when it is back', async () => {
    const { user } = renderApp('/data', route);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(server.calls).toBe(1);

    server.failing = false;
    await user.click(retry);

    expect(await screen.findByRole('heading', { level: 1, name: 'fresh data' })).toBeVisible();
    expect(server.calls).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Break caught: the reset forgetting that the fault may still be there: the error page comes back, once.
  it('shows the error page again, and asks again once, when the fault is still there', async () => {
    const { user } = renderApp('/data', route);
    const retry = await screen.findByRole('button', { name: 'Try again' });

    await user.click(retry);

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(server.calls).toBe(2);
  });
});
