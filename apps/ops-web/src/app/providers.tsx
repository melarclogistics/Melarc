import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiClientProvider } from '../platform/api/api-client';
import { createQueryClient } from '../platform/query/query-client';

/** Application-wide providers. One query client and one API client per application instance, created once. */
export function AppProviders({ children }: { readonly children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider>{children}</ApiClientProvider>
    </QueryClientProvider>
  );
}
