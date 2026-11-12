import type { QueryClient } from '@tanstack/react-query';

import type { ActAnswer } from '../api/answer-observer';
import { changesAQueue } from './queue-changing-acts';

/** The one key of the summary: the menu and My work read the same query, so a page that asks while the menu is asking is given that read. */
export const QUEUE_SUMMARY_KEY = ['queue-summary'] as const;

/**
 * Reads the summary again **now**, if anything is asking for it (the menu is, for as long as someone is signed in), and nothing otherwise. A read
 * that is already under way is cancelled and started again: it began before whatever this follows, and an answer that began before an act is an
 * answer that may not have it. (`useRefreshQueueSummary` is the other way round, for a refresh the person asks for: it joins a read under way,
 * because nothing it follows can have changed.)
 *
 * The read under way is **cancelled first, and explicitly**: asked to refetch, TanStack Query joins a first read that has not answered yet (it has no
 * data to keep, so it is not restarted), and a person who acts in the second after the menu loaded would then be shown the counts of before their act.
 * A cancelled read goes back to what it was before it began (nothing, or the last counts), and the read that follows is a new one.
 */
export async function refreshQueueSummaryNow(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ queryKey: QUEUE_SUMMARY_KEY });
  await queryClient.refetchQueries({ queryKey: QUEUE_SUMMARY_KEY, type: 'active' });
}

/**
 * What the portal does when the API client tells it an act was done (`ApiClientProvider`, `onAct`): if the act can change what a queue holds
 * (`queue-changing-acts.ts`), the summary is read again at once, so that the menu's counts and My work never lag an act the person has just taken
 * (the Product Owner's decision D11(b), 6 November 2026). The one mechanism: no page calls it. A read that fails is not an error of the act, and the
 * counts are then drawn as a failed read draws them (none).
 */
export function queueSummaryObserver(queryClient: QueryClient): (answer: ActAnswer) => void {
  return ({ method, path }) => {
    if (changesAQueue(method, path)) void refreshQueueSummaryNow(queryClient);
  };
}
