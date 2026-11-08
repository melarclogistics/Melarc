import type { BundlePurpose, Custodian } from './bootstrap-vocabulary.js';

/**
 * The custody bundle (MIGRATION_AND_SEEDING.md §3.2, "How the secrets reach the custodians"; S0.30): the one file that carries a
 * setup secret from the provisioning step to the custodian it belongs to. **It is the only place the secret is written in clear.**
 * Each bundle is one custodian's, names only that custodian, and is deleted after handover with the deletion recorded by the
 * operator; the repository can verify none of that, and says so in the handover text.
 *
 * The file name carries nothing: not the custodian, not the identity, not the purpose. A name that matches `BUNDLE_FILE_NAME`
 * and a first line that is `BUNDLE_MAGIC` are what mark a file as a bundle of this command, so the sweep of orphans removes files that
 * are provably its own and leaves every other file in the folder alone.
 */

/** The first line of every bundle. A version in it, so that a later layout is told from this one. */
export const BUNDLE_MAGIC = 'MELARC-BOOTSTRAP-BUNDLE v1';

/** `melarc-bootstrap-` and 32 hexadecimal digits of randomness (16 bytes), and nothing that identifies a custodian. */
export const BUNDLE_FILE_NAME = /^melarc-bootstrap-[0-9a-f]{32}\.bundle$/;

export const isBundleFileName = (name: string): boolean => BUNDLE_FILE_NAME.test(name);

/** Whether the start of a file is the start of a bundle: its first line is the magic, and the whole first line. */
export const startsLikeBundle = (head: string): boolean =>
  head === BUNDLE_MAGIC ||
  head.startsWith(`${BUNDLE_MAGIC}\n`) ||
  head.startsWith(`${BUNDLE_MAGIC}\r\n`);

/**
 * The target of a bundle: 32 hexadecimal digits that stand for the database it was written for (`targetOf`, `bootstrap-command.ts`:
 * the host, the port and the name of the database, never the user or the password). It is what lets the sweep of orphans say which
 * bundles are provably the run's own: a folder that served another environment holds bundles of pairs that did commit, and a bundle
 * whose pair did not commit is the only kind this run may remove.
 */
export const BUNDLE_TARGET = /^[0-9a-f]{32}$/;

/** The target a bundle names on its second line, or `undefined` when the head of the file names none (an unreadable or foreign file). */
export function bundleTargetOf(head: string): string | undefined {
  if (!startsLikeBundle(head)) return undefined;
  const line = head.split(/\r?\n/)[1];
  const given = line?.startsWith('target: ') === true ? line.slice('target: '.length) : undefined;
  return given !== undefined && BUNDLE_TARGET.test(given) ? given : undefined;
}

export interface BundleContent {
  /** The database this bundle was written for (`BUNDLE_TARGET`). */
  readonly target: string;
  readonly purpose: BundlePurpose;
  readonly custodian: Custodian;
  /** The raw setup secret. */
  readonly secret: string;
  readonly issuedAt: Date;
  /** `null` for a `BOOTSTRAP_SETUP`, which has no expiry (a clock there could strand an environment nobody can sign into). */
  readonly expiresAt: Date | null;
}

const STEPS: Readonly<Record<BundlePurpose, string>> = {
  BOOTSTRAP_SETUP:
    'Present the secret once to complete the credential setup (completeStaffCredentialSetup), which establishes your password and consumes the secret. It starts that one act and nothing else: it is not a password and it never signs in.',
  MFA_REENROLMENT:
    'Present the secret once to begin the re-enrolment of your authenticator (beginMfaReenrolment), which supersedes the unproven factor and issues the continuation to prove a code with. It is not a password, it never signs in, and it does not reset or reveal your password.',
};

/**
 * The text of a bundle: the magic line, the target, the facts, the secret on a line of its own, and the handover. Plain UTF-8 with `\n` line
 * ends so that it reads the same everywhere. It names the custodian (name and work email, the identity the secret is for) and no
 * other person, identity or identifier.
 */
export function renderBundle(content: BundleContent): string {
  const lines = [
    BUNDLE_MAGIC,
    // The second line, so that the head of the file says which database it is for without reading any more of it.
    `target: ${content.target}`,
    '',
    `custodian: ${content.custodian.fullName.trim()} <${content.custodian.workEmail.trim()}>`,
    `purpose: ${content.purpose}`,
    `issued: ${content.issuedAt.toISOString()}`,
    `expires: ${content.expiresAt === null ? 'never (a single-use secret, valid until it is used or replaced)' : content.expiresAt.toISOString()}`,
    '',
    'secret:',
    content.secret,
    '',
    'handover:',
    '- Give this file to the named custodian only, in person or through the controlled provisioning channel your deployment documents.',
    `- ${STEPS[content.purpose]}`,
    '- Delete this file after handover and record the deletion. A copy of it is a copy of the secret.',
    '- If it is lost before the secret is used, run the resume command: a new secret replaces this one.',
    '',
  ];
  return lines.join('\n');
}
