/**
 * `LIMITER_STORE_UNAVAILABLE` (the rate limiter port's `raises`): the limiter could not reach a decision, so it makes none. An
 * unavailable store **fails closed** for credential mutations (SECURITY_DESIGN.md §14.12): the request is answered with the
 * platform's generic operational failure and there is no permissive fallback, in memory or anywhere else. Whatever went wrong
 * (the pool, a lock that could not be taken within the server's time, a refused write, an uncertain commit, a limit that is missing
 * or invalid) is kept as the `cause` for the log and is not said to the caller.
 */
export class LimiterUnavailableError extends Error {
  readonly code = 'LIMITER_STORE_UNAVAILABLE';
  constructor(options: ErrorOptions = {}) {
    super('The rate limiter cannot decide: its store is unavailable', options);
    this.name = 'LimiterUnavailableError';
  }
}

/**
 * Why a limiter that cannot count every live row of a key refuses to decide (G2-04): rows are live in the table under a version of
 * the limiter's key that this instance does not hold, so it cannot see them and would count a key's allowance short. It is the
 * `cause` of a `LimiterUnavailableError`, so the caller's answer is the same generic operational failure, and the log can tell an
 * operator which state the deployment is in: an instance that was not given a key version another instance writes (a rotation
 * whose new key was not distributed to every instance first), or one that retired a version while rows under it were still live.
 * It names versions, which are not secrets, and never a digest, a bucket's key or a row.
 */
export class LimiterKeyVersionError extends Error {
  readonly code = 'LIMITER_KEY_VERSION_INCOMPATIBLE';
  constructor(
    readonly heldVersions: readonly number[],
    readonly liveVersionsUnheld: readonly number[],
  ) {
    super(
      `Live rate-limit rows exist under key versions this instance does not hold (held: ${heldVersions.join(',')}; live and not held: ${liveVersionsUnheld.join(',')})`,
    );
    this.name = 'LimiterKeyVersionError';
  }
}
