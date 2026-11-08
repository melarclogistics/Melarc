import { randomUUID } from 'node:crypto';

import type { SeedPlan } from '../../platform/database/seed/seed-helper.js';
import { HUBS } from '../seed/hubs.js';

/**
 * The demonstration riders (S0.53; MIGRATION_AND_SEEDING.md section 4a): a non-production fixture, because nothing in the product creates a
 * rider (rider onboarding is SLICE-009's, OQ-089) and the demonstration starts from riders who already exist. It leaves **two** riders,
 * because the exception paths include one rider's credentials presented with another rider's handset (`AC-SLICE-000-50`), each `ACTIVE`
 * with the seeded hub as the primary hub. **Five constraints, each closing a specific way a convenience becomes a back door:** it runs only
 * in Local and Staging and refuses in production (the command refuses before it connects, `assertFixturesAllowed`); it sets no PIN and no
 * registered device (the officer still calls `registerRiderDevice` and the rider still sets their own PIN, which is what the demonstration
 * exists to show); no API operation can do this; the phone is a number no real person holds; and it creates nothing else. Applied by
 * `melarc.add_rider_fixture` (migration 0040), which writes these rows and nothing else.
 *
 * - **The numbers are of the ITU-reserved `+999` range**, which no operator assigns: the function refuses any other, and the table's policy
 *   for the `seed` capability admits no other. The fixture's names say what they are wherever an operator reads them.
 */

/** The names and the two numbers of the fixture. Visibly a fixture wherever an operator reads them. */
export const RIDER_FIXTURE = Object.freeze([
  Object.freeze({ fullName: 'Demonstration Rider One (fixture)', phone: '+99900000001' }),
  Object.freeze({ fullName: 'Demonstration Rider Two (fixture)', phone: '+99900000002' }),
]);

/** The fixture as a seed plan: new ids each run (a second run is refused by the function while one exists). */
export function riderFixturePlan(): SeedPlan {
  return {
    policyKeys: { bundleIds: [], fixedPolicies: [] },
    entryPoint: 'add_rider_fixture',
    payload: {
      rider_identity: RIDER_FIXTURE.map((rider) => ({
        id: randomUUID(),
        phone: rider.phone,
        full_name: rider.fullName,
        primary_hub_id: HUBS[0]?.id,
      })),
    },
    labels: { rider_identity: 'rider_identity (fixture)' },
  };
}
