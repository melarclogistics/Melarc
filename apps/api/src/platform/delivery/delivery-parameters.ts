/**
 * The constants of the delivery path (S0.17, S0.18, S0.19).
 *
 * **The schedule and the lifecycle are the documents'** (`delivery-schedule.ts`, state-machines.md §22). **The rest are engineering
 * parameters, development-qualified at this, their first consumer, and not production-qualified** (plan section 3, "Engineering
 * parameters"): DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "What S0.18 applied and where it was exercised", records each with the
 * environment it was measured in and the test that exercises it, and S0.65 calibrates them. None is a product value.
 */

/**
 * The technical identity of the delivery worker's `SYSTEM` context: a fixed, non-null identifier for the capability (§14.16: never
 * null, never a wildcard), written down so that it never moves. It is not a person and not an actor, and no row carries it. (It is
 * not an idempotency principal: OB-48 stays open for the first consumer that needs one.)
 */
export const DELIVERY_WORKER_PRINCIPAL_ID = '64656c69-7665-4000-8000-000000000001';

/** The shortest and the longest lease a claim may ask for, in milliseconds. A lease outside them is a defect of the caller. */
export const MIN_LEASE_MS = 1_000;
export const MAX_LEASE_MS = 60 * 60_000;

/** A worker's name for itself, as the row keeps it: plain, short and non-secret. */
export const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * A lease is this long plus the longest provider call the worker may make: time to read the record, to ask the provider and to
 * record what it said, with the call itself on top. A lease that is too short hands a job to a second worker while the first is
 * still working on it (a second message, tolerated, never promised away); one that is too long strands a message for as long after
 * a crash. Development-qualified, not production-qualified.
 */
export const LEASE_BASE_MS = 30_000;

/**
 * What is kept back from a lease for recording the outcome: the work on a job (the read, the status query, the send) is bounded by
 * a budget that ends this long before the lease does, so that the outcome is written while the lease is still the worker's.
 */
export const LEASE_MARGIN_MS = 5_000;

/** The longest a claim, and the longest the recording of an outcome, may take: each is one short transaction. */
export const CLAIM_BUDGET_MS = 10_000;
export const RECORD_BUDGET_MS = 5_000;

/** The longest one call to the capture adapter's sink may take: a write to a local directory, bounded in case the disk stalls. */
export const CAPTURE_CALL_TIMEOUT_MS = 5_000;

/**
 * How much of the shutdown budget is kept to give leases back: lanes are given the budget less this to finish what they hold, and
 * what is still in flight after that is relinquished (the job is due again at once for the next worker).
 */
export const RELINQUISH_RESERVE_MS = 2_000;

/** The longest an idle or failing lane waits before it looks again, however many times it has failed in a row. */
export const MAX_BACKOFF_MS = 30_000;

/**
 * The retention cleanup (S0.19): the most rows of each kind one run takes, and how often the worker runs it. A batch keeps a run to a
 * short transaction; the interval is how long expired credential material may stay after its time: the sealed payload of a message whose
 * record has ended is useless once the record is (redemption refuses it), but a live token should not outlast its use by long.
 * Development-qualified, not production-qualified.
 */
export const RETENTION_BATCH_SIZE = 200;
export const RETENTION_INTERVAL_MS = 60_000;

/**
 * The longest one run of the cleanup may take: the budget its transactions run under, inside the worker's. A run that is not done by
 * then leaves the rest for the next one (a minute on); a stop cancels what is in flight.
 */
export const RETENTION_RUN_BUDGET_MS = 30_000;

/** The lease a worker asks for, from the longest provider call it may make. */
export const leaseMsFor = (longestProviderCallMs: number): number =>
  LEASE_BASE_MS + longestProviderCallMs;

/** The budget for the work on one job under such a lease: the lease less what is kept back to record the outcome. */
export const jobBudgetMsFor = (leaseMs: number): number => leaseMs - LEASE_MARGIN_MS;
