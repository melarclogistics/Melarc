import { NotReadyError, type ReadinessCheck } from '../../health/readiness.registry.js';
import type { UnitOfWork } from '../ports/unit-of-work.port.js';
import { AUTHENTICATION_PRINCIPAL_ID } from './session-parameters.js';
import { readFixedPolicy } from './bundle-reader.js';
import type { CompiledFixedPolicy } from './session-authority.js';

/**
 * The readiness of an instance against the fixed policy (S0.26; SECURITY_DESIGN.md section 13.10, part 2; decision C of 12 October
 * 2026): an instance whose compiled revision for an audience is **below the stored `minimum_revision`** serves nothing of that
 * audience and reports itself *not ready* with the reason `policy_superseded`. Refusing only the requests would leave the platform
 * sending traffic to an instance that can only refuse it; this is what lets the platform drain it, and a current instance take its
 * place, during a rolling release that reduced the policy.
 *
 * - It compares only the audiences this build declares a revision for. A build that declares none (the state until the Vendor and
 *   Rider sign-ins are built) is not asked, and is ready as far as policy goes.
 * - **Unable to find out is not superseded.** The read goes through the database; a database that does not answer, or a policy
 *   that was not seeded, makes the check fail as any dependency does (`dependency_unavailable`), and only a revision actually read,
 *   and found above this build's, is `policy_superseded`.
 * - It ends no session and writes nothing: it is a read, under the `authentication` capability (a Vendor or Rider context may not
 *   read the policy tables), in a short transaction of its own.
 */
export class PolicyReadiness implements ReadinessCheck {
  readonly name = 'fixed-policy';
  readonly #unitOfWork: Pick<UnitOfWork, 'run'>;
  readonly #compiled: CompiledFixedPolicy;

  constructor(options: {
    readonly unitOfWork: Pick<UnitOfWork, 'run'>;
    readonly compiled: CompiledFixedPolicy;
  }) {
    this.#unitOfWork = options.unitOfWork;
    this.#compiled = options.compiled;
  }

  async check(): Promise<void> {
    const declared = (['VENDOR', 'RIDER'] as const).flatMap((type) => {
      const revision = this.#compiled[type];
      return revision === undefined ? [] : [{ type, revision }];
    });
    if (declared.length === 0) return;

    const floors = await this.#unitOfWork.run(
      {
        principalType: 'SYSTEM',
        principalId: AUTHENTICATION_PRINCIPAL_ID,
        surface: 'SYSTEM',
        taskCapability: 'authentication',
        correlationId: 'readiness',
      },
      async (handle) => {
        const found: { type: 'VENDOR' | 'RIDER'; revision: number; minimum: number | null }[] = [];
        for (const { type, revision } of declared) {
          const stored = await readFixedPolicy(handle, type);
          found.push({ type, revision, minimum: stored?.minimumRevision ?? null });
        }
        return found;
      },
    );

    if (floors.some((each) => each.minimum === null)) {
      // The seed has not written the policy: nothing can be compared, and nothing may be served on a guess.
      throw new Error('The fixed policy is not seeded');
    }
    if (floors.some((each) => each.minimum !== null && each.revision < each.minimum)) {
      throw new NotReadyError('policy_superseded');
    }
  }
}
