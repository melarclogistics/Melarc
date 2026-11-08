import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../platform/database/database.service.js';
import type { HubConfiguration } from '../platform/settings/hub-configuration.js';
import { SettingInvalidError, SettingMissingError } from '../platform/settings/settings-reader.js';

/**
 * The attempts a booking may make (pickup-request.md section 5.2, "Attempt cap reached"; state-machines.md section 3; domain-model.md
 * section 6.2; `AC-SLICE-001-07`): the hub's cap (`MELARC_MAX_PICKUP_ATTEMPTS`, three) and the ceiling a hub Senior Ops extension sets for
 * the one request it is raised for. Three operations judge it: the confirmation (a request past its ceiling is not confirmed), the
 * reschedule of a failed attempt (the next attempt would be past it) and the extension itself (there must be a ceiling to raise).
 *
 * **What an extension reaches is provisional.** The contract leaves it open ("exact extension ceilings ... remain domain-design follow-up",
 * section 21.6) and says an extension "permits a further attempt": it permits exactly one, the attempt after the request's own, so that a
 * second reschedule needs a second extension and one Senior Ops action never makes a request uncapped. The rule is this module's and
 * nothing else's, so that the Product Owner's answer changes one place.
 */

/** The condition a failed setting read is recorded as, or `undefined` for a failure that is not about the setting. */
export type SettingAnomaly = 'SETTING_MISSING' | 'SETTING_INVALID';

export function anomalyOf(error: unknown): SettingAnomaly | undefined {
  if (error instanceof SettingMissingError) return 'SETTING_MISSING';
  if (error instanceof SettingInvalidError) return 'SETTING_INVALID';
  return undefined;
}

/** The hub's cap, or why it cannot be applied: a cap that is unset or invalid blocks nothing, and the condition is recorded. */
export type AttemptCap =
  | { readonly kind: 'SET'; readonly cap: number }
  | { readonly kind: 'UNAVAILABLE'; readonly anomaly: SettingAnomaly };

export function attemptCapOf(config: HubConfiguration): AttemptCap {
  try {
    return { kind: 'SET', cap: config.integer('MELARC_MAX_PICKUP_ATTEMPTS', '', 1).value };
  } catch (error) {
    const anomaly = anomalyOf(error);
    if (anomaly === undefined) throw error;
    return { kind: 'UNAVAILABLE', anomaly };
  }
}

/** The highest attempt a request may be at: the cap, or the ceiling its extension set when that is higher (the cap may have been raised since). */
export function attemptCeiling(cap: number, extensionCeiling: number | null): number {
  return extensionCeiling === null ? cap : Math.max(cap, extensionCeiling);
}

/**
 * The ceiling the extension a request names set, or `null` when it names none. An extension the reader cannot read (it was raised for a
 * request outside the reader's hubs) lifts nothing: a ceiling that cannot be shown is not one, and the cap then holds.
 */
export async function extensionCeilingOf(
  tx: DatabaseTransaction,
  row: { readonly attempt_extension_id: string | null },
): Promise<number | null> {
  if (row.attempt_extension_id === null) return null;
  const found = await tx.execute(
    sql`select ceiling_after from pickup_attempt_extension where id = ${row.attempt_extension_id}::uuid`,
  );
  // An extension that released a refused collection and lifted no ceiling holds none: it raised nothing, and the cap then holds.
  const ceiling = (found.rows[0] as { ceiling_after: number | null } | undefined)?.ceiling_after;
  return ceiling ?? null;
}

/** What a request's attempts are measured against: the cap and the ceiling it makes with the request's extension, or why there is none. */
export type AttemptLimit =
  | { readonly kind: 'SET'; readonly cap: number; readonly ceiling: number }
  | { readonly kind: 'UNAVAILABLE'; readonly anomaly: SettingAnomaly };

export async function attemptLimitOf(
  tx: DatabaseTransaction,
  config: HubConfiguration,
  row: { readonly attempt_extension_id: string | null },
): Promise<AttemptLimit> {
  const cap = attemptCapOf(config);
  if (cap.kind === 'UNAVAILABLE') return cap;
  return {
    kind: 'SET',
    cap: cap.cap,
    ceiling: attemptCeiling(cap.cap, await extensionCeilingOf(tx, row)),
  };
}

/** Whether a request at `attempt` may be followed by one more under the limit. An unavailable limit blocks nothing. */
export function permitsAnotherAttempt(limit: AttemptLimit, attempt: number): boolean {
  return limit.kind === 'UNAVAILABLE' || attempt + 1 <= limit.ceiling;
}

/**
 * Whether the request's stop failed as a **refused collection** (`AC-SLICE-001-33`; pickup-failure.md section 5.2; section 21.6, `MSC-DEC-116`): the sender declined to hand the
 * parcels over, which is escalation-only and is never rescheduled by ordinary action, whatever the cap says. The request keeps its claim on the failed stop (a failure
 * does not release it), so the stop is found through the request. A reader that cannot see the stop sees no refusal, which is why the reschedule and the extension are
 * both staff acts of the hub that holds the stop.
 */
export async function refusedCollectionOf(
  tx: DatabaseTransaction,
  requestId: string,
): Promise<boolean> {
  const found = await tx.execute(sql`
    select 1 from pickup_stop
     where pickup_request_id = ${requestId}::uuid and state = 'FAILED' and failure_category = 'REFUSED_COLLECTION' limit 1`);
  return found.rows.length > 0;
}

/**
 * Whether the request has been released from the restriction a refused collection puts on it: an extension raised **for this request** that says it released the restriction
 * (`releases_refused_collection`), and which the request still names. That is the only thing that opens a reschedule of a refused collection (the force-extension of hub Senior Ops,
 * `MSC-DEC-116`, with its reason), and it is for the request's one next attempt: a clone that carries its source's extension is not released by it, because the extension was raised
 * for the source. Provisional like the extension's reach (the module's header): it is the Product Owner's to change, in this place.
 */
export async function refusalReleasedFor(
  tx: DatabaseTransaction,
  row: { readonly id: string; readonly attempt_extension_id: string | null },
): Promise<boolean> {
  if (row.attempt_extension_id === null) return false;
  const found = await tx.execute(sql`
    select 1 from pickup_attempt_extension
     where id = ${row.attempt_extension_id}::uuid and pickup_request_id = ${row.id}::uuid and releases_refused_collection`);
  return found.rows.length > 0;
}

/** Whether an extension was raised for this very request (a request has at most one), as opposed to one it carries from the request it replaces. */
export async function hasExtensionOfItsOwn(
  tx: DatabaseTransaction,
  row: { readonly id: string },
): Promise<boolean> {
  const found = await tx.execute(
    sql`select 1 from pickup_attempt_extension where pickup_request_id = ${row.id}::uuid`,
  );
  return found.rows.length > 0;
}

/** Whether a request at `attempt` may be confirmed under the limit. An unavailable limit blocks nothing. */
export function permitsAttempt(limit: AttemptLimit, attempt: number): boolean {
  return limit.kind === 'UNAVAILABLE' || attempt <= limit.ceiling;
}
