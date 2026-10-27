import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeCustodyDirectory, parseBundle, removeDirectory, takeBundle } from './custody.ts';
import { repositoryPaths } from './paths.ts';

const SECRET = 'gRQh0T-sentinel-secret-of-a-custody-bundle-0001';

/** A bundle as `bootstrap:seed` writes it (`custody-bundle.ts`, `renderBundle`): the magic line, the target, the facts, the secret. */
function bundleText(options: {
  name?: string;
  email?: string;
  purpose?: string;
  secret?: string;
}): string {
  return [
    'MELARC-BOOTSTRAP-BUNDLE v1',
    'target: 0123456789abcdef0123456789abcdef',
    '',
    `custodian: ${options.name ?? 'Ada Admin'} <${options.email ?? 'ada@melarc.example'}>`,
    `purpose: ${options.purpose ?? 'BOOTSTRAP_SETUP'}`,
    'issued: 2026-10-05T09:00:00.000Z',
    'expires: never (a single-use secret, valid until it is used or replaced)',
    '',
    'secret:',
    options.secret ?? SECRET,
    '',
    'handover:',
    '- Give this file to the named custodian only.',
    '',
  ].join('\n');
}

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'melarc-custody-test-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const bundleFile = (n: number) => `melarc-bootstrap-${String(n).padStart(32, '0')}.bundle`;

describe('parseBundle', () => {
  it('reads the custodian, the purpose and the secret, and nothing else', () => {
    const read = parseBundle(bundleText({}));
    expect(read.fullName).toBe('Ada Admin');
    expect(read.workEmail).toBe('ada@melarc.example');
    expect(read.purpose).toBe('BOOTSTRAP_SETUP');
    expect(read.secret.reveal()).toBe(SECRET);
  });

  // Break caught: a secret that reaches a log or an assertion's diff through the object that carries it.
  it('carries the secret where it prints as nothing', () => {
    const read = parseBundle(bundleText({}));
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(String(read.secret)).not.toContain(SECRET);
  });

  // Break caught: a file that is not a bundle of the command being read as one, and its text taken for a secret.
  it.each([
    ['no magic line', bundleText({}).replace('MELARC-BOOTSTRAP-BUNDLE v1', 'something else')],
    ['no custodian', bundleText({}).replace(/custodian: .*\n/, '')],
    ['no purpose', bundleText({}).replace(/purpose: .*\n/, '')],
    ['no secret', bundleText({}).replace(`secret:\n${SECRET}\n`, '')],
    ['an empty secret', bundleText({ secret: '' })],
  ])('refuses a file with %s', (_label, text) => {
    expect(() => parseBundle(text)).toThrow(/bundle/);
  });

  it('does not repeat the secret when it refuses', () => {
    expect(() => parseBundle(bundleText({}).replace(/custodian: .*\n/, ''))).not.toThrow(
      new RegExp(SECRET),
    );
  });
});

describe('takeBundle', () => {
  // Break caught: a bundle being left in the folder after it was handed over. The command's own instruction is to delete it
  // after handover, and a harness that left it would leave the setup secret of a run on disk.
  it('reads the bundle of one custodian and purpose, and removes it', () => {
    writeFileSync(join(directory, bundleFile(1)), bundleText({ email: 'ada@melarc.example' }));
    writeFileSync(join(directory, bundleFile(2)), bundleText({ email: 'bola@melarc.example' }));

    const taken = takeBundle(directory, 'bola@melarc.example', 'BOOTSTRAP_SETUP');

    expect(taken.secret.reveal()).toBe(SECRET);
    expect(readdirSync(directory)).toEqual([bundleFile(1)]);
  });

  // Break caught: the secret of the wrong purpose being handed to a screen that would use it for another act. A re-enrolment
  // bundle and a setup bundle for the same person are different files.
  it('takes the bundle of the purpose asked for', () => {
    writeFileSync(join(directory, bundleFile(1)), bundleText({ secret: 'first' }));
    writeFileSync(
      join(directory, bundleFile(2)),
      bundleText({ purpose: 'MFA_REENROLMENT', secret: 'second' }),
    );

    expect(takeBundle(directory, 'ada@melarc.example', 'MFA_REENROLMENT').secret.reveal()).toBe(
      'second',
    );
    expect(readdirSync(directory)).toEqual([bundleFile(1)]);
  });

  // Break caught: a run that takes whichever bundle it finds when there are two, and signs one person in with another's secret.
  it('fails when there is none, or more than one, for that custodian and purpose', () => {
    expect(() => takeBundle(directory, 'ada@melarc.example', 'BOOTSTRAP_SETUP')).toThrow(
      /no bundle/,
    );
    writeFileSync(join(directory, bundleFile(1)), bundleText({}));
    writeFileSync(join(directory, bundleFile(2)), bundleText({}));
    expect(() => takeBundle(directory, 'ada@melarc.example', 'BOOTSTRAP_SETUP')).toThrow(
      /more than one/,
    );
    expect(readdirSync(directory)).toHaveLength(2);
  });

  // Break caught: another file in the folder being read as a bundle, or one with a name that is not the command's being trusted.
  it('ignores a file whose name is not a bundle name', () => {
    writeFileSync(join(directory, 'notes.txt'), bundleText({}));
    writeFileSync(join(directory, 'melarc-bootstrap-x.bundle'), bundleText({}));
    expect(() => takeBundle(directory, 'ada@melarc.example', 'BOOTSTRAP_SETUP')).toThrow(
      /no bundle/,
    );
  });

  it('does not repeat the secret or the address when it fails', () => {
    writeFileSync(join(directory, bundleFile(1)), bundleText({}));
    writeFileSync(join(directory, bundleFile(2)), bundleText({}));
    try {
      takeBundle(directory, 'ada@melarc.example', 'BOOTSTRAP_SETUP');
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
      expect(String(error)).not.toContain('ada@melarc.example');
    }
  });
});

describe('makeCustodyDirectory', () => {
  // Break caught: the folder of the secrets being made inside the checkout, where `package:source` and a review archive would reach it.
  it('is a new folder outside the checkout, and removeDirectory takes it away', () => {
    const made = makeCustodyDirectory();
    try {
      expect(existsSync(made)).toBe(true);
      expect(readdirSync(made)).toEqual([]);
      const away = relative(resolve(repositoryPaths().root), resolve(made));
      // On another drive there is no relative path, and the answer is absolute: that is outside too.
      expect(isAbsolute(away) || away.startsWith('..')).toBe(true);
    } finally {
      removeDirectory(made);
    }
    expect(existsSync(made)).toBe(false);
  });
});
