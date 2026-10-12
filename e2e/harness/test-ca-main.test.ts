import { describe, expect, it } from 'vitest';

import { main } from './test-ca-main.ts';
import { TestCaRefusedError, type MintOptions, type MintResult } from './test-ca.ts';

/** The command's own behaviour, with the generator replaced: it arranges the call, prints paths and fingerprints, and exits. */
const RESULT: MintResult = {
  directory: '/safe/tls',
  caPath: '/safe/tls/ca.pem',
  leafPath: '/safe/tls/leaf.pem',
  leafKeyPath: '/safe/tls/leaf-key.pem',
  caFingerprint256: 'AA:AA',
  leafFingerprint256: 'BB:BB',
  notes: ['a note'],
};

function run(
  argv: string[],
  mint?: (options: MintOptions) => MintResult,
  environment: NodeJS.ProcessEnv = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(
    argv,
    environment,
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    mint,
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('the test CA command', () => {
  it('prints the usage and exits 2 without a directory, or with more than it takes', () => {
    const calls: MintOptions[] = [];
    const mint = (options: MintOptions): MintResult => {
      calls.push(options);
      return RESULT;
    };

    expect(run([], mint).code).toBe(2);
    expect(run(['/a', '7', 'extra'], mint).code).toBe(2);
    expect(run([], mint).err).toContain('usage: pnpm --filter @melarc/e2e run tls:generate');
    expect(calls).toEqual([]);
  });

  it.each(['seven', '1.5', ''])(
    'refuses %j as the number of days, before it generates anything',
    (days) => {
      const mint = (): MintResult => {
        throw new Error('must not be called');
      };

      const answer = run(['/safe/tls', days], mint);

      expect(answer.code).toBe(2);
      expect(answer.err).toContain('is not a whole number of days');
    },
  );

  // Break caught: the command asking for the checkout as the place for key material, or ignoring the days given.
  it('passes the directory, the days and the checkout, and the openssl it was told to use', () => {
    const seen: MintOptions[] = [];

    const answer = run(['/safe/tls', '3'], (options) => (seen.push(options), RESULT), {
      OPENSSL: '/opt/openssl/bin/openssl',
    });

    expect(answer.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.days).toBe(3);
    expect(seen[0]?.directory).toMatch(/safe[\\/]tls$/);
    expect(seen[0]?.checkoutRoot).toMatch(/Melarc|melarc|checkout/i);
  });

  // Break caught: the result of the command carrying a key, and the next step being left for the reader to guess.
  it('prints the paths, the fingerprints and the next step, and says nothing was trusted', () => {
    const answer = run(['/safe/tls'], () => RESULT);

    expect(answer.out).toContain('/safe/tls/leaf-key.pem');
    expect(answer.out).toContain('AA:AA');
    expect(answer.out).toContain('BB:BB');
    expect(answer.out).toContain('note: a note');
    expect(answer.out).toContain('Nothing was trusted by this command');
    expect(answer.out).toContain(
      'openssl verify showed that the CA refuses a certificate for another name',
    );
    expect(answer.out).toContain('MELARC_E2E_TLS_DIR=/safe/tls');
    expect(answer.out).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it('prints why it refused, and exits 1', () => {
    const refusing = (): MintResult => {
      throw new TestCaRefusedError(['the TLS directory is inside the repository checkout']);
    };

    const answer = run(['/safe/tls'], refusing);

    expect(answer.code).toBe(1);
    expect(answer.err).toContain('inside the repository checkout');
  });

  it('prints a failure of the tool as a failure and exits 1', () => {
    const failing = (): MintResult => {
      throw new Error('openssl "req" failed (exit 1): bad option');
    };

    const answer = run(['/safe/tls'], failing);

    expect(answer.code).toBe(1);
    expect(answer.err).toBe('The test CA was not made: openssl "req" failed (exit 1): bad option');
  });
});
