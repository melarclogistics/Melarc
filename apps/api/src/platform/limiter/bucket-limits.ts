import type { RateLimitBucket } from '../auth/ports/rate-limiter.port.js';
import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import type { SettingsReader } from '../settings/settings-reader.js';

/** Where a bucket's limit comes from: the number of requests it admits in any rolling window. */
export interface BucketLimits {
  /** Reads the limit **in the transaction it is given** (the limiter's own), under that transaction's context. */
  limitOf(bucket: RateLimitBucket, transaction: TransactionHandle): Promise<number>;
}

/**
 * The limits as the settings state them (settings.md §7.7: `rate_limit_staff_signin` and its five siblings, whose names are the
 * buckets'). Read fresh for each admission: nothing is cached, because a recalibration (the post-launch telemetry the contract
 * names) must take effect, and a cache is a number the limiter would otherwise invent a lifetime for. S0.65 measures the cost.
 *
 * **They are read in the admission transaction itself** (G2 correction; obligation OB-102). The limiter's transaction runs under the
 * `rate_limit` capability, and since migration 0012 the policy on `setting` lets that capability read the six `rate_limit_*` rows
 * and no other: not another setting, and no write (the runtime logins hold no `INSERT`, `UPDATE` or `DELETE` on `setting`). That
 * removes the second pooled connection every admission used to take for its configuration. A missing or invalid setting is the
 * settings reader's `SETTING_MISSING` or `SETTING_INVALID`, and the limiter fails closed on either.
 */
export class SettingsBucketLimits implements BucketLimits {
  readonly #settings: SettingsReader;

  constructor(settings: SettingsReader) {
    this.#settings = settings;
  }

  limitOf(bucket: RateLimitBucket, transaction: TransactionHandle): Promise<number> {
    return this.#settings.integer(transaction, bucket);
  }
}
