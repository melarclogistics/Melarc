import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repositoryPaths } from './paths.ts';
import { privilegedRunner, systemTrust, systemTrustRefusal } from './system-trust.ts';
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
 * 3. run Playwright's HTTPS projects in **two runs** (`HTTPS_PHASES`), each with `MELARC_E2E_TLS_DIR` naming that directory (global setup
 *    judges the material, makes the per-engine stores below it, and starts the HTTPS front):
 *    - the first, with the system store lacking the CA: Chromium and Firefox, which trust it by a store of their own, and **WebKit's
 *      refusal**, the control that shows WebKit does not trust the origin until the CA is trusted;
 *    - the second, on a GitHub-hosted runner, with the CA put in the system store (`system-trust.ts`) and taken out when the run ends:
 *      WebKit's other proofs. WebKit has no way to trust a CA for one process (the first hosted run showed `SSL_CERT_FILE` ignored), so
 *      the order is what makes its control honest: refused before, trusted after, and nothing else differs;
 * 4. remove the CA from the system store if it was put there, and the directory, whatever happened, and exit with the status of the
 *    first run that failed. Each run says its exit status when it ends, and the command ends with a summary of every run and of the one
 *    the overall status comes from. Each run writes its artifacts to an output directory of its own below `test-results`
 *    (`HttpsPhase.output`), because Playwright clears the output directory of the projects it runs at the start of a run: with one
 *    directory for both, the second run erased the first run's evidence. The recorders of the secret projects are not touched.
 *
 * **It makes a CA and a private key, so it does not run where it is not allowed to.** It runs on Linux only (Chromium, Chrome and Edge
 * use the operating system's store on Windows and macOS, which has no disposable form), and only in CI or where the person who runs it
 * has said the machine is cleared for key material (`MELARC_E2E_KEYS_CLEARED=1`). The shared developer workstation is not such a
 * machine (the owner's ruling of 11 October 2026). **No trust store of the machine, the user or a browser is changed, with one
 * exception**: on a GitHub-hosted runner alone, a machine made for one job and discarded after it, WebKit's proofs run with the CA in the
 * system store, which is the only trust WebKit has (the owner's decision of 12 October 2026). Anywhere else the second run is made
 * without it, says so, and WebKit's proofs fail to trust, which is the correct report.
 */
export interface HttpsPhase {
  /** Said in the log. */
  readonly name: string;
  readonly projects: readonly string[];
  /** Whether the CA is in the system store while these projects run (a GitHub-hosted runner only). */
  readonly systemTrust: boolean;
  /**
   * Where Playwright writes this run's artifacts (`--output`), relative to the `e2e` directory and below `test-results`, which the failure
   * artifact of CI keeps. **Playwright removes the output directory of every project it is about to run when a run starts**, so the runs
   * must not share one: a second run that did would erase the evidence of the first (the first hosted run of the two-run command kept 10 KB
   * of diagnostics for that reason, whatever the first run had found). No directory is inside another or inside the plain run's
   * (`test-results/artifacts`). Secret projects keep their own restrictions (no trace, video or screenshot): only the place changes.
   */
  readonly output: string;
}

export const HTTPS_PHASES: readonly HttpsPhase[] = [
  {
    name: 'the engines that trust the CA by a store of their own, and WebKit refusing it while the system store lacks it',
    projects: [
      'https-chromium',
      'https-chromium-secret',
      'https-firefox',
      'https-firefox-secret',
      'https-webkit-control',
    ],
    systemTrust: false,
    output: 'test-results/https-1-own-stores',
  },
  {
    name: 'WebKit, with the CA in the system store',
    projects: ['https-webkit', 'https-webkit-secret'],
    systemTrust: true,
    output: 'test-results/https-2-system-store',
  },
];

/** What came of one run: Playwright answered; it was started and an error stopped the command before it answered; or it was never started. */
type RunOutcome =
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'not-run' };

export const HTTPS_PROJECTS: readonly string[] = HTTPS_PHASES.flatMap((phase) => phase.projects);

/**
 * The branded-browser projects of the configuration (Google Chrome and Microsoft Edge): the same specs and the same trust mechanism as
 * Chromium, for a person's smoke check. **No command runs them and CI does not**; a test holds the configuration to this list.
 */
export const BRANDED_PROJECTS: readonly string[] = ['https-chrome', 'https-msedge'];

/** The CA in the system store, for the one engine that has no other way to trust it (`system-trust.ts`). */
export interface SystemStorePort {
  /** Why the system trust store may not be changed here, or `undefined` when it may. */
  readonly refusal: () => string | undefined;
  readonly install: (caPath: string) => void;
  readonly remove: () => void;
}

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
  readonly systemTrust: SystemStorePort;
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
  // The status is settled after the `finally`, which can fail the run too (a CA that cannot be taken out of the system store).
  let status = 1;
  // Whether the CA may be in the system store, so that it must be taken out: set *before* the install, which can fail half way.
  let inSystemStore = false;
  let removalFailed = false;
  const outcomes: RunOutcome[] = HTTPS_PHASES.map(() => ({ kind: 'not-run' }));
  // The run being prepared or made when an error stopped the command, if one did.
  let stoppedAt: number | undefined;
  const takeOutOfSystemStore = (): void => {
    if (!inSystemStore) return;
    inSystemStore = false;
    try {
      deps.systemTrust.remove();
      deps.out('The disposable test CA is removed from the system trust store.');
    } catch (failure) {
      deps.err(
        failure instanceof Error
          ? failure.message
          : 'The disposable test CA could not be removed from the system trust store.',
      );
      // A CA left in the system store is a failure of the run, whatever the browsers did; a failure that came first is kept.
      removalFailed = true;
      if (status === 0) status = 1;
    }
  };
  try {
    const directory = join(root, 'tls');
    const material = deps.mint({ directory, checkoutRoot: deps.checkoutRoot, run: deps.openssl });
    deps.out(
      `Disposable test CA made (sha256 ${material.caFingerprint256}); it is removed when the run ends.`,
    );
    const environment = { ...deps.environment, MELARC_E2E_TLS_DIR: directory };
    status = 0;
    for (const [index, phase] of HTTPS_PHASES.entries()) {
      stoppedAt = index;
      deps.out(`HTTPS run ${String(index + 1)} of ${String(HTTPS_PHASES.length)}: ${phase.name}.`);
      if (phase.systemTrust) {
        const why = deps.systemTrust.refusal();
        if (why === undefined) {
          inSystemStore = true;
          deps.systemTrust.install(material.caPath);
          deps.out(
            'The disposable test CA is in the system trust store of this GitHub-hosted runner, for WebKit’s proofs; it is removed from the system trust store when they end.',
          );
        } else {
          deps.out(
            `WebKit’s proofs run without the CA in the system trust store (${why}); they are expected to fail to trust it.`,
          );
        }
      }
      outcomes[index] = { kind: 'incomplete' };
      const phaseStatus = deps.playwright(
        ['test', ...phase.projects.map((name) => `--project=${name}`), `--output=${phase.output}`],
        environment,
      );
      outcomes[index] = { kind: 'status', status: phaseStatus };
      deps.out(
        `HTTPS run ${String(index + 1)} of ${String(HTTPS_PHASES.length)} ended with exit status ${String(phaseStatus)}.`,
      );
      // Every run is made whatever the one before it did, so that nothing goes unreported; the first failure is the exit status.
      if (status === 0) status = phaseStatus;
      stoppedAt = undefined;
      takeOutOfSystemStore();
    }
  } catch (failure) {
    deps.err(
      failure instanceof Error
        ? failure.message
        : 'The HTTPS run failed for a reason that was not an error.',
    );
    status = 1;
  } finally {
    takeOutOfSystemStore();
    deps.removeDirectory(root);
  }
  summarize(deps.out, outcomes, { status, stoppedAt, removalFailed });
  return status;
}

/**
 * Says what became of every run and which one the overall status comes from, the first that did not pass, so that a log that ends in a
 * failure says at once where to look and nothing of a run that was made is lost to the one that followed.
 */
function summarize(
  out: (line: string) => void,
  outcomes: readonly RunOutcome[],
  settled: {
    readonly status: number;
    readonly stoppedAt: number | undefined;
    readonly removalFailed: boolean;
  },
): void {
  out('HTTPS run summary:');
  const failing: number[] = [];
  for (const [index, phase] of HTTPS_PHASES.entries()) {
    const outcome = outcomes[index] ?? { kind: 'not-run' };
    let what = 'not run';
    if (outcome.kind === 'status') {
      what = `exit status ${String(outcome.status)}`;
      if (outcome.status !== 0) failing.push(index);
    } else if (outcome.kind === 'incomplete') {
      what = 'did not complete (an error stopped it; see above)';
      failing.push(index);
    }
    out(
      `  run ${String(index + 1)} of ${String(HTTPS_PHASES.length)}: ${what}; output ${phase.output}`,
    );
  }
  if (settled.stoppedAt !== undefined) failing.push(settled.stoppedAt);
  const first = failing.length > 0 ? Math.min(...failing) : undefined;
  let source = '';
  if (first !== undefined) {
    source = `, from run ${String(first + 1)} of ${String(HTTPS_PHASES.length)}`;
  } else if (settled.status !== 0) {
    source = settled.removalFailed
      ? ', from taking the CA out of the system trust store (see above)'
      : ', no run was made (see above)';
  }
  out(`  overall exit status ${String(settled.status)}${source}`);
}

function realDependencies(): HttpsRunDependencies {
  const paths = repositoryPaths();
  const openssl = process.env.OPENSSL?.trim();
  const trust = systemTrust(privilegedRunner());
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
    systemTrust: {
      refusal: () => systemTrustRefusal(process.platform, process.env),
      install: (caPath) => {
        trust.install(caPath);
      },
      remove: () => {
        trust.remove();
      },
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
