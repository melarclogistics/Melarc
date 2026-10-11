import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Argon2Hasher } from '../../src/platform/auth/crypto/argon2.hasher.adapter.js';
import { DEVELOPMENT_QUALIFIED_ARGON2ID } from '../../src/platform/auth/crypto/argon2-parameters.js';
import type { Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import {
  BoundedHashAdmission,
  runAdmitted,
} from '../../src/platform/limiter/bounded.hash-admission.adapter.js';
import { BoundedMetrics } from '../../src/platform/metrics/bounded.metrics.adapter.js';
import { localKeys } from '../../src/test-support/key-config.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { openAdmin, type Admin } from './support/admin.js';
import { withHandle } from './support/handle.js';
import { observe, type Observer } from './support/observe.js';
import { applyContextFixture, applyFixture, systemContext } from './support/rls-fixture.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.16: hash admission, saturated, against a real database and the real Argon2id hasher (SECURITY_DESIGN.md §13.4c; Family O).
 * The stand-in for a sign-in step below is the whole of what the admission is for: admission first, then identity-dependent work
 * (a verification, a failed-attempt counter written to the database). A request refused at admission does no hash of any kind,
 * writes no counter, and is answered at once; admitted work completes.
 */

const SECRET = 'a correct horse battery staple';
/** One set of keys for every hasher of the test: a hash is bound to the pepper it was made under. */
const KEYS = localKeys();
const STAFF = 'STAFF_PASSWORD' as const;

let database: TestDatabase;
let built: BuiltService;
let admin: Admin;
let observer: Observer;
let storedHash: string;

/** The real hasher, counting every derivation it is asked for: a refused request must add none. */
class CountingHasher implements Hasher {
  calls = 0;
  readonly #inner = new Argon2Hasher(KEYS, DEVELOPMENT_QUALIFIED_ARGON2ID);
  hash(kind: typeof STAFF, secret: string): Promise<string> {
    this.calls += 1;
    return this.#inner.hash(kind, secret);
  }
  verify(kind: typeof STAFF, secret: string, hash: string) {
    this.calls += 1;
    return this.#inner.verify(kind, secret, hash);
  }
  verifyAgainstDummy(kind: typeof STAFF, secret: string): Promise<void> {
    this.calls += 1;
    return this.#inner.verifyAgainstDummy(kind, secret);
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await applyContextFixture(database);
  built = buildService(database, { poolMax: 4 });
  admin = await openAdmin(database);
  observer = await observe(database);
  storedHash = await new CountingHasher().hash(STAFF, SECRET);
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await built.close();
  await database.drop();
});

const failedAttempts = async (): Promise<number> =>
  (
    await observer.one<{ n: number }>(
      "select count(*)::int as n from rls_fixture.system_records where body = 'failed attempt'",
    )
  )?.n ?? 0;

/**
 * One sign-in step: admission, then the verification, then the counter of a wrong secret. A refusal at admission is `RATE_LIMITED`
 * and is counted as such by cause; nothing else of the step runs.
 */
function stepFor(admission: BoundedHashAdmission, hasher: CountingHasher, metrics: BoundedMetrics) {
  return async (secret: string): Promise<'OK' | 'WRONG' | 'RATE_LIMITED'> => {
    const outcome = await runAdmitted(admission, async () => {
      const verdict = await hasher.verify(STAFF, secret, storedHash);
      if (verdict.matches) return 'OK' as const;
      await withHandle(built.service, systemContext('authentication'), (_handle, tx) =>
        tx.execute(sql`insert into rls_fixture.system_records (body) values ('failed attempt')`),
      );
      return 'WRONG' as const;
    });
    if (outcome.admitted) return outcome.value;
    metrics.increment('rate_limited_total', {
      bucket: 'rate_limit_staff_signin',
      cause: 'HASH_ADMISSION_FULL',
    });
    return 'RATE_LIMITED';
  };
}

describe('a saturated admission', () => {
  // Break caught: a refused request that still hashes (a dummy included) or counts against a credential, which is the attack the
  // admission exists to stop: distinct identifiers spending the machine’s hashing capacity.
  it('refuses at once, with no hash, no counter and nothing waiting, while the slots are held', async () => {
    const admission = new BoundedHashAdmission({ slots: 2, threadpoolSize: 4 });
    const hasher = new CountingHasher();
    const metrics = new BoundedMetrics({ policy: 'throw', clock: new ManualClock() });
    const step = stepFor(admission, hasher, metrics);
    const held = [admission.tryAdmit(), admission.tryAdmit()];
    const before = await failedAttempts();

    // Eight requests, every slot taken: all eight answer while the slots are still held, so none waited.
    const answers = await Promise.all(Array.from({ length: 8 }, () => step('wrong secret')));

    expect(answers).toEqual(Array.from({ length: 8 }, () => 'RATE_LIMITED'));
    expect(hasher.calls).toBe(0);
    expect(await failedAttempts()).toBe(before);
    expect(admission.inUse).toBe(2);
    expect(
      metrics
        .snapshot()
        .counters.find(
          (entry) =>
            entry.labels.bucket === 'rate_limit_staff_signin' &&
            entry.labels.cause === 'HASH_ADMISSION_FULL',
        )?.value,
    ).toBe(8);

    for (const slot of held) slot?.release();
  });

  // Break caught: admitted work cut short by the refusals around it, or more work admitted than there are slots.
  it('lets admitted work complete, and refuses the rest, when more arrive than there are slots', async () => {
    const admission = new BoundedHashAdmission({ slots: 2, threadpoolSize: 4 });
    const hasher = new CountingHasher();
    const metrics = new BoundedMetrics({ policy: 'throw', clock: new ManualClock() });
    const step = stepFor(admission, hasher, metrics);
    const before = await failedAttempts();

    const answers = await Promise.all(Array.from({ length: 6 }, () => step('wrong secret')));

    expect(answers.filter((answer) => answer === 'WRONG')).toHaveLength(2);
    expect(answers.filter((answer) => answer === 'RATE_LIMITED')).toHaveLength(4);
    // Two derivations, two counters: the four refused requests did neither.
    expect(hasher.calls).toBe(2);
    expect(await failedAttempts()).toBe(before + 2);
    expect(admission.inUse).toBe(0);
  });

  // Break caught: a slot that stays taken after the work, so that the admission shrinks until it refuses everyone.
  it('admits again once the hashes have finished, including a correct secret', async () => {
    const admission = new BoundedHashAdmission({ slots: 2, threadpoolSize: 4 });
    const hasher = new CountingHasher();
    const step = stepFor(
      admission,
      hasher,
      new BoundedMetrics({ policy: 'throw', clock: new ManualClock() }),
    );
    await Promise.all(Array.from({ length: 6 }, () => step('wrong secret')));

    expect(await step(SECRET)).toBe('OK');
    expect(await step('wrong again')).toBe('WRONG');
    expect(admission.inUse).toBe(0);
  });

  // Break caught: hashing allowed to run more at once than the slots, which would exceed the memory the slots were budgeted for.
  it('never has more derivations in flight than there are slots', async () => {
    const admission = new BoundedHashAdmission({ slots: 2, threadpoolSize: 4 });
    let inFlight = 0;
    let peak = 0;
    const work = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new CountingHasher().verify(STAFF, 'wrong secret', storedHash);
      inFlight -= 1;
    };

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => runAdmitted(admission, work)),
    );

    expect(outcomes.filter((outcome) => outcome.admitted)).toHaveLength(2);
    expect(peak).toBe(2);
  });
});
