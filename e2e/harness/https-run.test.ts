import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config from '../playwright.config.ts';

import {
  BRANDED_PROJECTS,
  HTTPS_PROJECTS,
  refusalToRun,
  runHttpsSuite,
  type HttpsRunDependencies,
} from './https-run.ts';
import type { MintResult } from './test-ca.ts';

/**
 * The command that runs the proofs over the trusted HTTPS origin (S0.23), tested with a fake of everything it touches: no key is
 * made, no `openssl` runs, no browser starts. What these prove is what the command decides itself: where it will run, in what order
 * it does things, that the directory is removed whatever happens, and what it exits with.
 */
const TLS = join('/tmp/run', 'tls');
const MATERIAL: MintResult = {
  directory: '/tmp/run/tls',
  caPath: '/tmp/run/tls/ca.pem',
  leafPath: '/tmp/run/tls/leaf.pem',
  leafKeyPath: '/tmp/run/tls/leaf-key.pem',
  caFingerprint256: 'AA:BB',
  leafFingerprint256: 'CC:DD',
  notes: [],
};

function harness(
  options: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    mint?: () => MintResult;
    playwright?: () => number;
  } = {},
) {
  const events: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let playwrightEnvironment: NodeJS.ProcessEnv | undefined;
  let playwrightArguments: readonly string[] = [];
  const deps: HttpsRunDependencies = {
    platform: options.platform ?? 'linux',
    environment: options.environment ?? { CI: 'true', PATH: '/bin' },
    checkoutRoot: '/work/checkout',
    makeDirectory: () => {
      events.push('make-directory');
      return '/tmp/run';
    },
    removeDirectory: (path) => {
      events.push(`remove ${path}`);
    },
    mint: (mintOptions) => {
      events.push(`mint ${mintOptions.directory}`);
      return (options.mint ?? (() => MATERIAL))();
    },
    openssl: () => undefined,
    playwright: (args, environment) => {
      events.push('playwright');
      playwrightArguments = args;
      playwrightEnvironment = environment;
      return (options.playwright ?? (() => 0))();
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return {
    deps,
    events,
    out,
    err,
    playwrightEnvironment: () => playwrightEnvironment,
    playwrightArguments: () => playwrightArguments,
  };
}

describe('where the run is allowed', () => {
  // Break caught: a developer's own machine making a CA and a private key because a script was called (the owner's ruling of 11 October
  // 2026). It refuses without making a directory, a key or running anything.
  it.each([
    ['Windows', 'win32', { CI: 'true' }],
    ['macOS', 'darwin', { CI: 'true' }],
  ] as const)('refuses on %s, even in CI, and does nothing', (_label, platform, environment) => {
    const run = harness({ platform, environment });

    expect(runHttpsSuite(run.deps)).toBe(2);

    expect(run.events).toEqual([]);
    expect(run.err.join('\n')).toMatch(/only on Linux/);
  });

  it('refuses on Linux outside CI unless the machine is declared cleared, and does nothing', () => {
    const run = harness({ environment: { PATH: '/bin' } });

    expect(runHttpsSuite(run.deps)).toBe(2);

    expect(run.events).toEqual([]);
    expect(run.err.join('\n')).toMatch(/MELARC_E2E_KEYS_CLEARED=1/);
    expect(run.err.join('\n')).toMatch(/shared developer workstation is not such a machine/);
  });

  it.each([
    ['CI', { CI: 'true' }],
    ['a machine declared cleared', { MELARC_E2E_KEYS_CLEARED: '1' }],
  ])('runs on Linux in %s', (_label, environment) => {
    expect(refusalToRun('linux', environment)).toBeUndefined();
  });

  // Break caught: CI=false, CI=1 or a blank counted as CI, which would clear a developer's machine by accident.
  it.each([
    { CI: 'false' },
    { CI: '1' },
    { CI: '' },
    { MELARC_E2E_KEYS_CLEARED: 'yes' },
    { MELARC_E2E_KEYS_CLEARED: '0' },
  ])('does not take %j for permission', (environment) => {
    expect(refusalToRun('linux', environment)).toBeDefined();
  });
});

describe('what it does, in order', () => {
  it('makes a private directory, makes the CA in it, runs every HTTPS project with the directory named, and removes the directory', () => {
    const run = harness();

    expect(runHttpsSuite(run.deps)).toBe(0);

    expect(run.events).toEqual(['make-directory', `mint ${TLS}`, 'playwright', 'remove /tmp/run']);
    expect(run.playwrightEnvironment()?.MELARC_E2E_TLS_DIR).toBe(TLS);
    expect(run.playwrightEnvironment()?.CI).toBe('true');
    expect(run.playwrightArguments()).toEqual([
      'test',
      ...HTTPS_PROJECTS.map((name) => `--project=${name}`),
    ]);
    expect(HTTPS_PROJECTS).toEqual([
      'https-chromium',
      'https-chromium-secret',
      'https-firefox',
      'https-firefox-secret',
      'https-webkit',
      'https-webkit-secret',
    ]);
  });

  // Break caught: a run that says the CA was made and prints it, or anything of a key: only the public fingerprint.
  it('says the fingerprint of the CA and nothing of a key', () => {
    const run = harness();

    runHttpsSuite(run.deps);

    expect(run.out.join('\n')).toContain('AA:BB');
    expect(run.out.join('\n')).not.toMatch(/PRIVATE|leaf-key/);
  });
});

describe('how it ends', () => {
  // Break caught: the exit status of the browser run lost, so that a failing run is reported as a pass.
  it.each([1, 2, 130])(
    'exits with the status of the run (%i), and removes the directory',
    (status) => {
      const run = harness({ playwright: () => status });

      expect(runHttpsSuite(run.deps)).toBe(status);

      expect(run.events.at(-1)).toBe('remove /tmp/run');
    },
  );

  // Break caught: key material left behind because the run threw: the directory goes in a `finally`.
  it('removes the directory and fails when the CA cannot be made, and runs no browser', () => {
    const run = harness({
      mint: () => {
        throw new Error('The test CA was not made: openssl failed');
      },
    });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(run.events).toEqual(['make-directory', `mint ${TLS}`, 'remove /tmp/run']);
    expect(run.err.join('\n')).toContain('The test CA was not made');
  });

  it('removes the directory and fails when the browser run throws', () => {
    const run = harness({
      playwright: () => {
        throw new Error('spawn failed');
      },
    });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(run.events.at(-1)).toBe('remove /tmp/run');
  });
});

describe('the projects it runs, and the ones it leaves to the plain run', () => {
  const names = (config.projects ?? []).map((project) => project.name ?? '');
  const scripts = (
    JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  // Break caught: a project that no command runs (an engine added to the configuration and not to the run, so that its proofs never
  // happen and nothing says so), or one that two commands run.
  it('runs, between the plain script and this command, every project of the configuration once', () => {
    const plain = [...(scripts['test:e2e'] ?? '').matchAll(/--project=(\S+)/g)].map(
      (match) => match[1],
    );
    expect(plain).toEqual(['chromium', 'chromium-secret']);
    // The branded projects are the one exception, named: a smoke check for a person, run by neither command.
    expect(names.toSorted()).toEqual([...plain, ...HTTPS_PROJECTS, ...BRANDED_PROJECTS].toSorted());
    expect(new Set([...plain, ...HTTPS_PROJECTS, ...BRANDED_PROJECTS]).size).toBe(names.length);
    expect(HTTPS_PROJECTS.filter((name) => BRANDED_PROJECTS.includes(name))).toEqual([]);
  });

  it('is what the package script runs, through the one command', () => {
    expect(scripts['test:e2e:https']).toBe('node harness/https-run.ts');
  });
});
