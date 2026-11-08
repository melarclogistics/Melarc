import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseVendorAccountDetail,
  parseVendorAccountPage,
  type VendorAccountDetailView,
  type VendorAccountPageView,
  type VendorAccountStatus,
} from './vendor-shape';

/**
 * The reads of the vendor screens (S0.52b), judged before they are believed (`vendor-shape.ts`). As the identity screens' reads, none is read
 * again on focus or reconnect (every accepted request is activity), and nothing is kept once the screen lets go (`gcTime: 0`), so the version
 * an act takes is always the one just read.
 */
const NOT_KEPT = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  gcTime: 0,
} as const;

export interface VendorListParams {
  readonly status?: VendorAccountStatus;
  /** Matches the organisation name or the account identifier. Blank is no search. */
  readonly q?: string;
  readonly pageToken?: string;
  readonly enabled?: boolean;
}

/** `listVendorAccounts`: a page of the accounts the session's grant reaches, scoped by the server through each organisation's hub. */
export function useVendorAccounts(params: VendorListParams): UseQueryResult<VendorAccountPageView> {
  const client = useApiClient();
  const { status, q, pageToken, enabled = true } = params;
  const search = q?.trim() ?? '';
  return useQuery({
    queryKey: ['vendors', 'list', status ?? null, search, pageToken ?? null],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/ops/vendors', {
          params: {
            query: {
              ...(status === undefined ? {} : { status }),
              ...(search === '' ? {} : { q: search }),
              ...(pageToken === undefined ? {} : { page_token: pageToken }),
            },
          },
        }),
      );
      const page = parseVendorAccountPage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

/** An account, its browsers and the version the next act on it takes: the `ETag` of this read, exactly as the server sent it. */
export interface VendorRecord extends VendorAccountDetailView {
  readonly etag: string;
}

/** `getVendorAccount`. An account with no version cannot be acted on, and another account than the one asked for is not the answer. */
export function useVendorAccount(id: string, enabled = true): UseQueryResult<VendorRecord> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['vendors', 'account', id],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(await client.GET('/ops/vendors/{id}', { params: { path: { id } } }));
      const detail = parseVendorAccountDetail(answer.data);
      const isTheOneAskedFor = detail?.account.id.toLowerCase() === id.toLowerCase();
      if (detail === undefined || !isTheOneAskedFor || answer.etag === undefined) {
        throw unexpectedResponse(answer.status);
      }
      return { ...detail, etag: answer.etag };
    },
  });
}
