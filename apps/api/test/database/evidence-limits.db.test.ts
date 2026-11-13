import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guardReasonIn, serverErrorIn } from '../../src/platform/database/database-failures.js';
import {
  toContextSettings,
  type SecurityContext,
} from '../../src/platform/database/transaction-context.js';
import { SETTINGS } from '../../src/tools/seed/settings.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { startVendorRoutes, type VendorRoutes } from './support/vendor-routes.js';

/**
 * Run A2, migration `0085` (findings M1, M2 and L3 of the review of Run A; D-A8): what the database holds of an evidence record's **limits**, for every writer.
 *
 * - **The lifetime of an upload instruction and the size of the file** are the platform settings (`evidence_upload_authorization_ttl_minutes`,
 *   `evidence_upload_max_bytes`), and the guard of the record compares both with them, so a writer that is not the service cannot grant itself a longer
 *   instruction or a larger file. They are settings the owner changes without code: the database reads the same rows, so a changed value holds at once.
 * - **The tolerance on the moment of a capture** (`evidence_capture_clock_tolerance_minutes`, D-A8, 5 minutes) is a platform setting too, held where the
 *   moment is checked: a phone whose clock runs ahead is not refused for it, within the tolerance, and is beyond it.
 * - **The read of a request under the failure key** is the rider's own: an owner-run statement under a rider's context reaches the request of a stop on the
 *   rider's assigned run in progress, and no other (the policy of `0080` had no row condition).
 *
 * Each of these tests fails on the tree of Run A (`ac9f613`): the guard of `0080` accepted any positive lifetime and size and none ahead of the clock, there
 * was no tolerance setting, and the request policy admitted every request to an owner-run statement.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorOrganizationId: string;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorOrganizationId = (await routes.vendor()).row.organizationId;
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const FAILURE = 'pickup.failure.report';

const rider = (riderId: string, key: string = FAILURE): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'evidence-limits',
});

interface Result {
  readonly rows?: Record<string, unknown>[];
  readonly code?: string;
  readonly reason?: string;
}

async function attempt(context: SecurityContext, text: string): Promise<Result> {
  try {
    const rows = await routes.built.service.transactionWithContext(context, async (tx) => {
      return (await tx.execute(sql.raw(text))).rows;
    });
    return { rows };
  } catch (error) {
    const reason = guardReasonIn(error);
    return {
      code: serverErrorIn(error)?.code ?? 'other',
      ...(reason === undefined ? {} : { reason }),
    };
  }
}

const reached = (result: Result): Record<string, unknown> => {
  expect(result.code, JSON.stringify(result)).toBeUndefined();
  expect(result.rows?.length, JSON.stringify(result)).toBe(1);
  return result.rows?.[0] ?? {};
};
const refusedFor = (result: Result, reason: string): void => {
  expect(result.code, JSON.stringify(result)).toBe('23514');
  expect(result.reason, JSON.stringify(result)).toBe(reason);
};

const run = (): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'PENDING'],
  });

type Column = Record<string, string>;
/** The SQL text of a declaration by `riderId` for `stopId`; `over` replaces a column by its SQL literal. */
function declaration(riderId: string, stopId: string, over: Column = {}): string {
  const values: Column = {
    id: `'${randomUUID()}'`,
    owner_type: `'PICKUP_STOP'`,
    owner_id: `'${stopId}'`,
    purpose: `'COLLECTION_PROOF'`,
    captured_at: `now() - interval '1 minute'`,
    captured_by_actor: `'${riderId}'`,
    captured_by_principal_type: `'RIDER'`,
    storage_ref: `'ev/${randomBytes(16).toString('hex')}'`,
    access_rule: `'SUBJECT_READERS'`,
    retention_policy: `'PICKUP_STOP_EVIDENCE'`,
    content_type: `'image/jpeg'`,
    byte_size: '1000',
    checksum_sha256: `'${'a'.repeat(64)}'`,
    upload_ttl_seconds: '900',
    upload_expires_at: 'now()',
    ...over,
  };
  const names = Object.keys(values);
  return `insert into evidence (${names.join(', ')}) values (${names.map((name) => values[name]).join(', ')}) returning id, state`;
}

/** The setting changed for the length of `work`, and put back whatever `work` does. */
async function withSetting<T>(key: string, value: unknown, work: () => Promise<T>): Promise<T> {
  const before = await routes.admin.query<{ value: unknown }>(
    `select value from setting where key = $1`,
    [key],
  );
  if (before.rows.length !== 1) throw new Error(`the setting ${key} is not there`);
  await routes.admin.query(`update setting set value = $1::jsonb where key = $2`, [
    JSON.stringify(value),
    key,
  ]);
  try {
    return await work();
  } finally {
    await routes.admin.query(`update setting set value = $1::jsonb where key = $2`, [
      JSON.stringify(before.rows[0]?.value),
      key,
    ]);
  }
}

const TTL_KEY = 'evidence_upload_authorization_ttl_minutes';
const MAX_KEY = 'evidence_upload_max_bytes';
const TOLERANCE_KEY = 'evidence_capture_clock_tolerance_minutes';

describe('the lifetime of an upload instruction is the setting, for every writer (finding M1)', () => {
  it('accepts the lifetime the setting grants, or less, and refuses one second more', async () => {
    const arranged = await run();
    const stop = arranged.stops[0]?.id ?? '';
    const own = rider(arranged.rider.id);
    reached(
      await attempt(own, declaration(arranged.rider.id, stop, { upload_ttl_seconds: '900' })),
    );
    reached(await attempt(own, declaration(arranged.rider.id, stop, { upload_ttl_seconds: '60' })));
    refusedFor(
      await attempt(own, declaration(arranged.rider.id, stop, { upload_ttl_seconds: '901' })),
      'UPLOAD_LIFETIME_EXCEEDED',
    );
    // A lifetime of a year, as a writer that is not the service could ask for: it would make the instruction a bearer credential for a year.
    refusedFor(
      await attempt(
        own,
        declaration(arranged.rider.id, stop, { upload_ttl_seconds: String(365 * 86_400) }),
      ),
      'UPLOAD_LIFETIME_EXCEEDED',
    );
  });

  it('follows the setting when the owner changes it, at once and without a deploy', async () => {
    const arranged = await run();
    const stop = arranged.stops[0]?.id ?? '';
    const own = rider(arranged.rider.id);
    await withSetting(TTL_KEY, 10, async () => {
      reached(
        await attempt(own, declaration(arranged.rider.id, stop, { upload_ttl_seconds: '600' })),
      );
      refusedFor(
        await attempt(own, declaration(arranged.rider.id, stop, { upload_ttl_seconds: '900' })),
        'UPLOAD_LIFETIME_EXCEEDED',
      );
    });
    await withSetting(TTL_KEY, 20, async () => {
      reached(
        await attempt(own, declaration(arranged.rider.id, stop, { upload_ttl_seconds: '1200' })),
      );
    });
  });

  it('refuses when the setting is missing or is not a number, and invents no lifetime', async () => {
    const arranged = await run();
    const stop = arranged.stops[0]?.id ?? '';
    await withSetting(TTL_KEY, 'fifteen', async () => {
      refusedFor(
        await attempt(
          rider(arranged.rider.id),
          declaration(arranged.rider.id, stop, { upload_ttl_seconds: '60' }),
        ),
        'SETTING_MISSING',
      );
    });
  });
});

describe('the size of an upload is the setting, for every writer (finding M1)', () => {
  it('accepts the largest file the setting grants and refuses one byte more', async () => {
    const arranged = await run();
    const stop = arranged.stops[0]?.id ?? '';
    const own = rider(arranged.rider.id);
    reached(await attempt(own, declaration(arranged.rider.id, stop, { byte_size: '10485760' })));
    refusedFor(
      await attempt(own, declaration(arranged.rider.id, stop, { byte_size: '10485761' })),
      'UPLOAD_SIZE_EXCEEDED',
    );
    refusedFor(
      await attempt(own, declaration(arranged.rider.id, stop, { byte_size: '2147483647' })),
      'UPLOAD_SIZE_EXCEEDED',
    );
  });

  it('follows the setting when the owner lowers or raises it', async () => {
    const arranged = await run();
    const stop = arranged.stops[0]?.id ?? '';
    const own = rider(arranged.rider.id);
    await withSetting(MAX_KEY, 500_000, async () => {
      reached(await attempt(own, declaration(arranged.rider.id, stop, { byte_size: '500000' })));
      refusedFor(
        await attempt(own, declaration(arranged.rider.id, stop, { byte_size: '500001' })),
        'UPLOAD_SIZE_EXCEEDED',
      );
    });
    await withSetting(MAX_KEY, 20_971_520, async () => {
      reached(await attempt(own, declaration(arranged.rider.id, stop, { byte_size: '20971520' })));
    });
  });
});

describe('the moment of a capture may run ahead of the server by the tolerance setting (D-A8)', () => {
  it('seeds the tolerance as a platform setting of 5 minutes', async () => {
    const rows = await routes.admin.query<{
      value: unknown;
      scope: string;
      value_type: string;
      unit: string;
    }>(`select value, scope, value_type, unit from setting where key = $1`, [TOLERANCE_KEY]);
    expect(rows.rows).toEqual([
      { value: 5, scope: 'PLATFORM', value_type: 'integer', unit: 'minutes' },
    ]);
  });

  it('accepts a capture up to the tolerance ahead of the clock and refuses one past it', async () => {
    const arranged = await run();
    const stop = arranged.stops[0]?.id ?? '';
    const own = rider(arranged.rider.id);
    // `now()` is the start of the transaction and the guard reads the clock later, so the edge itself is inside the tolerance, deterministically.
    reached(
      await attempt(
        own,
        declaration(arranged.rider.id, stop, { captured_at: `now() + interval '5 minutes'` }),
      ),
    );
    reached(
      await attempt(
        own,
        declaration(arranged.rider.id, stop, { captured_at: `now() + interval '4 minutes'` }),
      ),
    );
    const past = await attempt(
      own,
      declaration(arranged.rider.id, stop, {
        captured_at: `now() + interval '5 minutes 10 seconds'`,
      }),
    );
    refusedFor(past, 'VALIDATION_FAILED');
    refusedFor(
      await attempt(
        own,
        declaration(arranged.rider.id, stop, { captured_at: `now() + interval '1 hour'` }),
      ),
      'VALIDATION_FAILED',
    );
  });

  it('follows the setting: none at 0, and the new tolerance when the owner changes it', async () => {
    const arranged = await run();
    const stop = arranged.stops[0]?.id ?? '';
    const own = rider(arranged.rider.id);
    await withSetting(TOLERANCE_KEY, 0, async () => {
      reached(await attempt(own, declaration(arranged.rider.id, stop, { captured_at: `now()` })));
      refusedFor(
        await attempt(
          own,
          declaration(arranged.rider.id, stop, { captured_at: `now() + interval '10 seconds'` }),
        ),
        'VALIDATION_FAILED',
      );
    });
    await withSetting(TOLERANCE_KEY, 1, async () => {
      reached(
        await attempt(
          own,
          declaration(arranged.rider.id, stop, { captured_at: `now() + interval '1 minute'` }),
        ),
      );
      refusedFor(
        await attempt(
          own,
          declaration(arranged.rider.id, stop, {
            captured_at: `now() + interval '1 minute 10 seconds'`,
          }),
        ),
        'VALIDATION_FAILED',
      );
    });
  });

  it('refuses when the setting is missing or invalid, and invents no tolerance', async () => {
    const arranged = await run();
    const stop = arranged.stops[0]?.id ?? '';
    for (const bad of ['five', -1, 2.5, null]) {
      await withSetting(TOLERANCE_KEY, bad, async () => {
        refusedFor(
          await attempt(
            rider(arranged.rider.id),
            declaration(arranged.rider.id, stop, { captured_at: `now() - interval '1 minute'` }),
          ),
          'SETTING_MISSING',
        );
      });
    }
  });

  it('gives a database seeded before it exactly the row a new seed writes (migration 0085 against the seed)', async () => {
    const file = resolve(
      import.meta.dirname,
      '../../migrations/0085_evidence_limits_held_by_the_guard.sql',
    );
    const data = readFileSync(file, 'utf8')
      .replaceAll('\r\n', '\n')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .find((statement) => statement.includes('DO $evidence_tolerance$'));
    if (data === undefined) throw new Error('the data statement of 0085 was not found');
    const columns = `key, scope, value_type, value, unit, description`;
    await routes.admin.query('begin');
    try {
      await routes.admin.query(`delete from setting where key = $1`, [TOLERANCE_KEY]);
      await routes.admin.query(data);
      const given = await routes.admin.query(`select ${columns} from setting where key = $1`, [
        TOLERANCE_KEY,
      ]);
      const seeded = SETTINGS.filter((setting) => setting.key === TOLERANCE_KEY).map((setting) => ({
        key: setting.key,
        scope: setting.scope,
        value_type: setting.valueType,
        value: setting.value,
        unit: setting.unit,
        description: setting.description,
      }));
      expect(seeded).toHaveLength(1);
      expect(given.rows).toEqual(seeded);
    } finally {
      await routes.admin.query('rollback');
    }
  });
});

describe('the request the failure key reaches is the rider’s own (finding L2)', () => {
  /** A statement run as the owner under a rider's context: the way the operations of the evidence read a request, which the runtime login never does. */
  async function asOwner(context: SecurityContext, text: string): Promise<string[]> {
    await routes.admin.query('begin');
    try {
      await routes.admin.query('set local role melarc_owner');
      for (const [name, value] of toContextSettings(context)) {
        await routes.admin.query('select set_config($1, $2, true)', [name, value]);
      }
      const result = await routes.admin.query<{ id: string }>(text);
      return result.rows.map((row) => row.id);
    } finally {
      await routes.admin.query('rollback');
    }
  }

  it('reaches the request of a stop on the rider’s assigned run in progress, and no other', async () => {
    const own = await run();
    const colleague = await run();
    const dispatched = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId,
      serviceDate: days.today,
      state: 'DISPATCHED',
      stops: 1,
      rider: own.rider,
    });
    const ids = [...own.stops, ...colleague.stops, ...dispatched.stops].map(
      (stop) => stop.requestId,
    );
    const seen = await asOwner(
      rider(own.rider.id),
      `select id from pickup_request where id = any('{${ids.join(',')}}'::uuid[])`,
    );
    expect(seen.toSorted()).toEqual(own.stops.map((stop) => stop.requestId).toSorted());
  });

  it('reaches nothing under another key, and nothing to the runtime login', async () => {
    const own = await run();
    const ids = own.stops.map((stop) => stop.requestId);
    const text = `select id from pickup_request where id = any('{${ids.join(',')}}'::uuid[])`;
    expect(await asOwner(rider(own.rider.id, 'pickup.run.execute'), text)).toEqual([]);
    const asLogin = await attempt(rider(own.rider.id), text);
    expect(asLogin.rows).toEqual([]);
  });
});
