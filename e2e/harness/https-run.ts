import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINES } from './engine-trust.ts';
import { repositoryPaths } from './paths.ts';
import {
  mintTestCertificates,
  opensslRunner,
  type MintOptions,
  type MintResult,
  type OpensslRun,
} from './test-ca.ts';

/**
 * The run of the integrated harness over the trusted HTTPS origin (S0.23): `pnpm run test:e2e:https`, one command that does everything
 * the proofs need and leaves nothing behind. It is the whole of a mandatory CI step (the workflow rules require each mandatory command
 * to be the whole script of its step, and allow no step that runs "always"), so the cleanup is here, in a `finally`:
 *
 * 1. refuse unless it is allowed to make key material (below);
 * 2. make a directory of its own outside the checkout, and in it the disposable CA and leaf (`test-ca.ts`: the CA's key is deleted as
 *    soon as the leaf is signed, after `openssl verify` has shown that the CA refuses a name outside the loopback);
 * 3. run Playwright's HTTPS projects, one ordinary and one secret for each engine, with `MELARC_E2E_TLS_DIR` naming that directory
 *    (global setup judges the material, makes the per-engine stores below it, and starts the HTTPS front);
 * 4. remove the directory, whatever happened, and exit with the status of the run.
 *
 * **It makes a CA and a private key, so it does not run where it is not allowed to.** It runs on Linux only (Chromium, Chrome and Edge
 * use the operating system's store on Windows and macOS, which has no disposable form), and only in CI or where the person who runs it
 * has said the machine is cleared for key material (`MELARC_E2E_KEYS_CLEARED=1`). The shared developer workstation is not such a
 * machine (the owner's ruling of 11 October 2026). Nothing is installed into any trust store, system, user or browser.
 */
export const HTTPS_PROJECTS: readonly string[] = ENGINES.flatMap((engine) => [
  `https-${engine}`,
  `https-${engine}-secret`,
]);

/**
 * The branded-browser projects of the configuration (Google Chrome and Microsoft Edge): the same specs and the same trust mechanism as
 * Chromium, for a person's smoke check. **No command runs them and CI does not**; a test holds the configuration to this list.
 */
export const BRANDED_PROJECTS: readonly string[] = ['https-chrome', 'https-msedge'];

export interface HttpsRunDependencies {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly checkoutRoot: string;
  /** Makes the private directory of the run, outside the checkout. */
  readonly makeDirectory: () => string;
  readonly removeDirectory: (path: string) => void;
  readonly mint: (options: MintOptions) => MintResult;
  readonly openssl: OpensslRun;
  /** Runs Playwright with the arguments and the environment; resolves with its exit status. */
  readonly playwright: (args: readonly string[], environment: NodeJS.ProcessEnv) => number;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Why the run will not start, or `undefined` when it may. */
export function refusalToRun(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform !== 'linux') {
    return `The automated HTTPS run exists only on Linux: on ${platform}, Chromium, Chrome and Edge use the operating system's trust store, which has no disposable form, and a persistent machine-wide trust change needs the owner's exact installation and removal plan first (e2e/README.md).`;
  }
  if (environment.CI !== 'true' && environment.MELARC_E2E_KEYS_CLEARED !== '1') {
    return 'This makes a CA and a private key. Run it in CI, or on a machine you have cleared for key material and say so with MELARC_E2E_KEYS_CLEARED=1. The shared developer workstation is not such a machine.';
  }
  return undefined;
}

export function runHttpsSuite(deps: HttpsRunDependencies): number {
  const refusal = refusalToRun(deps.platform, deps.environment);
  if (refusal !== undefined) {
    deps.err(refusal);
    return 2;
  }
  const root = deps.makeDirectory();
  try {
    const directory = join(root, 'tls');
    const material = deps.mint({ directory, checkoutRoot: deps.checkoutRoot, run: deps.openssl });
    deps.out(
      `Disposable test CA made (sha256 ${material.caFingerprint256}); it is removed when the run ends.`,
    );
    return deps.playwright(['test', ...HTTPS_PROJECTS.map((name) => `--project=${name}`)], {
      ...deps.environment,
      MELARC_E2E_TLS_DIR: directory,
    });
  } catch (failure) {
    deps.err(
      failure instanceof Error
        ? failure.message
        : 'The HTTPS run failed for a reason that was not an error.',
    );
    return 1;
  } finally {
    deps.removeDirectory(root);
  }
}

function realDependencies(): HttpsRunDependencies {
  const paths = repositoryPaths();
  const openssl = process.env.OPENSSL?.trim();
  return {
    platform: process.platform,
    environment: process.env,
    checkoutRoot: paths.root,
    makeDirectory: () => mkdtempSync(join(tmpdir(), 'melarc-e2e-https-')),
    removeDirectory: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
    mint: mintTestCertificates,
    openssl: opensslRunner(openssl === undefined || openssl === '' ? 'openssl' : openssl),
    playwright: (args, environment) => {
      const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: resolve(paths.root, 'e2e'),
        env: environment,
        stdio: 'inherit',
      });
      return result.status ?? 1;
    },
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runHttpsSuite(realDependencies());
}
