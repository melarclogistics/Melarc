import { rmSync } from 'node:fs';

import {
  certutilRunner,
  planAllEngines,
  prepareEngineTrust,
  trustRootOf,
} from './harness/engine-trust.ts';
import { describeConnectionForWorkers } from './harness/global.ts';
import { repositoryPaths } from './harness/paths.ts';
import { startStack } from './harness/stack.ts';
import { checkTlsMaterial, tlsDirectoryFrom, type TlsMaterial } from './harness/tls-material.ts';

/**
 * Starts the one stack the run's specs share: a disposable database, the API and the Ops build. Playwright
 * calls the function this returns when the run ends, however it ended, and that is what stops everything and
 * drops the database. If starting fails, `startStack` has already cleaned up after itself.
 *
 * With `MELARC_E2E_TLS_DIR` (S0.23) the stack also has the trusted HTTPS origin: the directory's test certificates are judged first
 * (a directory that is set and not usable fails the run, with every reason, and is never skipped), a store of the CA is made for
 * each engine that can have one, below the directory and for this run only, and the HTTPS front is started in front of the Ops
 * origin. Nothing is trusted outside those stores, and they are removed with the run.
 *
 * Nothing here removes another run's database. A run that was killed leaves its database behind; it is listed
 * and removed by name with `pnpm --filter @melarc/api db:orphans`, never on a guess that it looks idle.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const directory = tlsDirectoryFrom(process.env);
  let material: TlsMaterial | undefined;
  let trustRoot: string | undefined;

  const removeStores = (): void => {
    if (trustRoot !== undefined) rmSync(trustRoot, { recursive: true, force: true });
  };

  try {
    if (directory !== undefined) {
      const judged = checkTlsMaterial(directory, { checkoutRoot: repositoryPaths().root });
      if (!judged.ok) {
        throw new Error(
          `MELARC_E2E_TLS_DIR does not hold usable test certificates:\n${judged.problems.map((problem) => `  - ${problem}`).join('\n')}`,
        );
      }
      material = judged.material;
      trustRoot = trustRootOf(material.directory);
      // An empty `CERTUTIL` is no setting, so it is not `??` that picks the default.
      const named = process.env.CERTUTIL?.trim();
      prepareEngineTrust(
        planAllEngines({ root: trustRoot, caPath: material.caPath }),
        certutilRunner(named === undefined || named === '' ? 'certutil' : named),
      );
    }
    const stack = await startStack(material === undefined ? {} : { tls: material });
    describeConnectionForWorkers(stack.connection());
    return async () => {
      try {
        await stack.stop();
      } finally {
        removeStores();
      }
    };
  } catch (failure) {
    removeStores();
    throw failure;
  }
}
