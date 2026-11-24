import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApiClient, type ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import type { WorkListPageView } from '../pickup-work/pickup-work-shape';
import {
  parseClosedExceptionPage,
  parseClosure,
  parseCorrection,
  parseCorrectionPage,
  parseOrder,
  parseSummary,
  parseWorklist,
  type ClosedExceptionView,
  type ClosureView,
  type CorrectionView,
  type OrderView,
  type SummaryView,
  type WorkItemView,
  type WorkOrderView,
  type WorklistPageView,
  type WorklistViewId,
} from './orders-shape';
import { parseIntakeListPage, type ItemizableIntakeView } from './intake-list-shape';

/**
 * The reads of the order screens (S1.40), judged before they are believed (`orders-shape.ts`). As the other screens' reads, none is read again on focus or reconnect (every accepted request is
 * activity), and nothing is kept once the screen lets go (`gcTime: 0`), so the version an act takes is always the one just read. A failed read is retried by the person, not by the page. **No read is polled**:
 * the lists are read again after an act, on *Refresh* and when the person asks.
 */
const NOT_KEPT = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  gcTime: 0,
} as const;

export interface WorklistParams {
  /** The server's filter. The page filters nothing in the browser. */
  readonly view?: WorklistViewId;
  readonly pageToken?: string;
  readonly pageSize?: number;
  readonly enabled?: boolean;
}

export const worklistKey = (intakeId: string) =>
  ['hub-orders', 'worklist', intakeId.toLowerCase()] as const;

/** `listIntakeOrders` (`hub.read`): the parcel worklist of one vendor with the counts of the whole intake, never of a page. A row carries no price, portion or phone number: `hub.read` does not open the money. */
export function useWorklist(
  intakeId: string,
  params: WorklistParams = {},
): UseQueryResult<WorklistPageView> {
  const client = useApiClient();
  return useQuery({
    queryKey: [
      ...worklistKey(intakeId),
      params.view ?? null,
      params.pageToken ?? null,
      params.pageSize ?? null,
    ] as const,
    enabled: params.enabled ?? true,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/hub-intakes/{id}/orders', {
          params: {
            path: { id: intakeId },
            query: {
              ...(params.view === undefined ? {} : { view: params.view }),
              ...(params.pageToken === undefined ? {} : { page_token: params.pageToken }),
              ...(params.pageSize === undefined ? {} : { page_size: params.pageSize }),
            },
          },
        }),
      );
      const page = parseWorklist(answer.data);
      if (page?.intake_id.toLowerCase() !== intakeId.toLowerCase()) {
        throw unexpectedResponse(answer.status);
      }
      return page;
    },
  });
}

/** The most pages of a vendor's orders read to find the last of them: the list is paged and oldest first, so the last of it is the end of the pages. A vendor with more is told nothing rather than a list that is not the last. */
const MOST_PAGES = 10;

/**
 * The last orders of a vendor counted without photos (`listIntakeOrders`, view `all`, `hub.read`; D-S7-3): the officer who has just written a code on a parcel sees the orders made before it, to check the codes of
 * the parcels on the table against them. The server lists oldest first and gives no way to ask for the end, so the pages are read to the end (a hundred orders to a page) and the last `count` of them are kept.
 */
export function useLastOrders(
  intakeId: string,
  count: number,
  enabled = true,
): UseQueryResult<readonly WorkOrderView[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: [...worklistKey(intakeId), 'last', count] as const,
    enabled,
    ...NOT_KEPT,
    queryFn: async (): Promise<readonly WorkOrderView[]> => {
      let token: string | undefined;
      let last: readonly WorkOrderView[] = [];
      for (let page = 0; page < MOST_PAGES; page += 1) {
        const answer = answerOf(
          await client.GET('/hub-intakes/{id}/orders', {
            params: {
              path: { id: intakeId },
              query: {
                view: 'all',
                page_size: 100,
                ...(token === undefined ? {} : { page_token: token }),
              },
            },
          }),
        );
        const parsed = parseWorklist(answer.data);
        if (parsed?.intake_id.toLowerCase() !== intakeId.toLowerCase()) {
          throw unexpectedResponse(answer.status);
        }
        last = [
          ...last,
          ...parsed.items.flatMap((item) => (item.order === null ? [] : [item.order])),
        ].slice(-count);
        if (parsed.nextPageToken === null) return last;
        token = parsed.nextPageToken;
      }
      throw unexpectedResponse(200);
    },
  });
}

/** One page of a vendor's worklist, judged: the one read the lists below are made of. */
async function readWorklistPage(
  client: ApiClient,
  intakeId: string,
  view: WorklistViewId,
  token: string | undefined,
): Promise<WorklistPageView> {
  const answer = answerOf(
    await client.GET('/hub-intakes/{id}/orders', {
      params: {
        path: { id: intakeId },
        query: { view, page_size: 100, ...(token === undefined ? {} : { page_token: token }) },
      },
    }),
  );
  const parsed = parseWorklist(answer.data);
  if (parsed?.intake_id.toLowerCase() !== intakeId.toLowerCase()) {
    throw unexpectedResponse(answer.status);
  }
  return parsed;
}

/**
 * The row of one parcel of a vendor (`listIntakeOrders`, view `all`, `hub.read`): where it stands, the order made for it if there is one (so that the form of a parcel that already has its order says so, with
 * its code, and is never an empty form) and whether the officer is waiting on the vendor's details for it (D-S7-12). The server lists the parcels by their place and gives no way to ask for one, so the pages are read
 * until the place of the parcel is passed (a hundred to a page). `null` is a parcel the list does not hold.
 */
export function useParcelRow(
  intakeId: string,
  parcel: { readonly id: string; readonly ordinal: number },
  enabled = true,
): UseQueryResult<WorkItemView | null> {
  const client = useApiClient();
  return useQuery({
    queryKey: [...worklistKey(intakeId), 'parcel', parcel.id.toLowerCase()] as const,
    enabled,
    ...NOT_KEPT,
    queryFn: async (): Promise<WorkItemView | null> => {
      let token: string | undefined;
      for (let page = 0; page < MOST_PAGES; page += 1) {
        const read = await readWorklistPage(client, intakeId, 'all', token);
        for (const item of read.items) {
          if (item.parcel?.id.toLowerCase() === parcel.id.toLowerCase()) return item;
          // The list is in the order of the parcels: once their place is passed the parcel is not in it.
          if (item.parcel !== null && item.parcel.ordinal > parcel.ordinal) return null;
        }
        if (read.nextPageToken === null) return null;
        token = read.nextPageToken;
      }
      throw unexpectedResponse(200);
    },
  });
}

/** What the next order is for: the parcel to make it for, or that every parcel that is left is waited on, or that none is left. */
export type NextToOrder =
  | { readonly kind: 'parcel'; readonly parcelId: string }
  | { readonly kind: 'all-waiting' }
  | { readonly kind: 'none' };

/**
 * The next parcel that needs an order (`listIntakeOrders`, view `needs_order`, `hub.read`), **moving forward from the parcel just saved or marked** and passing over a parcel the officer is waiting on the vendor's
 * details for (D-S7-12). With no `after` it is the lowest parcel that needs an order and is not waited on; with one it is the first after that place, and when none is left after it, the lowest again. Nothing
 * of this is worked out from a count: the rows are the server's.
 *
 * **While the vendor's check-in is open** (`view` is `awaiting_arrival`, D-D6) the parcels to order are the ones that are not here yet, from their photos: the same walk over the view of the parcels that are
 * not here yet, **passing over the ones that already have an order** (that view lists every parcel that is not here, with an order or without one, and its rows say which).
 */
export function useNextToOrder(
  intakeId: string,
  after: number | undefined,
  enabled = true,
  view: 'needs_order' | 'awaiting_arrival' = 'needs_order',
): UseQueryResult<NextToOrder> {
  const client = useApiClient();
  return useQuery({
    queryKey: [...worklistKey(intakeId), 'next', view, after ?? null] as const,
    enabled,
    ...NOT_KEPT,
    queryFn: async (): Promise<NextToOrder> => {
      let token: string | undefined;
      let lowest: string | undefined;
      let seen = false;
      for (let page = 0; page < MOST_PAGES; page += 1) {
        const read = await readWorklistPage(client, intakeId, view, token);
        for (const item of read.items) {
          if (item.parcel === null) continue;
          // A parcel that is not here yet and has its order is not one to make an order for.
          if (view === 'awaiting_arrival' && item.order !== null) continue;
          seen = true;
          if (item.parcel.waiting_for_vendor !== null) continue;
          lowest ??= item.parcel.id;
          if (after === undefined || item.parcel.ordinal > after) {
            return { kind: 'parcel', parcelId: item.parcel.id };
          }
        }
        if (read.nextPageToken === null) break;
        token = read.nextPageToken;
        if (page === MOST_PAGES - 1) throw unexpectedResponse(200);
      }
      if (lowest !== undefined) return { kind: 'parcel', parcelId: lowest };
      return seen ? { kind: 'all-waiting' } : { kind: 'none' };
    },
  });
}

/** An order with the version every act on it takes (the `ETag` of `getOrder`, exactly as sent). */
export interface OrderRecordView {
  readonly order: OrderView;
  readonly etag: string;
}

export const orderKey = (orderId: string) =>
  ['hub-orders', 'order', orderId.toLowerCase()] as const;

/** `getOrder` (`pricing.read`): the order as the staff of its hub read it, in one snapshot with its history and its version. */
export function useOrder(orderId: string, enabled = true): UseQueryResult<OrderRecordView> {
  const client = useApiClient();
  return useQuery({
    queryKey: orderKey(orderId),
    enabled,
    ...NOT_KEPT,
    queryFn: async (): Promise<OrderRecordView> => {
      const answer = answerOf(
        await client.GET('/orders/{id}', { params: { path: { id: orderId } } }),
      );
      const order = parseOrder(answer.data);
      if (order?.id.toLowerCase() !== orderId.toLowerCase() || answer.etag === undefined) {
        throw unexpectedResponse(answer.status);
      }
      return { order, etag: answer.etag };
    },
  });
}

export const closureKey = (intakeId: string) =>
  ['hub-orders', 'closure', intakeId.toLowerCase()] as const;

/** `getIntakeClosure` (`hub.intake.close`): what closing the vendor would find, with the digest the exception is closed against. */
export function useClosure(intakeId: string, enabled = true): UseQueryResult<ClosureView> {
  const client = useApiClient();
  return useQuery({
    queryKey: closureKey(intakeId),
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/hub-intakes/{id}/closure', { params: { path: { id: intakeId } } }),
      );
      const closure = parseClosure(answer.data);
      if (closure?.intake_id.toLowerCase() !== intakeId.toLowerCase()) {
        throw unexpectedResponse(answer.status);
      }
      return closure;
    },
  });
}

/** `getIntakeSummary` (`pickup.read`): the orders of a closed vendor. A price is in it only where the reader's own pricing grant reaches the hub. */
export function useSummary(intakeId: string, enabled = true): UseQueryResult<SummaryView> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['hub-orders', 'summary', intakeId.toLowerCase()] as const,
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/hub-intakes/{id}/summary', { params: { path: { id: intakeId } } }),
      );
      const summary = parseSummary(answer.data);
      if (summary?.intake_id.toLowerCase() !== intakeId.toLowerCase()) {
        throw unexpectedResponse(answer.status);
      }
      return summary;
    },
  });
}

export interface PagedParams {
  readonly pageToken?: string;
  readonly enabled?: boolean;
}

/** `listClosedIntakeExceptions` (`hub.intake.close_exception`): the closes that left received parcels without an order, newest close first, so that the work is found again on the next shift. */
export function useClosedExceptions(
  params: PagedParams,
): UseQueryResult<WorkListPageView<ClosedExceptionView>> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['hub-orders', 'closed-exceptions', params.pageToken ?? null] as const,
    enabled: params.enabled ?? true,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/hub-intake-exceptions', {
          params: {
            query: params.pageToken === undefined ? {} : { page_token: params.pageToken },
          },
        }),
      );
      const page = parseClosedExceptionPage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

export interface CorrectionsParams extends PagedParams {
  /** The server's filter: what waits (the default), what was approved or rejected, or every correction. */
  readonly state?: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'all';
}

/** `listPayerCorrections` (`pricing.correction.create`): the payer corrections of the hubs of the grant, in the state asked for. */
export function usePayerCorrections(
  params: CorrectionsParams,
): UseQueryResult<WorkListPageView<CorrectionView>> {
  const client = useApiClient();
  return useQuery({
    queryKey: [
      'hub-orders',
      'corrections',
      params.state ?? null,
      params.pageToken ?? null,
    ] as const,
    enabled: params.enabled ?? true,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/payer-corrections', {
          params: {
            query: {
              ...(params.state === undefined ? {} : { state: params.state }),
              ...(params.pageToken === undefined ? {} : { page_token: params.pageToken }),
            },
          },
        }),
      );
      const page = parseCorrectionPage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

/** A correction with the version the decision takes. */
export interface CorrectionRecordView {
  readonly correction: CorrectionView;
  readonly etag: string;
}

/** `getPayerCorrection` (`pricing.correction.create`): one correction with its version, so that a checker can open it after a reload or on another device. */
export function usePayerCorrection(
  correctionId: string,
  enabled = true,
): UseQueryResult<CorrectionRecordView> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['hub-orders', 'correction', correctionId.toLowerCase()] as const,
    enabled,
    ...NOT_KEPT,
    queryFn: async (): Promise<CorrectionRecordView> => {
      const answer = answerOf(
        await client.GET('/payer-corrections/{id}', { params: { path: { id: correctionId } } }),
      );
      const correction = parseCorrection(answer.data);
      if (
        correction?.id.toLowerCase() !== correctionId.toLowerCase() ||
        answer.etag === undefined
      ) {
        throw unexpectedResponse(answer.status);
      }
      return { correction, etag: answer.etag };
    },
  });
}

export interface ItemizableParams extends PagedParams {
  /**
   * The vendors that are ready for their orders, or the ones being worked: the server's `state` filter. **`AWAITING_COUNT` is the vendors whose check-in is open** (D-D6): the ones an officer begins early orders for
   * from their photos; a vendor counted without photos that waits for its count is in that answer too, and the list leaves it out.
   */
  readonly state?: 'READY_FOR_ITEMIZATION' | 'ITEMIZING' | 'AWAITING_COUNT';
  /** The vendors that wait for a senior officer: the server's `view` (D-S7-7). Asked instead of a state, never beside one. */
  readonly view?: 'needs_senior';
}

/** `listHubIntakes` (`hub.read`): the vendors a hub has cleared for orders (or is making them for), oldest handover first, so that an officer finds the work without remembering which vendors finished. */
export function useItemizableIntakes(
  params: ItemizableParams,
): UseQueryResult<WorkListPageView<ItemizableIntakeView>> {
  const client = useApiClient();
  return useQuery({
    queryKey: [
      'hub-orders',
      'itemizable',
      params.view ?? params.state ?? null,
      params.pageToken ?? null,
    ] as const,
    enabled: params.enabled ?? true,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/hub-intakes', {
          params: {
            query: {
              ...(params.state === undefined ? {} : { state: params.state }),
              ...(params.view === undefined ? {} : { view: params.view }),
              ...(params.pageToken === undefined ? {} : { page_token: params.pageToken }),
            },
          },
        }),
      );
      const page = parseIntakeListPage(answer.data, {
        checkingIn: params.state === 'AWAITING_COUNT',
      });
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}
