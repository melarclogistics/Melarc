import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LaunchOptions } from '@playwright/test';

/**
 * The browser of the negative control of the trusted HTTPS origin (S0.23): a browser of an engine that has **no way to trust the test
 * CA**, launched so that nothing it can reach holds the CA, to show that the origin is refused for lack of trust and not for another
 * reason.
 *
 * **Why the environment is given explicitly, and never merely left out.** Playwright Test installs a project's `use.launchOptions` as
 * the defaults of every `browserType.launch` of its worker (`playwright._defaultLaunchOptions`, set by the worker's `_browserOptions`
 * fixture), and `launch` merges them under the options it is given: `{ ...defaults, ...options }`. An option that is absent from the
 * options is therefore the project's. The first hosted run (13 October 2026) showed it: the control copied the project's `launchOptions`
 * and deleted `env`; `launch` put the project's `env` back; for Chromium that is the `HOME` whose `.pki/nssdb` holds the CA, and Chromium
 * loaded the origin it must refuse. `untrusted-launch.test.ts` shows it against the real runner. The environment here is built from the
 * runner's own, not from the project's, and handed to `launch` as an `env` of its own.
 */

/** The variables that can name where a certificate store is: none reaches the untrusted browser. */
const STORE_LOCATORS: readonly string[] = ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'SSL_DIR'];

/** The harness's own variables (the TLS directory, database passwords): a browser has no use for them and one of them names the trusted store. */
const HARNESS_PREFIX = 'MELARC_';

/**
 * The environment of the untrusted browser: the runner's own (so the browser has what it needs to run: the path, the library path, the
 * display, the locale), with `HOME` and the XDG directories placed in `home`, which is empty, no variable that names a certificate store
 * and none of the harness's own. **Chromium reads its store from `$HOME/.pki/nssdb`**, so an empty `HOME` that is set, and not unset
 * (Chromium would fall back to the account's home), is what leaves it with none. If any value left still names one of `trustedPaths`, the
 * environment is refused: it would not be untrusted. `base` is not changed.
 */
export function isolatedEnvironment(
  base: NodeJS.ProcessEnv,
  home: string,
  trustedPaths: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (name.startsWith(HARNESS_PREFIX) || STORE_LOCATORS.includes(name)) continue;
    env[name] = value;
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  env.XDG_DATA_HOME = join(home, '.local', 'share');
  env.XDG_CACHE_HOME = join(home, '.cache');
  env.XDG_STATE_HOME = join(home, '.local', 'state');
  for (const [name, value] of Object.entries(env)) {
    for (const trusted of trustedPaths) {
      if (value.includes(trusted)) {
        throw new Error(
          `The environment of the untrusted browser names the trusted store (${name}), so the browser would not be untrusted.`,
        );
      }
    }
  }
  return env;
}

export interface Closable {
  close(): Promise<void>;
}

/** What a `BrowserType` is to this module: it launches a browser that can be closed. */
export interface Launcher<B extends Closable> {
  launch(options: LaunchOptions): Promise<B>;
}

/**
 * The cleanup of the untrusted browser failed (it would not close, or its home could not be removed). A test that passed is failed by it:
 * a browser left running or a directory left on disk is state the next test could meet, and a harness that hides it reports a pass it
 * cannot vouch for.
 */
export class UntrustedBrowserTeardownError extends Error {
  readonly failures: readonly unknown[];

  constructor(failures: readonly unknown[]) {
    super(
      `The untrusted browser of a test could not be cleaned up: ${failures
        .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
        .join('; ')}`,
    );
    this.name = 'UntrustedBrowserTeardownError';
    this.failures = failures;
  }
}

export interface UntrustedBrowserOptions {
  /** Directories of the trusted stores (the run's TLS directory): no value of the browser's environment may name one. */
  readonly trustedPaths: readonly string[];
  /** Where the disposable home is made. The system's temporary directory unless told otherwise. */
  readonly parent?: string;
  /** The environment the browser's own is built from. The process's own unless told otherwise. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Says what could not be cleaned up when the test had already failed. Standard error unless told otherwise. */
  readonly report?: (message: string) => void;
  /** Removes the home. A test supplies another to show what happens when it cannot be removed. */
  readonly removeDirectory?: (path: string) => void;
}

const toStandardError = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/**
 * Launches a browser from `launcher` in an isolated environment (`isolatedEnvironment`, with a disposable empty home made here), hands
 * it to `use`, and closes it and removes the home when `use` ends, however it ends (a launch that fails included). `launchOptions` are
 * the project's; **their `env` is ignored**, and the environment is given to `launch` explicitly, so that the project's launch defaults,
 * which Playwright merges under whatever is not given, cannot bring the trusted environment back.
 *
 * Nothing in the teardown is swallowed, as in `withFreshProfile`: both steps run whatever happens, then a test that **passed** fails with
 * an `UntrustedBrowserTeardownError`, and a test that **failed** keeps its own failure, the very same error, with the teardown's reported
 * beside it. Nothing of the machine's normal trust store is touched: the home is a directory made for this call.
 */
export async function withUntrustedBrowser<B extends Closable, T>(
  launcher: Launcher<B>,
  launchOptions: LaunchOptions,
  use: (browser: B) => Promise<T>,
  options: UntrustedBrowserOptions,
): Promise<T> {
  const remove =
    options.removeDirectory ??
    ((path: string): void => {
      rmSync(path, { recursive: true, force: true });
    });
  const home = mkdtempSync(join(options.parent ?? tmpdir(), 'melarc-untrusted-home-'));
  let browser: B | undefined;
  let outcome:
    | { readonly passed: true; readonly value: T }
    | { readonly passed: false; readonly error: unknown };
  try {
    const env = isolatedEnvironment(options.environment ?? process.env, home, options.trustedPaths);
    browser = await launcher.launch({ ...launchOptions, env });
    outcome = { passed: true, value: await use(browser) };
  } catch (error) {
    outcome = { passed: false, error };
  }

  const teardown: unknown[] = [];
  try {
    await browser?.close();
  } catch (error) {
    teardown.push(error);
  }
  try {
    remove(home);
  } catch (error) {
    teardown.push(error);
  }

  if (!outcome.passed) {
    if (teardown.length > 0) {
      (options.report ?? toStandardError)(new UntrustedBrowserTeardownError(teardown).message);
    }
    throw outcome.error;
  }
  if (teardown.length > 0) throw new UntrustedBrowserTeardownError(teardown);
  return outcome.value;
}
