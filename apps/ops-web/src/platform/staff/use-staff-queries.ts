import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseAssignableBundles,
  parseSessionRecords,
  parseStaffIdentity,
  parseTrustedBrowsers,
  parseStaffIdentityPage,
  type AssignableBundleView,
  type PrincipalType,
  type SessionRecordView,
  type StaffIdentityPageView,
  type StaffIdentityView,
  type StaffStatus,
  type TrustedBrowserView,
} from './staff-shape';

/**
 * The reads of the identity screens. Each one is judged before it is believed (`staff-shape.ts`), and an answer that is not what the
 * contract describes fails as `unexpected-response`, like any answer the API did not give.
 *
 * None of them is read again when the window is focused or the connection returns: every request the API accepts counts as activity, so a
 * page that polled would keep a session alive that its owner had walked away from. And the people, the profiles and the sessions are not
 * kept once the screen lets go of them (`gcTime: 0`): a page opened again starts from nothing, so the version it acts on (`If-Match`) is
 * always the one just read, never one from the cache.
 */
const READ_ONCE = {
  // A failed read is tried again by the person (the screen offers it), not by the page: the answer is a few lines and a silent retry only delays the words.
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

const NOT_KEPT = { ...READ_ONCE, gcTime: 0 } as const;

export interface StaffListParams {
  readonly status?: StaffStatus;
  /** Matches name or work email. Blank is no search. */
  readonly q?: string;
  /** The token of the page asked for; none is the first page. */
  readonly pageToken?: string;
  readonly enabled?: boolean;
}

/** `listStaffIdentities`: a page of the people the session may see, scoped to its hubs by the server. */
export function useStaffList(params: StaffListParams): UseQueryResult<StaffIdentityPageView> {
  const client = useApiClient();
  const { status, q, pageToken, enabled = true } = params;
  const search = q?.trim() ?? '';
  return useQuery({
    queryKey: ['staff', 'list', status ?? null, search, pageToken ?? null],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/staff-identities', {
          params: {
            query: {
              ...(status === undefined ? {} : { status }),
              ...(search === '' ? {} : { q: search }),
              ...(pageToken === undefined ? {} : { page_token: pageToken }),
            },
          },
        }),
      );
      const page = parseStaffIdentityPage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

/** A profile and the version the next act on it takes: the `ETag` of this read, exactly as the server sent it. */
export interface StaffRecord {
  readonly identity: StaffIdentityView;
  readonly etag: string;
}

/**
 * `getStaffIdentity`. A profile with no version cannot be acted on, and the profile of another person than the one asked for is not
 * the answer; both are answers that are not the API's.
 */
export function useStaffIdentity(id: string, enabled = true): UseQueryResult<StaffRecord> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['staff', 'identity', id],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/staff-identities/{id}', { params: { path: { id } } }),
      );
      const identity = parseStaffIdentity(answer.data);
      const isTheOneAskedFor = identity?.id.toLowerCase() === id.toLowerCase();
      if (identity === undefined || !isTheOneAskedFor || answer.etag === undefined) {
        throw unexpectedResponse(answer.status);
      }
      return { identity, etag: answer.etag };
    },
  });
}

/**
 * `listAssignableStaffRoleBundles`: the roles a maker may name, and the names the screens give a role. It needs its own key
 * (`permission.assignable_bundle.read`), so a screen turns it on only for a session that holds it.
 */
export function useAssignableBundles(enabled = true): UseQueryResult<AssignableBundleView[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['staff', 'assignable-bundles'],
    enabled,
    ...READ_ONCE,
    queryFn: async () => {
      const answer = answerOf(await client.GET('/staff-role-bundles/assignable'));
      const bundles = parseAssignableBundles(answer.data);
      if (bundles === undefined) throw unexpectedResponse(answer.status);
      return bundles;
    },
  });
}

/** `listSessions`: the live sessions of one principal, newest first. The server decides whether the session may see them. */
export function useSessionRecords(
  principalType: PrincipalType,
  principalId: string,
  enabled = true,
): UseQueryResult<SessionRecordView[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['sessions', principalType, principalId],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/auth/sessions', {
          params: { query: { principal_type: principalType, principal_id: principalId } },
        }),
      );
      const sessions = parseSessionRecords(answer.data);
      if (sessions === undefined) throw unexpectedResponse(answer.status);
      return sessions;
    },
  });
}

/** `listTrustedBrowsers`: the signed-in person's own valid trusted browsers, newest first. The browser asking is marked `current`. */
export function useOwnTrustedBrowsers(enabled = true): UseQueryResult<TrustedBrowserView[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['trusted-browsers', 'own'],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(await client.GET('/auth/staff/trusted-browsers'));
      const browsers = parseTrustedBrowsers(answer.data);
      if (browsers === undefined) throw unexpectedResponse(answer.status);
      return browsers;
    },
  });
}

/** `listStaffTrustedBrowsers`: one person's valid trusted browsers, for a Platform Admin. None of them is ever `current`. */
export function useStaffTrustedBrowsers(
  id: string,
  enabled = true,
): UseQueryResult<TrustedBrowserView[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['trusted-browsers', 'staff', id],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/ops/staff/{id}/trusted-browsers', { params: { path: { id } } }),
      );
      const browsers = parseTrustedBrowsers(answer.data);
      if (browsers === undefined || browsers.some((browser) => browser.current)) {
        throw unexpectedResponse(answer.status);
      }
      return browsers;
    },
  });
}
