import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseMissingPage,
  parseRunListPage,
  parseRunPage,
  type MissingPageView,
  type MissingView,
  type RunListPageView,
  type RunPageView,
  type RunView,
} from './receiving-shape';

/**
 * The reads of the receiving screens of a run (S1.35c), judged before they are believed (`receiving-shape.ts`). As the other screens' reads, none is read again on focus or reconnect (every accepted request is
 * activity), and nothing is kept once the screen lets go (`gcTime: 0`), so the token an act takes is always the one just read. A failed read is retried by the person, not by the page. **No read is polled**: the
 * one timer of these screens is the lock's (`use-receiving-locks.ts`), and the run page is read again after each act, when it becomes visible again and on *Refresh*.
 */
const NOT_KEPT = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  gcTime: 0,
} as const;

export interface ReceivingRunsParams {
  /** The server's filter: runs with a vendor still waiting (the default), runs with a vendor that needs a decision, or every run. The page filters nothing in the browser. */
  readonly view?: RunView;
  /** The hub the switcher chose: the list is narrowed to it (OB-S1-104), and left out for *All hubs*. A filter that narrows and never widens what the grant reaches. */
  readonly hubId?: string;
  /** The lookup: a run's code, an intake's code or a vendor's name, 2 to 64 characters. Shorter is not sent. */
  readonly q?: string;
  readonly pageToken?: string;
  readonly enabled?: boolean;
}

/** The shortest lookup the server takes. */
export const LOOKUP_MIN = 2;
/** The longest lookup the server takes. */
export const LOOKUP_MAX = 64;

/** `listReceivingRuns` (`hub.read`): the receiving queue by run, oldest handover first. A row names the run, its rider and its vendors; it never gives a declared count. */
export function useReceivingRuns(params: ReceivingRunsParams): UseQueryResult<RunListPageView> {
  const client = useApiClient();
  const lookup = params.q?.trim();
  const q =
    lookup !== undefined && lookup.length >= LOOKUP_MIN && lookup.length <= LOOKUP_MAX
      ? lookup
      : undefined;
  return useQuery({
    queryKey: [
      'hub-receiving',
      'runs',
      params.view ?? null,
      params.hubId ?? null,
      q ?? null,
      params.pageToken ?? null,
    ] as const,
    enabled: params.enabled ?? true,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/receiving-runs', {
          params: {
            query: {
              ...(params.view === undefined ? {} : { view: params.view }),
              ...(params.hubId === undefined ? {} : { hub_id: params.hubId }),
              ...(q === undefined ? {} : { q }),
              ...(params.pageToken === undefined ? {} : { page_token: params.pageToken }),
            },
          },
        }),
      );
      const page = parseRunListPage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

export const runKey = (manifestId: string) =>
  ['hub-receiving', 'run', manifestId.toLowerCase()] as const;

/**
 * `getReceivingRun` (`hub.read`): a run's receiving page, a section for each vendor with its parcels. **There is no `ETag` header: each vendor carries its own token** (`intake_etag`), the `If-Match` of its acts.
 * The answer must be the run asked about.
 */
export function useReceivingRun(manifestId: string, enabled = true): UseQueryResult<RunPageView> {
  const client = useApiClient();
  return useQuery({
    queryKey: runKey(manifestId),
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/receiving-runs/{manifest_id}', {
          params: { path: { manifest_id: manifestId } },
        }),
      );
      const page = parseRunPage(answer.data);
      if (page?.run.id.toLowerCase() !== manifestId.toLowerCase()) {
        throw unexpectedResponse(answer.status);
      }
      return page;
    },
  });
}

export interface MissingParcelsParams {
  /** `searching` (the default): missing parcels of a case that is open. `vendor_to_tell`: written off, the vendor not yet recorded as told. */
  readonly view?: MissingView;
  readonly hubId?: string;
  readonly pageToken?: string;
  readonly enabled?: boolean;
}

/** `listMissingParcels` (`hub.read`): the list *Missing — being searched for*, oldest first, each with its picture, vendor, run and how long it has been missing. */
export function useMissingParcels(params: MissingParcelsParams): UseQueryResult<MissingPageView> {
  const client = useApiClient();
  return useQuery({
    queryKey: [
      'hub-receiving',
      'missing',
      params.view ?? null,
      params.hubId ?? null,
      params.pageToken ?? null,
    ] as const,
    enabled: params.enabled ?? true,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/missing-parcels', {
          params: {
            query: {
              ...(params.view === undefined ? {} : { view: params.view }),
              ...(params.hubId === undefined ? {} : { hub_id: params.hubId }),
              ...(params.pageToken === undefined ? {} : { page_token: params.pageToken }),
            },
          },
        }),
      );
      const page = parseMissingPage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}
