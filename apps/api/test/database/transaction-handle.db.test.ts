import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bindTransactionHandle,
  securityContextOf,
} from '../../src/platform/database/transaction-handle.js';
import {
  frozenContextCopy,
  toContextSettings,
  type SecurityContext,
} from '../../src/platform/database/transaction-context.js';
import {
  HUB_A,
  HUB_B,
  PRINCIPAL_1,
  PRINCIPAL_2,
  staffContext,
  systemContext,
} from './support/rls-fixture.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * The bridge between the opaque handle and the real `DatabaseService` (review of 10 October 2026, finding 6): the context a handle
 * carries is the one the database applied to the transaction, whatever the code that binds the handle holds or does.
 */

let database: TestDatabase;
let built: BuiltService;

beforeAll(async () => {
  database = await createTestDatabase();
  built = buildService(database, { poolMax: 2 });
});

afterAll(async () => {
  await built.close();
  await database.drop();
});

describe('the context of a handle over the real service', () => {
  // Break caught: the context of a handle being the caller's object (or a copy taken after the transaction was opened), so that a
  // change to it between the opening and the binding changes who the audit says acted, while the database applied the original.
  it('is the context the database applied, even when the caller changes its object before binding', async () => {
    const mutable = {
      ...staffContext([HUB_A]),
      authorizedHubIds: [HUB_A],
    } as { -readonly [K in keyof SecurityContext]: SecurityContext[K] } & {
      authorizedHubIds: string[];
    };
    const original = mutable.principalId;

    const seen = await built.service.transactionWithContext(mutable, async (tx) => {
      // The service has validated and applied the context; the caller now changes its own object, then binds.
      mutable.principalId = PRINCIPAL_2;
      mutable.authorizedHubIds.push(HUB_B);
      const handle = bindTransactionHandle(tx);
      const applied = await tx.execute(
        sql`select current_setting('melarc.principal_id') as principal, current_setting('melarc.authorized_hub_ids') as hubs`,
      );
      return {
        held: securityContextOf(handle),
        applied: applied.rows[0] as Record<string, string>,
      };
    });

    expect(original).not.toBe(PRINCIPAL_2);
    expect(PRINCIPAL_1).toBe(original);
    expect(seen.applied.principal).toBe(original.toLowerCase());
    expect(seen.held.principalId).toBe(original);
    expect(seen.held.authorizedHubIds).toEqual([HUB_A]);
    expect(seen.applied.hubs).not.toContain(HUB_B);
    expect(Object.isFrozen(seen.held)).toBe(true);
  });

  // Break caught: the service judging the capability on the caller's object after the context was validated and applied, so a change
  // made to it in between (by a concurrent task that shares the object) opens the transaction under one capability while checking
  // another. The context is read to be validated and copied, and never again.
  it('does not read the caller’s context again once it has been validated and copied', async () => {
    let probed = 0;
    const counting = {
      ...systemContext('rate_limit'),
      get taskCapability() {
        probed += 1;
        return 'rate_limit' as const;
      },
    };
    toContextSettings(counting);
    frozenContextCopy(counting);
    const readsToValidateAndCopy = probed;

    let reads = 0;
    const changing = {
      ...systemContext('rate_limit'),
      get taskCapability() {
        reads += 1;
        // The capability it names after it has been validated and copied is one that the API login cannot open.
        return reads <= readsToValidateAndCopy ? ('rate_limit' as const) : ('seed' as const);
      },
    };

    const opened = await built.service.transactionWithContext(changing, (tx) =>
      Promise.resolve(securityContextOf(bindTransactionHandle(tx)).taskCapability),
    );

    expect(opened).toBe('rate_limit');
  });
});
