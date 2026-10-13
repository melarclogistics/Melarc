import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MAX_VALID_DAYS,
  TLS_FILES,
  checkTlsMaterial,
  directoryProblems,
  type TlsMaterialResult,
} from './tls-material.ts';

/**
 * Generates the disposable test CA and leaf of the trusted HTTPS origin (S0.23; implementation plan §11.5) with the `openssl`
 * command-line tool, into a directory **outside the checkout**. **Nothing in this repository runs it on its own**: it is run by a
 * person on a machine the owner has cleared for key material (a clean machine or CI), and its tests run it against a fake `openssl`
 * and generate no key.
 *
 * What it makes, and what it will not:
 *
 * - A P-256 CA and one leaf, each valid for `days` days (at most `MAX_VALID_DAYS`). The CA is a self-signed authority with a path
 *   length of zero and **name constraints that permit only `localhost` and `127.0.0.1`**, so that even a browser that trusted it
 *   could be made to believe nothing outside the loopback. The leaf is not a CA, serves `serverAuth`, and names `localhost` and
 *   `127.0.0.1`.
 * - **Before the CA's key is deleted, the name constraints are proved to bind, with `openssl verify`**, which is the only tool here that
 *   enforces them (the policy of `tls-material.ts` reads that they exist, not what they permit): the leaf verifies against the CA for
 *   `localhost` and for `127.0.0.1`, and a second leaf for `example.com`, signed by the same CA, **does not** (a permitted subtree
 *   violation). A CA whose constraints do not refuse an outside name is refused, and everything it made is removed.
 * - **The CA's private key is deleted as soon as the leaf is signed and the proofs are done.** What remains is the CA certificate and
 *   the leaf certificate (both public) and the leaf's private key, which is readable by its owner alone.
 * - It works in a private directory of its own inside the result and removes it (the serial file of the CA goes with it), and it
 *   checks that exactly the three files remain. If any step fails, or the directory holds anything else, everything it made is
 *   removed (the folders it created, or the contents of the empty directory it was given) and the failure is reported; it leaves
 *   no partial material. It never overwrites: the directory must be new or empty, and outside the checkout wherever it leads.
 * - It installs **nothing** into any trust store, system, user or browser, and changes no setting of the machine. How a browser is
 *   made to trust the CA, in a disposable environment or an isolated profile, is the spike's to record per engine (`e2e/README.md`);
 *   a persistent machine-wide trust change needs the owner's authorization of an exact installation and removal plan first.
 * - It prints no key and no key material: the result is the paths and the fingerprints of the two certificates.
 */
/** Runs `openssl` with the arguments, in `cwd`, and throws if it does not succeed. It is given no input and returns no output. */
export type OpensslRun = (args: readonly string[], cwd: string) => void;

export interface MintOptions {
  readonly directory: string;
  readonly checkoutRoot: string;
  readonly days?: number;
  /** The `openssl` runner. The real one is `opensslRunner`. */
  readonly run: OpensslRun;
  /** Judges the result. Defaults to the policy of `tls-material.ts`; a test replaces it because it has no certificate to judge. */
  readonly verify?: (directory: string) => TlsMaterialResult;
  readonly platform?: NodeJS.Platform;
}

export interface MintResult {
  readonly directory: string;
  readonly caPath: string;
  readonly leafPath: string;
  readonly leafKeyPath: string;
  readonly caFingerprint256: string;
  readonly leafFingerprint256: string;
  readonly notes: readonly string[];
}

const CURVE = ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256'] as const;

/** The serial number file `openssl x509 -CAcreateserial` keeps, in the work directory (it is removed with it). */
const SERIAL_FILE = 'ca.srl';

/** The extension file the leaf is signed with. A file and not `-addext`, which `openssl x509 -req` does not take. */
export const LEAF_EXTENSIONS = [
  'basicConstraints = critical, CA:FALSE',
  'keyUsage = critical, digitalSignature',
  'extendedKeyUsage = serverAuth',
  'subjectAltName = DNS:localhost, IP:127.0.0.1',
  '',
].join('\n');

/** A name outside the loopback, for the leaf that the CA must refuse. */
export const OUTSIDE_NAME = 'example.com';

/** The extensions of that leaf: the same as the real one's, but for a name the CA's constraints do not permit. */
export const OUTSIDE_EXTENSIONS = LEAF_EXTENSIONS.replace(
  'subjectAltName = DNS:localhost, IP:127.0.0.1',
  `subjectAltName = DNS:${OUTSIDE_NAME}`,
);

/** What `openssl verify` says when a name constraint refuses a certificate (X509_V_ERR_PERMITTED_VIOLATION). */
const PERMITTED_VIOLATION = /permitted subtree violation/i;

export class TestCaRefusedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The test CA was not made:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'TestCaRefusedError';
    this.problems = problems;
  }
}

export function mintTestCertificates(options: MintOptions): MintResult {
  const { directory, checkoutRoot, run } = options;
  const days = options.days ?? 7;
  const platform = options.platform ?? process.platform;
  const problems = directoryProblems(directory, checkoutRoot);
  if (!Number.isInteger(days) || days < 1 || days > MAX_VALID_DAYS) {
    problems.push(
      `the certificates are valid for a whole number of days from 1 to ${String(MAX_VALID_DAYS)}`,
    );
  }
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    problems.push('the TLS directory is not empty: nothing is overwritten');
  }
  if (problems.length > 0) throw new TestCaRefusedError(problems);

  // The first folder this call makes (every one it makes is below it), or nothing when the directory was there and empty. A failure
  // removes that folder, or empties the directory it was given: the directory was empty when this started, so whatever is in it was
  // made by this run.
  const made = mkdirSync(directory, { recursive: true, mode: 0o700 });
  const undo = (): void => {
    if (made !== undefined) {
      rmSync(made, { recursive: true, force: true });
      return;
    }
    for (const entry of readdirSync(directory)) {
      rmSync(join(directory, entry), { recursive: true, force: true });
    }
  };
  const work = join(directory, `.work-${randomBytes(6).toString('hex')}`);
  const days_ = String(days);

  try {
    mkdirSync(work, { mode: 0o700 });
    // The CA: a key, and a self-signed certificate that can sign one level of leaf and name only the loopback.
    run([...CURVE, '-out', 'ca-key.pem'], work);
    run(
      [
        'req',
        '-new',
        '-x509',
        '-sha256',
        '-key',
        'ca-key.pem',
        '-days',
        days_,
        '-subj',
        '/CN=Melarc disposable test CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE,pathlen:0',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
        '-addext',
        'nameConstraints=critical,permitted;DNS:localhost,permitted;IP:127.0.0.1/255.255.255.255',
        '-out',
        join('..', TLS_FILES.ca),
      ],
      work,
    );
    // The leaf: its own key, a request, and a certificate the CA signs with the extensions below.
    run([...CURVE, '-out', join('..', TLS_FILES.leafKey)], work);
    run(
      [
        'req',
        '-new',
        '-key',
        join('..', TLS_FILES.leafKey),
        '-subj',
        '/CN=localhost',
        '-out',
        'leaf.csr',
      ],
      work,
    );
    writeFileSync(join(work, 'leaf.ext'), LEAF_EXTENSIONS, { mode: 0o600 });
    run(
      [
        'x509',
        '-req',
        '-sha256',
        '-in',
        'leaf.csr',
        '-CA',
        join('..', TLS_FILES.ca),
        '-CAkey',
        'ca-key.pem',
        // Without this `openssl` writes the serial file next to the CA certificate, which is the result directory.
        '-CAserial',
        SERIAL_FILE,
        '-CAcreateserial',
        '-days',
        days_,
        '-extfile',
        'leaf.ext',
        '-out',
        join('..', TLS_FILES.leaf),
      ],
      work,
    );

    // The CA's key is still here. Show what the policy can only read: that the constraints are enforced by a verifier.
    const proof = nameConstraintProblems(run, work, days_);
    if (proof.length > 0) throw new TestCaRefusedError(proof);
  } catch (failure) {
    // Whatever was made is removed, the CA's key with it, and a directory this call made goes too.
    undo();
    throw failure;
  }

  // The CA's key has done its one job. It is removed with everything else the work directory held.
  rmSync(work, { recursive: true, force: true });
  if (platform !== 'win32') chmodSync(join(directory, TLS_FILES.leafKey), 0o600);

  // Exactly the three files, whatever `openssl` did on this machine: the result is what is documented, or it is nothing.
  const wanted = new Set<string>(Object.values(TLS_FILES));
  const strays = readdirSync(directory).filter((entry) => !wanted.has(entry));
  const verdict: TlsMaterialResult =
    strays.length > 0
      ? {
          ok: false,
          problems: [
            `the directory holds more than the three files that were asked for: ${strays.join(', ')}`,
          ],
        }
      : (options.verify ?? ((dir: string) => checkTlsMaterial(dir, { checkoutRoot, platform })))(
          directory,
        );
  if (!verdict.ok) {
    undo();
    throw new TestCaRefusedError(verdict.problems);
  }
  const { material } = verdict;
  return {
    directory,
    caPath: material.caPath,
    leafPath: material.leafPath,
    leafKeyPath: material.leafKeyPath,
    caFingerprint256: material.caFingerprint256,
    leafFingerprint256: material.leafFingerprint256,
    notes: material.notes,
  };
}

/**
 * The proof that the name constraints bind, by the tool that enforces them: positive for the leaf's own names, negative for a name
 * outside, signed by the same CA with the same key (so that nothing but the name differs). Steps that make the second leaf are
 * generation steps and fail the run as any other does; the verifications are judged, and say what they found.
 */
function nameConstraintProblems(run: OpensslRun, work: string, days: string): string[] {
  const problems: string[] = [];
  const ca = join('..', TLS_FILES.ca);
  const leaf = join('..', TLS_FILES.leaf);
  const verify = (extra: readonly string[], certificate: string): string | undefined => {
    try {
      run(['verify', '-CAfile', ca, '-purpose', 'sslserver', ...extra, certificate], work);
      return undefined;
    } catch (failure) {
      return failure instanceof Error ? failure.message : 'openssl verify failed';
    }
  };

  for (const [what, extra] of [
    ['localhost', ['-verify_hostname', 'localhost']],
    ['127.0.0.1', ['-verify_ip', '127.0.0.1']],
  ] as const) {
    const failure = verify(extra, leaf);
    if (failure !== undefined) {
      problems.push(`the leaf certificate does not verify against the CA for ${what}: ${failure}`);
    }
  }

  writeFileSync(join(work, 'outside.ext'), OUTSIDE_EXTENSIONS, { mode: 0o600 });
  run(
    [
      'req',
      '-new',
      '-key',
      join('..', TLS_FILES.leafKey),
      '-subj',
      `/CN=${OUTSIDE_NAME}`,
      '-out',
      'outside.csr',
    ],
    work,
  );
  run(
    [
      'x509',
      '-req',
      '-sha256',
      '-in',
      'outside.csr',
      '-CA',
      ca,
      '-CAkey',
      'ca-key.pem',
      '-CAserial',
      SERIAL_FILE,
      '-days',
      days,
      '-extfile',
      'outside.ext',
      '-out',
      'outside.pem',
    ],
    work,
  );
  const refusal = verify([], 'outside.pem');
  if (refusal === undefined) {
    problems.push(
      `the CA verified a certificate for ${OUTSIDE_NAME}: its name constraints do not hold, and the CA is not made`,
    );
  } else if (!PERMITTED_VIOLATION.test(refusal)) {
    problems.push(
      `a certificate for ${OUTSIDE_NAME} was refused, but not by the name constraints (no permitted subtree violation): ${refusal}`,
    );
  }
  return problems;
}

/**
 * Runs the `openssl` found as `command` (by name on the path, or by the full path of a copy that is not on it). The tool is given no
 * input and its output is not kept, apart from the last lines of what it says on failure; no step prints a key. A command that
 * cannot be started, and one that exits with anything but zero, are both failures that say which step it was.
 */
export function opensslRunner(command = 'openssl'): OpensslRun {
  return (args, cwd) => {
    const result = spawnSync(command, [...args], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error !== undefined) {
      throw new Error(
        `${command} could not be run for "${args[0] ?? ''}": ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      const tail = result.stderr.trim().split('\n').slice(-3).join(' | ');
      throw new Error(
        `${command} "${args[0] ?? ''}" failed (exit ${String(result.status)}): ${tail}`,
      );
    }
  };
}
