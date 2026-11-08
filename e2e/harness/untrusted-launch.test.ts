import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Project-level launch defaults cannot leak into the untrusted launch (the first hosted run, 13 October 2026: the Chromium negative
 * control loaded the origin it must refuse). **This runs the real Playwright Test runner**, with a project whose `launchOptions.env` is
 * the trusted one (a HOME that holds the CA, as `playwright.config.ts` builds it for an HTTPS project), and the real `launch` of the
 * pinned Playwright, which merges the project's defaults under the options it is given: `{ ...defaults, ...options }`. A double that
 * never merged defaults would show nothing about whether they leak.
 *
 * The one thing that is not real is the browser: the "executable" is Node itself, run on a script that writes only the environment it
 * was handed (names and paths of the test's own making, no value of the real environment), so no browser, no CA and no network is
 * needed. Two launches are made under the same project:
 *
 * - the **old control**, which copied the options and deleted `env`: the run must see the trusted HOME come back, which is the cause;
 * - `withUntrustedBrowser`, which gives an environment of its own explicitly: the run must see the isolated one, and the disposable home
 *   must be gone afterwards although the launch failed (the fake exits, which is how a launch fails).
 */
const E2E = resolve(import.meta.dirname, '..');
const TRUSTED_HOME = '/trusted/run/tls/engines/chromium-home';
const TRUSTED_DIR = '/trusted/run/tls';

/** What the "browser" writes: where it was told its home and its XDG directories are, and which locators of a store it was given. */
const RECORD_SCRIPT = [
  'const e = process.env;',
  "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({",
  '  home: e.HOME === undefined ? null : e.HOME,',
  '  xdg: [e.XDG_CONFIG_HOME, e.XDG_DATA_HOME, e.XDG_CACHE_HOME, e.XDG_STATE_HOME].map((v) => (v === undefined ? null : v)),',
  '  ssl: [e.SSL_CERT_FILE, e.SSL_CERT_DIR, e.SSL_DIR].map((v) => (v === undefined ? null : v)),',
  "  harness: Object.keys(e).filter((name) => name.startsWith('MELARC_')),",
  "  path: typeof e.PATH === 'string' && e.PATH.length > 0,",
  '}));',
].join('\n');

const SPEC = [
  "import { existsSync, readFileSync } from 'node:fs';",
  "import { expect, test } from '@playwright/test';",
  "import { withUntrustedBrowser } from '../harness/untrusted-browser.ts';",
  '',
  '// The "browser" is Node, run on the recording script: no default argument is passed, so the script is all it runs.',
  'const fake = (record) => ({',
  '  executablePath: process.execPath,',
  '  ignoreDefaultArgs: true,',
  "  args: ['-e', process.env.MELARC_CASE_SCRIPT, '--', record],",
  '  timeout: 20000,',
  '});',
  '',
  "test('what the untrusted launch is handed, under the project\\'s trusted launch defaults', async ({ playwright, launchOptions }) => {",
  '  // The defaults of the project are the trusted ones: this is what Playwright Test installs for every launch of the worker.',
  '  expect(launchOptions.env.HOME).toBe(process.env.MELARC_CASE_TRUSTED_HOME);',
  '',
  '  // The old control: the options copied and `env` deleted. The fake exits, so the launch rejects, which is fine here.',
  '  const old = { ...launchOptions, ...fake(process.env.MELARC_CASE_RECORD_OLD) };',
  '  delete old.env;',
  '  await playwright.chromium.launch(old).then(() => undefined, () => undefined);',
  '  expect(existsSync(process.env.MELARC_CASE_RECORD_OLD)).toBe(true);',
  '',
  '  // The correction: the environment is given explicitly, by the helper that the negative control uses.',
  '  await withUntrustedBrowser(',
  '    playwright.chromium,',
  '    { ...launchOptions, ...fake(process.env.MELARC_CASE_RECORD_NEW) },',
  '    () => Promise.resolve(),',
  '    { trustedPaths: [process.env.MELARC_CASE_TRUSTED_DIR], parent: process.env.MELARC_CASE_PARENT },',
  '  ).then(() => undefined, () => undefined);',
  '  expect(existsSync(process.env.MELARC_CASE_RECORD_NEW)).toBe(true);',
  '  expect(readFileSync(process.env.MELARC_CASE_RECORD_NEW, "utf8")).not.toBe("");',
  '});',
].join('\n');

const CONFIG = [
  '// A project whose launch options are the trusted ones: the environment of the run, with a HOME that holds the trust store.',
  'export default {',
  "  testDir: '.',",
  "  testMatch: 'untrusted.spec.ts',",
  "  reporter: 'list',",
  '  workers: 1,',
  '  retries: 0,',
  '  use: { launchOptions: { env: { ...process.env, HOME: process.env.MELARC_CASE_TRUSTED_HOME } } },',
  '};',
].join('\n');

interface Recorded {
  home: string | null;
  xdg: (string | null)[];
  ssl: (string | null)[];
  harness: string[];
  path: boolean;
}

describe('the untrusted launch under the real Playwright Test runner', () => {
  // The directory is made below `e2e`, so that `@playwright/test` resolves as it does for the real specs; it is removed after.
  let work = '';
  let parent = '';
  const records = { old: '', fresh: '' };
  let output = '';
  let status: number | null = null;

  beforeAll(() => {
    work = mkdtempSync(join(E2E, '.untrusted-launch-'));
    parent = join(work, 'homes');
    mkdirSync(parent);
    records.old = join(work, 'record-old.json');
    records.fresh = join(work, 'record-new.json');
    writeFileSync(join(work, 'playwright.config.mjs'), CONFIG);
    writeFileSync(join(work, 'untrusted.spec.ts'), SPEC);
    const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
    const result = spawnSync(
      process.execPath,
      [cli, 'test', '-c', 'playwright.config.mjs', '--output=out'],
      {
        cwd: work,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          // The names of the test's own, all stripped from an untrusted environment because of their prefix, and all in the trusted one.
          MELARC_CASE_SCRIPT: RECORD_SCRIPT,
          MELARC_CASE_TRUSTED_HOME: TRUSTED_HOME,
          MELARC_CASE_TRUSTED_DIR: TRUSTED_DIR,
          MELARC_CASE_PARENT: parent,
          MELARC_CASE_RECORD_OLD: records.old,
          MELARC_CASE_RECORD_NEW: records.fresh,
          // Things that name a store, in the trusted environment and in the runner's own: none may reach the untrusted browser.
          SSL_CERT_FILE: `${TRUSTED_DIR}/ca.pem`,
          SSL_CERT_DIR: TRUSTED_DIR,
          SSL_DIR: `${TRUSTED_HOME}/.pki/nssdb`,
          XDG_CONFIG_HOME: `${TRUSTED_HOME}/.config`,
          XDG_DATA_HOME: `${TRUSTED_HOME}/.local/share`,
        },
      },
    );
    status = result.status;
    output = `${result.stdout}\n${result.stderr}`;
  }, 150_000);

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const read = (path: string): Recorded => JSON.parse(readFileSync(path, 'utf8')) as Recorded;

  it('ran the synthetic spec to a pass, under the real runner', () => {
    expect(status, output).toBe(0);
  });

  // The cause. Deleting `env` from the copy does not remove it from the launch: Playwright Test installs the project's launch options
  // as the defaults of every launch of the worker and `launch` merges them under the options, so the trusted environment is back, with
  // its CA-bearing HOME and everything else that names a store.
  it('shows the old control getting the trusted environment back, which is why the Chromium control loaded the origin', () => {
    const old = read(records.old);

    expect(old.home).toBe(TRUSTED_HOME);
    expect(old.ssl).toEqual([`${TRUSTED_DIR}/ca.pem`, TRUSTED_DIR, `${TRUSTED_HOME}/.pki/nssdb`]);
    expect(old.harness).toContain('MELARC_CASE_TRUSTED_DIR');
  });

  // Break caught: the helper's environment merged with, or overridden by, the project's defaults.
  it('hands the untrusted launch an environment of its own, whatever the project’s launch defaults are', () => {
    const fresh = read(records.fresh);

    expect(fresh.home).not.toBe(TRUSTED_HOME);
    expect(fresh.home?.startsWith(parent)).toBe(true);
    expect(basename(fresh.home ?? '').startsWith('melarc-untrusted-home-')).toBe(true);
    for (const directory of fresh.xdg) {
      const way = relative(fresh.home ?? '', directory ?? '');
      expect(directory !== null && way !== '' && !way.startsWith('..') && !isAbsolute(way)).toBe(
        true,
      );
    }
    expect(fresh.ssl).toEqual([null, null, null]);
    expect(fresh.harness).toEqual([]);
    expect(fresh.path, 'the runtime settings of the runner are kept').toBe(true);
    expect(JSON.stringify(fresh).includes(TRUSTED_DIR)).toBe(false);
  });

  // Break caught: a disposable home left behind when the launch fails (the fake exits, as a browser that cannot start does).
  it('removes the disposable home although the launch failed', () => {
    const fresh = read(records.fresh);

    expect(existsSync(fresh.home ?? '')).toBe(false);
  });
});
