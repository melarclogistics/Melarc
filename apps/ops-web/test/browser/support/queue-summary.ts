import type { Route } from '@playwright/test';

/** The queue summary that every signed-in screen's shell reads for the menu's counts (`getQueueSummary`, task C1). */
export const SUMMARY_PATH = '/api/v1/ops/queue-summary';

/**
 * What a stand-in of the API answers to the shell's read of the summary when its test is about something else: **no queue at all**, the
 * answer for a session the server gave none (a stand-in that has a world to count from passes the queues its server would count). The menu then draws no count and the landing says nothing of waiting, so a test of a page is not
 * disturbed by the shell's own read, and the read is not one of the requests the test counts. A test of the counts replaces this: a route
 * registered later answers first.
 *
 * Returns whether the request was the summary (and has been answered), so the caller can stop.
 */
export async function answerQueueSummary(
  route: Route,
  queues: readonly Record<string, unknown>[] = [],
): Promise<boolean> {
  const request = route.request();
  if (request.method() !== 'GET' || new URL(request.url()).pathname !== SUMMARY_PATH) return false;
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    json: { queues },
  });
  return true;
}
