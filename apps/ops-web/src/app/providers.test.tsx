import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AppProviders } from './providers';

/** Reports the query client the component can see each time it renders. */
function Probe({ onClient }: { readonly onClient: (client: QueryClient) => void }) {
  onClient(useQueryClient());
  return null;
}

describe('AppProviders', () => {
  // Break caught: components finding no query client, which throws the first time one fetches.
  it('gives its descendants a query client', () => {
    const seen: QueryClient[] = [];

    render(
      <AppProviders>
        <Probe onClient={(client) => seen.push(client)} />
      </AppProviders>,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(QueryClient);
  });

  // Break caught: a new client built on every render, which empties the cache whenever anything above
  // it re-renders.
  it('keeps one client for as long as it stays mounted', () => {
    const seen: QueryClient[] = [];
    const { rerender } = render(
      <AppProviders>
        <Probe onClient={(client) => seen.push(client)} />
      </AppProviders>,
    );

    rerender(
      <AppProviders>
        <Probe onClient={(client) => seen.push(client)} />
      </AppProviders>,
    );

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });

  // Break caught: one client shared by every application instance, so cached data from one user's
  // session could be shown to the next.
  it('creates a separate client for each application instance', () => {
    const seen: QueryClient[] = [];

    for (let instance = 0; instance < 2; instance += 1) {
      const { unmount } = render(
        <AppProviders>
          <Probe onClient={(client) => seen.push(client)} />
        </AppProviders>,
      );
      unmount();
    }

    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
  });
});
