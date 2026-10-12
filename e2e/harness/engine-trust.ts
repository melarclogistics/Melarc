import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How each browser engine is made to trust the disposable test CA (S0.23; implementation plan §11.5). **Nothing here changes a
 * trust store of the machine, the user or the system**: each engine is given a store of its own, in a directory made for the run,
 * that holds the CA certificate (public) and nothing else, and the engine is pointed at it. The run removes the directory.
 *
 * - **Chromium** (Playwright's build, on Linux) reads the NSS database at `$HOME/.pki/nssdb`. The database is made in a home
 *   directory of its own, and only the browser process is launched with that `HOME`.
 * - **Firefox** reads `cert9.db` from its profile. The profile is seeded with the CA and is a **template that no browser is launched
 *   from**: each test is given a private copy of it for a persistent context and the copy is removed when the test ends
 *   (`fresh-profile.ts`, `https-test.ts`), because a persistent context keeps what a page stores, and a profile shared by tests would
 *   carry one test's cookies and storage into the next.
 * - **WebKit** (Playwright's build, on Linux, over libsoup and glib-networking): the candidate is the trust file the TLS library
 *   honours from the environment (`SSL_CERT_FILE`), set for the browser process only. **It is unproven**: whether this build honours
 *   it is exactly what the spike (`tests/https-trust.spec.ts`) is there to find out, and WebKit is reported blocked until it passes.
 * - **Branded Chrome and Edge** are Chromium, and trust the same way on Linux; they are not in the automated runs. On Windows and
 *   macOS, Chromium, Chrome and Edge use the operating system's store, which has no disposable form: a persistent machine-wide trust
 *   change needs the owner's exact installation and removal plan first, so the automated runs do not exist there (`e2e/README.md`).
 *
 * The functions that plan are pure (paths, commands, the environment); the ones that act take the runner of `certutil` as a
 * parameter, so that their tests run no tool and make no store. `certutil` is the NSS tool (`libnss3-tools` on Debian and Ubuntu).
 */
export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type Engine = (typeof ENGINES)[number];

/** The name the CA is given in a store. */
export const CA_NICKNAME = 'melarc-test-ca';

/** NSS trust flags `C,,`: a certificate authority trusted to issue server certificates, and for nothing else. */
export const CA_TRUST_FLAGS = 'C,,';

export type CertutilRun = (args: readonly string[]) => void;

export interface EngineTrust {
  readonly engine: Engine;
  /** What makes the engine trust the CA, as the spike records it. */
  readonly mechanism: string;
  /** The environment for the browser process, over the process's own. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The seeded profile, when the mechanism is a profile: a pristine template that carries the CA. It is copied for each test and
   * never launched from, so that nothing a test stores in a context is there for the next.
   */
  readonly profileTemplate?: string;
  /** Whether the mechanism is documented behaviour of the engine or a candidate that only a run can show to work. */
  readonly basis: 'documented' | 'candidate';
}

export type EnginePlan =
  | {
      readonly supported: true;
      readonly trust: EngineTrust;
      /** The directories to make for the engine (private to the owner). */
      readonly directories: readonly string[];
      /** The `certutil` invocations, in order, that seed a store with the CA. */
      readonly certutil: readonly (readonly string[])[];
    }
  | { readonly supported: false; readonly engine: Engine; readonly reason: string };

/** Where the stores of a run are kept: below the TLS directory, which is outside the checkout and removed after the run. */
export const trustRootOf = (tlsDirectory: string): string => join(tlsDirectory, 'engines');

const seed = (database: string, caPath: string): string[][] => [
  ['-N', '-d', `sql:${database}`, '--empty-password'],
  ['-A', '-d', `sql:${database}`, '-n', CA_NICKNAME, '-t', CA_TRUST_FLAGS, '-i', caPath],
];

export function planEngineTrust(
  engine: Engine,
  options: { readonly root: string; readonly caPath: string; readonly platform?: NodeJS.Platform },
): EnginePlan {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') {
    return {
      supported: false,
      engine,
      reason: `a disposable trust store exists only on Linux: ${engine} uses the operating system's store on ${platform}, and a persistent machine-wide trust change needs the owner's exact installation and removal plan first`,
    };
  }
  const { root, caPath } = options;
  switch (engine) {
    case 'chromium': {
      const home = join(root, 'chromium-home');
      const database = join(home, '.pki', 'nssdb');
      return {
        supported: true,
        trust: {
          engine,
          mechanism:
            'the NSS database of a home directory made for the run (HOME is set for the browser process only)',
          env: { HOME: home },
          basis: 'documented',
        },
        directories: [home, join(home, '.pki'), database],
        certutil: seed(database, caPath),
      };
    }
    case 'firefox': {
      const profile = join(root, 'firefox-profile');
      return {
        supported: true,
        trust: {
          engine,
          mechanism:
            'a profile seeded with the CA in cert9.db, copied for each test, from which a persistent context is launched',
          env: {},
          profileTemplate: profile,
          basis: 'documented',
        },
        directories: [profile],
        certutil: seed(profile, caPath),
      };
    }
    case 'webkit':
      return {
        supported: true,
        trust: {
          engine,
          mechanism:
            'SSL_CERT_FILE, set for the browser process only, naming the CA certificate (whether this build honours it is what the spike shows)',
          env: { SSL_CERT_FILE: caPath },
          basis: 'candidate',
        },
        directories: [],
        certutil: [],
      };
  }
}

/** The plan of every engine, in the order of `ENGINES`. */
export const planAllEngines = (options: Parameters<typeof planEngineTrust>[1]): EnginePlan[] =>
  ENGINES.map((engine) => planEngineTrust(engine, options));

/** Runs `certutil` (by name on the path, or the full path in `command`), giving it no input and keeping none of its output. */
export function certutilRunner(command = 'certutil'): CertutilRun {
  return (args) => {
    const result = spawnSync(command, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error !== undefined) {
      throw new Error(
        `${command} could not be run: ${result.error.message}. It is the NSS tool: install libnss3-tools (Debian, Ubuntu) and run again.`,
      );
    }
    if (result.status !== 0) {
      const tail = result.stderr.trim().split('\n').slice(-2).join(' | ');
      throw new Error(
        `${command} "${args[0] ?? ''}" failed (exit ${String(result.status)}): ${tail}`,
      );
    }
  };
}

/**
 * Makes the stores of the supported engines among `plans`. A failure removes what this call made and fails with the reason; nothing is
 * left half seeded. Returns the trust of each engine that has one.
 */
export function prepareEngineTrust(plans: readonly EnginePlan[], run: CertutilRun): EngineTrust[] {
  const made: string[] = [];
  try {
    for (const plan of plans) {
      if (!plan.supported) continue;
      for (const directory of plan.directories) {
        const first = mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (first !== undefined) made.push(first);
        chmodSync(directory, 0o700);
      }
      for (const args of plan.certutil) run(args);
    }
  } catch (failure) {
    for (const directory of made.toReversed()) rmSync(directory, { recursive: true, force: true });
    throw failure;
  }
  return plans.flatMap((plan) => (plan.supported ? [plan.trust] : []));
}
