import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';

/**
 * The one change the HTTPS harness makes outside its own directory (S0.23). **The owner decided it on 12 October 2026**, after the first
 * hosted run: Playwright's WebKit on Linux (libsoup over glib-networking's GnuTLS backend, which reads the system's trust list and no
 * environment variable) trusts a certificate authority only if the *system* store holds it, so there is no way to give WebKit the
 * disposable CA for its own process. On a **GitHub-hosted runner**, a machine made for one job and discarded after it, the run therefore
 * puts the CA in the system store for WebKit's proofs and takes it out when they end (`https-run.ts`).
 *
 * It is allowed nowhere else. A developer's machine, a self-hosted runner and a machine declared "cleared for key material" are all refused:
 * clearing a machine for a CA and a private key is not permission to change what it trusts (the owner's ruling of 11 October 2026), and
 * on those machines WebKit's proofs are reported as failing to trust, which is the correct report. What goes in is the CA's certificate,
 * which is public and is constrained to the loopback names (`test-ca.ts`); its key was deleted when the leaf was signed.
 */

/** Where the CA is put: update-ca-certificates reads only `*.crt` files below this directory, and the name says whose it is. */
export const SYSTEM_CA_PATH = '/usr/local/share/ca-certificates/melarc-e2e-disposable-ca.crt';

/** Runs `command` with its `args` with privilege, no shell. Throws, with the command and the end of what it said, when it fails. */
export type PrivilegedRun = (command: string, args: readonly string[]) => void;

/** Why the system store may not be changed here, or `undefined` when it may: only on a Linux runner that GitHub itself hosts. */
export function systemTrustRefusal(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (
    platform === 'linux' &&
    environment.CI === 'true' &&
    environment.GITHUB_ACTIONS === 'true' &&
    environment.RUNNER_ENVIRONMENT === 'github-hosted'
  ) {
    return undefined;
  }
  return 'the system trust store is changed only on a GitHub-hosted runner (Linux, with CI and GITHUB_ACTIONS set to "true" and RUNNER_ENVIRONMENT set to "github-hosted"), a machine made for one job and discarded after it; no other machine has its trust changed, a machine declared cleared for key material included';
}

export interface SystemTrust {
  /** Copies the CA into the system store and rebuilds the system bundle. Fails, naming the step, when either step does. */
  install(caPath: string): void;
  /**
   * Removes the CA and rebuilds the bundle from the system's own sources. Tries both steps whatever the first does and says every one
   * that failed, so it is safe after an install that failed half way, and a CA left behind is never reported as removed.
   */
  remove(): void;
}

const REMOVAL: readonly (readonly [string, readonly string[]])[] = [
  ['rm', ['-f', SYSTEM_CA_PATH]],
  ['update-ca-certificates', ['--fresh']],
];

export function systemTrust(run: PrivilegedRun): SystemTrust {
  return {
    install: (caPath) => {
      // A relative path would copy whatever the working directory holds, as root.
      if (!posix.isAbsolute(caPath)) {
        throw new Error(
          `The CA to put in the system trust store must be given as an absolute path, not "${caPath}".`,
        );
      }
      run('install', ['-m', '0644', caPath, SYSTEM_CA_PATH]);
      run('update-ca-certificates', []);
    },
    remove: () => {
      const failures: string[] = [];
      for (const [command, args] of REMOVAL) {
        try {
          run(command, args);
        } catch (failure) {
          failures.push(failure instanceof Error ? failure.message : String(failure));
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `The disposable CA could not be removed from the system trust store: ${failures.join('; ')}`,
        );
      }
    },
  };
}

/** The arguments of `sudo` for a command: `-n` first, so that a machine that wants a password fails at once and does not wait. */
export const sudoArguments = (
  command: string,
  args: readonly string[],
  prefix: readonly string[] = ['-n'],
): string[] => [...prefix, command, ...args];

/**
 * Runs a command through `sudo -n` (by name on the path, or the full path in `sudo`), giving it no input and keeping none of its output.
 * `prefix` is the arguments that come before the command; a test supplies its own so that no privilege is used.
 */
export function privilegedRunner(sudo = 'sudo', prefix: readonly string[] = ['-n']): PrivilegedRun {
  return (command, args) => {
    const result = spawnSync(sudo, sudoArguments(command, args, prefix), {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error !== undefined) {
      throw new Error(
        `${sudo} could not be run: ${result.error.message}. The system trust store is changed only on a GitHub-hosted runner, where sudo asks for no password.`,
      );
    }
    if (result.status !== 0) {
      const tail = result.stderr.trim().split('\n').slice(-2).join(' | ');
      throw new Error(
        `${[command, ...args].join(' ')} failed (exit ${String(result.status)}): ${tail}`,
      );
    }
  };
}
