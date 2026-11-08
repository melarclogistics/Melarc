/**
 * The engineering parameters of the notification lane (S1.12). Like those of the delivery path (`delivery-parameters.ts`) they are
 * development-qualified and not production-qualified, and none is a product value: the retry schedule is the document's
 * (BACKGROUND_JOBS_AND_EVENTS.md §3.2), the limits are the Product Owner's (settings), and what is here is how much one tick does and how
 * long it may take.
 */

/** The most units of each kind one tick of the lane does. A tick that is cut short by its batch does the rest at the next. */
export const NOTIFICATION_BATCH = Object.freeze({ envelopes: 20, sends: 10, receipts: 10 });

/**
 * What is kept back from a lease for recording the outcome of a send: a send starts only while the provider's whole time-out and this
 * are still left in the lease (the credential worker keeps the same back, `LEASE_MARGIN_MS`), so that the outcome is written while the
 * lease is still the lane's.
 */
export const SEND_RECORD_MARGIN_MS = 5_000;

/** How long the lane waits before it is first run: the periodic task of the worker starts at once, and this is its wait between runs. */
export const NOTIFICATION_LANE_INTERVAL_MS = 2_000;

/**
 * The longest one tick may take, as the worker's budget for the run: the claims, the relay's transactions and, for each message, the
 * provider's time-out and the transactions around it, with a margin. A budget that runs out mid-send would lose the outcome of a message
 * the provider took, so it is sized for the whole batch and not for the typical tick.
 */
export function notificationRunBudgetMs(providerTimeoutMs: number): number {
  const { envelopes, sends, receipts } = NOTIFICATION_BATCH;
  return 30_000 + envelopes * 5_000 + (sends + receipts) * (providerTimeoutMs + 5_000);
}
