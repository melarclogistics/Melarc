import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import { EvidenceSweep, evidenceSweepTask } from '../../src/platform/evidence/evidence-sweep.js';
import { createServiceLogger } from '../../src/platform/logging/create-logger.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, type ArrangedRun } from './support/runs.js';
import { systemContext } from './support/rls-fixture.js';
import { seedHubConfiguration } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { API } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.11, the sweep of abandoned captures, against a real PostgreSQL and as the delivery worker's own login under the `evidence_validation` capability: a record still
 * `PENDING_UPLOAD` whose upload window has closed becomes `EXPIRED` and is kept; a record whose window is open, and a record already stored, are not touched; a batch is a batch;
 * and the capability can do nothing else (it reads the id, the state and the end of the window of the pending records, writes the state to `EXPIRED` once the window has passed,
 * and has no other column, no other state and no delete).
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let work: BuiltService;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  work = buildService(routes.database, { poolMax: 3, login: WORKER_RUNTIME_ROLE });
}, 180_000);

afterAll(async () => {
  await work.close();
  await routes.stop();
});

/** The sweep as the worker runs it, over the worker's own login. */
const sweep = (batchSize?: number) =>
  new EvidenceSweep({
    database: work.service,
    clock: routes.kit.clock,
    ...(batchSize === undefined ? {} : { batchSize }),
  });

/** Leaves nothing due, so that a test counts only what it made. */
async function drain(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    if (!(await sweep().runOnce()).more) return;
  }
}
beforeEach(drain);

const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

let arranged: ArrangedRun;
beforeAll(async () => {
  arranged = await arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 1,
    stopStates: ['ARRIVED'],
  });
}, 60_000);

/** A record the rider declared through the operation: pending, with an open window. */
async function declared(): Promise<string> {
  const stop = arranged.stops[0];
  if (stop === undefined) throw new Error('stop');
  const response = await arranged.rider.client.post(
    `${API}/evidence`,
    {
      owner_type: 'PICKUP_STOP',
      owner_id: stop.id,
      purpose: 'COLLECTION_PROOF',
      captured_at: new Date(Date.now() - 60_000).toISOString(),
      content_type: 'image/jpeg',
      byte_size: JPEG.length,
      checksum_sha256: createHash('sha256').update(JPEG).digest('hex'),
    },
    { headers: { 'Idempotency-Key': randomUUID() } },
  );
  expect(response.status, response.text).toBe(200);
  return (response.json() as { evidence: { id: string } }).evidence.id;
}

/** A statement run with the record's guard and version triggers off, as a test that moves time needs; they are on again when it ends. */
async function arrange(statement: string, values: unknown[]): Promise<void> {
  await routes.admin.query('alter table evidence disable trigger evidence_guard');
  await routes.admin.query('alter table evidence disable trigger evidence_version');
  try {
    await routes.admin.query(statement, values);
  } finally {
    await routes.admin.query('alter table evidence enable trigger evidence_version');
    await routes.admin.query('alter table evidence enable trigger evidence_guard');
  }
}

const age = (id: string) =>
  arrange(
    `update evidence set created_at = now() - interval '2 hours', upload_expires_at = now() - interval '1 hour' where id = $1`,
    [id],
  );
const store = (id: string) =>
  arrange(
    `update evidence set state = 'STORED', uploaded_at = now(), validated_signature = 'JPEG' where id = $1`,
    [id],
  );

const stateOf = async (id: string) =>
  (
    await routes.rows<{ state: string; version: number }>(
      `select state, version from evidence where id = $1`,
      [id],
    )
  )[0];
const total = async () =>
  (await routes.rows<{ n: number }>(`select count(*)::int as n from evidence`))[0]?.n ?? 0;

describe('the sweep marks abandoned captures expired and keeps them', () => {
  // Break caught: a record expired before its window closed, a stored record expired, a record deleted, or a second run that changes anything.
  it('expires a pending record whose window has closed, leaves an open window and a stored record alone, and deletes nothing', async () => {
    const due = await declared();
    const open = await declared();
    const kept = await declared();
    await store(kept);
    await age(kept);
    await age(due);
    const before = await total();

    expect(await sweep().runOnce()).toEqual({ expired: 1, more: false });

    expect(await stateOf(due)).toEqual({ state: 'EXPIRED', version: 2 });
    expect((await stateOf(open))?.state).toBe('PENDING_UPLOAD');
    expect((await stateOf(kept))?.state).toBe('STORED');
    expect(await total()).toBe(before);
    expect(await sweep().runOnce()).toEqual({ expired: 0, more: false });
    expect((await stateOf(due))?.state).toBe('EXPIRED');
  });

  // Break caught: a batch that is not the size asked for, a run that does not say there is more, or a task that stops after one round.
  it('takes a batch at a time, says when there may be more, and the task goes on until there is none', async () => {
    const ids = [await declared(), await declared(), await declared()];
    for (const id of ids) await age(id);

    expect(await sweep(2).runOnce()).toEqual({ expired: 2, more: true });
    expect(await sweep(2).runOnce()).toEqual({ expired: 1, more: false });

    const more = [await declared(), await declared(), await declared()];
    for (const id of more) await age(id);
    const raw: string[] = [];
    const task = evidenceSweepTask({
      sweep: sweep(2),
      logger: createServiceLogger({
        service: 'melarc-delivery-worker',
        level: 'debug',
        appEnv: 'local',
        destination: { write: (line: string) => void raw.push(line) },
      }),
    });
    await task.run(new AbortController().signal);
    for (const id of more) expect((await stateOf(id))?.state).toBe('EXPIRED');
    const lines = raw.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([expect.objectContaining({ evidence_expired: 3 })]);
    // The log says a count and nothing about a record: no identifier, no storage reference.
    expect(raw.join('')).not.toContain('ev/');
    for (const id of more) expect(raw.join('')).not.toContain(id);
  });

  // Break caught: two sweeps at once that expire a record twice, or one that waits for the other.
  it('lets two sweeps run at once and gives each record to one of them', async () => {
    const ids = [await declared(), await declared(), await declared(), await declared()];
    for (const id of ids) await age(id);
    const [one, two] = await Promise.all([sweep(2).runOnce(), sweep(2).runOnce()]);
    expect(one.expired + two.expired).toBe(4);
    for (const id of ids) expect(await stateOf(id)).toEqual({ state: 'EXPIRED', version: 2 });
  });

  // Break caught: a sweep that waits for a record another transaction holds (a rider’s completion, another sweep), so that one slow transaction holds back every other abandoned
  // capture; or one that gives up on the held record for good.
  it('skips a record another transaction holds, expires the rest, and takes the held one at the next run', async () => {
    const held = await declared();
    const free = await declared();
    await age(held);
    await age(free);
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select id from evidence where id = $1 for update`, [held]);
      const outcome = await Promise.race([
        sweep().runOnce(),
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('waited');
          }, 5_000);
        }),
      ]);
      expect(outcome, 'the sweep waited for a record another transaction holds').toEqual({
        expired: 1,
        more: false,
      });
      expect((await stateOf(free))?.state).toBe('EXPIRED');
      expect((await stateOf(held))?.state).toBe('PENDING_UPLOAD');
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
    expect(await sweep().runOnce()).toEqual({ expired: 1, more: false });
    expect((await stateOf(held))?.state).toBe('EXPIRED');
  });
});

describe('the capability can do nothing else', () => {
  const attempt = async (
    text: string,
    capability: 'evidence_validation' | 'credential_delivery' = 'evidence_validation',
  ) => {
    try {
      const result = await work.service.transactionWithContext(systemContext(capability), (tx) =>
        tx.execute(sql.raw(text)),
      );
      return { code: 'ok', rows: result.rows.length, count: result.rowCount ?? 0 };
    } catch (error) {
      return { code: serverErrorIn(error)?.code ?? 'other', rows: 0, count: 0 };
    }
  };

  // Break caught: a lane that reads the storage reference or the hash, writes another column, stores a record, expires a window still open, deletes, or is seen by another capability.
  it('reads the pending records’ state and window and writes the state to EXPIRED once the window has passed, and no more', async () => {
    const pending = await declared();
    const aged = await declared();
    await age(aged);

    expect(
      (await attempt(`select id, state, upload_expires_at from evidence where id = '${pending}'`))
        .rows,
    ).toBe(1);
    // A column the grant does not name, a column it names for reading only, a delete, and a store.
    expect((await attempt(`select storage_ref from evidence`)).code).toBe('42501');
    expect((await attempt(`select checksum_sha256 from evidence`)).code).toBe('42501');
    expect((await attempt(`update evidence set byte_size = 1 where id = '${aged}'`)).code).toBe(
      '42501',
    );
    expect(
      (await attempt(`update evidence set upload_expires_at = now() where id = '${pending}'`)).code,
    ).toBe('42501');
    expect((await attempt(`delete from evidence where id = '${aged}'`)).code).toBe('42501');
    expect(
      (await attempt(`update evidence set state = 'STORED' where id = '${pending}'`)).code,
    ).toBe('42501');
    // A window still open does not expire, whoever asks: the record's guard says so.
    expect(
      (await attempt(`update evidence set state = 'EXPIRED' where id = '${pending}'`)).code,
    ).toBe('23514');
    // Another capability of the same worker sees none of it.
    expect(
      (await attempt(`select id from evidence where id = '${pending}'`, 'credential_delivery'))
        .rows,
    ).toBe(0);
    // And what the lane may do is what the sweep does.
    expect(await stateOf(pending)).toEqual({ state: 'PENDING_UPLOAD', version: 1 });
    expect(
      (await attempt(`update evidence set state = 'EXPIRED' where id = '${aged}'`)).count,
    ).toBe(1);
    expect((await stateOf(aged))?.state).toBe('EXPIRED');
    // Expired is final, for the lane too.
    expect(
      (await attempt(`update evidence set state = 'EXPIRED' where id = '${aged}'`)).count,
    ).toBe(0);
  });
});
