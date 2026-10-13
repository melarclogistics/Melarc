import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repositoryPaths } from './paths.ts';
import {
  TestCaRefusedError,
  mintTestCertificates,
  opensslRunner,
  type MintOptions,
  type MintResult,
} from './test-ca.ts';

/**
 * The command that makes the disposable test CA and leaf (`pnpm --filter @melarc/e2e run tls:generate <directory> [days]`; S0.23).
 * It is run by a person, on a machine the owner has cleared for key material, into a directory outside the checkout. **Nothing in
 * the repository runs it**, no test calls the real `openssl`, and it installs nothing into any trust store: its whole output is the
 * three files, and this text.
 */
export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

type Mint = (options: MintOptions) => MintResult;

const USAGE = [
  'usage: pnpm --filter @melarc/e2e run tls:generate <directory> [days]',
  '',
  '  <directory>  where the test CA certificate, the leaf certificate and the leaf key are written.',
  '               It must be outside the repository checkout, and new or empty.',
  '  [days]       how long both certificates are valid, 1 to 31 (default 7).',
  '',
  'It needs the openssl command-line tool (set OPENSSL to its full path if it is not on the path).',
  'It makes keys: run it only on a machine you trust, and not on the shared developer workstation.',
].join('\n');

export function main(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: Io,
  mint: Mint = mintTestCertificates,
): number {
  const [directory, daysText, ...extra] = argv;
  if (directory === undefined || extra.length > 0) {
    io.err(USAGE);
    return 2;
  }
  // Digits only: `Number('')` is 0 and `Number(' 7 ')` is 7, and neither is a number of days somebody typed.
  const days =
    daysText === undefined ? undefined : /^\d{1,3}$/.test(daysText) ? Number(daysText) : Number.NaN;
  if (days !== undefined && Number.isNaN(days)) {
    io.err(`"${daysText ?? ''}" is not a whole number of days.\n\n${USAGE}`);
    return 2;
  }
  const openssl = environment.OPENSSL;
  try {
    const result = mint({
      directory: resolve(directory),
      checkoutRoot: repositoryPaths().root,
      run: opensslRunner(openssl === undefined || openssl.trim() === '' ? 'openssl' : openssl),
      ...(days === undefined ? {} : { days }),
    });
    io.out(`Test certificates written to ${result.directory}`);
    io.out(`  CA certificate  ${result.caPath}`);
    io.out(`  leaf certificate ${result.leafPath}`);
    io.out(`  leaf key         ${result.leafKeyPath}  (private: do not copy it, do not commit it)`);
    io.out(`  CA sha256        ${result.caFingerprint256}`);
    io.out(`  leaf sha256      ${result.leafFingerprint256}`);
    for (const note of result.notes) io.out(`  note: ${note}`);
    io.out('');
    io.out(
      'Before the CA key was deleted, openssl verify showed that the CA refuses a certificate for another name (example.com: a permitted subtree violation) and accepts the leaf for localhost and 127.0.0.1.',
    );
    io.out(
      'The CA key was deleted as soon as the leaf was signed and those proofs were made. Nothing was trusted by this command:',
    );
    io.out(
      'how each browser is made to trust the CA, in a disposable profile, is recorded per engine (e2e/README.md).',
    );
    io.out(`To use the material in a run, set MELARC_E2E_TLS_DIR=${result.directory}`);
    return 0;
  } catch (failure) {
    io.err(
      failure instanceof TestCaRefusedError
        ? failure.message
        : `The test CA was not made: ${failure instanceof Error ? failure.message : 'unknown failure'}`,
    );
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env, {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  });
}
