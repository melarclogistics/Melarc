import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  UntrustedBrowserTeardownError,
  isolatedEnvironment,
  withUntrustedBrowser,
  type Launcher,
} from './untrusted-browser.ts';

/**
 * The browser of the negative control of the trusted HTTPS origin (S0.23), launched in an environment that cannot reach any store that
 * holds the test CA. Proved here on what has no need of a browser: what the environment holds and what it does not, and what happens to
 * the disposable home and the browser when the launch, the test or the teardown fails. **That Playwright's own default launch options
 * cannot leak the trusted environment back in is proved against the real Playwright Test runner**, in `untrusted-launch.test.ts`: a
 * double that never merges defaults would show nothing about it.
 */
const TRUSTED = '/run/tls';
const TRUSTED_HOME = `${TRUSTED}/engines/chromium-home`;

/** Whether `path` is inside `directory`, whatever separator the platform writes. */
const isInside = (path: string, directory: string): boolean => {
  const way = relative(directory, path);
  return way !== '' && !way.startsWith('..') && !isAbsolute(way);
};

/** The environment of a trusted project: the runner's own, with a HOME that holds the CA, as `playwright.config.ts` builds it. */
const TRUSTED_ENVIRONMENT = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LD_LIBRARY_PATH: '/opt/browser/lib',
  DISPLAY: ':99',
  LANG: 'C.UTF-8',
  TMPDIR: '/tmp',
  HOME: TRUSTED_HOME,
  XDG_CONFIG_HOME: `${TRUSTED_HOME}/.config`,
  XDG_DATA_HOME: `${TRUSTED_HOME}/.local/share`,
  SSL_CERT_FILE: `${TRUSTED}/ca.pem`,
  SSL_CERT_DIR: TRUSTED,
  SSL_DIR: `${TRUSTED_HOME}/.pki/nssdb`,
  MELARC_E2E_TLS_DIR: TRUSTED,
  MELARC_PG_ADMIN_PASSWORD: 'a-throwaway-value',
} as const;

describe('isolatedEnvironment', () => {
  const HOME = '/tmp/melarc-untrusted-home-abc';
  const environment = () => isolatedEnvironment(TRUSTED_ENVIRONMENT, HOME, [TRUSTED]);

  // Break caught: an environment so bare that the browser cannot start (no PATH, no library path, no display), which would fail the
  // control for a reason that has nothing to do with trust. What the browser needs to run is the runner's own, untouched.
  it('keeps the settings a browser needs to run', () => {
    const env = environment();

    for (const name of ['PATH', 'LD_LIBRARY_PATH', 'DISPLAY', 'LANG', 'TMPDIR'] as const) {
      expect(env[name], name).toBe(TRUSTED_ENVIRONMENT[name]);
    }
  });

  // Break caught: HOME left as the trusted project's (Chromium reads its NSS database from `$HOME/.pki/nssdb`), or the XDG
  // directories pointing back at it. Each is a place inside the disposable home, which holds nothing.
  it('puts HOME and the XDG directories in the disposable home', () => {
    const env = environment();

    expect(env.HOME).toBe(HOME);
    for (const name of [
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
    ] as const) {
      expect(env[name], name).toBeDefined();
      expect(isInside(env[name] ?? '', HOME), name).toBe(true);
    }
  });

  // Break caught: a variable that names a trust store left in place (the NSS database directory, a CA file, a CA directory): none of
  // them may reach the untrusted browser.
  it('removes every variable that can name a certificate store', () => {
    const env = environment();

    for (const name of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'SSL_DIR']) {
      expect(Object.hasOwn(env, name), name).toBe(false);
    }
  });

  // Break caught: the harness's own variables (the TLS directory, database passwords) handed to a browser process, which has no use for
  // them and, in the TLS directory's case, would name the trusted store.
  it('removes the harness’s own variables', () => {
    const env = environment();

    expect(Object.keys(env).filter((name) => name.startsWith('MELARC_'))).toEqual([]);
  });

  it('holds no value that names the trusted directory', () => {
    const env = environment();

    for (const [name, value] of Object.entries(env)) {
      expect(value.includes(TRUSTED), name).toBe(false);
    }
  });

  // Break caught: a variable the function does not know about that still points at the trusted store (a search path of data
  // directories, say): the environment is refused, not quietly trusted.
  it('refuses an environment in which anything else still names the trusted directory', () => {
    expect(() =>
      isolatedEnvironment(
        { ...TRUSTED_ENVIRONMENT, XDG_DATA_DIRS: `/usr/share:${TRUSTED_HOME}/.local/share` },
        HOME,
        [TRUSTED],
      ),
    ).toThrow(/names the trusted store.*XDG_DATA_DIRS/);
  });

  it('does not change the environment it was given, and drops what is undefined', () => {
    const base: NodeJS.ProcessEnv = { ...TRUSTED_ENVIRONMENT, GONE: undefined };
    const before = JSON.stringify(base);

    const env = isolatedEnvironment(base, HOME, [TRUSTED]);

    expect(JSON.stringify(base)).toBe(before);
    expect(Object.hasOwn(env, 'GONE')).toBe(false);
  });
});

describe('withUntrustedBrowser', () => {
  let parent = '';
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'melarc-untrusted-test-'));
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  interface Browser {
    close(): Promise<void>;
  }

  /** A launcher that records what it was asked and what became of the browser it made. */
  function launcher(options: { launchFails?: Error; closeFails?: Error } = {}) {
    const asked: Record<string, unknown>[] = [];
    const state = { closed: 0 };
    const browser: Browser = {
      close: () => {
        state.closed += 1;
        return options.closeFails === undefined
          ? Promise.resolve()
          : Promise.reject(options.closeFails);
      },
    };
    const launch: Launcher<Browser> = {
      launch: (given) => {
        asked.push({ ...given });
        return options.launchFails === undefined
          ? Promise.resolve(browser)
          : Promise.reject(options.launchFails);
      },
    };
    return { launch, asked, state };
  }

  const homeOf = (asked: Record<string, unknown>[]): string => {
    const env = asked[0]?.env as Record<string, string> | undefined;
    return env?.HOME ?? '';
  };

  const run = <T>(
    given: ReturnType<typeof launcher>,
    use: (browser: Browser) => Promise<T>,
    extra: { report?: (message: string) => void; removeDirectory?: (path: string) => void } = {},
  ) =>
    withUntrustedBrowser(
      given.launch,
      { channel: 'chromium', env: { HOME: TRUSTED_HOME, SSL_CERT_FILE: `${TRUSTED}/ca.pem` } },
      use,
      { trustedPaths: [TRUSTED], parent, environment: TRUSTED_ENVIRONMENT, ...extra },
    );

  // Break caught (the first hosted run, 13 October 2026): the project's trusted `env` left in the options, or merely deleted from them,
  // which Playwright fills in again from the project's defaults. The environment is handed over explicitly, and is the isolated one;
  // what else the options carried is kept.
  it('launches with an environment of its own, given explicitly, and keeps the other options', async () => {
    const given = launcher();

    await run(given, () => Promise.resolve());

    const asked = given.asked[0];
    expect(asked).toBeDefined();
    expect(Object.hasOwn(asked ?? {}, 'env')).toBe(true);
    const env = asked?.env as Record<string, string>;
    expect(env.HOME).not.toBe(TRUSTED_HOME);
    expect(env.HOME?.startsWith(parent)).toBe(true);
    expect(Object.hasOwn(env, 'SSL_CERT_FILE')).toBe(false);
    expect(asked?.channel).toBe('chromium');
  });

  it('makes the home for the use, empty of any certificate store, and removes it with the browser after', async () => {
    const given = launcher();
    let seen: { existed: boolean; empty: boolean } | undefined;

    await run(given, () => {
      const home = homeOf(given.asked);
      seen = { existed: existsSync(home), empty: !existsSync(join(home, '.pki')) };
      return Promise.resolve();
    });

    expect(seen).toEqual({ existed: true, empty: true });
    expect(existsSync(homeOf(given.asked))).toBe(false);
    expect(given.state.closed).toBe(1);
  });

  it('gives back what the use returns', async () => {
    await expect(run(launcher(), () => Promise.resolve('the verdict'))).resolves.toBe(
      'the verdict',
    );
  });

  // Break caught: a home left behind when the browser could not be launched.
  it('removes the home and fails with the launch’s own error when the launch fails', async () => {
    const given = launcher({ launchFails: new Error('could not launch') });

    await expect(run(given, () => Promise.resolve())).rejects.toThrow('could not launch');

    expect(existsSync(homeOf(given.asked))).toBe(false);
    expect(given.state.closed).toBe(0);
  });

  // Break caught: a teardown failure that replaces the failure of the test, or one that is lost.
  it('keeps the failure of a test that failed, closes the browser, removes the home, and reports a failed close beside it', async () => {
    const reports: string[] = [];
    const given = launcher({ closeFails: new Error('already gone') });
    const failure = new Error('the test failed');

    const outcome = await run(given, () => Promise.reject(failure), {
      report: (message) => {
        reports.push(message);
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBe(failure);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/already gone/);
    expect(existsSync(homeOf(given.asked))).toBe(false);
  });

  it('fails a test that passed when the browser cannot be closed, and still removes the home', async () => {
    const given = launcher({ closeFails: new Error('already gone') });

    const outcome = await run(given, () => Promise.resolve()).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(UntrustedBrowserTeardownError);
    expect((outcome as UntrustedBrowserTeardownError).message).toMatch(/already gone/);
    expect(existsSync(homeOf(given.asked))).toBe(false);
  });

  it('fails a test that passed when the home cannot be removed, and says so beside a failed test', async () => {
    const stuck = (path: string) => {
      rmSync(path, { recursive: true, force: true });
      throw new Error('the directory is in use');
    };
    const reports: string[] = [];

    const passed = await run(launcher(), () => Promise.resolve(), { removeDirectory: stuck }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const failure = new Error('the test failed');
    const failed = await run(launcher(), () => Promise.reject(failure), {
      removeDirectory: stuck,
      report: (message) => {
        reports.push(message);
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(passed).toBeInstanceOf(UntrustedBrowserTeardownError);
    expect((passed as UntrustedBrowserTeardownError).message).toMatch(/the directory is in use/);
    expect(failed).toBe(failure);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/the directory is in use/);
  });

  it('reports the close and the removal together when both fail', async () => {
    const given = launcher({ closeFails: new Error('already gone') });

    const outcome = await run(given, () => Promise.resolve(), {
      removeDirectory: (path) => {
        rmSync(path, { recursive: true, force: true });
        throw new Error('the directory is in use');
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(UntrustedBrowserTeardownError);
    expect((outcome as UntrustedBrowserTeardownError).failures).toHaveLength(2);
    expect((outcome as UntrustedBrowserTeardownError).message).toMatch(
      /already gone.*the directory is in use/,
    );
  });
});
