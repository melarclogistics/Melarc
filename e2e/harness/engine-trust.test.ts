import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CA_NICKNAME,
  CA_TRUST_FLAGS,
  ENGINES,
  certutilRunner,
  planAllEngines,
  planEngineTrust,
  prepareEngineTrust,
  trustRootOf,
  type EnginePlan,
} from './engine-trust.ts';

/**
 * How each engine is made to trust the disposable CA (S0.23), proved on what has no need of a store, a tool or a certificate: where
 * each store is, what is asked of `certutil`, what environment each browser process gets, that nothing outside the run's own
 * directory is named, and what happens when a step fails. **No store is made and no `certutil` is run by any test here**; that each
 * engine really trusts the CA is what the spike (`tests/https-trust.spec.ts`) shows, in the clean environment.
 */
let base = '';
const CA = '/tls/ca.pem';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'melarc-trust-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const linux = (engine: (typeof ENGINES)[number], root = join(base, 'engines')) =>
  planEngineTrust(engine, { root, caPath: CA, platform: 'linux' });
const supported = (plan: EnginePlan) => {
  if (!plan.supported) throw new Error(`not supported: ${plan.reason}`);
  return plan;
};

describe('where the stores are, and what each engine is given', () => {
  // Break caught: a store in the user's home or the system's, which would be a trust change of the machine. Every directory and
  // every environment value is below the run's own root, or is the CA certificate itself.
  it.each(ENGINES)(
    'keeps the store of %s below the run’s own root and names nothing else',
    (engine) => {
      const root = join(base, 'engines');
      const plan = supported(linux(engine, root));

      for (const directory of plan.directories) expect(directory.startsWith(root)).toBe(true);
      for (const value of Object.values(plan.trust.env)) {
        expect(value.startsWith(root) || value === CA).toBe(true);
      }
      if (plan.trust.profileTemplate !== undefined) {
        expect(plan.trust.profileTemplate.startsWith(root)).toBe(true);
      }
      for (const args of plan.certutil) {
        for (const argument of args) {
          if (argument.startsWith('sql:')) expect(argument.slice(4).startsWith(root)).toBe(true);
        }
      }
    },
  );

  it('puts Chromium’s NSS database in a home of its own and sets HOME for the browser process only', () => {
    const root = join(base, 'engines');
    const plan = supported(linux('chromium', root));

    expect(plan.trust.env).toEqual({ HOME: join(root, 'chromium-home') });
    expect(plan.directories.at(-1)).toBe(join(root, 'chromium-home', '.pki', 'nssdb'));
    expect(plan.certutil[0]).toEqual([
      '-N',
      '-d',
      `sql:${join(root, 'chromium-home', '.pki', 'nssdb')}`,
      '--empty-password',
    ]);
    expect(plan.trust.profileTemplate).toBeUndefined();
    expect(plan.trust.basis).toBe('documented');
  });

  // Break caught (F04): the seeded profile handed out as the thing to launch from, so that every test shares it. What the plan names is a
  // template; each test copies it (`fresh-profile.ts`), and the plan makes no other directory for a browser to run in.
  it('seeds a Firefox profile as a template to copy, with no environment of its own', () => {
    const root = join(base, 'engines');
    const plan = supported(linux('firefox', root));

    expect(plan.trust.profileTemplate).toBe(join(root, 'firefox-profile'));
    expect(plan.trust.mechanism).toMatch(/copied for each test/);
    expect(plan.directories).toEqual([join(root, 'firefox-profile')]);
    expect(plan.trust.env).toEqual({});
    expect(plan.certutil.map((args) => args[2])).toEqual([
      `sql:${join(root, 'firefox-profile')}`,
      `sql:${join(root, 'firefox-profile')}`,
    ]);
  });

  // Break caught: WebKit reported as established because a candidate was written down. It stays a candidate, which names the CA
  // file for the browser process only and makes no store.
  it('names the CA file to WebKit, makes no store for it, and says it is a candidate', () => {
    const plan = supported(linux('webkit'));

    expect(plan.trust.env).toEqual({ SSL_CERT_FILE: CA });
    expect(plan.directories).toEqual([]);
    expect(plan.certutil).toEqual([]);
    expect(plan.trust.basis).toBe('candidate');
    expect(plan.trust.mechanism).toMatch(/what the spike shows/);
  });

  // Break caught: a CA trusted for more than server authentication (code signing, mail), or marked trusted as an end entity.
  it('trusts the CA to issue server certificates and for nothing else', () => {
    expect(CA_TRUST_FLAGS).toBe('C,,');
    for (const engine of ['chromium', 'firefox'] as const) {
      const add = supported(linux(engine)).certutil[1] ?? [];
      expect(add[0]).toBe('-A');
      expect(add[add.indexOf('-t') + 1]).toBe('C,,');
      expect(add[add.indexOf('-n') + 1]).toBe(CA_NICKNAME);
      expect(add[add.indexOf('-i') + 1]).toBe(CA);
    }
  });

  it('keeps the stores below the TLS directory, in a folder of their own', () => {
    expect(trustRootOf(join(base, 'tls'))).toBe(join(base, 'tls', 'engines'));
  });
});

describe('where a disposable store does not exist', () => {
  // Break caught: a run on a machine whose browsers use the operating system's store being given a "disposable" mechanism that
  // would have to change that store. It is reported unsupported with the reason, never planned.
  it.each(['win32', 'darwin'] as const)('is not planned on %s, and says why', (platform) => {
    for (const engine of ENGINES) {
      const plan = planEngineTrust(engine, { root: join(base, 'engines'), caPath: CA, platform });
      expect(plan).toMatchObject({ supported: false, engine });
      expect(plan.supported ? '' : plan.reason).toMatch(/persistent machine-wide trust change/);
    }
  });
});

describe('making the stores', () => {
  const recorder = () => {
    const calls: (readonly string[])[] = [];
    return { calls, run: (args: readonly string[]) => void calls.push(args) };
  };

  it('makes the directories private to their owner, then runs the commands in order, for each engine that has a store', () => {
    const root = join(base, 'engines');
    const { calls, run } = recorder();

    const trusts = prepareEngineTrust(planAllEngines({ root, caPath: CA, platform: 'linux' }), run);

    expect(trusts.map((trust) => trust.engine)).toEqual(['chromium', 'firefox', 'webkit']);
    expect(existsSync(join(root, 'chromium-home', '.pki', 'nssdb'))).toBe(true);
    expect(existsSync(join(root, 'firefox-profile'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'chromium-home')).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, 'firefox-profile')).mode & 0o777).toBe(0o700);
    }
    expect(calls.map((args) => args[0])).toEqual(['-N', '-A', '-N', '-A']);
  });

  it('runs nothing and makes nothing where no store can be made, and returns no trust', () => {
    const root = join(base, 'engines');
    const { calls, run } = recorder();

    const trusts = prepareEngineTrust(planAllEngines({ root, caPath: CA, platform: 'win32' }), run);

    expect(trusts).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  // Break caught: a store left half seeded (a database with no CA in it) that a later run would trust to be complete.
  it('removes what it made when a command fails, and fails with the reason', () => {
    const root = join(base, 'engines');
    let count = 0;

    expect(() =>
      prepareEngineTrust(planAllEngines({ root, caPath: CA, platform: 'linux' }), () => {
        count += 1;
        if (count === 3) throw new Error('certutil failed');
      }),
    ).toThrow('certutil failed');

    expect(existsSync(root)).toBe(false);
  });
});

describe('certutilRunner', () => {
  const node = (script: string): [string, string[]] => [process.execPath, ['-e', script]];

  it('runs a command to success without keeping its output', () => {
    const [command, args] = node('process.stdout.write("whatever")');

    expect(() => {
      certutilRunner(command)(args);
    }).not.toThrow();
  });

  it('fails with the step and the exit status', () => {
    const [command, args] = node('process.stderr.write("one\\ntwo\\nthree"); process.exit(4)');

    expect(() => {
      certutilRunner(command)(args);
    }).toThrow(/"-e" failed \(exit 4\): two \| three/);
  });

  // Break caught: a missing tool read as a certificate problem. It says what to install.
  it('says what to install when the tool is not there', () => {
    expect(() => {
      certutilRunner(join(base, 'no-such-certutil'))(['-N']);
    }).toThrow(/install libnss3-tools/);
  });
});
