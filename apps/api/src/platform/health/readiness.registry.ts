import { Injectable } from '@nestjs/common';

/**
 * Why an instance is not ready, as a probe says it (a coarse reason, never a name or an error). `dependency_unavailable` is a
 * dependency that does not answer; `policy_superseded` is an instance that answered and found that it is older than the policy the
 * deployment now runs (SECURITY_DESIGN.md section 13.10: its compiled fixed-policy revision is below the stored floor). They are
 * different facts with different remedies (wait, or drain this instance and start a current one), so a check says which.
 */
export type NotReadyReason = 'dependency_unavailable' | 'policy_superseded';

/**
 * A check that found the instance not fit to serve for a reason other than a dependency being unreachable throws this, with the
 * reason. Any other failure of a check is `dependency_unavailable`: a check that could not even find out is a dependency down.
 */
export class NotReadyError extends Error {
  constructor(readonly reason: NotReadyReason) {
    super(`The instance is not ready: ${reason}`);
    this.name = 'NotReadyError';
  }
}

/** A check that failed, with the reason its failure stands for. */
export interface FailingCheck {
  readonly name: string;
  readonly reason: NotReadyReason;
}

/** What a check is told of the run it is part of. */
export interface ReadinessCheckOptions {
  /**
   * How long the run waits for this check. The registry stops waiting when it passes, so a check that holds anything (a
   * connection, a place in a line) must end it by then on its own account: an answer nobody waits for frees nothing.
   */
  readonly timeoutMs: number;
}

export interface ReadinessCheck {
  /** Identifies the check in logs. Never sent to a caller. */
  readonly name: string;
  /** Resolves when the dependency is usable; throws or rejects when it is not. */
  check(options: ReadinessCheckOptions): Promise<void> | void;
}

/** A probe must answer quickly even when a dependency does not. */
export const DEFAULT_CHECK_TIMEOUT_MS = 2000;

/**
 * The dependency checks that decide readiness. Platform modules that own a dependency (the database,
 * from B0.4) register a check; the readiness probe asks the registry which of them are failing.
 */
@Injectable()
export class ReadinessRegistry {
  private readonly checks = new Map<string, ReadinessCheck>();

  register(check: ReadinessCheck): void {
    if (this.checks.has(check.name)) {
      throw new Error(`A readiness check named "${check.name}" is already registered`);
    }
    this.checks.set(check.name, check);
  }

  private running: Promise<FailingCheck[]> | undefined;

  /**
   * The names of the checks that fail or do not answer within the timeout.
   *
   * Probes that arrive while a run is under way share it. A probe is unauthenticated and the checks are real
   * queries on the pool that serves the business, so one run per probe would let a flood of probes (or one slow
   * database and a patient load balancer) put as many queries on the pool as there are probes. The run is not
   * kept once it ends: the next probe asks again.
   */
  async failing(timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS): Promise<string[]> {
    return (await this.failingChecks(timeoutMs)).map((each) => each.name);
  }

  /** The checks that fail or do not answer, each with the reason it stands for. Probes share a run, as `failing` describes. */
  failingChecks(timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS): Promise<FailingCheck[]> {
    this.running ??= this.runChecks(timeoutMs).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runChecks(timeoutMs: number): Promise<FailingCheck[]> {
    const outcomes = await Promise.all(
      [...this.checks.values()].map(async (check) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => check.check({ timeoutMs })),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(new Error('readiness check timed out'));
              }, timeoutMs);
            }),
          ]);
          return undefined;
        } catch (error) {
          const reason: NotReadyReason =
            error instanceof NotReadyError ? error.reason : 'dependency_unavailable';
          return { name: check.name, reason };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return outcomes.filter((outcome): outcome is FailingCheck => outcome !== undefined);
  }
}
