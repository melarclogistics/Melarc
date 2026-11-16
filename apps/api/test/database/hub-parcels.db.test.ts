import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import {
  toContextSettings,
  type SecurityContext,
} from '../../src/platform/database/transaction-context.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { handOver } from './support/handed-over.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { seedHubConfiguration } from './support/seeded.js';
import { HUB_A, HUB_B } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.35b (Run D, D-D1 to D-D8; migrations 0103 to 0106): the database layer of receiving by run, against a real PostgreSQL. **What the database holds for every writer** (features/hub/hub-intake.md
 * sections 5.1 and 5.4 to 5.8; contracts/state-machines.md section 7; domain-model.md sections 6.6 and 6.6a):
 *
 * - **The receiving mode and the parcels are the handover's**: a stop whose count carries door photos opens a photo intake with one parcel for each photo, in the order they were attached, and any other
 *   stop opens a blind-count intake with none; the mode never changes, and the set of parcels is judged again at the end of the transaction.
 * - **The machine of a parcel is the database's**, by the key of each act: the receiver taps, untaps, finishes the vendor and finds a missing parcel; the senior's correction moves the rest; nothing
 *   moves once itemizing has started; who and when are the database's.
 * - **The four acts** (`record_parcel_arrival`, `finish_check_in`, `add_extra_parcel`, `correct_intake_count`) write the parcels and the count in one change, route the intake again by the one rule of the
 *   System, and name the rule of each refusal; a tap and an extra before the finish never move the intake's version.
 * - **The condition of a photo intake is a parcel's**, once for each parcel; "Vendor told" is a record after a write-off; the names of the receiving side are display names and nothing else.
 *
 * The acts are run as the application's login with a staff context (the policies and the grants judge them as they do the application's), the machine and the guards as the owner under each key, and what
 * is deferred through the administrator's transaction with the triggers off for the statement that breaks it.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const COUNT = 'hub.intake.count';
const OSD = 'hub.osd.adjudicate';
const READ = 'hub.read';
const HANDOVER = 'hub.handover.submit';

const staff = (
  key: string,
  hubs: readonly string[] | 'ALL' = [HUB_A],
  principalId: string = randomUUID(),
): SecurityContext => ({
  principalType: 'STAFF',
  principalId,
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: hubs === 'ALL' ? 'ALL' : 'SET',
  authorizedHubIds: hubs === 'ALL' ? [] : [...hubs],
  correlationId: 'hub-parcels',
});

const rider = (riderId: string, key: string): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'hub-parcels',
});

interface Failure {
  readonly code: string | undefined;
  readonly message: string;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
}
type Result = { readonly rows: Record<string, unknown>[] } | Failure;
const failed = (result: Result): result is Failure => 'code' in result;

/** What a statement does as the application's login under a context: the rows it returned, or the SQLSTATE, the DETAIL and the HINT of the error the database raised. */
async function attemptAll(context: SecurityContext, texts: readonly string[]): Promise<Result> {
  try {
    const rows = await routes.built.service.transactionWithContext(context, async (tx) => {
      let last: unknown[] = [];
      for (const text of texts) last = (await tx.execute(sql.raw(text))).rows;
      return last as Record<string, unknown>[];
    });
    return { rows };
  } catch (error) {
    const server = serverErrorIn(error);
    return {
      code: server?.code ?? 'other',
      message: server?.message ?? String(error),
      detail: server?.detail,
      hint: server?.hint,
    };
  }
}
const attempt = (context: SecurityContext, text: string): Promise<Result> =>
  attemptAll(context, [text]);

/** A jsonb column as the driver gave it: parsed, or the text of it. */
const jsonOf = (value: unknown): unknown =>
  typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
const rowsOf = (result: Result): Record<string, unknown>[] => {
  if (failed(result)) throw new Error(`refused: ${result.code ?? '?'} ${result.message}`);
  return result.rows;
};
/** The refusal a rule of the database names: the SQLSTATE, the reason of the DETAIL (`reason=...`) and the rule of the HINT (`rule=...`). */
const refusal = (result: Result): [string | undefined, string | undefined, string | undefined] =>
  failed(result)
    ? [result.code, result.detail?.replace(/^reason=/, ''), result.hint?.replace(/^rule=/, '')]
    : ['none', undefined, undefined];

/**
 * What statements do as the owner under a context, in a transaction that is always rolled back: `ran:<rows of the last>` or the SQLSTATE of the refusal. The keys are an operation's, so a statement
 * of the login never meets them; the guards and the policies judge the statement itself (a row a policy hides is `ran:0`, a rule of a guard is `23514`).
 */
async function asOwner(context: SecurityContext, texts: readonly string[]): Promise<string> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local role melarc_owner');
    for (const [name, value] of toContextSettings(context))
      await routes.admin.query('select set_config($1, $2, true)', [name, value]);
    let last = 0;
    for (const text of texts) last = (await routes.admin.query(text)).rowCount ?? 0;
    return `ran:${String(last)}`;
  } catch (error) {
    return serverErrorIn(error)?.code ?? 'other';
  } finally {
    await routes.admin.query('rollback');
  }
}

/** What the administrator's transaction does, the triggers of the statements between `breaking` off, the end of the transaction judged as the database judges it: `committed` or the error it raised. */
async function adminCommit(
  statements: readonly string[],
): Promise<
  { readonly code: string | undefined; readonly constraint: string | undefined } | 'committed'
> {
  await routes.admin.query('begin');
  try {
    for (const statement of statements) await routes.admin.query(statement);
    await routes.admin.query('commit');
    return 'committed';
  } catch (error) {
    await routes.admin.query('rollback').catch(() => undefined);
    const server = serverErrorIn(error);
    return { code: server?.code, constraint: server?.constraint };
  }
}

interface Parcel {
  readonly id: string;
  readonly ordinal: number;
  readonly origin: string;
  readonly state: string;
  readonly door_photo_evidence_id: string | null;
  readonly hub_photo_evidence_id: string | null;
  readonly arrived_by: string | null;
  readonly arrived_at: Date | null;
  readonly missing_marked_at: Date | null;
  readonly version: number;
}
interface IntakeRow {
  readonly state: string;
  readonly physical_count: number | null;
  readonly count_variance: string | null;
  readonly count_difference: number | null;
  readonly condition: string;
  readonly counted_by: string | null;
  readonly counted_at: Date | null;
  readonly receiving_mode: string;
  readonly version: number;
  readonly active_receiver_id: string | null;
  readonly lock_acquired_at: Date | null;
  readonly lock_opened_at: Date | null;
}

const parcelsOf = (intakeId: string): Promise<Parcel[]> =>
  routes.rows<Parcel>(
    `select id, ordinal, origin, state, door_photo_evidence_id, hub_photo_evidence_id, arrived_by, arrived_at, missing_marked_at, version
       from intake_parcel where pickup_intake_id = $1 order by ordinal`,
    [intakeId],
  );
const parcelOf = async (id: string): Promise<Parcel> => {
  const [row] = await routes.rows<Parcel>(
    `select id, ordinal, origin, state, door_photo_evidence_id, hub_photo_evidence_id, arrived_by, arrived_at, missing_marked_at, version from intake_parcel where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('no such parcel');
  return row;
};
const intakeOf = async (id: string): Promise<IntakeRow> => {
  const [row] = await routes.rows<IntakeRow>(
    `select state, physical_count, count_variance, count_difference, condition, counted_by, counted_at, receiving_mode, version, active_receiver_id, lock_acquired_at, lock_opened_at
       from pickup_intake where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('no such intake');
  return row;
};
const findingsOf = (intakeId: string) =>
  routes.rows<{
    id: string;
    kind: string;
    condition: string | null;
    outcome: string | null;
    intake_parcel_id: string | null;
    note: string | null;
    recorded_by: string;
  }>(
    `select id, kind, condition, outcome, intake_parcel_id, note, recorded_by from pickup_intake_finding where pickup_intake_id = $1 order by recorded_at, id`,
    [intakeId],
  );
const secondsSince = (moment: Date | null): number =>
  moment === null ? Number.POSITIVE_INFINITY : (Date.now() - moment.getTime()) / 1000;

interface PhotoIntake {
  readonly id: string;
  readonly parcels: readonly Parcel[];
  readonly photos: readonly string[];
  readonly riderId: string;
  readonly manifestId: string;
  readonly requestId: string;
}

/** A photo intake, as the real handover leaves it: a run whose stop was counted with a photo of each of its `count` parcels, handed over by its rider. */
async function photoIntake(count = 3): Promise<PhotoIntake> {
  const done = await handOver(routes, vendor, days, {
    collected: [count],
    declared: [count],
    photos: true,
  });
  const id = done.intakes[0]?.id ?? '';
  return {
    id,
    parcels: await parcelsOf(id),
    photos: done.photoIds,
    riderId: done.run.rider.id,
    manifestId: done.run.manifest.id,
    requestId: done.run.stops[0]?.requestId ?? '',
  };
}
/** A blind-count intake: the stop was let through without photos. */
async function blindIntake(declared = 3): Promise<{ id: string; riderId: string }> {
  const done = await handOver(routes, vendor, days, {
    collected: [declared],
    declared: [declared],
  });
  return { id: done.intakes[0]?.id ?? '', riderId: done.run.rider.id };
}

const tap = (parcel: string, arrived: boolean): string =>
  `select * from melarc.record_parcel_arrival('${parcel}', ${String(arrived)})`;
const finish = (intake: string, all: boolean, confirmed: number | null = null): string =>
  `select * from melarc.finish_check_in('${intake}', ${String(all)}, ${confirmed === null ? 'null' : String(confirmed)})`;
const addExtra = (intake: string, parcel: string, evidence: string): string =>
  `select * from melarc.add_extra_parcel('${intake}', '${parcel}', '${evidence}')`;
const correct = (
  intake: string,
  reason: string | null,
  changes: readonly { parcel_id: string; state: string }[] | null,
  physical: number | null,
): string =>
  `select previous_state, resulting_state, old_received, new_received, old_variance, new_variance, changed
     from melarc.correct_intake_count('${intake}', ${reason === null ? 'null' : `'${reason}'`}, ${changes === null ? 'null' : `'${JSON.stringify(changes)}'::jsonb`}, ${physical === null ? 'null' : String(physical)})`;
const blindCount = (intake: string, physical: number): string =>
  `select intake_id, rider_declared_count, parcel_photo_ids from melarc.commit_blind_count('${intake}', ${String(physical)})`;
const uuids = (values: readonly string[]): string =>
  `array[${values.map((value) => `'${value}'`).join(', ')}]::uuid[]`;
const condition = (
  intake: string,
  parcel: string | null,
  value: string,
  evidence: readonly string[] = [],
): string =>
  `select previous_state, resulting_state from melarc.record_intake_condition('${intake}', '${randomUUID()}', '${value}', 'seen at the bench', ${uuids(evidence)}, ${parcel === null ? 'null' : `'${parcel}'`})`;
const adjudicate = (
  intake: string,
  outcome: string,
  options: { condition?: string; evidence?: readonly string[] } = {},
): string =>
  `select previous_state, resulting_state from melarc.adjudicate_discrepancy('${intake}', '${randomUUID()}', '${outcome}', ${options.condition === undefined ? 'null' : `'${options.condition}'`}, 'weighed by Senior Ops', ${uuids(options.evidence ?? [])})`;

/** A piece of evidence about an intake, as the evidence operations leave it (arranged as the administrator with the guards off for the statement). */
async function intakeEvidence(
  intakeId: string,
  by: string,
  purpose: 'CONDITION' | 'OSD',
  state: 'STORED' | 'PENDING_UPLOAD' = 'STORED',
): Promise<string> {
  const id = randomUUID();
  const stored = state === 'STORED';
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `insert into evidence (id, owner_type, owner_id, purpose, captured_at, captured_by_actor, captured_by_principal_type, storage_ref, responsible_hub_id, access_rule, retention_policy,
                             state, content_type, byte_size, checksum_sha256, upload_ttl_seconds, upload_expires_at, uploaded_at, validated_signature, scanner, scanner_signature_version, scanned_at)
       values ($1, 'PICKUP_INTAKE', $2, $3, now() - interval '1 minute', $4, 'STAFF', 'ev/' || replace(gen_random_uuid()::text, '-', ''), $5, 'SUBJECT_READERS', 'PICKUP_INTAKE_EVIDENCE',
               $6, 'image/jpeg', 12, repeat('a', 64), 900, now() + interval '15 minutes',
               case when $7::boolean then now() end, case when $7::boolean then 'JPEG' end, case when $7::boolean then 'test' end, case when $7::boolean then '1' end, case when $7::boolean then now() end)`,
      [id, intakeId, purpose, by, HUB_A, stored ? 'STORED' : 'PENDING_UPLOAD', stored],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
  return id;
}

const moveToArrived = (parcel: string): string =>
  `update intake_parcel set state = 'ARRIVED' where id = '${parcel}'`;

/** The first `tapped` parcels of a photo intake checked in by the officer, one tap each, and the vendor finished as tapped (what is not tapped is missing). */
async function finishedAsTapped(
  count: number,
  tapped: number,
): Promise<{ intake: PhotoIntake; officer: SecurityContext }> {
  const intake = await photoIntake(count);
  const officer = staff(COUNT);
  for (const parcel of intake.parcels.slice(0, tapped))
    rowsOf(await attempt(officer, tap(parcel.id, true)));
  rowsOf(await attempt(officer, finish(intake.id, false)));
  return { intake, officer };
}

describe('the receiving mode and the parcels a handover opens (migration 0103)', () => {
  // Break caught: a mode that does not follow the stop (a stop with photos opened as a blind count, so the officer is given nothing to check against; a stop without them opened with parcels), a
  // parcel opened for fewer or more photos than the stop's count carries, in another order than the photos were attached, in another state than EXPECTED, or with who and when set.
  it('opens a photo intake with one parcel for each door photo in the order they were attached, and a blind-count intake with none', async () => {
    const photo = await photoIntake(3);
    const blind = await blindIntake();
    expect((await intakeOf(photo.id)).receiving_mode).toBe('PHOTO_CHECK_IN');
    expect((await intakeOf(blind.id)).receiving_mode).toBe('BLIND_COUNT');
    const attached = await routes.rows<{ evidence_id: string }>(
      `select p.evidence_id from collection_parcel_photo p join pickup_stop s on s.id = p.pickup_stop_id
        where s.pickup_manifest_id = $1 and s.pickup_request_id = $2 order by p.attached_at, p.evidence_id`,
      [photo.manifestId, photo.requestId],
    );
    expect(attached.map((row) => row.evidence_id).toSorted()).toEqual(photo.photos.toSorted());
    expect(photo.parcels.map((parcel) => parcel.ordinal)).toEqual([1, 2, 3]);
    expect(photo.parcels.map((parcel) => parcel.door_photo_evidence_id)).toEqual(
      attached.map((row) => row.evidence_id),
    );
    for (const parcel of photo.parcels) {
      expect(parcel).toMatchObject({
        origin: 'DOOR_PHOTO',
        state: 'EXPECTED',
        hub_photo_evidence_id: null,
        arrived_by: null,
        arrived_at: null,
        missing_marked_at: null,
        version: 1,
      });
    }
    expect(await parcelsOf(blind.id)).toEqual([]);
  });

  // Break caught: a mode a writer can change, which would turn a checked-in intake into a counted blind one (or the reverse) after the fact; a parcel a writer can make for a blind-count intake.
  it('fixes the mode for ever and gives a blind-count intake no parcel, whoever writes', async () => {
    const photo = await photoIntake(2);
    const blind = await blindIntake();
    for (const [id, other] of [
      [photo.id, 'BLIND_COUNT'],
      [blind.id, 'PHOTO_CHECK_IN'],
    ] as const) {
      expect(
        await adminCommit([
          `update pickup_intake set receiving_mode = '${other}' where id = '${id}'`,
        ]),
      ).toMatchObject({ code: '23514' });
    }
    expect(
      await adminCommit([
        `insert into intake_parcel (id, pickup_intake_id, responsible_hub_id, ordinal, origin, hub_photo_evidence_id, state, arrived_by, arrived_at)
         values (gen_random_uuid(), '${blind.id}', '${HUB_A}', 1, 'HUB_EXTRA', gen_random_uuid(), 'ARRIVED', gen_random_uuid(), now())`,
      ]),
    ).toMatchObject({ code: '23514' });
    expect(await parcelsOf(blind.id)).toEqual([]);
  });

  // Break caught: a set of door parcels that is not judged again at the end of the transaction (a handover that opens fewer parcels than the stop has photos, or none, would be accepted), for a
  // writer that has the triggers of its statements off.
  it('judges the door parcels of a photo intake again at the end of the transaction: one for each photo, or the transaction is refused', async () => {
    const photo = await photoIntake(3);
    const [, second, third] = photo.parcels;
    expect(
      await adminCommit([
        'set local session_replication_role = replica',
        `delete from intake_parcel where id in ('${second?.id ?? ''}', '${third?.id ?? ''}')`,
        'set local session_replication_role = origin',
        `insert into intake_parcel (id, pickup_intake_id, responsible_hub_id, ordinal, origin, door_photo_evidence_id, state)
         values (gen_random_uuid(), '${photo.id}', '${HUB_A}', 3, 'DOOR_PHOTO', '${third?.door_photo_evidence_id ?? ''}', 'EXPECTED')`,
      ]),
    ).toEqual({ code: '23514', constraint: 'intake_parcel_set' });
    expect((await parcelsOf(photo.id)).map((parcel) => parcel.ordinal)).toEqual([1, 2, 3]);
  });

  // Break caught: a finished photo intake whose count is not the number of its parcels that arrived, one with a parcel left to check in, or one still being checked in with a parcel missing: each is
  // judged at the end of the transaction, for a writer that put a parcel right under the guard and then asked for the check.
  it('judges a finished photo intake’s count against its parcels at the end of the transaction', async () => {
    const { intake } = await finishedAsTapped(3, 2);
    const [, , missing] = await parcelsOf(intake.id);
    // The third parcel is put right with the triggers off; the intake is then touched with them on, so that the check is asked for: the count (2) is not the number that arrived (3).
    expect(
      await adminCommit([
        'set local session_replication_role = replica',
        `update intake_parcel set state = 'ARRIVED', arrived_by = gen_random_uuid(), arrived_at = now() where id = '${missing?.id ?? ''}'`,
        'set local session_replication_role = origin',
        `update pickup_intake set state = state where id = '${intake.id}'`,
      ]),
    ).toEqual({ code: '23514', constraint: 'intake_parcel_count' });
    // The number is wrong and nothing else is: the difference and the variance still say what the parcels say, so that only the number of the count can be what the check refuses.
    expect(
      await adminCommit([
        'set local session_replication_role = replica',
        `update pickup_intake set physical_count = 7 where id = '${intake.id}'`,
        'set local session_replication_role = origin',
        `update pickup_intake set state = state where id = '${intake.id}'`,
      ]),
    ).toEqual({ code: '23514', constraint: 'intake_parcel_count' });
    // A parcel left to check in in a finished vendor.
    expect(
      await adminCommit([
        'set local session_replication_role = replica',
        `update intake_parcel set state = 'EXPECTED', arrived_by = null, arrived_at = null, missing_marked_at = null where id = '${missing?.id ?? ''}'`,
        'set local session_replication_role = origin',
        `update pickup_intake set state = state where id = '${intake.id}'`,
      ]),
    ).toEqual({ code: '23514', constraint: 'intake_parcel_count' });
    // A parcel missing while the vendor is still being checked in.
    const open = await photoIntake(2);
    expect(
      await adminCommit([
        'set local session_replication_role = replica',
        `update intake_parcel set state = 'MISSING', missing_marked_at = now() where id = '${open.parcels[0]?.id ?? ''}'`,
        'set local session_replication_role = origin',
        `update pickup_intake set state = state where id = '${open.id}'`,
      ]),
    ).toEqual({ code: '23514', constraint: 'intake_parcel_count' });
    expect((await parcelOf(missing?.id ?? '')).state).toBe('MISSING');
  });

  // Break caught: the deferred checks open to a context a writer builds for itself: a login that asserts the label of the check reaches no row (the policies that admit it name the owner).
  it('lets no login read as the capability of the deferred checks and of the names', async () => {
    const photo = await photoIntake(2);
    for (const capability of ['intake_parcel_check', 'receiving_names']) {
      const asserted = await attemptAll(staff(COUNT), [
        `select set_config('melarc.principal_type', 'SYSTEM', true)`,
        `select set_config('melarc.task_capability', '${capability}', true)`,
        `select id from intake_parcel where pickup_intake_id = '${photo.id}'`,
      ]);
      expect(rowsOf(asserted), capability).toEqual([]);
      const named = await attemptAll(staff(COUNT), [
        `select set_config('melarc.principal_type', 'SYSTEM', true)`,
        `select set_config('melarc.task_capability', '${capability}', true)`,
        `select id from staff_identity`,
      ]);
      expect(rowsOf(named), capability).toEqual([]);
      const riders = await attemptAll(staff(COUNT), [
        `select set_config('melarc.principal_type', 'SYSTEM', true)`,
        `select set_config('melarc.task_capability', '${capability}', true)`,
        `select id from rider_identity`,
      ]);
      expect(rowsOf(riders), capability).toEqual([]);
    }
  });
});

describe('the moment a lock was opened (migration 0103)', () => {
  /** The receiver takes, keeps or refreshes the lock, as the application's login does (the columns it may write); the row is read back from the observer, where the moments are dates. */
  const takeLock = async (id: string, receiver: SecurityContext): Promise<IntakeRow> => {
    const taken = await attempt(
      receiver,
      `update pickup_intake set active_receiver_id = '${receiver.principalId}', lock_acquired_at = now() where id = '${id}' returning id`,
    );
    expect(rowsOf(taken)).toHaveLength(1);
    return intakeOf(id);
  };
  /** Statements of the administrator with the triggers off, to arrange a lock as an earlier build or an older holder left it. */
  const arranged = async (text: string, values: readonly unknown[]): Promise<void> => {
    await routes.admin.query('begin');
    try {
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query(text, [...values]);
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback').catch(() => undefined);
      throw error;
    }
  };

  // Break caught: a lock that does not say when its holder first took it (the page could not say "opened at 09:12"), one whose refresh moves that moment (it would say when the holder last looked), a
  // takeover that keeps the old holder's moment, a release that leaves it behind, a moment a writer can give, or one that moves the intake's ETag.
  it('is the first moment of the current holder: kept by its refreshes, restarted by a takeover, cleared by a release, never a writer’s, and never the ETag', async () => {
    const photo = await photoIntake(2);
    const a = staff(COUNT, [HUB_A]);
    const b = staff(COUNT, [HUB_A]);
    const version = (await intakeOf(photo.id)).version;

    const first = await takeLock(photo.id, a);
    expect(first.lock_opened_at).not.toBeNull();
    expect(first.lock_opened_at).toEqual(first.lock_acquired_at);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const refreshed = await takeLock(photo.id, a);
    expect(refreshed.lock_acquired_at?.getTime()).toBeGreaterThan(
      first.lock_acquired_at?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(refreshed.lock_opened_at).toEqual(first.lock_opened_at);
    expect(refreshed.version).toBe(version);

    // The holder's lock is old (arranged with the triggers off, as the lock tests age one): another receiver takes it over, and the moment is theirs.
    await arranged(
      `update pickup_intake set lock_acquired_at = now() - interval '20 minutes' where id = $1`,
      [photo.id],
    );
    const taken = await takeLock(photo.id, b);
    expect(taken).toMatchObject({ active_receiver_id: b.principalId, version });
    expect(taken.lock_opened_at).toEqual(taken.lock_acquired_at);
    expect(taken.lock_opened_at?.getTime()).toBeGreaterThan(
      first.lock_opened_at?.getTime() ?? Number.POSITIVE_INFINITY,
    );

    // A moment a writer gives is not kept, and the login cannot write the column at all.
    await routes.admin.query(
      `update pickup_intake set lock_opened_at = now() - interval '1 day' where id = $1`,
      [photo.id],
    );
    expect((await intakeOf(photo.id)).lock_opened_at).toEqual(taken.lock_opened_at);
    expect(
      refusal(
        await attempt(
          b,
          `update pickup_intake set lock_opened_at = now() where id = '${photo.id}'`,
        ),
      )[0],
    ).toBe('42501');

    // A release clears it with the lock.
    await routes.admin.query(
      `update pickup_intake set active_receiver_id = null, lock_acquired_at = null where id = $1`,
      [photo.id],
    );
    expect(await intakeOf(photo.id)).toMatchObject({
      active_receiver_id: null,
      lock_acquired_at: null,
      lock_opened_at: null,
      version,
    });
  });

  // Break caught: a lock that was taken before the moment existed (an intake with a holder and no opening moment) whose first refresh leaves the opening empty or restarts it.
  it('reads the acquisition of a lock that was taken before the moment existed as its opening', async () => {
    const photo = await photoIntake(2);
    const a = staff(COUNT, [HUB_A]);
    await arranged(
      `update pickup_intake set active_receiver_id = $2, lock_acquired_at = now() - interval '5 minutes' where id = $1`,
      [photo.id, a.principalId],
    );
    const before = await intakeOf(photo.id);
    expect(before.lock_opened_at).toBeNull();
    const refreshed = await takeLock(photo.id, a);
    expect(refreshed.lock_opened_at).toEqual(before.lock_acquired_at);
    expect(refreshed.lock_acquired_at?.getTime()).toBeGreaterThan(
      before.lock_acquired_at?.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });
});

describe('the machine of a parcel: what the database holds for every writer (migration 0103)', () => {
  const moveTo = (parcel: string, state: string): string =>
    `update intake_parcel set state = '${state}' where id = '${parcel}'`;

  // Break caught: a move that is not the machine's, or that is by the wrong key: the adjudicator tapping before the vendor is finished, the receiver moving an arrived door parcel to missing (a
  // senior's correction), a parcel that goes back to expected from missing, an identity or a photo that changes, who and when that a writer gives; a delete, a statement with no key.
  it('lets each key make its own moves while the vendor is being checked in, and no other', async () => {
    const photo = await photoIntake(3);
    const [one, two] = photo.parcels;
    expect(rowsOf(await attempt(staff(COUNT), tap(one?.id ?? '', true)))).toHaveLength(1);
    const cases: [string, SecurityContext, readonly string[], string][] = [
      ['the receiver taps', staff(COUNT), [moveTo(two?.id ?? '', 'ARRIVED')], 'ran:1'],
      ['the receiver untaps', staff(COUNT), [moveTo(one?.id ?? '', 'EXPECTED')], 'ran:1'],
      [
        'the receiver marks a parcel missing, as a finish does',
        staff(COUNT),
        [moveTo(two?.id ?? '', 'MISSING')],
        'ran:1',
      ],
      ['the adjudicator taps', staff(OSD), [moveTo(two?.id ?? '', 'ARRIVED')], '23514'],
      [
        'the adjudicator corrects before the vendor is finished',
        staff(OSD),
        [moveTo(one?.id ?? '', 'MISSING')],
        '23514',
      ],
      [
        'the receiver moves an arrived door parcel to missing',
        staff(COUNT),
        [moveTo(one?.id ?? '', 'MISSING')],
        '23514',
      ],
      ['a door parcel is never void', staff(COUNT), [moveTo(two?.id ?? '', 'VOID')], '23514'],
      [
        'a key that is not a receiver’s',
        staff('pickup.read'),
        [moveTo(two?.id ?? '', 'ARRIVED')],
        'ran:0',
      ],
      ['a reader', staff(READ), [moveTo(two?.id ?? '', 'ARRIVED')], 'ran:0'],
      [
        'another hub’s receiver',
        staff(COUNT, [HUB_B]),
        [moveTo(two?.id ?? '', 'ARRIVED')],
        'ran:0',
      ],
      [
        'the place of a parcel',
        staff(COUNT),
        [`update intake_parcel set ordinal = 9 where id = '${two?.id ?? ''}'`],
        '23514',
      ],
      [
        'the door photo of a parcel',
        staff(COUNT),
        [
          `update intake_parcel set door_photo_evidence_id = '${photo.photos[2] ?? ''}' where id = '${two?.id ?? ''}'`,
        ],
        '23514',
      ],
      [
        'who checked a parcel in, without its state',
        staff(COUNT),
        [`update intake_parcel set arrived_by = gen_random_uuid() where id = '${one?.id ?? ''}'`],
        '23514',
      ],
    ];
    for (const [name, context, texts, expected] of cases) {
      expect(await asOwner(context, texts), name).toBe(expected);
    }
    // Nobody removes a parcel (the administrator's statement meets the guard; the others meet no policy for a delete).
    expect(
      await adminCommit([`delete from intake_parcel where id = '${one?.id ?? ''}'`]),
    ).toMatchObject({
      code: '23514',
    });
    expect(
      await asOwner(staff(COUNT), [`delete from intake_parcel where id = '${one?.id ?? ''}'`]),
    ).toBe('ran:0');
    // Who and when are the database's: the receiver's statement gave none and the tap has them.
    expect(await parcelOf(one?.id ?? '')).toMatchObject({ state: 'ARRIVED', version: 2 });
  });

  // Break caught: a missing parcel found by the wrong key or in the wrong state, a correction that is not the senior's, a vendor's parcels that move after the case is closed, or after itemizing
  // has started.
  it('lets a missing parcel be found by the receiver while the case is open and moved by the senior’s correction, and none move once itemizing has started', async () => {
    const { intake } = await finishedAsTapped(3, 2);
    const [one, , missing] = await parcelsOf(intake.id);
    const cases: [string, SecurityContext, readonly string[], string][] = [
      [
        'the receiver finds the missing parcel',
        staff(COUNT),
        [moveTo(missing?.id ?? '', 'ARRIVED')],
        'ran:1',
      ],
      ['the senior finds it', staff(OSD), [moveTo(missing?.id ?? '', 'ARRIVED')], 'ran:1'],
      [
        'the senior marks an arrived door parcel missing',
        staff(OSD),
        [moveTo(one?.id ?? '', 'MISSING')],
        'ran:1',
      ],
      [
        'the receiver marks an arrived parcel missing',
        staff(COUNT),
        [moveTo(one?.id ?? '', 'MISSING')],
        '23514',
      ],
      [
        'the receiver untaps after the vendor is finished',
        staff(COUNT),
        [moveTo(one?.id ?? '', 'EXPECTED')],
        '23514',
      ],
      [
        'a missing parcel does not go back to expected',
        staff(OSD),
        [moveTo(missing?.id ?? '', 'EXPECTED')],
        '23514',
      ],
    ];
    for (const [name, context, texts, expected] of cases) {
      expect(await asOwner(context, texts), name).toBe(expected);
    }
    // The senior closes the case; the receiver then finds nothing, and once itemizing has started nobody moves a parcel.
    rowsOf(await attempt(staff(OSD), adjudicate(intake.id, 'ACCEPTED')));
    expect(
      await asOwner(staff(COUNT), [moveTo(missing?.id ?? '', 'ARRIVED')]),
      'the case is closed',
    ).toBe('23514');
    expect(
      await asOwner(staff(OSD), [moveTo(missing?.id ?? '', 'ARRIVED')]),
      'resolved, before itemizing',
    ).toBe('ran:1');
    await routes.admin.query(`update pickup_intake set state = 'ITEMIZING' where id = $1`, [
      intake.id,
    ]);
    for (const [name, context, texts] of [
      ['the receiver', staff(COUNT), [moveTo(missing?.id ?? '', 'ARRIVED')]],
      ['the senior', staff(OSD), [moveTo(one?.id ?? '', 'MISSING')]],
    ] as const) {
      expect(await asOwner(context, texts), name).toBe('23514');
    }
  });
});

describe('the guard of an intake: what the database holds of a count for every writer (migration 0103)', () => {
  const countUpdate = (
    id: string,
    physical: number,
    difference: number,
    variance: string,
    state?: string,
  ): string =>
    `update pickup_intake set physical_count = ${String(physical)}, count_difference = ${String(difference)}, count_variance = '${variance}'${state === undefined ? '' : `, state = '${state}'`} where id = '${id}'`;

  // Break caught: a count of a photo intake that is not the number of its parcels that arrived, a found parcel that clears the case (only an adjudication does), a correction that does not route
  // the intake again by the rule, a blind count changed by the receiver, a count compared with the wrong difference, a count whose moment changes, a count that moves after itemizing started,
  // a condition put back to OK before the count, one found on a blind-count intake before its count, a mode that changes.
  it('holds the count by the key of the act that changes it, and routes the intake again after a correction', async () => {
    const { intake: photo } = await finishedAsTapped(3, 2);
    const missing = (await parcelsOf(photo.id))[2]?.id ?? '';
    const blindRecon = await blindIntake(3);
    rowsOf(await attempt(staff(COUNT), blindCount(blindRecon.id, 1)));
    const blindReady = await blindIntake(3);
    rowsOf(await attempt(staff(COUNT), blindCount(blindReady.id, 3)));
    const itemizing = await blindIntake(3);
    rowsOf(await attempt(staff(COUNT), blindCount(itemizing.id, 3)));
    await routes.admin.query(`update pickup_intake set state = 'ITEMIZING' where id = $1`, [
      itemizing.id,
    ]);
    const waitingPhoto = await photoIntake(2);
    const waitingBlind = await blindIntake(3);
    // A blind count with a variance, on which the receiver then found damage: the numbers can be made to match, and only the condition says the senior's still to decide.
    const damaged = await blindIntake(3);
    const recorder = staff(COUNT);
    rowsOf(await attempt(recorder, blindCount(damaged.id, 1)));
    const damage = await intakeEvidence(damaged.id, recorder.principalId, 'CONDITION');
    rowsOf(await attempt(recorder, condition(damaged.id, null, 'DAMAGED', [damage])));
    expect(await intakeOf(photo.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 2,
    });

    const cases: [string, SecurityContext, readonly string[], string][] = [
      [
        'a photo count that is not the number of parcels that arrived',
        staff(COUNT),
        [countUpdate(photo.id, 3, 0, 'MATCH')],
        '23514',
      ],
      [
        'a found parcel and its count, the case left open',
        staff(COUNT),
        [moveToArrived(missing), countUpdate(photo.id, 3, 0, 'MATCH')],
        'ran:1',
      ],
      [
        'a found parcel that clears the case',
        staff(COUNT),
        [moveToArrived(missing), countUpdate(photo.id, 3, 0, 'MATCH', 'READY_FOR_ITEMIZATION')],
        '23514',
      ],
      [
        'a correction that clears a clean intake',
        staff(OSD),
        [moveToArrived(missing), countUpdate(photo.id, 3, 0, 'MATCH', 'READY_FOR_ITEMIZATION')],
        'ran:1',
      ],
      [
        'a correction that leaves a clean intake in reconciliation',
        staff(OSD),
        [moveToArrived(missing), countUpdate(photo.id, 3, 0, 'MATCH')],
        '23514',
      ],
      [
        'a count of nobody’s act',
        staff('pickup.read'),
        [countUpdate(photo.id, 3, 0, 'MATCH')],
        'ran:0',
      ],
      [
        'a blind count changed by the receiver',
        staff(COUNT),
        [countUpdate(blindRecon.id, 3, 0, 'MATCH', 'READY_FOR_ITEMIZATION')],
        '23514',
      ],
      // The case left where it was: only the key says that the receiver may not change a blind count (the rule of a found parcel, which leaves the state alone, would let it through).
      [
        'a blind count changed by the receiver, the case left open',
        staff(COUNT),
        [countUpdate(blindRecon.id, 3, 0, 'MATCH')],
        '23514',
      ],
      [
        'a blind count corrected by the senior',
        staff(OSD),
        [countUpdate(blindRecon.id, 3, 0, 'MATCH', 'READY_FOR_ITEMIZATION')],
        'ran:1',
      ],
      [
        'a blind correction compared with the wrong difference',
        staff(OSD),
        [countUpdate(blindRecon.id, 3, 5, 'MATCH', 'READY_FOR_ITEMIZATION')],
        '23514',
      ],
      [
        'a blind correction that leaves the intake where it was',
        staff(OSD),
        [countUpdate(blindRecon.id, 3, 0, 'MATCH')],
        '23514',
      ],
      [
        'a correction that clears an intake whose condition stands',
        staff(OSD),
        [countUpdate(damaged.id, 3, 0, 'MATCH', 'READY_FOR_ITEMIZATION')],
        '23514',
      ],
      [
        'a correction that leaves it in reconciliation',
        staff(OSD),
        [countUpdate(damaged.id, 3, 0, 'MATCH')],
        'ran:1',
      ],
      [
        'a blind count that moves its moment',
        staff(OSD),
        [`update pickup_intake set counted_at = now() where id = '${blindRecon.id}'`],
        '23514',
      ],
      [
        'a cleared blind count corrected into a variance',
        staff(OSD),
        [countUpdate(blindReady.id, 2, -1, 'SHORT', 'RECONCILIATION_REQUIRED')],
        'ran:1',
      ],
      [
        'a variance left in a cleared state',
        staff(OSD),
        [countUpdate(blindReady.id, 2, -1, 'SHORT')],
        '23514',
      ],
      [
        'a count that moves once itemizing has started',
        staff(OSD),
        [countUpdate(itemizing.id, 2, -1, 'SHORT', 'RECONCILIATION_REQUIRED')],
        '23514',
      ],
      [
        'a condition found while a photo intake is being checked in',
        staff(COUNT),
        [`update pickup_intake set condition = 'DAMAGED' where id = '${waitingPhoto.id}'`],
        'ran:1',
      ],
      [
        'a condition put back to OK before the count',
        staff(COUNT),
        [
          `update pickup_intake set condition = 'DAMAGED' where id = '${waitingPhoto.id}'`,
          `update pickup_intake set condition = 'OK' where id = '${waitingPhoto.id}'`,
        ],
        '23514',
      ],
      [
        'a condition found on a blind-count intake before its count',
        staff(COUNT),
        [`update pickup_intake set condition = 'DAMAGED' where id = '${waitingBlind.id}'`],
        '23514',
      ],
      [
        'a mode changed by the receiver',
        staff(COUNT),
        [`update pickup_intake set receiving_mode = 'BLIND_COUNT' where id = '${photo.id}'`],
        '23514',
      ],
    ];
    for (const [name, context, texts, expected] of cases) {
      expect(await asOwner(context, texts), name).toBe(expected);
    }
  });
});

describe('the System’s move after a count is one rule, held for every writer (migration 0103)', () => {
  const counted = (id: string, physical: number, variance: string, difference: number): string =>
    `update pickup_intake set state = 'COUNTED', physical_count = ${String(physical)}, counted_at = now(), counted_by = gen_random_uuid(), count_variance = '${variance}', count_difference = ${String(difference)} where id = '${id}'`;
  const moveIntake = (id: string, state: string): string =>
    `update pickup_intake set state = '${state}' where id = '${id}'`;

  // Break caught: a count that clears an intake while a parcel is missing and an extra stands (the numbers match, so only the parcels say), one that sends a clean count to the senior, one that
  // clears a count the System should have sent; the rule judged for the writer that has no operation (the owner's statements here), not only for the operations that make the move.
  it('clears a photo intake only when nothing is missing and no extra stands, and sends every other to reconciliation', async () => {
    const photo = await photoIntake(3);
    const officer = staff(COUNT);
    const [one, two, three] = photo.parcels;
    rowsOf(await attempt(officer, tap(one?.id ?? '', true)));
    rowsOf(await attempt(officer, tap(two?.id ?? '', true)));
    const extraPhoto = await intakeEvidence(photo.id, officer.principalId, 'OSD');
    rowsOf(await attempt(officer, addExtra(photo.id, randomUUID(), extraPhoto)));
    const missing = `update intake_parcel set state = 'MISSING' where id = '${three?.id ?? ''}'`;
    // Two arrived and an extra against three expected: the count matches, a parcel is missing and an extra stands.
    expect(
      await asOwner(officer, [
        missing,
        counted(photo.id, 3, 'MATCH', 0),
        moveIntake(photo.id, 'READY_FOR_ITEMIZATION'),
      ]),
      'cleared with a missing parcel and an extra',
    ).toBe('23514');
    expect(
      await asOwner(officer, [
        missing,
        counted(photo.id, 3, 'MATCH', 0),
        moveIntake(photo.id, 'RECONCILIATION_REQUIRED'),
      ]),
      'sent to the senior',
    ).toBe('ran:1');

    const clean = await photoIntake(2);
    for (const parcel of clean.parcels) rowsOf(await attempt(officer, tap(parcel.id, true)));
    expect(
      await asOwner(officer, [
        counted(clean.id, 2, 'MATCH', 0),
        moveIntake(clean.id, 'RECONCILIATION_REQUIRED'),
      ]),
      'a clean count sent to the senior',
    ).toBe('23514');
    expect(
      await asOwner(officer, [
        counted(clean.id, 2, 'MATCH', 0),
        moveIntake(clean.id, 'READY_FOR_ITEMIZATION'),
      ]),
      'a clean count cleared',
    ).toBe('ran:1');
    // A damaged parcel stands in the rule too: the condition found while the vendor was checked in keeps a clean count from being cleared.
    const damaged = await photoIntake(2);
    for (const parcel of damaged.parcels) rowsOf(await attempt(officer, tap(parcel.id, true)));
    const evidence = await intakeEvidence(damaged.id, officer.principalId, 'CONDITION');
    rowsOf(
      await attempt(
        officer,
        condition(damaged.id, damaged.parcels[0]?.id ?? '', 'DAMAGED', [evidence]),
      ),
    );
    expect(
      await asOwner(officer, [
        counted(damaged.id, 2, 'MATCH', 0),
        moveIntake(damaged.id, 'READY_FOR_ITEMIZATION'),
      ]),
      'cleared with a condition that is not OK',
    ).toBe('23514');
  });
});

describe('recordParcelArrival: the tap, the untap, the void of an extra and the find (migration 0104)', () => {
  // Break caught: a tap that does not check the parcel in with the officer and the moment of the database, that moves the intake's version (a finish would be refused for the taps that led to it),
  // that is not idempotent (the same tap twice writes twice), an untap that leaves who and when behind.
  it('checks a parcel in and takes the tap back, idempotently, as the officer and the database’s moment, and never moves the intake’s version', async () => {
    const photo = await photoIntake(3);
    const [one] = photo.parcels;
    const officer = staff(COUNT);
    const before = await intakeOf(photo.id);
    expect(rowsOf(await attempt(officer, tap(one?.id ?? '', true)))).toEqual([
      {
        parcel_previous_state: 'EXPECTED',
        parcel_resulting_state: 'ARRIVED',
        parcel_intake_id: photo.id,
        parcel_intake_state: 'AWAITING_COUNT',
      },
    ]);
    const arrived = await parcelOf(one?.id ?? '');
    expect(arrived).toMatchObject({
      state: 'ARRIVED',
      arrived_by: officer.principalId,
      version: 2,
    });
    expect(secondsSince(arrived.arrived_at)).toBeLessThan(120);
    expect(rowsOf(await attempt(officer, tap(one?.id ?? '', true)))[0]).toMatchObject({
      parcel_previous_state: 'ARRIVED',
      parcel_resulting_state: 'ARRIVED',
    });
    expect((await parcelOf(one?.id ?? '')).version).toBe(2);
    expect(rowsOf(await attempt(officer, tap(one?.id ?? '', false)))[0]).toMatchObject({
      parcel_previous_state: 'ARRIVED',
      parcel_resulting_state: 'EXPECTED',
    });
    expect(await parcelOf(one?.id ?? '')).toMatchObject({
      state: 'EXPECTED',
      arrived_by: null,
      arrived_at: null,
    });
    expect((await intakeOf(photo.id)).version).toBe(before.version);
  });

  // Break caught: an act open to a reader, the adjudicator, a rider or a vendor, to another hub's receiver, or for a parcel that is not there; a tap on a blind-count intake's id.
  it('is a receiver’s alone, in the hubs of the grant', async () => {
    const photo = await photoIntake(2);
    const [one] = photo.parcels;
    const text = tap(one?.id ?? '', true);
    for (const [name, context] of [
      ['a reader', staff(READ)],
      ['the adjudicator', staff(OSD)],
      ['a staff member of another key', staff('pickup.read')],
      ['the rider of the handover', rider(photo.riderId, HANDOVER)],
    ] as const) {
      expect(refusal(await attempt(context, text)), name).toEqual(['42501', undefined, undefined]);
    }
    for (const [name, context, parcel] of [
      ['another hub’s receiver', staff(COUNT, [HUB_B]), one?.id ?? ''],
      ['a parcel that is not there', staff(COUNT), randomUUID()],
    ] as const) {
      const refused = await attempt(context, tap(parcel, true));
      expect(refusal(refused)[0], name).toBe('42501');
      expect((refused as Failure).message, name).toMatch(/no such parcel/);
    }
    expect((await parcelOf(one?.id ?? '')).state).toBe('EXPECTED');
  });

  // Break caught: a found parcel that does not recompute the count, the difference and the variance in the same change, that moves the case out of reconciliation (only an adjudication does), that
  // is allowed while no case is open or after one was closed; a finish that leaves the parcels it did not tap anything but missing, with the moment of the database.
  it('finishes as tapped (what is not tapped is missing) and finds a missing parcel while the case is open: the count follows and the case stays open', async () => {
    const { intake, officer } = await finishedAsTapped(4, 2);
    const [, , third, fourth] = await parcelsOf(intake.id);
    expect(await intakeOf(intake.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 2,
      count_variance: 'SHORT',
      count_difference: -2,
      counted_by: officer.principalId,
    });
    expect(third).toMatchObject({ state: 'MISSING', arrived_by: null, arrived_at: null });
    expect(secondsSince(third?.missing_marked_at ?? null)).toBeLessThan(120);
    const finder = staff(COUNT);
    const version = (await intakeOf(intake.id)).version;
    expect(rowsOf(await attempt(finder, tap(third?.id ?? '', true)))).toEqual([
      {
        parcel_previous_state: 'MISSING',
        parcel_resulting_state: 'ARRIVED',
        parcel_intake_id: intake.id,
        parcel_intake_state: 'RECONCILIATION_REQUIRED',
      },
    ]);
    expect(await intakeOf(intake.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 3,
      count_variance: 'SHORT',
      count_difference: -1,
    });
    expect((await intakeOf(intake.id)).version).toBeGreaterThan(version);
    const found = await parcelOf(third?.id ?? '');
    expect(found).toMatchObject({ state: 'ARRIVED', arrived_by: finder.principalId });
    expect(found.missing_marked_at).not.toBeNull();
    // The last one found matches the expected number, and the intake is still the senior's to close.
    rowsOf(await attempt(finder, tap(fourth?.id ?? '', true)));
    expect(await intakeOf(intake.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 4,
      count_variance: 'MATCH',
      count_difference: 0,
    });
  });

  // Break caught: a tap after the vendor is finished, an untap after it, a find while no case is open or once it was closed, or after itemizing has started; each with the rule it is refused by.
  it('names the rule of each refusal once the vendor is finished', async () => {
    const { intake } = await finishedAsTapped(4, 2);
    const [one, , third, fourth] = await parcelsOf(intake.id);
    const receiver = staff(COUNT);
    expect(refusal(await attempt(receiver, tap(one?.id ?? '', false)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'check_in_finished',
    ]);
    rowsOf(await attempt(receiver, tap(third?.id ?? '', true)));
    // The senior closes the case: a parcel still missing is no longer found.
    rowsOf(await attempt(staff(OSD), adjudicate(intake.id, 'ACCEPTED')));
    expect(refusal(await attempt(receiver, tap(fourth?.id ?? '', true)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'check_in_finished',
    ]);
    await routes.admin.query(`update pickup_intake set state = 'ITEMIZING' where id = $1`, [
      intake.id,
    ]);
    expect(refusal(await attempt(receiver, tap(fourth?.id ?? '', true)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'itemization_started',
    ]);
  });
});

describe('finishCheckIn: "All N here", or as tapped (migration 0104)', () => {
  // Break caught: a finish that takes the number the officer counted on trust (a number that is not what the photos expect must refuse and record nothing), that does not check in the parcels not
  // yet tapped, that writes a count that is not the number that arrived, that does not make the System's move in the same change, that is allowed twice, or after itemizing has started.
  it('"all here" needs the officer’s own number to be the number expected, checks in every parcel left, and clears a clean intake in the one change', async () => {
    const photo = await photoIntake(3);
    const officer = staff(COUNT);
    rowsOf(await attempt(officer, tap(photo.parcels[0]?.id ?? '', true)));
    expect(refusal(await attempt(officer, finish(photo.id, true, 2)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'count_changed',
    ]);
    expect(refusal(await attempt(officer, finish(photo.id, true, null)))[0]).toBe('22023');
    expect(refusal(await attempt(officer, finish(photo.id, true, 0)))[0]).toBe('22023');
    expect(refusal(await attempt(officer, finish(photo.id, false, 3)))[0]).toBe('22023');
    expect((await parcelsOf(photo.id)).map((parcel) => parcel.state)).toEqual([
      'ARRIVED',
      'EXPECTED',
      'EXPECTED',
    ]);
    expect((await intakeOf(photo.id)).state).toBe('AWAITING_COUNT');

    expect(rowsOf(await attempt(officer, finish(photo.id, true, 3)))).toEqual([
      {
        previous_state: 'AWAITING_COUNT',
        resulting_state: 'READY_FOR_ITEMIZATION',
        expected_count: 3,
        received_count: 3,
        missing_count: 0,
        extra_count: 0,
        resulting_variance: 'MATCH',
      },
    ]);
    expect((await parcelsOf(photo.id)).map((parcel) => parcel.state)).toEqual([
      'ARRIVED',
      'ARRIVED',
      'ARRIVED',
    ]);
    const counted = await intakeOf(photo.id);
    expect(counted).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      physical_count: 3,
      count_variance: 'MATCH',
      count_difference: 0,
      counted_by: officer.principalId,
    });
    expect(secondsSince(counted.counted_at)).toBeLessThan(120);
    expect(refusal(await attempt(officer, finish(photo.id, true, 3)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'check_in_finished',
    ]);
    expect(refusal(await attempt(officer, finish(photo.id, false)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'check_in_finished',
    ]);
    await routes.admin.query(`update pickup_intake set state = 'ITEMIZING' where id = $1`, [
      photo.id,
    ]);
    expect(refusal(await attempt(officer, finish(photo.id, false)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'itemization_started',
    ]);
  });

  // Break caught: a finish as tapped that does not send a missing parcel to the senior, that writes a count that is not the number that arrived, that is not against the expected number (the door
  // photos), or whose variance is not the sign of the difference; an extra and a missing parcel of equal number that read as a clean count.
  it('as tapped, takes the untapped to missing and sends the case to the senior: short, over, and a missing parcel and an extra of equal number', async () => {
    const short = await finishedAsTapped(3, 1);
    expect(await intakeOf(short.intake.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 1,
      count_variance: 'SHORT',
      count_difference: -2,
    });
    expect((await parcelsOf(short.intake.id)).map((parcel) => parcel.state)).toEqual([
      'ARRIVED',
      'MISSING',
      'MISSING',
    ]);

    const none = await finishedAsTapped(2, 0);
    expect(await intakeOf(none.intake.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 0,
      count_variance: 'SHORT',
      count_difference: -2,
    });

    // A missing parcel and an extra of equal number: the count equals the expectation, and the case goes to the senior all the same.
    const equal = await photoIntake(3);
    const officer = staff(COUNT);
    rowsOf(await attempt(officer, tap(equal.parcels[0]?.id ?? '', true)));
    rowsOf(await attempt(officer, tap(equal.parcels[1]?.id ?? '', true)));
    const extraPhoto = await intakeEvidence(equal.id, officer.principalId, 'OSD');
    rowsOf(await attempt(officer, addExtra(equal.id, randomUUID(), extraPhoto)));
    expect(rowsOf(await attempt(officer, finish(equal.id, false)))).toEqual([
      {
        previous_state: 'AWAITING_COUNT',
        resulting_state: 'RECONCILIATION_REQUIRED',
        expected_count: 3,
        received_count: 3,
        missing_count: 1,
        extra_count: 1,
        resulting_variance: 'MATCH',
      },
    ]);
    expect(await intakeOf(equal.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 3,
      count_variance: 'MATCH',
      count_difference: 0,
    });
  });

  // Break caught: a finish of a blind-count intake (it is counted, not checked in), of another hub's intake, of one that does not exist, by a reader, the adjudicator or a rider.
  it('is a receiver’s act on a photo intake of the hubs of the grant, and a blind-count intake is counted instead', async () => {
    const photo = await photoIntake(2);
    const blind = await blindIntake();
    expect(refusal(await attempt(staff(COUNT), finish(blind.id, false)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'blind_count_intake',
    ]);
    for (const [name, context] of [
      ['a reader', staff(READ)],
      ['the adjudicator', staff(OSD)],
      ['the rider of the handover', rider(photo.riderId, HANDOVER)],
    ] as const) {
      expect(refusal(await attempt(context, finish(photo.id, false)))[0], name).toBe('42501');
    }
    expect(refusal(await attempt(staff(COUNT, [HUB_B]), finish(photo.id, false)))[0]).toBe('42501');
    expect(refusal(await attempt(staff(COUNT), finish(randomUUID(), false)))[0]).toBe('42501');
    expect((await intakeOf(photo.id)).state).toBe('AWAITING_COUNT');
  });
});

describe('addExtraParcel: a parcel on the table that no photo shows (migration 0104)', () => {
  // Break caught: an extra without a stored photo of this intake that no other parcel uses (a record that is pending, another purpose, another intake's, a colleague's, used already), one that moves the
  // intake's version before the vendor is finished, that is not placed after the last parcel, that "all here" accepts, or that a void does not take out of the count.
  it('takes a stored photo of the intake once, places the extra after the last parcel, moves no version before the finish, and is voided by the receiver', async () => {
    const photo = await photoIntake(3);
    const officer = staff(COUNT);
    const mine = await intakeEvidence(photo.id, officer.principalId, 'OSD');
    const before = await intakeOf(photo.id);
    const extra = randomUUID();
    expect(rowsOf(await attempt(officer, addExtra(photo.id, extra, mine)))).toEqual([
      {
        extra_parcel_id: extra,
        extra_parcel_ordinal: 4,
        extra_intake_state: 'AWAITING_COUNT',
        extra_counted: false,
      },
    ]);
    const parcel = await parcelOf(extra);
    expect(parcel).toMatchObject({
      origin: 'HUB_EXTRA',
      state: 'ARRIVED',
      ordinal: 4,
      hub_photo_evidence_id: mine,
      door_photo_evidence_id: null,
      arrived_by: officer.principalId,
    });
    expect(secondsSince(parcel.arrived_at)).toBeLessThan(120);
    expect((await intakeOf(photo.id)).version).toBe(before.version);

    const refused = async (evidence: string): Promise<[string | undefined, string | undefined]> => {
      const result = await attempt(officer, addExtra(photo.id, randomUUID(), evidence));
      return [refusal(result)[0], refusal(result)[1]];
    };
    const pending = await intakeEvidence(photo.id, officer.principalId, 'OSD', 'PENDING_UPLOAD');
    const conditionPhoto = await intakeEvidence(photo.id, officer.principalId, 'CONDITION');
    const colleagues = await intakeEvidence(photo.id, randomUUID(), 'OSD');
    const other = await photoIntake(2);
    const elsewhere = await intakeEvidence(other.id, officer.principalId, 'OSD');
    for (const [name, evidence] of [
      ['one that is used already', mine],
      ['one that is pending', pending],
      ['one of another purpose', conditionPhoto],
      ['a colleague’s', colleagues],
      ['another intake’s', elsewhere],
      ['one that is not there', randomUUID()],
    ] as const) {
      expect(await refused(evidence), name).toEqual(['23514', 'EVIDENCE_NOT_STORED']);
    }
    expect(await parcelsOf(photo.id)).toHaveLength(4);

    // "All here" is not said of a pile with an extra; the void takes the extra out, and the officer can say it.
    expect(refusal(await attempt(officer, finish(photo.id, true, 3)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'has_extra_parcels',
    ]);
    expect(rowsOf(await attempt(officer, tap(extra, false)))[0]).toMatchObject({
      parcel_previous_state: 'ARRIVED',
      parcel_resulting_state: 'VOID',
    });
    expect(await parcelOf(extra)).toMatchObject({ state: 'VOID', arrived_by: officer.principalId });
    expect(rowsOf(await attempt(officer, finish(photo.id, true, 3)))[0]).toMatchObject({
      resulting_state: 'READY_FOR_ITEMIZATION',
      received_count: 3,
      extra_count: 0,
    });
  });

  // Break caught: an extra added after the vendor is finished that is not counted at once (the case would hide it), that moves the case out of reconciliation, that is allowed to a case that was
  // resolved or once itemizing has started, with the rule it is refused by.
  it('is counted at once while the case is open, and refused to a case that was resolved and after itemizing has started', async () => {
    const { intake } = await finishedAsTapped(3, 3);
    // Three arrived and nothing missing: clean, so cleared. A finish as tapped with all tapped is "all here" by another road.
    expect((await intakeOf(intake.id)).state).toBe('READY_FOR_ITEMIZATION');
    const officer = staff(COUNT);
    const late = await intakeEvidence(intake.id, officer.principalId, 'OSD');
    expect(refusal(await attempt(officer, addExtra(intake.id, randomUUID(), late)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'check_in_finished',
    ]);

    const open = await finishedAsTapped(3, 2);
    const photo = await intakeEvidence(open.intake.id, open.officer.principalId, 'OSD');
    const extra = randomUUID();
    expect(rowsOf(await attempt(open.officer, addExtra(open.intake.id, extra, photo)))).toEqual([
      {
        extra_parcel_id: extra,
        extra_parcel_ordinal: 4,
        extra_intake_state: 'RECONCILIATION_REQUIRED',
        extra_counted: true,
      },
    ]);
    expect(await intakeOf(open.intake.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 3,
      count_variance: 'MATCH',
    });
    await routes.admin.query(
      `update pickup_intake set state = 'READY_FOR_ITEMIZATION' where id = $1`,
      [open.intake.id],
    );
    await routes.admin.query(`update pickup_intake set state = 'ITEMIZING' where id = $1`, [
      open.intake.id,
    ]);
    const after = await intakeEvidence(open.intake.id, open.officer.principalId, 'OSD');
    expect(
      refusal(await attempt(open.officer, addExtra(open.intake.id, randomUUID(), after))),
    ).toEqual(['23514', 'STATE_CONFLICT', 'itemization_started']);
  });

  // Break caught: an extra on a blind-count intake, one added by a reader, the adjudicator or a rider, or on another hub's intake.
  it('is a receiver’s act on a photo intake of the hubs of the grant', async () => {
    const photo = await photoIntake(2);
    const blind = await blindIntake();
    const officer = staff(COUNT);
    const evidence = await intakeEvidence(photo.id, officer.principalId, 'OSD');
    const blindEvidence = await intakeEvidence(blind.id, officer.principalId, 'OSD');
    expect(
      refusal(await attempt(officer, addExtra(blind.id, randomUUID(), blindEvidence))),
    ).toEqual(['23514', 'STATE_CONFLICT', 'blind_count_intake']);
    for (const [name, context] of [
      ['a reader', staff(READ)],
      ['the adjudicator', staff(OSD)],
      ['the rider of the handover', rider(photo.riderId, HANDOVER)],
      ['another hub’s receiver', staff(COUNT, [HUB_B])],
    ] as const) {
      expect(
        refusal(await attempt(context, addExtra(photo.id, randomUUID(), evidence)))[0],
        name,
      ).toBe('42501');
    }
    expect(await parcelsOf(photo.id)).toHaveLength(2);
  });
});

describe('correctIntakeCount: a senior officer’s correction (migration 0104; D-D8)', () => {
  // Break caught: a correction that needs no reason, that is open to the receiver, that takes a body of the other mode (or both, or neither), a parcel that is not the intake's, a change the machine
  // does not allow, the same parcel twice, a change that changes nothing; one that does not recompute the count, the difference and the variance, does not route the intake again by the rule,
  // loses the officer and the moment of the count, or does not say the old and the new numbers and the parcels changed.
  it('corrects a photo intake’s parcels with a reason: recomputes the count, routes the intake again and says what changed', async () => {
    const { intake } = await finishedAsTapped(3, 2);
    const [one, two, missing] = await parcelsOf(intake.id);
    const counted = await intakeOf(intake.id);
    const senior = staff(OSD);
    const ok = [{ parcel_id: missing?.id ?? '', state: 'ARRIVED' }];

    expect(refusal(await attempt(staff(COUNT), correct(intake.id, 'a recount', ok, null)))[0]).toBe(
      '42501',
    );
    expect(refusal(await attempt(staff(READ), correct(intake.id, 'a recount', ok, null)))[0]).toBe(
      '42501',
    );
    expect(
      refusal(await attempt(staff(OSD, [HUB_B]), correct(intake.id, 'a recount', ok, null)))[0],
    ).toBe('42501');
    for (const reason of [null, '', '   ']) {
      expect(
        refusal(await attempt(senior, correct(intake.id, reason, ok, null))),
        String(reason),
      ).toEqual(['23514', 'REASON_REQUIRED', undefined]);
    }
    for (const [name, changes, physical] of [
      ['the other mode’s member', ok, 3],
      ['neither', null, null],
      ['an empty list', [], null],
    ] as const) {
      expect(
        refusal(await attempt(senior, correct(intake.id, 'a recount', changes, physical))),
        name,
      ).toEqual(['23514', 'VALIDATION_FAILED', 'mode_mismatch']);
    }
    for (const [name, changes] of [
      [
        'a parcel of another intake',
        [
          {
            parcel_id: (await parcelsOf((await photoIntake(2)).id))[0]?.id ?? '',
            state: 'ARRIVED',
          },
        ],
      ],
      ['a parcel that is not there', [{ parcel_id: randomUUID(), state: 'ARRIVED' }]],
      ['a door parcel made void', [{ parcel_id: missing?.id ?? '', state: 'VOID' }]],
      ['a state that is not one', [{ parcel_id: missing?.id ?? '', state: 'EXPECTED' }]],
      [
        'the same parcel twice',
        [
          { parcel_id: missing?.id ?? '', state: 'ARRIVED' },
          { parcel_id: missing?.id ?? '', state: 'MISSING' },
        ],
      ],
      ['a change that changes nothing', [{ parcel_id: one?.id ?? '', state: 'ARRIVED' }]],
      [
        'two parcels swapped, the number the same',
        [
          { parcel_id: one?.id ?? '', state: 'MISSING' },
          { parcel_id: missing?.id ?? '', state: 'ARRIVED' },
        ],
      ],
    ] as const) {
      expect(
        refusal(await attempt(senior, correct(intake.id, 'a recount', changes, null)))[0],
        name,
      ).toBe('22023');
    }
    expect(await intakeOf(intake.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 2,
    });
    expect((await parcelOf(missing?.id ?? '')).state).toBe('MISSING');

    expect(
      rowsOf(await attempt(senior, correct(intake.id, 'a recount', ok, null))).map((row) => ({
        ...row,
        changed: jsonOf(row.changed),
      })),
    ).toEqual([
      {
        previous_state: 'RECONCILIATION_REQUIRED',
        resulting_state: 'READY_FOR_ITEMIZATION',
        old_received: 2,
        new_received: 3,
        old_variance: 'SHORT',
        new_variance: 'MATCH',
        changed: [{ parcel_id: missing?.id, from: 'MISSING', to: 'ARRIVED' }],
      },
    ]);
    const corrected = await intakeOf(intake.id);
    expect(corrected).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      physical_count: 3,
      count_variance: 'MATCH',
      count_difference: 0,
      counted_by: counted.counted_by,
    });
    expect(corrected.counted_at).toEqual(counted.counted_at);
    expect(await parcelOf(missing?.id ?? '')).toMatchObject({
      state: 'ARRIVED',
      arrived_by: senior.principalId,
    });

    // The same intake corrected again: an arrived door parcel that did not arrive. The case opens again.
    expect(
      rowsOf(
        await attempt(
          senior,
          correct(
            intake.id,
            'it was not there',
            [{ parcel_id: two?.id ?? '', state: 'MISSING' }],
            null,
          ),
        ),
      )[0],
    ).toMatchObject({
      previous_state: 'READY_FOR_ITEMIZATION',
      resulting_state: 'RECONCILIATION_REQUIRED',
      old_received: 3,
      new_received: 2,
      old_variance: 'MATCH',
      new_variance: 'SHORT',
    });
  });

  // Break caught: a count of a blind-count intake that the receiver can change, that is not compared with the declaration by the database, that is routed by anything but the one rule, a correction of
  // a number that is the same, one with a negative number or one that names parcels; a correction after itemizing has started.
  it('corrects a blind count’s number, routes the intake again, and refuses what is not a correction', async () => {
    const blind = await blindIntake(3);
    const senior = staff(OSD);
    rowsOf(await attempt(staff(COUNT), blindCount(blind.id, 1)));
    expect((await intakeOf(blind.id)).state).toBe('RECONCILIATION_REQUIRED');
    expect(refusal(await attempt(senior, correct(blind.id, 'a recount', null, null)))).toEqual([
      '23514',
      'VALIDATION_FAILED',
      'mode_mismatch',
    ]);
    expect(
      refusal(
        await attempt(
          senior,
          correct(blind.id, 'a recount', [{ parcel_id: randomUUID(), state: 'ARRIVED' }], null),
        ),
      ),
    ).toEqual(['23514', 'VALIDATION_FAILED', 'mode_mismatch']);
    expect(refusal(await attempt(senior, correct(blind.id, 'a recount', null, 1)))[0]).toBe(
      '22023',
    );
    expect(refusal(await attempt(senior, correct(blind.id, 'a recount', null, -1)))[0]).toBe(
      '22023',
    );
    expect(refusal(await attempt(staff(COUNT), correct(blind.id, 'a recount', null, 3)))[0]).toBe(
      '42501',
    );
    expect(
      rowsOf(await attempt(senior, correct(blind.id, 'the officer miscounted', null, 3))).map(
        (row) => ({ ...row, changed: jsonOf(row.changed) }),
      ),
    ).toEqual([
      {
        previous_state: 'RECONCILIATION_REQUIRED',
        resulting_state: 'READY_FOR_ITEMIZATION',
        old_received: 1,
        new_received: 3,
        old_variance: 'SHORT',
        new_variance: 'MATCH',
        changed: [],
      },
    ]);
    expect(await intakeOf(blind.id)).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      physical_count: 3,
      count_variance: 'MATCH',
      count_difference: 0,
    });
    expect(rowsOf(await attempt(senior, correct(blind.id, 'again', null, 4)))[0]).toMatchObject({
      resulting_state: 'RECONCILIATION_REQUIRED',
      new_variance: 'OVER',
    });
    await routes.admin.query(
      `update pickup_intake set state = 'READY_FOR_ITEMIZATION' where id = $1`,
      [blind.id],
    );
    await routes.admin.query(`update pickup_intake set state = 'ITEMIZING' where id = $1`, [
      blind.id,
    ]);
    expect(refusal(await attempt(senior, correct(blind.id, 'too late', null, 3)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'itemization_started',
    ]);
    // An intake that has not been counted is not corrected.
    const waiting = await photoIntake(2);
    expect(
      refusal(
        await attempt(
          senior,
          correct(
            waiting.id,
            'early',
            [{ parcel_id: waiting.parcels[0]?.id ?? '', state: 'MISSING' }],
            null,
          ),
        ),
      ),
    ).toEqual(['23514', 'STATE_CONFLICT', 'intake_not_counted']);
  });

  // Break caught: a correction that clears an intake whose condition stands (the numbers match, so only the condition says): the senior's correction explains nothing away, and a damaged parcel is still
  // the senior's to decide.
  it('keeps a corrected intake with a condition that is not OK in reconciliation, though its count now matches', async () => {
    const photo = await photoIntake(3);
    const officer = staff(COUNT);
    const [one, two, three] = photo.parcels;
    rowsOf(await attempt(officer, tap(one?.id ?? '', true)));
    rowsOf(await attempt(officer, tap(two?.id ?? '', true)));
    const evidence = await intakeEvidence(photo.id, officer.principalId, 'CONDITION');
    rowsOf(await attempt(officer, condition(photo.id, one?.id ?? '', 'DAMAGED', [evidence])));
    rowsOf(await attempt(officer, finish(photo.id, false)));
    const corrected = await attempt(
      staff(OSD),
      correct(
        photo.id,
        'it was found behind the door',
        [{ parcel_id: three?.id ?? '', state: 'ARRIVED' }],
        null,
      ),
    );
    expect(rowsOf(corrected)[0]).toMatchObject({
      previous_state: 'RECONCILIATION_REQUIRED',
      resulting_state: 'RECONCILIATION_REQUIRED',
      old_received: 2,
      new_received: 3,
      old_variance: 'SHORT',
      new_variance: 'MATCH',
    });
    expect(await intakeOf(photo.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 3,
      count_variance: 'MATCH',
      condition: 'DAMAGED',
    });
  });

  // Break caught: a correction that clears an intake because the numbers now match while a parcel is still missing and an extra still stands (the rule of the System is one rule: a missing parcel
  // and an extra of equal number are reconciled too), here made by the senior taking an extra out.
  it('keeps an intake in reconciliation when a correction makes the numbers match while a parcel is missing and an extra stands', async () => {
    const photo = await photoIntake(3);
    const officer = staff(COUNT);
    const [one, two] = photo.parcels;
    rowsOf(await attempt(officer, tap(one?.id ?? '', true)));
    rowsOf(await attempt(officer, tap(two?.id ?? '', true)));
    const first = randomUUID();
    const second = randomUUID();
    rowsOf(
      await attempt(
        officer,
        addExtra(photo.id, first, await intakeEvidence(photo.id, officer.principalId, 'OSD')),
      ),
    );
    rowsOf(
      await attempt(
        officer,
        addExtra(photo.id, second, await intakeEvidence(photo.id, officer.principalId, 'OSD')),
      ),
    );
    // Two parcels and two extras arrived against three expected: over by one, with the third parcel missing.
    expect(rowsOf(await attempt(officer, finish(photo.id, false)))[0]).toMatchObject({
      resulting_state: 'RECONCILIATION_REQUIRED',
      received_count: 4,
      missing_count: 1,
      extra_count: 2,
      resulting_variance: 'OVER',
    });
    expect(
      rowsOf(
        await attempt(
          staff(OSD),
          correct(
            photo.id,
            'an extra added by mistake',
            [{ parcel_id: second, state: 'VOID' }],
            null,
          ),
        ),
      )[0],
    ).toMatchObject({
      previous_state: 'RECONCILIATION_REQUIRED',
      resulting_state: 'RECONCILIATION_REQUIRED',
      old_received: 4,
      new_received: 3,
      old_variance: 'OVER',
      new_variance: 'MATCH',
    });
    expect(await intakeOf(photo.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 3,
      count_variance: 'MATCH',
    });
    expect((await parcelOf(second)).state).toBe('VOID');
    expect((await parcelOf(first)).state).toBe('ARRIVED');
  });

  // Break caught: a photo intake that can be counted blind (the officer would be given nothing to check against and the parcels' states would not hold the count).
  it('refuses to count a photo intake blind, and counts a blind-count one', async () => {
    const photo = await photoIntake(2);
    expect(refusal(await attempt(staff(COUNT), blindCount(photo.id, 2)))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'photo_check_in',
    ]);
    expect((await intakeOf(photo.id)).state).toBe('AWAITING_COUNT');
    const blind = await blindIntake(2);
    expect(rowsOf(await attempt(staff(COUNT), blindCount(blind.id, 2)))).toHaveLength(1);
    expect((await intakeOf(blind.id)).state).toBe('READY_FOR_ITEMIZATION');
  });

  // Break caught: the declaration and the photos of a photo intake withheld before the count, as a blind-count intake's are, or served for a blind-count intake that has not been counted.
  it('serves a photo intake’s declaration and door photos from the start, and a blind-count intake’s only once it is counted', async () => {
    const photo = await photoIntake(3);
    const blind = await blindIntake(4);
    const ids = `array['${photo.id}', '${blind.id}']::uuid[]`;
    const read = (key: string) =>
      attempt(
        staff(key),
        `select intake_id, rider_declared_count, parcel_photo_ids from melarc.hub_intake_after_count(${ids})`,
      );
    for (const key of [READ, COUNT, OSD]) {
      const rows = rowsOf(await read(key));
      expect(rows, key).toHaveLength(1);
      expect(rows[0]).toMatchObject({ intake_id: photo.id, rider_declared_count: 3 });
      expect((rows[0]?.parcel_photo_ids as string[]).toSorted(), key).toEqual(
        photo.photos.toSorted(),
      );
    }
    rowsOf(await attempt(staff(COUNT), blindCount(blind.id, 4)));
    expect(rowsOf(await read(READ))).toHaveLength(2);
    expect(
      refusal(
        await attempt(
          rider(photo.riderId, HANDOVER),
          `select * from melarc.hub_intake_after_count(${ids})`,
        ),
      )[0],
    ).toBe('42501');
  });
});

describe('the condition is a parcel’s, and "Vendor told" a record (migration 0105)', () => {
  // Break caught: a condition of a photo intake with no parcel, of a parcel that has not arrived, of another intake's parcel, a second for the same parcel, one that overwrites the intake's own
  // condition (the first stands), a non-OK condition that does not stand in the finish's routing, a finding that is not about its parcel.
  it('is recorded once for each parcel that has arrived, whether or not the vendor is finished, and a condition that is not OK sends the finish to the senior', async () => {
    const photo = await photoIntake(3);
    const [one, two, three] = photo.parcels;
    const officer = staff(COUNT);
    rowsOf(await attempt(officer, tap(one?.id ?? '', true)));
    rowsOf(await attempt(officer, tap(two?.id ?? '', true)));
    const damage = await intakeEvidence(photo.id, officer.principalId, 'CONDITION');
    const damage2 = await intakeEvidence(photo.id, officer.principalId, 'CONDITION');

    expect(refusal(await attempt(officer, condition(photo.id, null, 'OTHER')))).toEqual([
      '23514',
      'VALIDATION_FAILED',
      'parcel_required',
    ]);
    expect(refusal(await attempt(officer, condition(photo.id, three?.id ?? '', 'OTHER')))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'parcel_not_arrived',
    ]);
    const other = await photoIntake(2);
    expect(
      refusal(await attempt(officer, condition(photo.id, other.parcels[0]?.id ?? '', 'OTHER')))[0],
    ).toBe('22023');
    expect(refusal(await attempt(officer, condition(photo.id, one?.id ?? '', 'DAMAGED')))).toEqual([
      '23514',
      'REASON_REQUIRED',
      undefined,
    ]);

    expect(
      rowsOf(await attempt(officer, condition(photo.id, one?.id ?? '', 'DAMAGED', [damage]))),
    ).toEqual([{ previous_state: 'AWAITING_COUNT', resulting_state: 'AWAITING_COUNT' }]);
    expect(await intakeOf(photo.id)).toMatchObject({
      state: 'AWAITING_COUNT',
      condition: 'DAMAGED',
    });
    expect(refusal(await attempt(officer, condition(photo.id, one?.id ?? '', 'OTHER')))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'condition_already_recorded',
    ]);
    // Another parcel's damage is recorded; the intake's own condition is the first found.
    rowsOf(await attempt(officer, condition(photo.id, two?.id ?? '', 'TAMPERED', [damage2])));
    expect(await intakeOf(photo.id)).toMatchObject({ condition: 'DAMAGED' });
    const findings = await findingsOf(photo.id);
    expect(findings.map((finding) => [finding.intake_parcel_id, finding.condition])).toEqual([
      [one?.id, 'DAMAGED'],
      [two?.id, 'TAMPERED'],
    ]);
    // The third parcel arrives and the vendor is finished: every parcel is here and the count matches, and a damaged parcel still stands in the routing.
    rowsOf(await attempt(officer, tap(three?.id ?? '', true)));
    expect(rowsOf(await attempt(officer, finish(photo.id, true, 3)))[0]).toMatchObject({
      resulting_state: 'RECONCILIATION_REQUIRED',
      resulting_variance: 'MATCH',
      missing_count: 0,
      extra_count: 0,
    });
  });

  // Break caught: a condition of a parcel that cannot be found after a clean finish (the commonest real case), that does not send the cleared intake back to the senior, that is recorded after
  // itemizing has started, or an OK finding that changes the intake.
  it('is found on a parcel of a cleared intake and sends it back to the senior; OK changes nothing; not after itemizing has started', async () => {
    const photo = await photoIntake(2);
    const officer = staff(COUNT);
    rowsOf(await attempt(officer, finish(photo.id, true, 2)));
    expect((await intakeOf(photo.id)).state).toBe('READY_FOR_ITEMIZATION');
    const [one, two] = await parcelsOf(photo.id);
    const evidence = await intakeEvidence(photo.id, officer.principalId, 'CONDITION');
    expect(rowsOf(await attempt(officer, condition(photo.id, one?.id ?? '', 'OK')))).toEqual([
      { previous_state: 'READY_FOR_ITEMIZATION', resulting_state: 'READY_FOR_ITEMIZATION' },
    ]);
    expect(await intakeOf(photo.id)).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      condition: 'OK',
    });
    expect(
      rowsOf(await attempt(officer, condition(photo.id, two?.id ?? '', 'DAMAGED', [evidence]))),
    ).toEqual([
      { previous_state: 'READY_FOR_ITEMIZATION', resulting_state: 'RECONCILIATION_REQUIRED' },
    ]);
    expect(await intakeOf(photo.id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      condition: 'DAMAGED',
    });
    const third = await photoIntake(2);
    rowsOf(await attempt(officer, finish(third.id, true, 2)));
    await routes.admin.query(`update pickup_intake set state = 'ITEMIZING' where id = $1`, [
      third.id,
    ]);
    expect(
      refusal(await attempt(officer, condition(third.id, third.parcels[0]?.id ?? '', 'OTHER'))),
    ).toEqual(['23514', 'STATE_CONFLICT', 'itemization_started']);
  });

  // Break caught: a blind-count intake that takes a parcel for its condition, that records a second condition (0097's rule, now one of two partial indexes), or whose refusals carry no rule.
  it('keeps a blind-count intake’s one condition for the intake, and takes no parcel for it', async () => {
    const blind = await blindIntake(3);
    const officer = staff(COUNT);
    expect(refusal(await attempt(officer, condition(blind.id, null, 'OTHER')))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'intake_not_counted',
    ]);
    rowsOf(await attempt(officer, blindCount(blind.id, 3)));
    expect(refusal(await attempt(officer, condition(blind.id, randomUUID(), 'OTHER')))[0]).toBe(
      '22023',
    );
    expect(rowsOf(await attempt(officer, condition(blind.id, null, 'OTHER')))).toEqual([
      { previous_state: 'READY_FOR_ITEMIZATION', resulting_state: 'RECONCILIATION_REQUIRED' },
    ]);
    expect(refusal(await attempt(officer, condition(blind.id, null, 'OTHER')))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'condition_already_recorded',
    ]);
  });

  // Break caught: a finding that is about a parcel when it is not a condition, a second finding of a condition for one parcel (or for a blind-count intake) or a second "Vendor told" that a writer
  // with no operation can append, a finding the guard does not judge for the writer that has no operation (the administrator's).
  it('holds the rules of the findings for every writer, and the one-of-each by a unique index', async () => {
    const { intake } = await finishedAsTapped(3, 3);
    const parcel = (await parcelsOf(intake.id))[0]?.id ?? '';
    const missing = await finishedAsTapped(3, 2);
    const absent = (await parcelsOf(missing.intake.id))[2]?.id ?? '';
    const insert = (columns: string, values: string, id = intake.id): string =>
      `insert into pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, kind, recorded_by, ${columns}) values (gen_random_uuid(), '${id}', '${HUB_A}', ${values}`;
    // The first is the check on the kind (a parcel is a condition's); the second the photo intake's parcel_required; the third the parcel that has not arrived; the fourth "Vendor told" first.
    const guards: string[] = [];
    for (const statement of [
      insert(
        'intake_parcel_id, condition',
        `'ADJUDICATION', gen_random_uuid(), '${parcel}', 'OK')`,
      ),
      insert('condition', `'CONDITION', gen_random_uuid(), 'OK')`),
      insert(
        'intake_parcel_id, condition',
        `'CONDITION', gen_random_uuid(), '${absent}', 'OTHER')`,
        missing.intake.id,
      ),
      insert('outcome, note', `'ADJUDICATION', gen_random_uuid(), 'VENDOR_NOTIFIED', 'told')`),
    ]) {
      const outcome = await adminCommit([statement]);
      guards.push(outcome === 'committed' ? outcome : (outcome.code ?? 'none'));
    }
    expect(guards).toEqual(['23514', '23514', '23514', '23514']);
    // One finding for a parcel, and one "Vendor told", by the index; the triggers are off for the statements that would be refused first.
    const twice = (columns: string, values: string, id: string) => [
      'set local session_replication_role = replica',
      insert(columns, values, id),
      insert(columns, values, id),
    ];
    expect(
      await adminCommit(
        twice(
          'intake_parcel_id, condition',
          `'CONDITION', gen_random_uuid(), '${parcel}', 'OK')`,
          intake.id,
        ),
      ),
    ).toMatchObject({ code: '23505' });
    expect(
      await adminCommit(
        twice(
          'outcome, note',
          `'ADJUDICATION', gen_random_uuid(), 'VENDOR_NOTIFIED', 'told')`,
          intake.id,
        ),
      ),
    ).toMatchObject({ code: '23505' });
    const blind = await blindIntake(3);
    expect(
      await adminCommit(twice('condition', `'CONDITION', gen_random_uuid(), 'OK')`, blind.id)),
    ).toMatchObject({ code: '23505' });
  });

  // Break caught: "Vendor told" that resolves a case (it is a record), that is accepted before a write-off or twice, that sets a condition, that moves a state or an intake's version, or that is refused
  // once itemizing has started; the outcomes that resolve a case judged for an intake that is not in reconciliation without the rule.
  it('records "Vendor told" after a write-off, once, with no condition, moving nothing, in any state past the count', async () => {
    const { intake } = await finishedAsTapped(3, 2);
    const senior = staff(OSD);
    expect(refusal(await attempt(senior, adjudicate(intake.id, 'VENDOR_NOTIFIED')))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'not_written_off',
    ]);
    rowsOf(await attempt(senior, adjudicate(intake.id, 'ESCALATED')));
    expect(refusal(await attempt(senior, adjudicate(intake.id, 'VENDOR_NOTIFIED')))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'not_written_off',
    ]);
    expect((await intakeOf(intake.id)).state).toBe('RECONCILIATION_REQUIRED');
    expect(rowsOf(await attempt(senior, adjudicate(intake.id, 'WRITTEN_OFF')))).toEqual([
      { previous_state: 'RECONCILIATION_REQUIRED', resulting_state: 'READY_FOR_ITEMIZATION' },
    ]);
    const settled = await intakeOf(intake.id);
    const evidence = await intakeEvidence(intake.id, senior.principalId, 'OSD');
    expect(
      refusal(
        await attempt(
          senior,
          adjudicate(intake.id, 'VENDOR_NOTIFIED', { condition: 'DAMAGED', evidence: [evidence] }),
        ),
      )[0],
    ).toBe('22023');
    expect(rowsOf(await attempt(senior, adjudicate(intake.id, 'VENDOR_NOTIFIED')))).toEqual([
      { previous_state: 'READY_FOR_ITEMIZATION', resulting_state: 'READY_FOR_ITEMIZATION' },
    ]);
    expect(await intakeOf(intake.id)).toEqual(settled);
    expect(refusal(await attempt(senior, adjudicate(intake.id, 'VENDOR_NOTIFIED')))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'vendor_already_told',
    ]);
    expect(refusal(await attempt(senior, adjudicate(intake.id, 'ACCEPTED')))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'not_awaiting_resolution',
    ]);
    expect((await findingsOf(intake.id)).map((finding) => finding.outcome)).toEqual([
      'ESCALATED',
      'WRITTEN_OFF',
      'VENDOR_NOTIFIED',
    ]);

    // After the write-off of another intake, itemizing begins, and the vendor is told all the same.
    const later = await finishedAsTapped(3, 1);
    rowsOf(await attempt(senior, adjudicate(later.intake.id, 'WRITTEN_OFF')));
    await routes.admin.query(`update pickup_intake set state = 'ITEMIZING' where id = $1`, [
      later.intake.id,
    ]);
    expect(rowsOf(await attempt(senior, adjudicate(later.intake.id, 'VENDOR_NOTIFIED')))).toEqual([
      { previous_state: 'ITEMIZING', resulting_state: 'ITEMIZING' },
    ]);
    expect((await intakeOf(later.intake.id)).state).toBe('ITEMIZING');
  });
});

describe('the evidence of an intake while its vendor is being checked in (migration 0104)', () => {
  const declare = (intakeId: string, by: string, purpose: string, hub: string = HUB_A): string =>
    `insert into evidence (id, owner_type, owner_id, purpose, captured_at, captured_by_actor, captured_by_principal_type, storage_ref, responsible_hub_id, access_rule, retention_policy,
                           content_type, byte_size, checksum_sha256, upload_ttl_seconds, upload_expires_at)
     values (gen_random_uuid(), 'PICKUP_INTAKE', '${intakeId}', '${purpose}', now() - interval '1 minute', '${by}', 'STAFF', 'ev/' || replace(gen_random_uuid()::text, '-', ''), '${hub}', 'SUBJECT_READERS', 'PICKUP_INTAKE_EVIDENCE',
             'image/jpeg', 12, repeat('a', 64), 900, now() + interval '15 minutes') returning id`;

  // Break caught: the receiver given no way to attach the photo of a damaged parcel or of an extra while the vendor is being checked in (the check-in is the work); the same freedom for a blind-count
  // intake that has not been counted, to the adjudicator, or after the case was resolved for an extra.
  it('lets the receiver declare a parcel’s condition photo and an extra’s photo while a photo intake is waiting, and keeps every other door as it was', async () => {
    const photo = await photoIntake(2);
    const blind = await blindIntake();
    const officer = staff(COUNT);
    for (const purpose of ['CONDITION', 'OSD']) {
      expect(
        rowsOf(await attempt(officer, declare(photo.id, officer.principalId, purpose))),
        purpose,
      ).toHaveLength(1);
      expect(
        refusal(await attempt(officer, declare(blind.id, officer.principalId, purpose)))[0],
        purpose,
      ).toBe('42501');
      expect(
        refusal(await attempt(staff(OSD), declare(photo.id, officer.principalId, purpose)))[0],
        purpose,
      ).toBe('42501');
      expect(
        refusal(await attempt(officer, declare(photo.id, randomUUID(), purpose)))[0],
        'another’s name',
      ).toBe('42501');
    }
    expect(
      refusal(
        await attempt(staff(COUNT, [HUB_B]), declare(photo.id, officer.principalId, 'OSD', HUB_B)),
      )[0],
    ).toBe('42501');
    // Resolved: a condition photo may still be made until itemizing starts, an extra's may not.
    rowsOf(await attempt(officer, finish(photo.id, true, 2)));
    expect(
      rowsOf(await attempt(officer, declare(photo.id, officer.principalId, 'CONDITION'))),
    ).toHaveLength(1);
    expect(refusal(await attempt(officer, declare(photo.id, officer.principalId, 'OSD')))[0]).toBe(
      '42501',
    );
    // The adjudicator's own photo of an adjudication, for an intake that has been counted.
    const senior = staff(OSD);
    expect(
      rowsOf(await attempt(senior, declare(photo.id, senior.principalId, 'OSD'))),
    ).toHaveLength(1);
  });
});

describe('the names of the receiving side (migration 0106)', () => {
  // Break caught: a name that is not the stop's snapshot of the vendor, the rider who handed the run over, or an officer on the intake; one that leaks a phone number or an e-mail address; one for an
  // intake of another hub; one asked by a key that does not read intakes, a rider or a vendor.
  it('answers the display names of the vendor, the rider and the officers of the intakes the caller may see, and nothing else', async () => {
    const real = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const photo = await photoIntake(2);
    const blind = await blindIntake();
    // A run of the same hub whose intake nobody asks about: its rider is in the caller's scope and is not named.
    const unasked = await blindIntake();
    const officer = staff(COUNT, [HUB_A], real.identity.id);
    rowsOf(await attempt(officer, tap(photo.parcels[0]?.id ?? '', true)));
    rowsOf(await attempt(officer, finish(photo.id, false)));
    const ask = (context: SecurityContext) =>
      attempt(
        context,
        `select party, party_id, intake_id, display_name from melarc.receiving_names(array['${photo.id}', '${blind.id}']::uuid[])`,
      );
    const [staffRow] = await routes.rows<{ full_name: string; work_email: string }>(
      `select full_name, work_email from staff_identity where id = $1`,
      [real.identity.id],
    );
    const riders = await routes.rows<{ id: string; full_name: string; phone: string }>(
      `select id, full_name, phone from rider_identity where id in ($1, $2)`,
      [photo.riderId, blind.riderId],
    );
    for (const key of [READ, COUNT, OSD]) {
      const rows = rowsOf(await ask(staff(key)));
      expect(rows, key).toHaveLength(5);
      expect(rows, key).toEqual(
        expect.arrayContaining([
          { party: 'VENDOR', party_id: null, intake_id: photo.id, display_name: 'Fixture Sender' },
          { party: 'VENDOR', party_id: null, intake_id: blind.id, display_name: 'Fixture Sender' },
          {
            party: 'STAFF',
            party_id: real.identity.id,
            intake_id: null,
            display_name: staffRow?.full_name,
          },
          ...riders.map((row) => ({
            party: 'RIDER',
            party_id: row.id,
            intake_id: null,
            display_name: row.full_name,
          })),
        ]),
      );
      for (const row of riders) expect(JSON.stringify(rows), key).not.toContain(row.phone);
      expect(JSON.stringify(rows), key).not.toContain(unasked.riderId);
      expect(JSON.stringify(rows), key).not.toContain(staffRow?.work_email ?? 'unreachable');
    }
    // Another hub sees no intake and so names nobody; a context that does not read intakes is refused.
    expect(rowsOf(await ask(staff(READ, [HUB_B])))).toEqual([]);
    for (const [name, context] of [
      ['a staff member of another key', staff('pickup.read')],
      ['the rider of the handover', rider(photo.riderId, HANDOVER)],
    ] as const) {
      expect(refusal(await ask(context))[0], name).toBe('42501');
    }
    expect(
      refusal(await attempt(staff(READ), `select * from melarc.receiving_names(null)`))[0],
    ).toBe('22023');
    // The context is put back when the function returns: the next statement of the same transaction is the officer's again, and sees the parcels the officer may see.
    const restored = await attemptAll(staff(READ), [
      `select count(*) from melarc.receiving_names(array['${photo.id}']::uuid[])`,
      `select count(*)::int as n from intake_parcel where pickup_intake_id = '${photo.id}'`,
    ]);
    expect(rowsOf(restored)).toEqual([{ n: 2 }]);
  });
});
