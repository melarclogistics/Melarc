import { ARGON2ID_DEPLOYED_FLOOR, isBelowDeployedFloor } from '../auth/crypto/argon2-parameters.js';
import { EXPECTED } from './config-settings.js';
import type { AppConfig, ConfigProblem } from './load-config.js';

/**
 * What a configuration may not select where it runs (DEPLOYMENT_AND_ENVIRONMENTS.md §12.3; SECURITY_DESIGN.md §14.9, §14.12).
 * It judges the configuration that was built, not the environment text, so it holds for a configuration made by hand exactly
 * as for one `loadConfig` made: no route into the application skips it.
 *
 * - **Production** refuses the local key substitute (there is no production key custody yet, so a production start is refused
 *   until a task builds one), the capture delivery adapter, the substitute attestation verifier and the describe composition.
 * - **Staging and production** refuse the in-memory limiter, because the authoritative PostgreSQL limiter serves every
 *   integrated or deployed environment, and refuse the describe composition and the describe key custody, which are for a
 *   local run and for the tools that describe the application only.
 * - **Staging** keeps the local key custody, the capture adapter and the substitute verifier, so that the walk of the slice can
 *   be done there against fixtures under control. That is controlled fixture acceptance and nothing else: it is not
 *   real-provider evidence, real-secret evidence or release evidence, and it widens no waiver.
 * - **Production stays refused until managed key custody exists.** Building it, with a rotation proof and a recovery proof, is
 *   a prerequisite of release gate G3 (plan obligation OB-36), not part of the identity slice.
 *
 * This judges what a configuration selects. It does not enforce what the selection would do: a setting is validated here and
 * is applied only by the task that owns it.
 *
 * Each problem names the setting and says what is needed, never a value.
 */
export function adapterRefusals(config: AppConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const refuse = (key: string, expected: string): void => {
    problems.push({ key, problem: 'invalid', expected });
  };
  const production = config.appEnv === 'production';
  const deployed = config.appEnv !== 'local';

  if (config.keys.custody === 'describe' && deployed) refuse('KEY_CUSTODY', EXPECTED.KEY_CUSTODY);
  if (config.keys.custody === 'local' && production) refuse('KEY_CUSTODY', EXPECTED.KEY_CUSTODY);
  if (production && config.adapters.delivery.email.kind === 'capture') {
    refuse('DELIVERY_EMAIL_ADAPTER', EXPECTED.DELIVERY_EMAIL_ADAPTER);
  }
  if (production && config.adapters.delivery.sms.kind === 'capture') {
    refuse('DELIVERY_SMS_ADAPTER', EXPECTED.DELIVERY_SMS_ADAPTER);
  }
  if (production && config.adapters.attestationVerifier.kind === 'substitute') {
    refuse('ATTESTATION_VERIFIER', EXPECTED.ATTESTATION_VERIFIER);
  }
  if (deployed && config.adapters.limiter === 'memory')
    refuse('RATE_LIMITER', EXPECTED.RATE_LIMITER);
  // A deployed environment writes credential hashes at no less than the floor (a local run may use a cheaper profile in an explicit
  // test composition). The floor is on what is written: older profiles that may still be verified are not judged by it.
  if (deployed && isBelowDeployedFloor(config.credentialHashing.profile)) {
    if (config.credentialHashing.profile.memoryKiB < ARGON2ID_DEPLOYED_FLOOR.memoryKiB) {
      refuse('ARGON2_MEMORY_KIB', EXPECTED.ARGON2_MEMORY_KIB);
    }
    if (config.credentialHashing.profile.passes < ARGON2ID_DEPLOYED_FLOOR.passes) {
      refuse('ARGON2_PASSES', EXPECTED.ARGON2_PASSES);
    }
  }
  if (deployed && config.composition === 'describe') {
    refuse(
      'composition',
      'runtime when APP_ENV is staging or production: the describe composition binds inert adapters and is for a local run and for tools only',
    );
  }
  return problems;
}

/** A configuration the environment it names refuses. The message names settings, never a value. */
export class AdapterRefusedError extends Error {
  constructor(readonly problems: readonly ConfigProblem[]) {
    super(
      `This configuration selects what its environment refuses: ${problems.map((problem) => problem.key).join(', ')}.`,
    );
    this.name = 'AdapterRefusedError';
  }
}

/** Throws `AdapterRefusedError` when the configuration selects what its environment refuses. */
export function assertAdaptersAllowed(config: AppConfig): void {
  const problems = adapterRefusals(config);
  if (problems.length > 0) throw new AdapterRefusedError(problems);
}
