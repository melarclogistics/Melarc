import { runSeed } from '../../../src/platform/database/seed/seed-helper.js';
import { PROVISIONING_ROLE } from '../../../src/platform/database/technical-roles.js';
import { fixturePlan } from '../../../src/tools/fixtures/fixtures.js';
import { referenceSeedPlan } from '../../../src/tools/seed/reference-seed.js';
import { buildService } from './service.js';
import type { TestDatabase } from './test-database.js';

/**
 * Fills a freshly migrated test database with the reference data the way the product does: the seed command's helper, as the
 * provisioning login, in one transaction (`melarc.initialize_reference_data`). `fixtures` adds the two test-only reasons through
 * `melarc.add_reason_fixtures`. A test that reads settings, reasons, bundles or hubs starts here.
 */
export async function seedReferenceData(
  database: TestDatabase,
  options: { readonly fixtures?: boolean } = {},
): Promise<void> {
  const { service, close } = buildService(database, { login: PROVISIONING_ROLE });
  try {
    await runSeed(service, referenceSeedPlan());
    if (options.fixtures === true) await runSeed(service, fixturePlan());
  } finally {
    await close();
  }
}
