import { test } from './guarded-test';
import {
  hostedWebkit,
  KNOWN_FLAKY_ON_HOSTED_WEBKIT,
  reasonOf,
  type KnownFlaky,
  type KnownFlakyId,
} from './known-flaky-list';

/**
 * How a spec leaves out what the Product Owner accepted as known flaky on the hosted WebKit run (`known-flaky-list.ts` says what, why and where). Both functions do nothing anywhere else:
 * not in Chromium, not in Firefox, and not in a developer's WebKit.
 *
 * - `skipWhereKnownFlaky(browserName, id)` is the **first line of a test** that is left out whole: the report shows it skipped, with the reason.
 * - `leavesOutStep(browserName, id)` is asked **before a step** of a test that runs on: it answers whether to leave the step out, and a step that is left out is written on the test as an
 *   annotation (`known-flaky-webkit`), so the report says that the test did not make that check.
 */
function entryOf(id: KnownFlakyId, scope: KnownFlaky['scope']): KnownFlaky {
  const entry = KNOWN_FLAKY_ON_HOSTED_WEBKIT.find((one) => one.id === id);
  if (entry === undefined) throw new Error(`No known-flaky entry is named ${id}.`);
  if (entry.scope !== scope) {
    throw new Error(`The known-flaky entry ${id} is of scope ${entry.scope}, not ${scope}.`);
  }
  return entry;
}

export function skipWhereKnownFlaky(browserName: string, id: KnownFlakyId): void {
  const entry = entryOf(id, 'test');
  test.skip(hostedWebkit(browserName), reasonOf(entry));
}

export function leavesOutStep(browserName: string, id: KnownFlakyId): boolean {
  const entry = entryOf(id, 'step');
  if (!hostedWebkit(browserName)) return false;
  test.info().annotations.push({ type: 'known-flaky-webkit', description: reasonOf(entry) });
  return true;
}
