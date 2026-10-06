import { Injectable } from '@nestjs/common';

export interface ReadinessCheck {
  /** Identifies the check in logs. Never sent to a caller. */
  readonly name: string;
  /** Resolves when the dependency is usable; throws or rejects when it is not. */
  check(): Promise<void> | void;
}

/** A probe must answer quickly even when a dependency does not. */
const DEFAULT_CHECK_TIMEOUT_MS = 2000;

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

  private running: Promise<string[]> | undefined;

  /**
   * The names of the checks that fail or do not answer within the timeout.
   *
   * Probes that arrive while a run is under way share it. A probe is unauthenticated and the checks are real
   * queries on the pool that serves the business, so one run per probe would let a flood of probes (or one slow
   * database and a patient load balancer) put as many queries on the pool as there are probes. The run is not
   * kept once it ends: the next probe asks again.
   */
  failing(timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS): Promise<string[]> {
    this.running ??= this.runChecks(timeoutMs).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runChecks(timeoutMs: number): Promise<string[]> {
    const outcomes = await Promise.all(
      [...this.checks.values()].map(async (check) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => check.check()),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(new Error('readiness check timed out'));
              }, timeoutMs);
            }),
          ]);
          return undefined;
        } catch {
          return check.name;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return outcomes.filter((name): name is string => name !== undefined);
  }
}
