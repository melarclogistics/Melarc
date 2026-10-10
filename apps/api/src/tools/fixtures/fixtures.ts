import { APP_ENVS } from '../../platform/config/config-settings.js';
import type { SeedPlan } from '../../platform/database/seed/seed-helper.js';
import { reasonCodeRow, type ReasonSeed } from '../seed/reasons.js';

/**
 * The test-only fixtures (S0.9; MIGRATION_AND_SEEDING.md section 4: "Test-only reason fixtures stay outside the seed, are visibly
 * named as fixtures and are refused in production, so they can never become an accidental production seed"). They live here, apart
 * from `tools/seed/`, so that nothing the production seed runs can reach them; every code starts with `FIXTURE_` and every label
 * with `Fixture: `, so a listing of the reason table shows what they are; and `assertFixturesAllowed` refuses anything but a known
 * non-production environment, naming what is allowed and not what is forbidden.
 *
 * What they are for: the identity operations validate their `reason_code` against the catalogue, and a test needs a reason the
 * catalogue refuses for a stated cause: one that is inactive, and one that permits no real operation. The names of the operations
 * a fixture permits start with `fixtureOnly`, which no operation of the contract does.
 *
 * The demonstration rider and vendor of MIGRATION_AND_SEEDING.md sections 4a and 4b are fixtures too, but they write tables that
 * do not exist yet (`RiderIdentity`, the vendor tables) and arrive with the tasks that build those tables.
 */

/** The prefix of every fixture code. `melarc.add_reason_fixtures` (migration 0005) writes codes with this prefix and no others. */
export const FIXTURE_CODE_PREFIX = 'FIXTURE_';

const fixture = (
  code: string,
  label: string,
  active: boolean,
  permittedOperations: readonly string[],
): ReasonSeed => ({
  code,
  domain: 'SESSION_REVOCATION',
  label,
  validCheckpoints: null,
  requiresNote: false,
  requiresPhoto: false,
  requiresContactAttempt: false,
  requiresApproval: false,
  attribution: 'MELARC',
  consumesDeliveryAttempt: false,
  requiresOpsReview: false,
  requiresEscalation: false,
  active,
  permittedOperations,
});

export const REASON_FIXTURES: readonly ReasonSeed[] = [
  fixture('FIXTURE_REASON_INACTIVE', 'Fixture: an inactive reason', false, ['revokeSession']),
  fixture('FIXTURE_REASON_OTHER_OPERATION', 'Fixture: a reason no real operation permits', true, [
    'fixtureOnlyOperation',
  ]),
];

/** The fixtures were asked for in an environment that is not a known non-production one. */
export class FixturesRefusedError extends Error {
  constructor() {
    super(
      'The test fixtures run only in a local or staging environment: this environment is production or is not one of the known environments',
    );
    this.name = 'FixturesRefusedError';
  }
}

/** Allows `local` and `staging` and refuses everything else: production, a spelling of it, and a value that is not an environment. */
export function assertFixturesAllowed(appEnv: unknown): void {
  const allowed = APP_ENVS.filter((environment) => environment !== 'production');
  if (typeof appEnv !== 'string' || !(allowed as readonly string[]).includes(appEnv)) {
    throw new FixturesRefusedError();
  }
}

/**
 * The fixture rows as a seed plan, applied by `melarc.add_reason_fixtures` (migration 0005). The function writes reasons whose code
 * starts with the prefix and nothing else, and it counts the fixtures already there (not the whole table, which holds the seeded
 * reasons): running it twice refuses, running it after the reference seed does not. The provisioning login holds no privilege on the
 * reason table, so this is the only way a fixture gets in.
 */
export function fixturePlan(): SeedPlan {
  return {
    locks: [],
    entryPoint: 'add_reason_fixtures',
    payload: { reason_code: REASON_FIXTURES.map((each) => reasonCodeRow(each)) },
    labels: { reason_code: 'reason_code (fixtures)' },
  };
}
