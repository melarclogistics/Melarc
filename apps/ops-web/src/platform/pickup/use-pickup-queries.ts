import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApiClient, type ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import { problemOf } from '../problem/problem-copy';
import {
  parseAdHocSenders,
  parseAttributedReasons,
  parsePickupRequest,
  parsePickupRequestPage,
  parseVendorPickupLocations,
  type AdHocSenderView,
  type AttributedReason,
  type CutoffExceptionState,
  type ExceptionState,
  type PickupReasonDomain,
  type PickupRequestPageView,
  type PickupRequestView,
  type PickupState,
  type VendorPickupLocationView,
} from './pickup-shape';

/**
 * The reads of the pickup screens (S1.19), judged before they are believed (`pickup-shape.ts`). As the identity, vendor and rider screens'
 * reads, none is read again on focus or reconnect (every accepted request is activity), and nothing is kept once the screen lets go
 * (`gcTime: 0`), so the version an act takes is always the one just read. A failed read is retried by the person, not by the page.
 */
const NOT_KEPT = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  gcTime: 0,
} as const;

export interface PickupListParams {
  readonly state?: PickupState;
  /** A calendar date, `YYYY-MM-DD`. */
  readonly serviceDate?: string;
  /** Only the requests whose one-package exception is in this state: `REQUESTED` is the approver's queue. */
  readonly exceptionState?: ExceptionState;
  /**
   * Only the requests whose booking-cutoff decision is in this state: with `state: 'CONFIRMED'`, `PENDING_OPS_REVIEW` is the late bookings
   * waiting for Ops (task C1.1; the set the queue summary counts).
   */
  readonly cutoffExceptionState?: CutoffExceptionState;
  /**
   * `false` with `state: 'CONFIRMED'` is the manifest pool: the confirmed requests no manifest holds, less any whose booking cutoff is still to be
   * reviewed (the server's reading, S1.20). It is staff's alone; a page that sends it is a staff page.
   */
  readonly manifested?: boolean;
  readonly pageToken?: string;
  readonly enabled?: boolean;
}

/**
 * `listPickupRequests`: a page of the requests the session's grant reaches (`pickup.read`), scoped by the server, filtered by state, date and
 * the state of the one-package exception.
 */
export function usePickupRequests(params: PickupListParams): UseQueryResult<PickupRequestPageView> {
  const client = useApiClient();
  const {
    state,
    serviceDate,
    exceptionState,
    cutoffExceptionState,
    manifested,
    pageToken,
    enabled = true,
  } = params;
  return useQuery({
    queryKey: [
      'pickup-requests',
      'list',
      state ?? null,
      serviceDate ?? null,
      exceptionState ?? null,
      cutoffExceptionState ?? null,
      manifested ?? null,
      pageToken ?? null,
    ],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/pickup-requests', {
          params: {
            query: {
              ...(state === undefined ? {} : { state }),
              ...(serviceDate === undefined ? {} : { service_date: serviceDate }),
              ...(exceptionState === undefined
                ? {}
                : { one_package_exception_state: exceptionState }),
              ...(cutoffExceptionState === undefined
                ? {}
                : { cutoff_exception_state: cutoffExceptionState }),
              ...(manifested === undefined ? {} : { manifested }),
              ...(pageToken === undefined ? {} : { page_token: pageToken }),
            },
          },
        }),
      );
      const page = parsePickupRequestPage(answer.data);
      // Filtered by the state of the exception, every request carries an exception in that state: a page that does not is not this query's.
      // The same for the cut-off decision: every request of the page carries the state that was asked for.
      if (
        page === undefined ||
        (exceptionState !== undefined &&
          page.items.some((request) => request.one_package_exception?.state !== exceptionState)) ||
        (cutoffExceptionState !== undefined &&
          page.items.some((request) => request.cutoff_exception_state !== cutoffExceptionState))
      ) {
        throw unexpectedResponse(answer.status);
      }
      return page;
    },
  });
}

/** A request and the version the next act on it takes: the `ETag` of this read, exactly as the server sent it. */
export interface PickupRecord {
  readonly request: PickupRequestView;
  readonly etag: string;
}

/** `getPickupRequest`. A request with no version cannot be acted on, and another request than the one asked for is not the answer. */
export function usePickupRequest(id: string, enabled = true): UseQueryResult<PickupRecord> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['pickup-requests', 'request', id],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/pickup-requests/{id}', { params: { path: { id } } }),
      );
      const request = parsePickupRequest(answer.data);
      if (request?.id.toLowerCase() !== id.toLowerCase() || answer.etag === undefined) {
        throw unexpectedResponse(answer.status);
      }
      return { request, etag: answer.etag };
    },
  });
}

/** One link of an attempt chain: a request that was read, or one the session may not read (another hub's) or that is not there. */
export type AttemptLink =
  | { readonly kind: 'read'; readonly request: PickupRequestView }
  | { readonly kind: 'unreadable'; readonly id: string };

/**
 * The longest chain walked in one direction. A chain is as long as its attempts (three, and the force-extensions past them); a link beyond this
 * is a loop in an answer that is not the API's, and the walk stops rather than reading for ever.
 */
const MAX_LINKS = 50;

/** A request of the chain, or nothing when the session may not read it or it is not there. Any other failure is the read's own. */
async function readLink(client: ApiClient, id: string): Promise<PickupRequestView | undefined> {
  try {
    const answer = answerOf(
      await client.GET('/pickup-requests/{id}', { params: { path: { id } } }),
    );
    const request = parsePickupRequest(answer.data);
    if (request?.id.toLowerCase() !== id.toLowerCase()) throw unexpectedResponse(answer.status);
    return request;
  } catch (error) {
    // A link in a hub the session does not act in, or one that is not there, is told as such in its place; it does not fail the chain.
    // Anything else (no answer, a fault, the end of the session) is the read's failure, and the screen offers to read it again.
    const problem = problemOf(error);
    if (
      problem.kind === 'not-found' ||
      (problem.kind === 'forbidden' && problem.forbidden === 'outside-hubs')
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Walks one way along the chain from `start`, by the field that links each request to the next. */
async function walk(
  client: ApiClient,
  start: string | undefined,
  next: (request: PickupRequestView) => string | undefined,
  seen: Set<string>,
): Promise<AttemptLink[]> {
  const links: AttemptLink[] = [];
  let id = start;
  while (id !== undefined && links.length < MAX_LINKS && !seen.has(id.toLowerCase())) {
    seen.add(id.toLowerCase());
    // One link after another: each names the next, so they cannot be read side by side.
    const request = await readLink(client, id);
    if (request === undefined) {
      links.push({ kind: 'unreadable', id });
      break;
    }
    links.push({ kind: 'read', request });
    id = next(request);
  }
  return links;
}

/**
 * The attempt chain of a request (§21.6, §35.4.3): every request it replaced, oldest first, the request itself, and every request that replaced
 * it, each read by its own id. A reschedule is a new request linked to the one it replaced (`replaces_request_id`, `replacement_request_id`),
 * never an edit, so the chain is the history of the pickup. The record is the one the page read; the others are read once, here.
 */
export function useAttemptChain(record: PickupRequestView): UseQueryResult<readonly AttemptLink[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: [
      'pickup-requests',
      'chain',
      record.id,
      record.replaces_request_id ?? null,
      record.replacement_request_id ?? null,
    ] as const,
    ...NOT_KEPT,
    queryFn: async () => {
      const seen = new Set([record.id.toLowerCase()]);
      const earlier = await walk(
        client,
        record.replaces_request_id,
        (request) => request.replaces_request_id,
        seen,
      );
      const later = await walk(
        client,
        record.replacement_request_id,
        (request) => request.replacement_request_id,
        seen,
      );
      return [...earlier.reverse(), { kind: 'read', request: record } as const, ...later];
    },
  });
}

/**
 * `listVendorPickupLocations`: a vendor's saved locations, active and retired, the default first (`vendor.pickup_location.manage`). A booking
 * offers the active ones. Read only once a vendor is chosen.
 */
export function useVendorPickupLocations(
  vendorId: string | undefined,
  enabled: boolean,
): UseQueryResult<VendorPickupLocationView[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['pickup-requests', 'vendor-locations', vendorId ?? null],
    enabled: enabled && vendorId !== undefined,
    ...NOT_KEPT,
    queryFn: async () => {
      const id = vendorId ?? '';
      const answer = answerOf(
        await client.GET('/vendor-organizations/{id}/pickup-locations', {
          params: { path: { id } },
        }),
      );
      const locations = parseVendorPickupLocations(answer.data, id);
      if (locations === undefined) throw unexpectedResponse(answer.status);
      return locations;
    },
  });
}

/**
 * `findAdHocSender`: the returning walk-in sender with this phone, or none (`vendor.read`). An unknown phone is an empty answer and not an
 * error. Read only once a phone is asked for.
 */
export function useAdHocSenderLookup(phone: string | undefined): UseQueryResult<AdHocSenderView[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['pickup-requests', 'ad-hoc-sender', phone ?? null],
    enabled: phone !== undefined && phone !== '',
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/ad-hoc-senders', { params: { query: { phone: phone ?? '' } } }),
      );
      const senders = parseAdHocSenders(answer.data);
      if (senders === undefined) throw unexpectedResponse(answer.status);
      return senders;
    },
  });
}

/**
 * The active reasons of one pickup catalogue domain (`listReasonDefinitions` with `domain`; `settings.reason.read`), each with its attribution.
 * **The codes are the Product Owner's and may not be seeded yet** (domain-model.md section 3.9): an empty answer is an answer, and the screen
 * says that no reason is configured. No code is ever written here.
 */
export function usePickupReasons(
  domain: PickupReasonDomain,
  enabled = true,
): UseQueryResult<AttributedReason[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['reason-definitions', 'domain', domain],
    enabled,
    // The request is not tied to the query's abort signal: the answer is a few lines, and a dialog opened twice in quick succession should
    // share one request and not cancel and repeat it.
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/reason-definitions', { params: { query: { domain } } }),
      );
      const reasons = parseAttributedReasons(answer.data, domain);
      if (reasons === undefined) throw unexpectedResponse(answer.status);
      return reasons;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
