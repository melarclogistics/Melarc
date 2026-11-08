import { BUNDLE_IDS } from '../seed/bundles.js';

/**
 * The bootstrap seed and the resume command (S0.30; MIGRATION_AND_SEEDING.md §3.2 and §3.3a). What the two commands share: the
 * identifiers they work under, the shapes of the facts they exchange with the database functions of migration 0019, and the errors
 * they raise. **No error message and no field here ever holds a secret, a work email or a path**: a refusal names the rule, because
 * what the commands print is read by an operator and kept by a terminal, a CI log or a ticket.
 */

/**
 * The technical identifier of the bootstrap task as a `SYSTEM` principal: stable, and not the id of any record. It is what a
 * transaction's context carries under the `bootstrap` capability; the audit writer maps it to the null actor, so it never becomes an
 * `actor_id`. The reserved system actor that the two identities record is another value (`RESERVED_SYSTEM_ACTOR_ID`).
 */
export const BOOTSTRAP_PRINCIPAL_ID = '5eed0000-0000-4000-8000-0000000000b1';

/** Exactly two bootstrap administrators, one per custodian (`MSC-DEC-440`): never one, never three. */
export const BOOTSTRAP_ADMINISTRATOR_COUNT = 2;

/** The one bundle a bootstrap identity holds. The database fixes it as well: the command cannot name another. */
export const BOOTSTRAP_BUNDLE_ID = BUNDLE_IDS.platformAdmin;

/** What a custody bundle can carry the secret of: the two grants a provisioning command issues. */
export const BUNDLE_PURPOSES = ['BOOTSTRAP_SETUP', 'MFA_REENROLMENT'] as const;
export type BundlePurpose = (typeof BUNDLE_PURPOSES)[number];

/**
 * A custodian as an operator names one: the name the identity will show and the work email it signs in with. Neither is printed
 * by the commands, and neither is secret from the person it belongs to.
 */
export interface Custodian {
  readonly fullName: string;
  readonly workEmail: string;
}

export const INPUT_PROBLEMS = [
  'CUSTODIAN_COUNT',
  'CUSTODIAN_NAME',
  'CUSTODIAN_EMAIL',
  'CUSTODIANS_NOT_DISTINCT',
  'ARGUMENTS',
] as const;
export type InputProblem = (typeof INPUT_PROBLEMS)[number];

const INPUT_MESSAGES: Readonly<Record<InputProblem, string>> = {
  CUSTODIAN_COUNT:
    'the bootstrap names exactly two custodians, one for each administrator: no identity is created for one, or for three',
  CUSTODIAN_NAME: 'each custodian has a name: one or more characters, not only white space',
  CUSTODIAN_EMAIL:
    'each custodian has a work email in the form of an address (a name, an @ and a domain), at most 320 characters',
  CUSTODIANS_NOT_DISTINCT:
    'the two custodians collapse to one work email: the pair is not two identities that one person controls, so nothing was created',
  ARGUMENTS: 'the arguments of the command are not the ones it takes',
};

/** The operator gave the command something it refuses before it opens a database or writes a file. */
export class BootstrapInputError extends Error {
  constructor(readonly problem: InputProblem) {
    super(INPUT_MESSAGES[problem]);
    this.name = 'BootstrapInputError';
  }
}

/**
 * The rules the database functions refuse on, each stated as the rule and with a stable code. `STAFF_TABLE_NOT_EMPTY` is the seed's
 * (the staff table is not empty); the rest are the resume command's, the conditions of MIGRATION_AND_SEEDING.md §3.3a, numbered as
 * that section numbers them where it does.
 */
export const REFUSAL_REASONS = [
  'STAFF_TABLE_NOT_EMPTY',
  'REFERENCE_DATA_MISSING',
  'NO_SUCH_IDENTITY',
  'NOT_BOOTSTRAP_IDENTITY',
  'OFFBOARDED',
  'ACTIVE_FACTOR',
  'LIVE_SESSION',
  'LIVE_GRANT',
  'SETTING_MISSING',
  'STATE_CHANGED',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

const REFUSAL_MESSAGES: Readonly<Record<RefusalReason, string>> = {
  STAFF_TABLE_NOT_EMPTY:
    'the bootstrap refuses to run: the staff table already holds identities. The seed fills an empty table once, and a lost secret or a lapsed enrolment is recovered by the resume command, never by a second seed',
  REFERENCE_DATA_MISSING:
    'the reference data is not seeded: the Platform Admin bundle does not exist yet. Run the reference seed first',
  NO_SUCH_IDENTITY: 'no staff identity has that work email',
  NOT_BOOTSTRAP_IDENTITY:
    'condition 1: that identity is not one of the two bootstrap administrators (its origin is not BOOTSTRAP)',
  OFFBOARDED: 'condition 2: that bootstrap identity is offboarded',
  ACTIVE_FACTOR:
    'conditions 4 and 6: that identity already holds an ACTIVE MFA factor, so its setup is complete and the resume command no longer applies to it',
  LIVE_SESSION: 'condition 5: a session of that identity is live',
  LIVE_GRANT:
    'that identity holds a live setup grant: wait until it has expired (or use it), then run the command again',
  SETTING_MISSING:
    'the setting recovery_link_ttl_minutes is not seeded, and the lifetime of the grant is never invented',
  STATE_CHANGED:
    'the identity changed between the moment it was read and the moment it was changed: nothing was written, run the command again',
};

/** The database refused the seed or the resume on a rule above. Names the rule and the table or count, never a value. */
export class BootstrapRefusedError extends Error {
  constructor(
    readonly reason: RefusalReason,
    readonly rows?: number,
  ) {
    super(REFUSAL_MESSAGES[reason]);
    this.name = 'BootstrapRefusedError';
  }
}

export const isRefusalReason = (value: unknown): value is RefusalReason =>
  typeof value === 'string' && (REFUSAL_REASONS as readonly string[]).includes(value);

export const CUSTODY_PROBLEMS = [
  'DIRECTORY_MISSING',
  'DIRECTORY_NOT_ABSOLUTE',
  'DIRECTORY_INSIDE_CHECKOUT',
  'DIRECTORY_NOT_PRIVATE',
  'FILE_EXISTS',
  'WRITE_FAILED',
  'ACCESS_REFUSED',
  'ACCESS_UNVERIFIED',
] as const;
export type CustodyProblem = (typeof CUSTODY_PROBLEMS)[number];

const CUSTODY_MESSAGES: Readonly<Record<CustodyProblem, string>> = {
  DIRECTORY_MISSING:
    'BOOTSTRAP_CUSTODY_DIRECTORY is not set: the custody bundles are written to a folder the operator names, and never to a default',
  DIRECTORY_NOT_ABSOLUTE:
    'BOOTSTRAP_CUSTODY_DIRECTORY is an absolute path: a relative one is read from wherever the command was started, which can be the repository',
  DIRECTORY_INSIDE_CHECKOUT:
    'BOOTSTRAP_CUSTODY_DIRECTORY is inside a checkout: a custody bundle holds a secret in clear and must be outside the repository',
  DIRECTORY_NOT_PRIVATE:
    'BOOTSTRAP_CUSTODY_DIRECTORY is not private to its user: its folder must be owned by the user running the command (on POSIX) and give no access to anyone but that user, the system and the administrators',
  FILE_EXISTS: 'a custody bundle with that name already exists: a bundle is created exclusively',
  WRITE_FAILED: 'a custody bundle could not be written',
  ACCESS_REFUSED:
    'the access to a custody bundle is broad or inherited, which the command refuses: no secret was written to it',
  ACCESS_UNVERIFIED:
    'the access to a custody bundle could not be inspected, which the command refuses: no secret was written to it',
};

/**
 * A custody bundle could not be written or made private. Names the rule, never the path or the secret.
 *
 * `residual` names the files of this write that **could not be removed** and so may still hold the secret, whole or in part (the audit
 * of 21 October 2026, A05): by their random file names alone, which carry nothing of a custodian and are safe to print. It is empty
 * when the file was removed (or was never made), which is the usual case. The `problem` stays the rule that was broken first; a
 * failed removal is added to it and never replaces it.
 */
export class BootstrapCustodyError extends Error {
  readonly residual: readonly string[];

  constructor(
    readonly problem: CustodyProblem,
    residual: readonly string[] = [],
  ) {
    super(CUSTODY_MESSAGES[problem]);
    this.name = 'BootstrapCustodyError';
    this.residual = Object.freeze([...residual]);
  }
}
