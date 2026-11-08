import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { RATE_LIMIT_BUCKETS } from '../../auth/ports/rate-limiter.port.js';
import { bytea } from './types.js';

/**
 * The authoritative state of the six rate-limit buckets (S0.14; SECURITY_DESIGN.md §14.12; data-scope-registry.md
 * `RateLimitAdmission`): **one row per admitted request**, keyed by a keyed digest of the bucket's key and never by an identifier,
 * an address or a token. A bucket admits at most its configured number of requests in any rolling 60 seconds, and the rows that
 * are still inside the window are what the decision counts. A refused request writes nothing, so a refusal never extends a penalty.
 *
 * This file is the *shape*. The migration (`0008_rate_limit_admission.sql`) adds by hand, in the same change: the owner
 * (`melarc_owner`), `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies (a `SYSTEM` context under the `rate_limit` capability
 * alone reads and inserts; it deletes **only a row that has left the window**, which is how "never evict a live penalty" holds at
 * the database; every other principal reads and writes nothing) and the grants (`SELECT`, `INSERT` and `DELETE` to the API runtime;
 * no `UPDATE`). The expired rows are removed by the limiter itself, a bounded batch inside its admission transactions; nothing
 * else removes them.
 */
export const rateLimitAdmission = pgTable(
  'rate_limit_admission',
  {
    id: uuid('id').primaryKey().defaultRandom().notNull(),
    /** One of the six canonical buckets of settings.md §7.7 (there is no seventh). */
    bucket: text('bucket').notNull(),
    /** HMAC-SHA-256 of the namespaced key under the limiter's own key purpose: 32 bytes, a pseudonym. */
    keyDigest: bytea('key_digest').notNull(),
    /** The version of the limiter key the digest was made under, so a rotation can look up every version it overlaps. */
    digestVersion: integer('digest_version').notNull(),
    /** When the request was admitted: the database's wall clock, taken in the admission transaction. */
    admittedAt: timestamp('admitted_at', { withTimezone: true })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    // The decision: the live rows of one key. And the cleanup and the capacity check: the oldest rows of the table.
    index('rate_limit_admission_key_idx').on(table.bucket, table.keyDigest, table.admittedAt),
    index('rate_limit_admission_age_idx').on(table.admittedAt),
    // The limiter's check that every live row is under a key version it holds (G2-04): one range probe for each stretch of version
    // numbers the instance does not hold, which finds nothing in a deployment that rotated its key in order.
    index('rate_limit_admission_version_idx').on(table.digestVersion, table.admittedAt),
    check(
      'rate_limit_admission_bucket_closed',
      sql`${table.bucket} IN (${sql.raw(RATE_LIMIT_BUCKETS.map((bucket) => `'${bucket}'`).join(', '))})`,
    ),
    check('rate_limit_admission_digest_length', sql`length(${table.keyDigest}) = 32`),
    check('rate_limit_admission_digest_version_positive', sql`${table.digestVersion} >= 1`),
  ],
);
