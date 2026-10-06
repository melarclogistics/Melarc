export type Within<T> = { readonly expired: true } | { readonly expired: false; readonly value: T };

/**
 * Waits for a promise for at most `ms` and reports which came first. When the time is up the promise
 * is abandoned, not cancelled: it may settle later, and a later rejection is already handled here, so
 * it cannot surface as an unhandled rejection. The timer is always cleared, so a shutdown that
 * finishes in time leaves nothing behind to keep the process alive.
 *
 * An infinite budget waits for ever, without a timer.
 */
export async function withinBudget<T>(promise: Promise<T>, ms: number): Promise<Within<T>> {
  if (!Number.isFinite(ms)) return { expired: false, value: await promise };

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<Within<T>>((resolve) => {
    timer = setTimeout(
      () => {
        resolve({ expired: true });
      },
      Math.max(ms, 0),
    );
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ expired: false as const, value })),
      expiry,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
