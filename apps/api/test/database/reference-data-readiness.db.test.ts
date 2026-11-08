import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { seedReferenceData } from './support/seeded.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * Readiness over a database the reference seed has not filled (the owner's decision of 25 October 2026): the migrations had run on the
 * owner's database and `db:seed` had not, `/readyz` said ready, and every sign-in answered 503 for want of a setting. The instance is
 * now not ready, with a reason of its own, until the seed has run, and ready the moment it has, with no restart: the probe asks the
 * real database each time.
 */
let database: TestDatabase;
let kit: IntegrationKit;

beforeAll(async () => {
  database = await createTestDatabase();
  kit = await startIntegrationKit(database, { poolMax: 2 });
});

afterAll(async () => {
  await kit.stop();
  await database.drop();
});

describe('GET /readyz over a real database', () => {
  // Break caught: a probe that checks the connection and not the data, which is what the owner met.
  it('is not ready, with reference_data_missing, while the seed has not run, and is ready once it has', async () => {
    const before = await kit.client.get('/readyz');
    expect(before.status).toBe(503);
    expect(before.json()).toEqual({ status: 'not_ready', reason: 'reference_data_missing' });
    expect(before.header('cache-control')).toBe('no-store');

    await seedReferenceData(database);

    const after = await kit.client.get('/readyz');
    expect(after.status).toBe(200);
    expect(after.json()).toEqual({ status: 'ready' });
  });

  // Break caught: the process dying, or the liveness probe following readiness, for a database that is only waiting for its seed.
  it('stays live while it is not ready for want of the seed', async () => {
    const live = await kit.client.get('/livez');

    expect(live.status).toBe(200);
  });
});
