import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { useApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import { parseQueueSummary, type QueueSummaryView } from './queue-summary-shape';

/** The one key of the summary: the menu and the landing read the same query, so a page that asks while the menu is asking is given that read. */
export const QUEUE_SUMMARY_KEY = ['queue-summary'] as const;

/**
 * `getQueueSummary`: how much work is waiting in each queue the session may read (task C1; reporting-data-dictionary.md section 5.5). The
 * menu draws a count beside the entry of a queue from it and the landing lists the queues from it. The server decides which queues the
 * session is given and what each count is; this reads, judges (`queue-summary-shape.ts`) and hands the answer on.
 *
 * **When it is read** (`AC-QSUM-09`): when the signed-in shell loads (the menu asks, and stays asking for as long as the person is signed
 * in), when a page is returned to (`useRefreshQueueSummaryOnReturn`, which the shell calls on a change of page), when a page that shows it
 * opens (a new asker of a stale read starts one), and when the person asks for a refresh of a queue (`useRefreshQueueSummary`, which the
 * queue's refresh calls beside its own read). **Never on a timer, and never when the window is focused or the connection returns**: the
 * read is `background` for the session's idle lifetime (it does not count as the person acting), and a page that polled would only
 * show an unattended session how busy the queue is.
 *
 * A read that failed is not tried again by the page (the menu draws no count and works as it does; the landing says so and offers
 * *Try again*), and an answer that is not what the contract describes fails as `unexpected-response`, like any other. What is read is
 * dropped when nothing asks for it any more (`gcTime: 0`), and the end of a session empties the cache like any other (`endSession`), so
 * one person's counts are never the next person's.
 */
export function useQueueSummary(enabled = true): UseQueryResult<QueueSummaryView> {
  const client = useApiClient();
  return useQuery({
    queryKey: QUEUE_SUMMARY_KEY,
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    queryFn: async () => {
      const answer = answerOf(await client.GET('/ops/queue-summary'));
      const summary = parseQueueSummary(answer.data);
      if (summary === undefined) throw unexpectedResponse(answer.status);
      return summary;
    },
  });
}

/**
 * Reads the summary again if anything is asking for it, and joins a read already under way instead of starting a second (`cancelRefetch:
 * false`: the default would cancel the first and send another). Nothing is read when nothing is on a screen that needs it.
 */
export function useRefreshQueueSummary(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await queryClient.refetchQueries(
      { queryKey: QUEUE_SUMMARY_KEY, type: 'active' },
      { cancelRefetch: false },
    );
  }, [queryClient]);
}

/**
 * Reads the summary again when the person goes to another page (`AC-QSUM-09`): the counts beside the menu are those of the moment the page
 * was opened, which is what a person returning to a queue expects to find. The first page is read by the menu's own mounting, so the
 * address a person starts at causes no second read; a change of the query string alone (a filter on the page they are on) is not a return
 * to a page. Called once, by the shell.
 */
export function useRefreshQueueSummaryOnReturn(pathname: string): void {
  const refresh = useRefreshQueueSummary();
  const at = useRef(pathname);
  useEffect(() => {
    if (at.current === pathname) return;
    at.current = pathname;
    void refresh();
  }, [pathname, refresh]);
}
