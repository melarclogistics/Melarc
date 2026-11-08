/**
 * The limiter's constants (S0.14; SECURITY_DESIGN.md §14.12).
 *
 * **The window is the contract's.** A bucket admits at most its configured number of requests in any rolling 60 seconds, and a
 * fixed window would admit a double burst at its boundary. It is not a setting and not a tuning value.
 *
 * **The rest are engineering parameters, development-qualified at this, their first consumer, and not production-qualified**
 * (plan section 3, "Engineering parameters"). DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "What S0.14 applied and where it was
 * exercised", records each with the environment it was measured in and the test that exercises it; S0.65 calibrates them and proposes
 * release values. None of them is a product value: the six buckets' figures come from the settings (settings.md §7.7) and are not
 * here.
 */

/** The rolling window of every bucket, in seconds (SECURITY_DESIGN.md §14.12). */
export const WINDOW_SECONDS = 60;

/** The longest canonical key the limiter digests, in UTF-8 bytes. The contract bounds every key it uses far below this. */
export const MAX_KEY_BYTES = 1024;

/** The largest limit a bucket may be configured with; a stored limit above it is invalid and the limiter fails closed. */
export const MAX_BUCKET_LIMIT = 10_000;

/**
 * The most admitted rows the table holds. At the cap new admissions are refused uniformly and no live row is evicted, so a
 * caller who invents keys cannot flush another caller's bucket (§14.12). The count that decides it is bounded by the cap + 1.
 */
export const MAX_TOTAL_ROWS = 20_000;

/** The most expired rows one admission removes, so that cleanup is bounded work inside an admission and never a sweep. */
export const CLEANUP_BATCH = 100;

/**
 * The technical identity of the limiter's `SYSTEM` context: a fixed, non-null identifier for the capability (§14.16: never null,
 * never a wildcard), written down so that it never moves. It is not a person and not an actor, and no row carries it.
 */
export const LIMITER_PRINCIPAL_ID = '6c696d69-7465-4000-8000-000000000001';
