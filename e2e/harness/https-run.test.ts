import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config from '../playwright.config.ts';

import {
  BRANDED_PROJECTS,
  HTTPS_PHASES,
  HTTPS_PROJECTS,
  refusalToRun,
  runHttpsSuite,
  type HttpsRunDependencies,
} from './https-run.ts';
import type { MintResult } from './test-ca.ts';

/**
 * The command that runs the proofs over the trusted HTTPS origin (S0.23), tested with a fake of everything it touches: no key is
 * made, no `openssl` runs, no browser starts, no `sudo` is used and no store is changed. What these prove is what the command decides
 * itself: where it will run, in what order it does things (the engines that have a store of their own and WebKit's refusal first, then
 * the CA into the system store, then WebKit's proofs, then the CA out again), that the directory and the CA are removed whatever
 * happens, and what it exits with.
 */
const TLS = join('/tmp/run', 'tls');
const CA = '/tmp/run/tls/ca.pem';
const MATERIAL: MintResult = {
  directory: '/tmp/run/tls',
  caPath: CA,
  leafPath: '/tmp/run/tls/leaf.pem',
  leafKeyPath: '/tmp/run/tls/leaf-key.pem',
  caFingerprint256: 'AA:BB',
  leafFingerprint256: 'CC:DD',
  notes: [],
};

/** The projects of the first run: every engine that has a store of its own, and WebKit's refusal, while the system store lacks the CA. */
const BEFORE_CA = [
  'https-chromium',
  'https-chromium-secret',
  'https-firefox',
  'https-firefox-secret',
  'https-webkit-control',
] as const;
/** The projects of the second run: WebKit's proofs that need its trust, with the CA in the system store. */
const WITH_CA = ['https-webkit', 'https-webkit-secret'] as const;

/**
 * Where each run writes its artifacts. Playwright removes the output directory of every project it is about to run when a run starts,
 * so two runs that share one directory erase the first run's evidence (traces, attachments) when the second begins: the first hosted
 * run of the two-run command kept 10 KB of diagnostics for that reason, whatever the first run had found.
 */
const BEFORE_OUT = 'test-results/https-1-own-stores';
const WITH_OUT = 'test-results/https-2-system-store';

const args = (projects: readonly string[], output: string) => [
  'test',
  ...projects.map((name) => `--project=${name}`),
  `--output=${output}`,
];

function harness(
  options: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    mint?: () => MintResult;
    /** What the browser run answers for the projects it is given. */
    playwright?: (projects: readonly string[]) => number;
    /** Why the system store may not be changed here; `undefined` when it may. */
    systemStoreRefusal?: string;
    install?: () => void;
    remove?: () => void;
  } = {},
) {
  const events: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const runs: { args: readonly string[]; environment: NodeJS.ProcessEnv }[] = [];
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
    playwright: (given, environment) => {
      const projects = given
        .filter((argument) => argument.startsWith('--project='))
        .map((argument) => argument.slice('--project='.length));
      events.push(`playwright ${projects.join(',')}`);
      runs.push({ args: given, environment });
      return (options.playwright ?? (() => 0))(projects);
    },
    systemTrust: {
      refusal: () => options.systemStoreRefusal,
      install: (caPath) => {
        events.push(`system-trust install ${caPath}`);
        options.install?.();
      },
      remove: () => {
        events.push('system-trust remove');
        options.remove?.();
      },
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, events, out, err, runs };
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
  // Break caught (the first hosted run, 12 October 2026): WebKit's proofs run with nothing in the system store, so that every one that
  // needs trust fails; or the CA put there before WebKit's refusal ran, so that the refusal is trusted and fails the control.
  it('runs WebKit’s refusal before the CA is in the system store and WebKit’s other proofs after, and takes the CA out', () => {
    const run = harness();

    expect(runHttpsSuite(run.deps)).toBe(0);

    expect(run.events).toEqual([
      'make-directory',
      `mint ${TLS}`,
      `playwright ${BEFORE_CA.join(',')}`,
      `system-trust install ${CA}`,
      `playwright ${WITH_CA.join(',')}`,
      'system-trust remove',
      'remove /tmp/run',
    ]);
    expect(run.runs.map((call) => call.args)).toEqual([
      args(BEFORE_CA, BEFORE_OUT),
      args(WITH_CA, WITH_OUT),
    ]);
    for (const call of run.runs) {
      expect(call.environment.MELARC_E2E_TLS_DIR).toBe(TLS);
      expect(call.environment.CI).toBe('true');
    }
  });

  it('is two runs, the second with the CA in the system store, and every HTTPS project in exactly one', () => {
    expect(HTTPS_PHASES).toEqual([
      {
        name: expect.any(String) as string,
        projects: BEFORE_CA,
        systemTrust: false,
        output: BEFORE_OUT,
      },
      {
        name: expect.any(String) as string,
        projects: WITH_CA,
        systemTrust: true,
        output: WITH_OUT,
      },
    ]);
    expect(HTTPS_PROJECTS).toEqual([...BEFORE_CA, ...WITH_CA]);
    expect(new Set(HTTPS_PROJECTS).size).toBe(HTTPS_PROJECTS.length);
  });

  // Break caught: a run that says the CA was made and prints it, or anything of a key: only the public fingerprint.
  it('says the fingerprint of the CA and nothing of a key', () => {
    const run = harness();

    runHttpsSuite(run.deps);

    expect(run.out.join('\n')).toContain('AA:BB');
    expect(run.out.join('\n')).not.toMatch(/PRIVATE|leaf-key/);
  });

  it('says when the CA is in the system store and when it is taken out', () => {
    const run = harness();

    runHttpsSuite(run.deps);

    expect(run.out.join('\n')).toMatch(/system trust store of this GitHub-hosted runner/);
    expect(run.out.join('\n')).toMatch(/removed from the system trust store/);
  });
});

describe('where the system store may not be changed', () => {
  // Break caught: the system store changed on a machine that is not a disposable runner, because the run was asked for. WebKit's proofs
  // still run, with nothing changed, and are expected to fail to trust; the run says so, and does not skip an engine.
  it('changes nothing, runs WebKit’s proofs anyway and says they will fail to trust', () => {
    const reason = 'the system trust store is changed only on a GitHub-hosted runner';
    const run = harness({
      environment: { MELARC_E2E_KEYS_CLEARED: '1' },
      systemStoreRefusal: reason,
    });

    expect(runHttpsSuite(run.deps)).toBe(0);

    expect(run.events).toEqual([
      'make-directory',
      `mint ${TLS}`,
      `playwright ${BEFORE_CA.join(',')}`,
      `playwright ${WITH_CA.join(',')}`,
      'remove /tmp/run',
    ]);
    expect(run.out.join('\n')).toContain(reason);
    expect(run.out.join('\n')).toMatch(/expected to fail to trust/);
  });
});

describe('how it ends', () => {
  // Break caught: the exit status of the browser run lost, so that a failing run is reported as a pass.
  it.each([1, 2, 130])(
    'exits with the status of the run (%i), and removes the CA and the directory',
    (status) => {
      const run = harness({ playwright: () => status });

      expect(runHttpsSuite(run.deps)).toBe(status);

      expect(run.events.slice(-2)).toEqual(['system-trust remove', 'remove /tmp/run']);
    },
  );

  // Break caught: a failure of the first run hiding the second, so that WebKit's result is never known, or the second run's status
  // replacing the first's, so that what failed first is not what is reported.
  it('runs WebKit’s proofs even when the first run failed, and exits with the first failure', () => {
    const run = harness({ playwright: (projects) => (projects.includes('https-webkit') ? 2 : 1) });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(run.events).toContain(`playwright ${WITH_CA.join(',')}`);
    expect(run.events.slice(-2)).toEqual(['system-trust remove', 'remove /tmp/run']);
  });

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

  it('removes the directory and fails when the first browser run throws, and never touches the system store', () => {
    const run = harness({
      playwright: () => {
        throw new Error('spawn failed');
      },
    });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(run.events).toEqual([
      'make-directory',
      `mint ${TLS}`,
      `playwright ${BEFORE_CA.join(',')}`,
      'remove /tmp/run',
    ]);
  });

  // Break caught: a CA left in the system store because the browser run threw: it is taken out in the `finally`, and before the
  // directory goes.
  it('takes the CA out of the system store when WebKit’s browser run throws', () => {
    const run = harness({
      playwright: (projects) => {
        if (projects.includes('https-webkit')) throw new Error('spawn failed');
        return 0;
      },
    });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(run.events.slice(-2)).toEqual(['system-trust remove', 'remove /tmp/run']);
    expect(run.err.join('\n')).toContain('spawn failed');
  });

  // Break caught: a half-made install (the copy done, the rebuild failed) left in place because the run stopped at the failure: the
  // removal is attempted, WebKit's proofs are not run with a store in an unknown state, and the run fails with the reason.
  it('takes the CA out and does not run WebKit’s proofs when the install fails', () => {
    const run = harness({
      install: () => {
        throw new Error('update-ca-certificates failed (exit 1)');
      },
    });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(run.events).toEqual([
      'make-directory',
      `mint ${TLS}`,
      `playwright ${BEFORE_CA.join(',')}`,
      `system-trust install ${CA}`,
      'system-trust remove',
      'remove /tmp/run',
    ]);
    expect(run.err.join('\n')).toContain('update-ca-certificates failed');
  });

  // Break caught: a CA that stays in the system store reported as a pass. A removal that fails fails the run, whatever the browsers did,
  // and the directory is still removed.
  it('fails a run that passed when the CA cannot be taken out of the system store', () => {
    const run = harness({
      remove: () => {
        throw new Error(
          'The disposable CA could not be removed from the system trust store: rm failed',
        );
      },
    });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(run.err.join('\n')).toContain('could not be removed from the system trust store');
    expect(run.events.at(-1)).toBe('remove /tmp/run');
  });

  it('keeps the status of a failed run when the CA cannot be taken out either', () => {
    const run = harness({
      playwright: () => 2,
      remove: () => {
        throw new Error('rm failed');
      },
    });

    expect(runHttpsSuite(run.deps)).toBe(2);

    expect(run.err.join('\n')).toContain('rm failed');
  });
});

describe('what a failure leaves behind', () => {
  const outputs = HTTPS_PHASES.map((phase) => phase.output);

  // Break caught (the first hosted run of the two-run command, 13 October 2026): the second run clearing the first run's output
  // directory when it began, so that the traces and attachments of a failure of the first run were gone before the artifact was kept,
  // and the artifact said nothing of what had failed. Playwright removes the output directory of every project it runs at the start of a
  // run; each run therefore writes to a directory of its own, and none is inside another or inside the plain run's.
  it('gives each run an output directory of its own, none inside another and none the plain run’s', () => {
    expect(outputs).toEqual([BEFORE_OUT, WITH_OUT]);
    expect(new Set(outputs).size).toBe(outputs.length);
    const plain = posix.normalize(String(config.outputDir));
    for (const output of outputs) {
      expect(output, 'is not the plain run’s').not.toBe(plain);
      expect(output.startsWith(`${plain}/`), 'is not inside the plain run’s').toBe(false);
      expect(plain.startsWith(`${output}/`), 'does not hold the plain run’s').toBe(false);
      for (const other of outputs.filter((candidate) => candidate !== output)) {
        expect(output.startsWith(`${other}/`), `${output} is not inside ${other}`).toBe(false);
      }
    }
  });

  it('hands each run its directory to Playwright, as the output of that run and no other', () => {
    const run = harness();

    runHttpsSuite(run.deps);

    expect(
      run.runs.map((call) => call.args.filter((argument) => argument.startsWith('--output='))),
    ).toEqual([[`--output=${BEFORE_OUT}`], [`--output=${WITH_OUT}`]]);
  });

  // Break caught: a directory of a run written somewhere the failure artifact does not keep, so that a failing job loses the evidence
  // of one of the runs. The workflow keeps `e2e/test-results`, and both directories are below it.
  it('writes below the directory that the failure artifact keeps', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../.github/workflows/ci.yml'),
      'utf8',
    );
    const start = workflow.indexOf('name: Keep the failure diagnostics');
    expect(start, 'the workflow keeps the failure diagnostics').toBeGreaterThan(-1);
    const step = workflow.slice(start, workflow.indexOf('if-no-files-found', start));

    expect(step).toMatch(/^\s+e2e\/test-results\s*$/m);
    for (const output of outputs) expect(output.startsWith('test-results/')).toBe(true);
  });
});

describe('what it says of each run, and of all of them', () => {
  const said = (run: ReturnType<typeof harness>) => run.out.join('\n');

  it('says the exit status of each run when it ends, and sums them up at the end', () => {
    const run = harness();

    runHttpsSuite(run.deps);

    expect(said(run)).toContain('HTTPS run 1 of 2 ended with exit status 0.');
    expect(said(run)).toContain('HTTPS run 2 of 2 ended with exit status 0.');
    expect(said(run)).toContain('HTTPS run summary:');
    expect(said(run)).toContain(`run 1 of 2: exit status 0; output ${BEFORE_OUT}`);
    expect(said(run)).toContain(`run 2 of 2: exit status 0; output ${WITH_OUT}`);
    expect(said(run)).toContain('overall exit status 0');
    expect(run.out.at(-1)).toBe('  overall exit status 0');
  });

  // Break caught: a failure of the first run reported as the second run's, or the second run's status hiding the first: the summary
  // says what each run answered and which one the overall status comes from, the first that did not pass.
  it('names the first run that failed as the source of the overall status, and says what the other did', () => {
    const run = harness({ playwright: (projects) => (projects.includes('https-webkit') ? 2 : 1) });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(said(run)).toContain('HTTPS run 1 of 2 ended with exit status 1.');
    expect(said(run)).toContain('HTTPS run 2 of 2 ended with exit status 2.');
    expect(said(run)).toContain(`run 1 of 2: exit status 1; output ${BEFORE_OUT}`);
    expect(said(run)).toContain(`run 2 of 2: exit status 2; output ${WITH_OUT}`);
    expect(run.out.at(-1)).toBe('  overall exit status 1, from run 1 of 2');
  });

  it('names the second run when only the second failed', () => {
    const run = harness({ playwright: (projects) => (projects.includes('https-webkit') ? 1 : 0) });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(said(run)).toContain(`run 1 of 2: exit status 0; output ${BEFORE_OUT}`);
    expect(said(run)).toContain(`run 2 of 2: exit status 1; output ${WITH_OUT}`);
    expect(run.out.at(-1)).toBe('  overall exit status 1, from run 2 of 2');
  });

  it('says that a run that threw did not complete, and that the next one was not run', () => {
    const run = harness({
      playwright: () => {
        throw new Error('spawn failed');
      },
    });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(said(run)).toContain(
      `run 1 of 2: did not complete (an error stopped it; see above); output ${BEFORE_OUT}`,
    );
    expect(said(run)).toContain(`run 2 of 2: not run; output ${WITH_OUT}`);
    expect(run.out.at(-1)).toBe('  overall exit status 1, from run 1 of 2');
  });

  it('says that the second run was not run when the CA could not be put in the system store', () => {
    const run = harness({
      install: () => {
        throw new Error('update-ca-certificates failed (exit 1)');
      },
    });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(said(run)).toContain(`run 1 of 2: exit status 0; output ${BEFORE_OUT}`);
    expect(said(run)).toContain(`run 2 of 2: not run; output ${WITH_OUT}`);
    expect(run.out.at(-1)).toBe('  overall exit status 1, from run 2 of 2');
  });

  it('says that no run was made when the CA could not be made', () => {
    const run = harness({
      mint: () => {
        throw new Error('The test CA was not made: openssl failed');
      },
    });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(said(run)).toContain(`run 1 of 2: not run; output ${BEFORE_OUT}`);
    expect(said(run)).toContain(`run 2 of 2: not run; output ${WITH_OUT}`);
    expect(run.out.at(-1)).toBe('  overall exit status 1, no run was made (see above)');
  });

  // Break caught: a CA left in the system store reported as a pass that merely had nothing to say: the status comes from taking it out.
  it('says the status came from taking the CA out when both runs passed', () => {
    const run = harness({
      remove: () => {
        throw new Error('rm failed');
      },
    });

    expect(runHttpsSuite(run.deps)).toBe(1);

    expect(said(run)).toContain(`run 2 of 2: exit status 0; output ${WITH_OUT}`);
    expect(run.out.at(-1)).toBe(
      '  overall exit status 1, from taking the CA out of the system trust store (see above)',
    );
  });

  it('says nothing of runs when it refuses to run at all', () => {
    const run = harness({ platform: 'win32' });

    expect(runHttpsSuite(run.deps)).toBe(2);

    expect(run.out).toEqual([]);
  });
});

describe('the projects it runs, and the ones it leaves to the plain run', () => {
  const projects = config.projects ?? [];
  const names = projects.map((project) => project.name ?? '');
  const byName = (name: string) => projects.find((project) => project.name === name);
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

  // Break caught: WebKit's refusal run in the second phase, where the CA is in the system store and the browser trusts the origin (the
  // control then fails), or in neither phase (the control never runs and nothing says so). One tag and one pattern split WebKit's
  // specs: the first project runs only the tagged test, the second runs all the others, and no other project filters by title.
  it('splits WebKit’s specs between the refusal and the rest by one tag, and filters no other project', () => {
    const control = byName('https-webkit-control');
    const rest = byName('https-webkit');

    expect(control?.grep).toEqual(/@untrusted-control/);
    expect(rest?.grepInvert).toEqual(/@untrusted-control/);
    expect(control?.grepInvert).toBeUndefined();
    expect(rest?.grep).toBeUndefined();
    expect(control?.testMatch).toBe(rest?.testMatch);
    for (const name of HTTPS_PROJECTS.filter(
      (candidate) => candidate !== 'https-webkit-control' && candidate !== 'https-webkit',
    )) {
      expect(byName(name)?.grep, name).toBeUndefined();
      expect(byName(name)?.grepInvert, name).toBeUndefined();
    }
  });

  it('puts the tag on exactly one test: the refusal', () => {
    const spec = readFileSync(resolve(import.meta.dirname, '../tests/https-trust.spec.ts'), 'utf8');

    expect(spec.match(/tag: '@untrusted-control'/g)).toHaveLength(1);
    expect(spec).toMatch(
      /test\(\s*'refuses the same origin[^']*',\s*\{ tag: '@untrusted-control' \}/s,
    );
  });
});
