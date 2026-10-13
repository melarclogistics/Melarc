import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SYSTEM_CA_PATH,
  privilegedRunner,
  sudoArguments,
  systemTrust,
  systemTrustRefusal,
  type PrivilegedRun,
} from './system-trust.ts';

/**
 * The one change the HTTPS harness makes outside its own directory (S0.23; the owner's decision of 12 October 2026, after the first hosted
 * run showed that Playwright's WebKit on Linux trusts only the system store): on a **GitHub-hosted runner**, a machine made for one job and
 * discarded after it, the disposable CA is put in the system store for WebKit's proofs and taken out when they end. Proved here without
 * a runner, a `sudo` or a store: where the change is allowed, exactly what is asked of the system and in what order, and that taking the
 * CA out is attempted whatever went wrong putting it in. **Nothing here changes any store.**
 */
const HOSTED = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
} as const;
const CA = '/tmp/run/tls/ca.pem';

describe('where the system store may be touched', () => {
  it('is allowed on a Linux runner that GitHub hosts, and only there', () => {
    expect(systemTrustRefusal('linux', HOSTED)).toBeUndefined();
  });

  // Break caught: a developer's machine, a self-hosted runner, or a machine declared cleared for key material having its system trust
  // changed because one variable was set. All three variables must say it, with the exact values GitHub sets, and the owner's ruling of
  // 11 October 2026 (no trust change on the shared workstation) stands: "cleared for key material" is not permission to change trust.
  it.each([
    ['Windows', 'win32', HOSTED],
    ['macOS', 'darwin', HOSTED],
    ['a self-hosted runner', 'linux', { ...HOSTED, RUNNER_ENVIRONMENT: 'self-hosted' }],
    ['no runner environment', 'linux', { CI: 'true', GITHUB_ACTIONS: 'true' }],
    ['no CI variable', 'linux', { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }],
    ['a CI variable that is not "true"', 'linux', { ...HOSTED, CI: '1' }],
    ['no GitHub Actions variable', 'linux', { CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }],
    ['a GitHub Actions variable that is not "true"', 'linux', { ...HOSTED, GITHUB_ACTIONS: 'yes' }],
    ['a machine declared cleared for key material', 'linux', { MELARC_E2E_KEYS_CLEARED: '1' }],
    ['a machine declared cleared, in CI', 'linux', { CI: 'true', MELARC_E2E_KEYS_CLEARED: '1' }],
    ['nothing at all', 'linux', {}],
  ] as const)('refuses %s', (_label, platform, environment) => {
    expect(systemTrustRefusal(platform, environment)).toMatch(/GitHub-hosted runner/);
  });
});

describe('putting the CA in the system store, and taking it out', () => {
  const recorder = (failing: readonly string[] = []) => {
    const calls: string[] = [];
    const run: PrivilegedRun = (command, args) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      if (failing.includes(line)) throw new Error(`${line} failed`);
    };
    return { calls, run };
  };

  // Break caught: the CA put somewhere update-ca-certificates does not read (it reads only `*.crt` below this directory), or under a name
  // that does not say whose it is, so that nobody would know what to remove.
  it('puts the CA where update-ca-certificates reads local authorities, under a name of its own', () => {
    expect(SYSTEM_CA_PATH).toBe('/usr/local/share/ca-certificates/melarc-e2e-disposable-ca.crt');
  });

  it('copies the CA, readable and not writable by others, and rebuilds the system bundle: nothing else', () => {
    const { calls, run } = recorder();

    systemTrust(run).install(CA);

    expect(calls).toEqual([`install -m 0644 ${CA} ${SYSTEM_CA_PATH}`, 'update-ca-certificates']);
  });

  // Break caught: a relative or odd path handed to a privileged command, which would copy whatever the working directory holds.
  it.each(['ca.pem', './ca.pem', '../ca.pem', ''])(
    'refuses %j as the CA to install, and runs nothing',
    (path) => {
      const { calls, run } = recorder();

      expect(() => {
        systemTrust(run).install(path);
      }).toThrow(/absolute path/);

      expect(calls).toEqual([]);
    },
  );

  it('removes the CA and rebuilds the bundle from the system’s own sources', () => {
    const { calls, run } = recorder();

    systemTrust(run).remove();

    expect(calls).toEqual([`rm -f ${SYSTEM_CA_PATH}`, 'update-ca-certificates --fresh']);
  });

  // Break caught: a CA left in the system store because the copy had already succeeded when the rebuild failed: the caller removes after
  // any failure of the install, and the removal does not depend on the install having finished.
  it('can be removed after an install that failed half way', () => {
    const { calls, run } = recorder(['update-ca-certificates']);
    const trust = systemTrust(run);

    expect(() => {
      trust.install(CA);
    }).toThrow(/update-ca-certificates failed/);
    trust.remove();

    expect(calls).toEqual([
      `install -m 0644 ${CA} ${SYSTEM_CA_PATH}`,
      'update-ca-certificates',
      `rm -f ${SYSTEM_CA_PATH}`,
      'update-ca-certificates --fresh',
    ]);
  });

  // Break caught: the second step of the removal not tried because the first failed, which would leave the bundle still holding the CA
  // after the file was gone; and a failure reported as one when both happened.
  it('tries both steps of the removal, and says every one that failed', () => {
    const { calls, run } = recorder([`rm -f ${SYSTEM_CA_PATH}`, 'update-ca-certificates --fresh']);

    expect(() => {
      systemTrust(run).remove();
    }).toThrow(/could not be removed from the system trust store.*rm -f.*failed.*--fresh.*failed/s);

    expect(calls).toHaveLength(2);
  });

  it('says the CA was not put in when the copy fails, and goes no further', () => {
    const { calls, run } = recorder([`install -m 0644 ${CA} ${SYSTEM_CA_PATH}`]);

    expect(() => {
      systemTrust(run).install(CA);
    }).toThrow(/install -m 0644/);

    expect(calls).toEqual([`install -m 0644 ${CA} ${SYSTEM_CA_PATH}`]);
  });
});

describe('privilegedRunner', () => {
  let base = '';
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'melarc-sudo-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // The fake "sudo" is Node itself, run on a script that judges the arguments it was handed after the `--`, so that no privilege is used.
  const node = (script: string): [string, string[]] => [process.execPath, ['-e', script, '--']];

  // Break caught: `-n` left out, so that a runner that wants a password waits for ever; and the command and its arguments handed on in a
  // different order or joined into one string (no shell is involved, so nothing is split or quoted).
  it('hands the command and each argument on, in order, as separate arguments', () => {
    const [command, prefix] = node(
      'process.exit(JSON.stringify(process.argv.slice(1)) === JSON.stringify(["install","-m","0644","a b","c"]) ? 0 : 7)',
    );

    expect(() => {
      privilegedRunner(command, prefix)('install', ['-m', '0644', 'a b', 'c']);
    }).not.toThrow();
  });

  // Break caught: sudo left to ask for a password on a machine that has none to give, so that the run hangs until its deadline.
  it('asks sudo not to prompt, by default, and puts the command after that', () => {
    expect(sudoArguments('rm', ['-f', 'x'])).toEqual(['-n', 'rm', '-f', 'x']);
    expect(sudoArguments('update-ca-certificates', [])).toEqual(['-n', 'update-ca-certificates']);
  });

  it('fails with the command, the exit status and the end of what it said', () => {
    const [command, prefix] = node('process.stderr.write("one\\ntwo\\nthree"); process.exit(4)');

    expect(() => {
      privilegedRunner(command, prefix)('update-ca-certificates', ['--fresh']);
    }).toThrow(/update-ca-certificates --fresh failed \(exit 4\): two \| three/);
  });

  // Break caught: a missing sudo read as a certificate problem. It says where the change is allowed.
  it('says where the change is allowed when sudo is not there', () => {
    expect(() => {
      privilegedRunner(join(base, 'no-such-sudo'))('rm', ['-f', 'x']);
    }).toThrow(/GitHub-hosted runner/);
  });
});
