import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import { parseEvidenceLimits, type EvidenceLimitsView } from './evidence-limits';

/** The key of the limits, so that a test or a screen can name the one read the session makes. */
export const evidenceLimitsKey = ['evidence', 'limits'] as const;

/**
 * `getEvidenceLimits`: the platform's limits on a file of evidence, **read once for the session** by whoever draws a file chooser (a run page draws one for each vendor, and each is told the same ones), and not
 * read again on focus, on reconnection or when another chooser is drawn: they are configuration, and every request of an authenticated session counts toward its limit. The cache is dropped with the session.
 * **A read that fails gives no limits** (`data` stays undefined) and is not tried again by itself: the chooser then judges nothing in the browser and the platform refuses what it will not take. A limit is never
 * guessed.
 */
export function useEvidenceLimits(): UseQueryResult<EvidenceLimitsView> {
  const client = useApiClient();
  return useQuery({
    queryKey: evidenceLimitsKey,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      const answer = answerOf(await client.GET('/evidence-limits'));
      const limits = parseEvidenceLimits(answer.data);
      if (limits === undefined) throw unexpectedResponse(answer.status);
      return limits;
    },
  });
}
