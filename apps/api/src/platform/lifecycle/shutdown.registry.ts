import { Injectable } from '@nestjs/common';

import { withinBudget } from './within-budget.js';

export interface ClosableResource {
  /** Identifies the resource in logs. */
  readonly name: string;
  close(): Promise<void> | void;
}

export interface CloseFailure {
  readonly name: string;
  readonly error: unknown;
}

/**
 * What `closeAll` could and could not confirm. Only `closed` is a confirmation: a resource in `stalled`
 * or `unreached` may or may not ever close, and nothing here claims that it did.
 */
export interface CloseReport {
  /** Closed without error. */
  readonly closed: readonly string[];
  /** Threw or rejected while the budget lasted. */
  readonly failed: readonly CloseFailure[];
  /** Was being waited for when the budget ended. */
  readonly stalled: readonly string[];
  /** Not reached before the budget ended. Its close was started and not awaited. */
  readonly unreached: readonly string[];
}

type Attempt = { readonly failed: false } | { readonly failed: true; readonly error: unknown };

/**
 * Starts a close and turns every outcome, a throw included, into a value. It never rejects, so an
 * attempt that is abandoned and fails later cannot become an unhandled rejection.
 */
function attemptClose(resource: ClosableResource): Promise<Attempt> {
  return Promise.resolve()
    .then(() => resource.close())
    .then(
      (): Attempt => ({ failed: false }),
      (error: unknown): Attempt => ({ failed: true, error }),
    );
}

/**
 * The resources that must be closed on shutdown (the database pool, from B0.4). A resource registers
 * itself when it is created. Nest 12 only logs a failing shutdown hook and carries on, so a failure
 * would be invisible to the shutdown outcome; closing here makes it explicit and reportable.
 */
@Injectable()
export class ShutdownRegistry {
  private resources: ClosableResource[] = [];

  register(resource: ClosableResource): void {
    this.resources.push(resource);
  }

  /**
   * Closes every resource, last registered first (a dependent closes before what it depends on), and
   * never stops at a failure. Each resource is closed at most once.
   *
   * The closes run one after another and share one budget. When it ends, the resource being waited for
   * is reported as stalled and is not waited for any longer. The ones not yet reached are still started,
   * so a stalled resource cannot stop them from being attempted, but nothing waits for them either.
   */
  async closeAll(budgetMs = Number.POSITIVE_INFINITY): Promise<CloseReport> {
    const pending = this.resources.toReversed();
    this.resources = [];

    const startedAt = performance.now();
    const closed: string[] = [];
    const failed: CloseFailure[] = [];
    const stalled: string[] = [];
    const unreached: string[] = [];

    for (const resource of pending) {
      const attempt = attemptClose(resource);
      if (stalled.length > 0) {
        unreached.push(resource.name);
        continue;
      }

      const result = await withinBudget(attempt, budgetMs - (performance.now() - startedAt));
      if (result.expired) stalled.push(resource.name);
      else if (result.value.failed) failed.push({ name: resource.name, error: result.value.error });
      else closed.push(resource.name);
    }
    return { closed, failed, stalled, unreached };
  }
}
