import { createHash } from 'node:crypto';

import { canonicalWorkEmail } from '../../platform/auth/credentials/work-email.js';
import type { Clock } from '../../platform/auth/ports/clock.port.js';
import type { TokenService } from '../../platform/auth/ports/token-service.port.js';
import { CommitOutcomeUnknownError } from '../../platform/database/database-failures.js';
import { parsePostgresUrl } from '../../platform/database/postgres-url.js';
import { resolveTarget } from '../seed/seed-command.js';
import type { BootstrapDatabase } from './bootstrap-database.js';
import { planResume, planSeed, type PlanDependencies } from './bootstrap-plan.js';
import {
  BootstrapCustodyError,
  BootstrapInputError,
  BootstrapRefusedError,
  type Custodian,
} from './bootstrap-vocabulary.js';
import type { BundleContent } from './custody-bundle.js';
import type { CustodyStore, WrittenBundle } from './custody-store.js';

/**
 * The two commands of the bootstrap (S0.30; MIGRATION_AND_SEEDING.md §3.2 and §3.3a): `bootstrap:seed`, which makes the two
 * administrators of an empty environment and the custody bundle of each, and `bootstrap:resume`, which gives one stranded
 * administrator a fresh secret. **No API operation, route, module or screen can invoke either**: they are processes an operator
 * starts as the provisioning login, which the API never connects as (`DATABASE_SEED_URL` is forbidden in its environment), and no
 * code of the application imports this folder (`bootstrap-isolation.test.ts`).
 *
 * **One transaction, and the bundles before its commit.** Everything of a run happens inside one transaction under the `bootstrap`
 * capability. The seed asks the database for the status first, which locks the staff table against every other seed until the
 * transaction ends, so what follows is judged under that lock: a table that holds an identity is refused before anything is
 * written; an empty one is swept of the bundles an earlier run left (no pair exists to redeem them) and then receives the pair; and
 * each bundle is written, after the function that made the pair has succeeded and **before the transaction commits**, so that an
 * interrupted run leaves no pair, or a pair with its bundles. A bundle that cannot be written throws, which rolls the pair back; a
 * commit that is refused removes the bundles; a commit whose outcome is **unknown** removes nothing, because if the change did
 * commit the bundles are the only copies of its secrets. What the operator does next is **not** "run it again" for the resume (a
 * second resume replaces the secret again, so the bundle left behind would then hold one that no longer works), and **not** "no audit
 * event, so it did not commit" for either: an absent row in one read is not a rollback (the transaction may still be finishing, and
 * the read may be of a replica or a role that cannot see the rows), and deleting a bundle on that inference destroys the only copy of
 * a committed secret. The run's identifier is printed, and the reconciliation (MIGRATION_AND_SEEDING.md §3.3b) is made on the primary
 * database, with access that sees the audit trail, in a fresh transaction that first waits for the original one to end
 * (`unknownCommitGuidance`).
 *
 * **A file that a failed write could not remove is reported.** A write that fails after its file exists removes the file; one whose
 * removal fails leaves a file that may hold the secret, whole or in part, for a pair that will never be made. The store names it, by
 * its random name, in the error that carries the primary failure, and every attempt is tracked, the failed ones as well as the
 * written ones, so that the operator is told which files to delete (the audit of 21 October 2026, A05).
 *
 * **Nothing it prints names a secret, a custodian, an address or a path**: a bundle is named by its random file name, and the
 * custodian is the order the operator gave them in.
 */

export interface BootstrapTarget {
  readonly database: BootstrapDatabase;
  close(): Promise<void>;
}

export interface BootstrapDependencies {
  /** The local provisioning login's URL. Called only when no `DATABASE_SEED_URL` was given. */
  readonly localUrl: () => string;
  readonly open: (url: string) => BootstrapTarget;
  readonly store: CustodyStore;
  readonly tokens: Pick<TokenService, 'issue'>;
  readonly clock: Pick<Clock, 'now'>;
  /** Judges the folder the operator named (given, absolute, outside the checkout) and returns it. Throws a custody refusal. */
  readonly custodyDirectory: (value: string | undefined) => string;
  /** One identifier for a whole run. */
  readonly correlationId: () => string;
}

/**
 * The database a run acts on, as the 32 hexadecimal digits every bundle it writes records (`BUNDLE_TARGET`): a digest of the host, the
 * port and the name of the database, and of nothing that is a credential (not the user, not the password). The sweep of orphans removes
 * a bundle only when it names this target, so a folder that also holds the bundles of another environment's pair, which did commit and
 * which are the only copies of secrets still to be handed over, loses none of them. A URL that cannot be read is refused when the
 * connection is opened, before any bundle is written: it has no target, and one text stands for all of them.
 */
export function targetOf(url: string): string {
  const parsed = parsePostgresUrl(url);
  const identity =
    parsed === undefined
      ? 'unreadable'
      : `${parsed.host.toLowerCase()}:${String(parsed.port)}/${parsed.database}`;
  return createHash('sha256')
    .update(`melarc.bootstrap.target.v1\u0000${identity}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/** What an abandoned run left: the bundles that were written, and the names of the files that failed writes could not remove. */
interface Abandoned {
  readonly written: WrittenBundle[];
  /** Random file names only (never a path): files that may hold the secret, whole or in part, and that nothing has removed. */
  readonly residual: string[];
}

/**
 * The bundle writes of one run, each remembered the moment it starts. A run that is judged failed while a write is still in flight (the
 * database's budget ran out, the connection was lost) would otherwise leave that file behind with its secret in it, for a pair that
 * was never committed: the write cannot be told to stop, so it is waited for, and what it made is what the failure removes. Once a run
 * is abandoned, no further file is begun. **A failed write is tracked too**: the file of a write that fails and cannot be removed is
 * named in its error, and is collected here with the bundles that were written, so that nothing the run made goes unreported.
 */
class BundleWrites {
  readonly #attempts: Promise<WrittenBundle>[] = [];
  #abandoned = false;

  constructor(
    private readonly store: CustodyStore,
    private readonly directory: string,
    private readonly target: string,
  ) {}

  write(content: Omit<BundleContent, 'target'>): Promise<WrittenBundle> {
    if (this.#abandoned) return Promise.reject(new BootstrapCustodyError('WRITE_FAILED'));
    const attempt = this.store.write(this.directory, { ...content, target: this.target });
    this.#attempts.push(attempt);
    return attempt;
  }

  /**
   * Stops further writes and resolves every bundle that was written, including one that finished after the run was judged failed, and
   * the files that failed writes could not remove (each once, whichever attempt named it).
   */
  async abandon(): Promise<Abandoned> {
    this.#abandoned = true;
    const settled = await Promise.allSettled(this.#attempts);
    const residual = new Set<string>();
    for (const each of settled) {
      if (each.status === 'rejected' && each.reason instanceof BootstrapCustodyError) {
        for (const name of each.reason.residual) residual.add(name);
      }
    }
    return {
      written: settled.flatMap((each) => (each.status === 'fulfilled' ? [each.value] : [])),
      residual: [...residual],
    };
  }
}

const SEED_USAGE =
  'usage: bootstrap:seed --custodian "Full Name <work@email>" --custodian "Full Name <work@email>"';
const RESUME_USAGE = 'usage: bootstrap:resume --custodian <work@email>';

/** `Full Name <address>`: the name before the angle brackets (not empty), the address inside them. */
const CUSTODIAN = /^\s*(\S.*?)\s*<\s*([^<>\s]+)\s*>\s*$/;

/**
 * The values of `flag`, in order. One leading `--` is dropped: `pnpm run bootstrap:seed -- --custodian ...` hands the script that
 * separator, which names no flag of the command. No other `--` is accepted, in the middle or at the end.
 */
function flagValues(given: readonly string[], flag: string): string[] {
  const argv = given[0] === '--' ? given.slice(1) : given;
  const values: string[] = [];
  for (let at = 0; at < argv.length; at += 2) {
    const value = argv[at + 1];
    if (argv[at] !== flag || value === undefined) throw new BootstrapInputError('ARGUMENTS');
    values.push(value);
  }
  return values;
}

function parseSeedArguments(argv: readonly string[]): Custodian[] {
  const values = flagValues(argv, '--custodian');
  // One or three is not a pair: the count is its own refusal (the plan states it), before any value is read.
  if (values.length !== 2) throw new BootstrapInputError('CUSTODIAN_COUNT');
  return values.map((value) => {
    const match = CUSTODIAN.exec(value);
    if (match === null) throw new BootstrapInputError('ARGUMENTS');
    return { fullName: match[1] ?? '', workEmail: match[2] ?? '' };
  });
}

function parseResumeArguments(argv: readonly string[]): string {
  const values = flagValues(argv, '--custodian');
  const [value] = values;
  if (values.length !== 1 || value === undefined) throw new BootstrapInputError('ARGUMENTS');
  const canonical = canonicalWorkEmail(value.trim());
  if (
    !canonical.ok ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(canonical.email) ||
    canonical.email.length > 320
  ) {
    throw new BootstrapInputError('CUSTODIAN_EMAIL');
  }
  return canonical.email;
}

function planDependencies(dependencies: BootstrapDependencies): PlanDependencies {
  return {
    tokens: dependencies.tokens,
    clock: dependencies.clock,
    correlationId: dependencies.correlationId(),
  };
}

/**
 * What the operator is told after a commit whose outcome is not known, with the bundles left where they are (the review of 21 October
 * 2026, C01). **A missing audit event is unresolved and never a rollback**: the transaction may still be finishing, and a read may be
 * of a replica, or by a role that cannot see the rows. Only a reconciliation that has waited for the original transaction at the lock
 * it holds, on the primary, with access that sees the audit trail, can say that nothing committed; and a change that did commit may
 * since have been replaced or used, so its issuance event alone does not make its bundle the one to hand over.
 *
 * - **The seed** is its own reconciliation: a second run takes the same table lock first, so it waits for the original transaction (and
 *   gives up, changing nothing, if that takes too long), then refuses a table that holds the pair and sweeps this database's bundles
 *   only from an empty one, which is a definite rollback. Whether a bundle is still the current one is read as the document says.
 * - **The resume** is not: a second run on the lost-bundle path supersedes the secret again, so the bundle left behind would hold one
 *   that no longer works, and on the re-enrolment path it is refused while the first grant lives. The operator reconciles first.
 */
function unknownCommitGuidance(what: string, count: number, correlationId: string): string {
  const plural = count === 1 ? '' : 's';
  const were = count === 1 ? 'was' : 'were';
  const it = count === 1 ? 'it' : 'them';
  const absent = `Not finding this run's audit events (correlation id ${correlationId}) does not show that it did not commit: the transaction may still be finishing, or the read may not be of the primary database or may not see the rows.`;
  if (what === 'bootstrap seed') {
    return `${what}: could not tell whether the pair was committed, so the bundle${plural} ${were} left in place: do not delete ${it} until that is established, because if the pair committed ${count === 1 ? 'it is' : 'they are'} the only cop${count === 1 ? 'y' : 'ies'} of its secrets. ${absent} The seed is its own reconciliation: run it again and it waits at the same lock for the original transaction to end (and gives up, changing nothing, if that takes too long), refuses a staff table that holds the pair, and sweeps this database's bundles only from an empty one. When it refuses, hand a bundle over only while its grant is still the current one: MIGRATION_AND_SEEDING.md §3.3b says how to read that`;
  }
  return `${what}: could not tell whether the change was committed, so the bundle${plural} ${were} left in place: do not delete ${it}, and do not run the resume again, until that is established. If the change committed the bundle holds the only copy of the new secret, and a second run would replace that secret. ${absent} Reconcile as MIGRATION_AND_SEEDING.md §3.3b describes: on the primary database, at read committed, with a role that bypasses row-level security (owning the tables is not enough), in a fresh transaction that first waits for the original one to end. It tells four outcomes apart: committed and current (hand the bundle over), committed and since replaced or used (do not hand it over), not committed (only then delete the bundle and run the resume again) and unresolved (keep everything and do nothing)`;
}

/**
 * What a failed run does with the bundles it wrote, and says about them, and about the files that failed writes could not remove.
 * Resolves nothing: it reports through `write`. A commit whose outcome is **unknown** removes no bundle (they are the only copies of
 * the secrets if the change committed); every other failure removes them. A leftover of a failed write is reported whatever the
 * failure was, by its random file name alone.
 */
async function settleBundles(
  error: unknown,
  abandoned: Abandoned,
  store: CustodyStore,
  write: (line: string) => void,
  what: string,
  correlationId: string,
): Promise<void> {
  const { written, residual } = abandoned;
  if (residual.length > 0) {
    write(
      `${what}: ${String(residual.length)} file${residual.length === 1 ? '' : 's'} of a bundle that could not be written could not be removed and may hold a secret, whole or in part, for nobody: delete ${residual.join(', ')} from the custody folder`,
    );
  }
  if (written.length === 0) return;
  if (error instanceof CommitOutcomeUnknownError) {
    write(unknownCommitGuidance(what, written.length, correlationId));
    return;
  }
  const stuck = await store.discard(written);
  if (stuck.length > 0) {
    write(
      `${what}: ${String(stuck.length)} bundle${stuck.length === 1 ? '' : 's'} could not be removed and hold a secret for nobody: delete ${stuck.join(', ')} from the custody folder`,
    );
  }
}

/**
 * `bootstrap:seed`. Rejects, with nothing kept, on a usage mistake, a custody folder that is refused, a database that is not empty
 * or refuses, or a file that cannot be written; the connection is closed on every path that opened one.
 */
export async function runBootstrapSeed(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  write: (line: string) => void,
  dependencies: BootstrapDependencies,
): Promise<void> {
  // Everything that can be judged without a database or a file is judged first, so that a refused input costs nothing.
  const custodians = parseSeedArguments(argv);
  const directory = dependencies.custodyDirectory(env.BOOTSTRAP_CUSTODY_DIRECTORY);
  const { url } = resolveTarget(env, dependencies);
  const common = planDependencies(dependencies);
  const plan = planSeed(custodians, common);

  await dependencies.store.prepare(directory);
  const target = dependencies.open(url);
  const writes = new BundleWrites(dependencies.store, directory, targetOf(url));
  const written: WrittenBundle[] = [];
  try {
    const outcome = await target.database.run(common.correlationId, async (calls) => {
      const status = await calls.status();
      if (status.staffIdentities !== 0) {
        throw new BootstrapRefusedError('STAFF_TABLE_NOT_EMPTY', status.staffIdentities);
      }
      // The table is empty and locked: a bundle of this database in the folder belongs to a pair that was never committed.
      const swept = await dependencies.store.sweepOrphans(directory, targetOf(url));
      const seeded = await calls.seed(plan.document);
      for (const administrator of plan.administrators) {
        written.push(
          await writes.write({
            purpose: 'BOOTSTRAP_SETUP',
            custodian: { fullName: administrator.fullName, workEmail: administrator.workEmail },
            secret: administrator.secret,
            issuedAt: dependencies.clock.now(),
            expiresAt: null,
          }),
        );
      }
      return { swept, seeded };
    });
    if (outcome.swept.removed.length > 0) {
      write(
        `bootstrap seed: removed ${String(outcome.swept.removed.length)} bundle${outcome.swept.removed.length === 1 ? '' : 's'} of an earlier run that did not commit`,
      );
    }
    if (outcome.swept.kept > 0) {
      write(
        `bootstrap seed: left ${String(outcome.swept.kept)} other bundle${outcome.swept.kept === 1 ? '' : 's'} in the folder alone: not provably an earlier run's of this database, and possibly a secret still to be handed over; delete each yourself once it has been`,
      );
    }
    write(`bootstrap seed: staff_identity: ${String(outcome.seeded.staffIdentity)} rows`);
    write(`bootstrap seed: setup_grant: ${String(outcome.seeded.setupGrant)} rows`);
    write(`bootstrap seed: audit_event: ${String(outcome.seeded.auditEvent)} rows`);
    written.forEach((bundle, at) => {
      write(
        `bootstrap seed: custodian ${String(at + 1)} of ${String(written.length)}: ${bundle.name}`,
      );
    });
  } catch (error) {
    await settleBundles(
      error,
      await writes.abandon(),
      dependencies.store,
      write,
      'bootstrap seed',
      common.correlationId,
    );
    throw error;
  } finally {
    // What the run found is what is reported: a pool that would not close must not hide it.
    await target.close().catch(() => undefined);
  }
}

/**
 * `bootstrap:resume`. Rejects, with nothing kept, on a usage mistake, a custody folder that is refused, an identity the database
 * will not resume (the rule is named), or a file that cannot be written.
 */
export async function runBootstrapResume(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  write: (line: string) => void,
  dependencies: BootstrapDependencies,
): Promise<void> {
  const canonicalEmail = parseResumeArguments(argv);
  const directory = dependencies.custodyDirectory(env.BOOTSTRAP_CUSTODY_DIRECTORY);
  const { url } = resolveTarget(env, dependencies);
  const common = planDependencies(dependencies);

  await dependencies.store.prepare(directory);
  const target = dependencies.open(url);
  const writes = new BundleWrites(dependencies.store, directory, targetOf(url));
  const written: WrittenBundle[] = [];
  try {
    const outcome = await target.database.run(common.correlationId, async (calls) => {
      // The read locks the identity until the transaction ends: what the plan reads is what the change then judges again.
      const facts = await calls.identityState(canonicalEmail);
      const plan = planResume(facts.state, common);
      const resumed = await calls.resume(plan.document);
      written.push(
        await writes.write({
          purpose: resumed.purpose,
          custodian: facts.custodian,
          secret: plan.secret,
          issuedAt: resumed.issuedAt,
          expiresAt: resumed.expiresAt,
        }),
      );
      return resumed;
    });
    write(`bootstrap resume: path ${outcome.path}`);
    if (outcome.revokedFactorIds.length > 0) {
      write(
        `bootstrap resume: revoked ${String(outcome.revokedFactorIds.length)} stale factor${outcome.revokedFactorIds.length === 1 ? '' : 's'}`,
      );
    }
    if (outcome.expiredGrantIds.length > 0) {
      write(
        `bootstrap resume: ended ${String(outcome.expiredGrantIds.length)} lapsed grant${outcome.expiredGrantIds.length === 1 ? '' : 's'}`,
      );
    }
    if (outcome.supersededGrantId !== null)
      write('bootstrap resume: superseded the unconsumed secret');
    for (const bundle of written) write(`bootstrap resume: bundle: ${bundle.name}`);
  } catch (error) {
    await settleBundles(
      error,
      await writes.abandon(),
      dependencies.store,
      write,
      'bootstrap resume',
      common.correlationId,
    );
    throw error;
  } finally {
    await target.close().catch(() => undefined);
  }
}

export { SEED_USAGE, RESUME_USAGE };
