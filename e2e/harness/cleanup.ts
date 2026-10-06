const messageOf = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

/**
 * Runs the cleanup of a step that failed, and then fails with the failure. The failure that came first is the
 * one a person needs, so it is rethrown as it was when the cleanup works. A cleanup that fails too (a process
 * that could not be ended is the case) is not swallowed: both are reported, with the first as the cause,
 * because what a failed cleanup leaves running is what the next run trips over.
 */
export async function failWithCleanup(
  original: unknown,
  cleanup: () => Promise<unknown>,
): Promise<never> {
  let cleanupFailure: { readonly reason: unknown } | undefined;
  try {
    await cleanup();
  } catch (reason) {
    cleanupFailure = { reason };
  }
  if (cleanupFailure !== undefined) {
    throw new Error(
      `${messageOf(original)}\nAnd cleaning up after it failed too: ${messageOf(cleanupFailure.reason)}`,
      { cause: original },
    );
  }
  throw original instanceof Error ? original : new Error(messageOf(original));
}
