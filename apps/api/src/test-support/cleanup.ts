/**
 * Closing what a test kit opened. A kit opens several things in turn (an application, connections), and any of them can fail to
 * open or to close. The rules, so that a failure part-way leaks nothing and loses nothing:
 *
 * - whatever was opened is closed, last opened first;
 * - every close is attempted, whatever an earlier one did (a close that fails does not leave the ones after it open);
 * - the failures are kept: one failure is reported as itself (its class and message intact), several as an `AggregateError` that
 *   names the steps, never as the last of them;
 * - closing is done once: a later call neither closes again nor reports the failure a second time, so a chain of cleanups
 *   (`stop()`, then drop the database) is not cut short by the second call.
 *
 * It closes only what it was told about. A database or a service the kit was given is not the kit's to close.
 */

export interface CloseStep {
  /** Says which step failed, in the report of several failures. */
  readonly name: string;
  readonly close: () => Promise<void> | void;
}

/**
 * Runs every step in the order given, then reports what failed: nothing, the one failure itself, or an `AggregateError` of all of
 * them in order.
 */
export async function closeEach(steps: readonly CloseStep[]): Promise<void> {
  const failures: { readonly name: string; readonly error: unknown }[] = [];
  for (const step of steps) {
    try {
      await step.close();
    } catch (error) {
      failures.push({ name: step.name, error });
    }
  }
  const [first, ...others] = failures;
  if (first === undefined) return;
  if (others.length === 0) throw first.error;
  throw new AggregateError(
    failures.map((failure) => failure.error),
    `Closing failed in ${String(failures.length)} places: ${failures.map((failure) => failure.name).join(', ')}`,
  );
}

/** What a kit has opened so far. Each resource is recorded the moment it is open, so a failure part-way closes exactly that. */
export class Opened {
  private readonly steps: CloseStep[] = [];
  private closing: Promise<void> | undefined;
  private closed = false;

  /** Records an open resource and how to close it, and hands the resource back, so that opening and recording are one step. */
  add<T>(name: string, resource: T, close: (resource: T) => Promise<void> | void): T {
    this.steps.push({ name, close: () => close(resource) });
    return resource;
  }

  /**
   * Closes everything recorded, last opened first, and rejects with what failed (see {@link closeEach}). Calls made while it is
   * closing share its outcome; calls made after it has finished do nothing.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closing ??= closeEach([...this.steps].reverse()).finally(() => {
      this.closed = true;
    });
    return this.closing;
  }
}
