import {
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type UseQueryResult,
  type InfiniteData,
} from '@tanstack/react-query';

import { useApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import { createRetrievalAuthorization } from './pickup-work-commands';
import {
  parseDisputePage,
  parseOpsHandshakePage,
  parsePickupFailurePage,
  parseShortfallPage,
  parseStopEvidencePage,
  type DisputeView,
  type EvidencePurpose,
  type OpsHandshakeView,
  type PickupFailureView,
  type RetrievalAuthorizationView,
  type ShortfallView,
  type StopEvidencePageView,
  type WorkListPageView,
} from './pickup-work-shape';

/**
 * The reads of the screens of the door and the failure (S1.30), judged before they are believed (`pickup-work-shape.ts`). As the pickup, manifest and identity screens' reads, none is
 * read again on focus or reconnect (every accepted request is activity), and nothing is kept once the screen lets go (`gcTime: 0`), so the version an act takes is always the one just read.
 * A failed read is retried by the person, not by the page.
 */
const NOT_KEPT = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  gcTime: 0,
} as const;

export interface WorkListParams {
  /**
   * What the list's `open` filter says: `true` is what still waits for Ops, `false` is the rest of what the list holds, and left out is all of it. **The server filters, and the page
   * filters nothing**: a part of a page filtered in the browser would pass for the whole. What "waits" means is each list's own rule, told by its page.
   */
  readonly open?: boolean;
  /** Only the items of this hub (task C3; the hub the switcher chose): a filter that narrows and never widens what the grant reaches. Left out for *All hubs*. */
  readonly hubId?: string;
  readonly pageToken?: string;
  readonly enabled?: boolean;
}

/** What each list is asked: a parameter is the request's or it is not there (never sent empty), and no parameter is ever sent twice. */
function queryOf(params: WorkListParams) {
  return {
    ...(params.open === undefined ? {} : { open: params.open }),
    ...(params.hubId === undefined ? {} : { hub_id: params.hubId }),
    ...(params.pageToken === undefined ? {} : { page_token: params.pageToken }),
  };
}

const keyOf = (name: string, params: WorkListParams) =>
  [
    'pickup-work',
    name,
    params.open ?? null,
    params.hubId ?? null,
    params.pageToken ?? null,
  ] as const;

/** `listPickupFailures` (`pickup.failure.resolve`): the failure decision queue, oldest failure first. `open` is a failure whose request is still confirmed. */
export function usePickupFailures(
  params: WorkListParams,
): UseQueryResult<WorkListPageView<PickupFailureView>> {
  const client = useApiClient();
  return useQuery({
    queryKey: keyOf('failures', params),
    enabled: params.enabled ?? true,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/pickup-failures', { params: { query: queryOf(params) } }),
      );
      const page = parsePickupFailurePage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

/** `listHandshakesForOps` (`pickup.handshake.override`): the handshakes that need Ops now, and the ones Ops settled. */
export function useHandshakesForOps(
  params: WorkListParams,
): UseQueryResult<WorkListPageView<OpsHandshakeView>> {
  const client = useApiClient();
  return useQuery({
    queryKey: keyOf('handshakes', params),
    enabled: params.enabled ?? true,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/handshakes-for-ops', { params: { query: queryOf(params) } }),
      );
      const page = parseOpsHandshakePage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

/** `listCollectionShortfalls` (`pickup.handshake.override`): the short counts flagged to the office. `open` is a shortfall whose run is still in progress. */
export function useCollectionShortfalls(
  params: WorkListParams,
): UseQueryResult<WorkListPageView<ShortfallView>> {
  const client = useApiClient();
  return useQuery({
    queryKey: keyOf('shortfalls', params),
    enabled: params.enabled ?? true,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/collection-shortfalls', { params: { query: queryOf(params) } }),
      );
      const page = parseShortfallPage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

/** `listCollectionDisputes` (`pickup.read`): the disputes vendors raised. `open` is an item still `OPEN`. */
export function useCollectionDisputes(
  params: WorkListParams,
): UseQueryResult<WorkListPageView<DisputeView>> {
  const client = useApiClient();
  return useQuery({
    queryKey: keyOf('disputes', params),
    enabled: params.enabled ?? true,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/collection-disputes', { params: { query: queryOf(params) } }),
      );
      const page = parseDisputePage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

/**
 * The largest page of a stop's evidence the contract allows. **What a stop of two hundred photos costs the page:** this list, in two reads of this size (and each tile is a line of text, no
 * image), and nothing else until the officer opens a photo, which is one authorization and one image of its own. No small copy of a photo is made (OB-S1-86), so no tile has a picture.
 */
export const STOP_EVIDENCE_PAGE_SIZE = 100;

/** The key of a stop's evidence, so that a screen can read it again after the act that changes it (the exception). */
export const stopEvidenceKey = (stopId: string, purpose: EvidencePurpose | undefined) =>
  ['pickup-work', 'stop-evidence', stopId, purpose ?? null] as const;

/**
 * `listPickupStopEvidence` (`pickup.read`): the evidence of one stop, **read a page at a time** by the position the server gives (`fetchNextPage`), with the progress of its parcel photos and the
 * exception that let its count through without them on every page (the freshest page's are the ones to draw). `purpose` narrows the items and never the counts.
 */
export function useStopEvidence(
  stopId: string,
  purpose: EvidencePurpose | undefined,
  enabled = true,
): UseInfiniteQueryResult<InfiniteData<StopEvidencePageView, string | undefined>> {
  const client = useApiClient();
  return useInfiniteQuery({
    queryKey: stopEvidenceKey(stopId, purpose),
    enabled,
    ...NOT_KEPT,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: StopEvidencePageView) => last.nextPageToken ?? undefined,
    queryFn: async ({ pageParam }) => {
      const answer = answerOf(
        await client.GET('/pickup-stops/{id}/evidence', {
          params: {
            path: { id: stopId },
            query: {
              page_size: STOP_EVIDENCE_PAGE_SIZE,
              ...(purpose === undefined ? {} : { purpose }),
              ...(pageParam === undefined ? {} : { page_token: pageParam }),
            },
          },
        }),
      );
      const page = parseStopEvidencePage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

/**
 * The authorization to read **one** photo, asked for when the officer opens it and for no other photo (`createEvidenceRetrievalAuthorization`, five minutes). It is a bearer capability, so it is
 * kept by nothing but the open photo: not retried, never read again on focus, and dropped from memory the moment the photo is closed (`gcTime: 0`); opening the photo again asks again.
 * It is a `POST` the server answers as a read (it changes nothing), which is why it is a query and not an act: a query is the one thing that is dropped with the screen that asked for it.
 */
export function usePhotoAuthorization(
  evidenceId: string,
  enabled: boolean,
): UseQueryResult<RetrievalAuthorizationView> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['pickup-work', 'photo-authorization', evidenceId],
    enabled,
    ...NOT_KEPT,
    queryFn: () => createRetrievalAuthorization(client, evidenceId),
  });
}
