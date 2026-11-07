import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApiClient, type ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import { calendarDateOf, parsePickupRequest, type PickupRequestView } from '../pickup/pickup-shape';
import { problemOf } from '../problem/problem-copy';
import {
  manifestRecordOf,
  type HandoverRecord,
  type ManifestRecord,
  type StopRecord,
} from './manifest-commands';
import {
  MANIFEST_FILTER_STATES,
  parseHandover,
  parseHandoverPage,
  parseManifestPage,
  parseStop,
  type ManifestFilterState,
  type ManifestPageView,
  type StopView,
} from './manifest-shape';

/**
 * The reads of the manifest screens (S1.25), judged before they are believed (`manifest-shape.ts`). As the pickup, rider and identity screens'
 * reads, none is read again on focus or reconnect (every accepted request is activity), and nothing is kept once the screen lets go
 * (`gcTime: 0`), so the version an act takes is always the one just read. A failed read is retried by the person, not by the page.
 */
const NOT_KEPT = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  gcTime: 0,
} as const;

export interface ManifestListParams {
  /** Only the manifests in this state: one of the contract's five, exactly. Left out for every state, and never sent empty. */
  readonly state?: ManifestFilterState;
  /** Only the manifests worked on this day: `YYYY-MM-DD`, a day that exists. Left out for every day, and never sent empty. */
  readonly serviceDate?: string;
  /**
   * Only the manifests of this hub (task C3; the hub chosen in the switcher, `useActiveHub`): a filter that narrows and never widens what the grant
   * reaches. Left out for *All hubs*.
   */
  readonly hubId?: string;
  readonly pageToken?: string;
  readonly enabled?: boolean;
}

/**
 * `listPickupManifests`: a page of the manifests of the session's hubs (`pickup.read`), oldest first, as the server orders them, narrowed by
 * the filters the operation has (OB-S1-25, and task C3 for the hub): `state`, `service_date` and `hub_id`, each exact and combined as "and".
 * **The server filters, and the page filters nothing**: a part of a page filtered in the browser would pass for the whole. A filter is a
 * parameter of the request or it is not there: this is the one place a request is made, so a value the contract would refuse (a state that is
 * not one of the five, a day that does not exist, an empty text) is left out here whoever asked, and no parameter is ever sent twice. A page
 * token belongs to the filters it was made with, so the query is keyed by all four and a changed filter is another query with no token.
 */
export function useManifests(params: ManifestListParams): UseQueryResult<ManifestPageView> {
  const client = useApiClient();
  const { hubId, pageToken, enabled = true } = params;
  const state = MANIFEST_FILTER_STATES.find((each) => each === params.state);
  const serviceDate = calendarDateOf(params.serviceDate);
  return useQuery({
    queryKey: [
      'manifests',
      'list',
      state ?? null,
      serviceDate ?? null,
      hubId ?? null,
      pageToken ?? null,
    ],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/pickup-manifests', {
          params: {
            query: {
              ...(state === undefined ? {} : { state }),
              ...(serviceDate === undefined ? {} : { service_date: serviceDate }),
              ...(hubId === undefined ? {} : { hub_id: hubId }),
              ...(pageToken === undefined ? {} : { page_token: pageToken }),
            },
          },
        }),
      );
      const page = parseManifestPage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

/** `getPickupManifest`: the run with its stops in order and the version the next act takes. */
export function useManifest(id: string, enabled = true): UseQueryResult<ManifestRecord> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['manifests', 'manifest', id],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/pickup-manifests/{id}', { params: { path: { id } } }),
      );
      return manifestRecordOf(answer.data, answer.etag, answer.status, id);
    },
  });
}

/** `getPickupStop`: one stop and the version a skip takes. A stop with no version cannot be acted on, and another stop is not the answer. */
export function useStop(id: string, enabled = true): UseQueryResult<StopRecord> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['manifests', 'stop', id],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(await client.GET('/pickup-stops/{id}', { params: { path: { id } } }));
      const stop = parseStop(answer.data);
      if (stop?.id.toLowerCase() !== id.toLowerCase() || answer.etag === undefined) {
        throw unexpectedResponse(answer.status);
      }
      return { stop, etag: answer.etag };
    },
  });
}

/**
 * The run's pending custody handover, or `null` when it has none (`listRunCustodyHandovers` narrowed to the run and to `PENDING`, then
 * `getRunCustodyHandover` for the version its acts take; `fleet.custody.read`). **One run has at most one open handover** (the contract), so a
 * list that names two, or one of another run or another state, is not the answer to this question.
 */
export function usePendingHandover(
  manifestId: string,
  enabled: boolean,
): UseQueryResult<HandoverRecord | null> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['manifests', 'handover', manifestId],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const listed = answerOf(
        await client.GET('/run-custody-handovers', {
          params: { query: { manifest_id: manifestId, state: 'PENDING' } },
        }),
      );
      const page = parseHandoverPage(listed.data);
      if (
        page === undefined ||
        page.items.length > 1 ||
        page.items.some(
          (item) =>
            item.state !== 'PENDING' || item.manifest_id.toLowerCase() !== manifestId.toLowerCase(),
        )
      ) {
        throw unexpectedResponse(listed.status);
      }
      const [first] = page.items;
      if (first === undefined) return null;
      const read = answerOf(
        await client.GET('/run-custody-handovers/{id}', { params: { path: { id: first.id } } }),
      );
      const handover = parseHandover(read.data);
      if (
        handover?.id.toLowerCase() !== first.id.toLowerCase() ||
        handover.manifest_id.toLowerCase() !== manifestId.toLowerCase() ||
        read.etag === undefined
      ) {
        throw unexpectedResponse(read.status);
      }
      return { handover, etag: read.etag };
    },
  });
}

/** How many requests are read at once to name the stops of a draft: enough to be quick, few enough not to flood the server. */
const READ_AT_ONCE = 6;

/** A request of a stop, or `null` when the session may not read it (another hub's) or it is not there. Any other failure is the read's own. */
async function readRequest(client: ApiClient, id: string): Promise<PickupRequestView | null> {
  try {
    const answer = answerOf(
      await client.GET('/pickup-requests/{id}', { params: { path: { id } } }),
    );
    const request = parsePickupRequest(answer.data);
    if (request?.id.toLowerCase() !== id.toLowerCase()) throw unexpectedResponse(answer.status);
    return request;
  } catch (error) {
    const problem = problemOf(error);
    if (
      problem.kind === 'not-found' ||
      (problem.kind === 'forbidden' && problem.forbidden === 'outside-hubs')
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * The requests behind the stops that do not name their own pickup. A stop names its pickup (reference, sender, place) only once the manifest is
 * dispatched (`pickup_summary`, made at dispatch for the stops still to be worked); a draft's stops carry the request's identifier and nothing
 * else, so an officer ordering them could not tell one from another. Those requests are read by their own operation (`getPickupRequest`,
 * `pickup.read`), a few at a time, once. A request the session cannot read is `null` and is told as such; a failure of the read itself is the
 * read's and is offered again.
 */
export function useStopRequests(
  stops: readonly StopView[],
): UseQueryResult<ReadonlyMap<string, PickupRequestView | null>> {
  const client = useApiClient();
  const wanted = stops
    .filter((stop) => stop.pickup_summary === undefined)
    .map((stop) => stop.pickup_request_id);
  return useQuery({
    queryKey: ['manifests', 'stop-requests', wanted.join(',')],
    enabled: wanted.length > 0,
    ...NOT_KEPT,
    queryFn: async () => {
      const found = new Map<string, PickupRequestView | null>();
      for (let start = 0; start < wanted.length; start += READ_AT_ONCE) {
        const batch = wanted.slice(start, start + READ_AT_ONCE);
        const read = await Promise.all(batch.map((id) => readRequest(client, id)));
        batch.forEach((id, index) => {
          found.set(id.toLowerCase(), read[index] ?? null);
        });
      }
      return found;
    },
  });
}
