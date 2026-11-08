import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseRiderDetail,
  parseRiderPage,
  type RiderDetailView,
  type RiderPageView,
  type RiderStatus,
} from './rider-shape';

/**
 * The reads of the rider screens (S0.60), judged before they are believed (`rider-shape.ts`). As the identity and vendor screens' reads, none
 * is read again on focus or reconnect (every accepted request is activity), and nothing is kept once the screen lets go (`gcTime: 0`), so the
 * version an act takes is always the one just read.
 */
const NOT_KEPT = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  gcTime: 0,
} as const;

export interface RiderListParams {
  readonly status?: RiderStatus;
  /** Only the riders of this hub (the manifest's, for an assignment: what the grant reaches is not who is eligible). */
  readonly hubId?: string;
  /** Matches the rider's name or phone. Blank is no search. */
  readonly q?: string;
  readonly pageToken?: string;
  readonly enabled?: boolean;
}

/** `listRiders`: a page of the riders the session's grant reaches (`dispatch.read`), scoped by the server through each rider's primary hub. */
export function useRiders(params: RiderListParams): UseQueryResult<RiderPageView> {
  const client = useApiClient();
  const { status, hubId, q, pageToken, enabled = true } = params;
  const search = q?.trim() ?? '';
  return useQuery({
    queryKey: ['riders', 'list', status ?? null, hubId ?? null, search, pageToken ?? null],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/ops/riders', {
          params: {
            query: {
              ...(status === undefined ? {} : { status }),
              ...(hubId === undefined ? {} : { hub_id: hubId }),
              ...(search === '' ? {} : { q: search }),
              ...(pageToken === undefined ? {} : { page_token: pageToken }),
            },
          },
        }),
      );
      const page = parseRiderPage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

/** A rider, the devices the rider has held and the version the next act on the rider takes: the `ETag` of this read, exactly as sent. */
export interface RiderRecord extends RiderDetailView {
  readonly etag: string;
}

/** `getRider`. A rider with no version cannot be acted on, and another rider than the one asked for is not the answer. */
export function useRider(id: string, enabled = true): UseQueryResult<RiderRecord> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['riders', 'rider', id],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/ops/riders/{riderId}', { params: { path: { riderId: id } } }),
      );
      const detail = parseRiderDetail(answer.data);
      const isTheOneAskedFor = detail?.rider.id.toLowerCase() === id.toLowerCase();
      if (detail === undefined || !isTheOneAskedFor || answer.etag === undefined) {
        throw unexpectedResponse(answer.status);
      }
      return { ...detail, etag: answer.etag };
    },
  });
}
