import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SecretText } from './secret-text.ts';

/**
 * The custody bundles of a run (S0.45; MIGRATION_AND_SEEDING.md §3.2): where `bootstrap:seed` and `bootstrap:resume` leave the one-time
 * secret of an administrator, and how a journey takes it, as a custodian is handed theirs. **A bundle holds a secret in clear.** The
 * folder is made here, outside the checkout (the command refuses one inside it, and `package:source` refuses a bundle by its name), a
 * bundle is read once and removed in the same step, and the folder is removed when the run ends. The secret is a `SecretText`, so that
 * it prints as nothing.
 *
 * The format is the command's (`apps/api/src/tools/bootstrap/custody-bundle.ts`), and the harness reads it without importing it: the
 * file name, the first line, and the `custodian:`, `purpose:` and `secret:` lines. A change of the format fails a journey at the first
 * step, which is the right place for it to be found.
 */

const BUNDLE_FILE_NAME = /^melarc-bootstrap-[0-9a-f]{32}\.bundle$/;
const BUNDLE_MAGIC = 'MELARC-BOOTSTRAP-BUNDLE v1';
const CUSTODIAN = /^custodian: (.+?) <([^<>\s]+)>$/;

export interface Bundle {
  readonly fullName: string;
  readonly workEmail: string;
  readonly purpose: string;
  readonly secret: SecretText;
}

/** A new private folder in the machine's temporary folder, outside the checkout, for the bundles of one run. */
export function makeCustodyDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'melarc-e2e-custody-'));
}

export function removeDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/** Reads the text of a bundle. The failure names what is missing and never repeats the text. */
export function parseBundle(text: string): Bundle {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== BUNDLE_MAGIC)
    throw new Error('The file is not a custody bundle: its first line is not the magic line.');
  let custodian: RegExpExecArray | null = null;
  let purpose: string | undefined;
  let secret: string | undefined;
  lines.forEach((line, at) => {
    custodian ??= CUSTODIAN.exec(line);
    if (purpose === undefined && line.startsWith('purpose: '))
      purpose = line.slice('purpose: '.length).trim();
    if (secret === undefined && line === 'secret:') secret = (lines[at + 1] ?? '').trim();
  });
  const found = custodian as RegExpExecArray | null;
  if (found === null) throw new Error('The bundle names no custodian.');
  if (purpose === undefined || purpose === '') throw new Error('The bundle names no purpose.');
  if (secret === undefined || secret === '') throw new Error('The bundle holds no secret.');
  return {
    fullName: found[1] ?? '',
    workEmail: (found[2] ?? '').toLowerCase(),
    purpose,
    secret: new SecretText(secret),
  };
}

/**
 * The bundle of one custodian and purpose, read and removed. It fails when there is none or more than one: a run that took whichever
 * bundle it found would sign one person in with another's secret. The folder's other files, and a file whose name is not a bundle's, are
 * left alone and not read.
 */
export function takeBundle(directory: string, workEmail: string, purpose: string): Bundle {
  const wanted = workEmail.toLowerCase();
  const matches: { readonly path: string; readonly bundle: Bundle }[] = [];
  for (const name of readdirSync(directory)) {
    if (!BUNDLE_FILE_NAME.test(name)) continue;
    const path = join(directory, name);
    let bundle: Bundle;
    try {
      bundle = parseBundle(readFileSync(path, 'utf8'));
    } catch {
      // A file of the folder that is not a bundle of this run is not this custodian's.
      continue;
    }
    if (bundle.workEmail === wanted && bundle.purpose === purpose) matches.push({ path, bundle });
  }
  if (matches.length === 0) {
    throw new Error(`There is no bundle for that custodian and the purpose ${purpose}.`);
  }
  const [only, ...others] = matches;
  if (only === undefined || others.length > 0) {
    throw new Error(`There is more than one bundle for that custodian and the purpose ${purpose}.`);
  }
  rmSync(only.path, { force: true });
  return only.bundle;
}
