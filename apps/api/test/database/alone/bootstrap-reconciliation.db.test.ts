// Runs alone: it changes the roles every database of the server shares.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Sha256TokenService } from '../../../src/platform/auth/crypto/sha256.token-service.adapter.js';
import { serverErrorIn } from '../../../src/platform/database/database-failures.js';
import { PROVISIONING_ROLE } from '../../../src/platform/database/technical-roles.js';
import {
  planResume,
  planSeed,
  type IdentityState,
} from '../../../src/tools/bootstrap/bootstrap-plan.js';
import { setGrantState } from '../support/credentials.js';
import { insertStaff, staffRow } from '../support/identities.js';
import { seedReferenceData } from '../support/seeded.js';
import {
  clientFor,
  createTestDatabase,
  withClient,
  type TestDatabase,
} from '../support/test-database.js';

/**
 * Reconciling a bootstrap command whose commit outcome is not known (the review of 21 October 2026, C01, hardened by the owner's
 * instruction of the same day; MIGRATION_AND_SEEDING.md §3.3b), against a real PostgreSQL. **The statements are the document's own**: they
 * are read out of the fenced block of §3.3b and run verbatim, so the procedure that an operator is told to follow is the one that is
 * proved here, and cannot drift from it unseen.
 *
 * The conditions of the document, each shown to matter: the transaction states `READ COMMITTED` itself (a session whose default is
 * `REPEATABLE READ` would read, after the original commits, as if it had not); the role is verified to see every row (owning the
 * tables is not enough under `FORCE ROW LEVEL SECURITY`, and `SET LOCAL row_security = off` turns a filtered read into an error); the
 * lock of the resume is taken on every bootstrap identity and the intended one must be among them; a wait for a lock that ends is
 * unresolved; and after an error the transaction is rolled back explicitly. Anything that fails or cannot be checked is **unresolved**,
 * and never *not committed*. The original runs as the provisioning login, through the same functions as the commands; the
 * reconciliation runs as the administrator, who sees the tables.
 */

const tokens = new Sha256TokenService();
const clock = { now: () => new Date() };

const STATUS = 'select melarc.bootstrap_status() as status';
const SEED = 'select melarc.seed_bootstrap_administrators($1::jsonb) as report';
const STATE = 'select melarc.bootstrap_identity_state($1) as state';
const RESUME = 'select melarc.resume_bootstrap_identity($1::jsonb) as report';

let database: TestDatabase;
let admin: pg.Client;
/** A role that the policies filter: it may read what the procedure reads, and it bypasses nothing. */
const PROBE = `melarc_recon_probe_${randomUUID().slice(0, 8).replaceAll('-', '')}`;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(`create role ${PROBE} nologin`);
  await admin.query(`grant select on audit_event, setup_grant to ${PROBE}`);
  await admin.query(`grant select, update on staff_identity to ${PROBE}`);
  // Just enough to evaluate the policies, so that they filter this role quietly (as they do any role that holds a privilege and no
  // matching policy) and do not stop it with a permission error first: the trap is a short answer, not an error.
  await admin.query(`grant usage on schema melarc to ${PROBE}`);
  // (the policies call several helpers of the schema; this role is a test's own, never logs in, and is dropped with its grants)
  await admin.query(`grant execute on all functions in schema melarc to ${PROBE}`);
});

afterAll(async () => {
  await admin.query(`drop owned by ${PROBE}`);
  await admin.query(`drop role ${PROBE}`);
  await admin.end();
  await database.drop();
});

beforeEach(async () => {
  await admin.query(
    'truncate trusted_browser, mfa_challenge, mfa_factor, setup_grant, session, staff_identity',
  );
});

// ---- the procedure, as the document states it -----------------------------------------------------------------------------------

const DOCUMENT = readFileSync(
  fileURLToPath(new URL('../../../../../architecture/MIGRATION_AND_SEEDING.md', import.meta.url)),
  'utf8',
);

/** The statements of the fenced block under the heading of §3.3b, without its comments, in order. */
function procedure(): string[] {
  const block = /### 3\.3b[\s\S]*?```sql\n([\s\S]*?)```/.exec(DOCUMENT)?.[1];
  if (block === undefined) throw new Error('MIGRATION_AND_SEEDING.md §3.3b has no sql block');
  return block
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

const STATEMENTS = procedure();
const statementStarting = (prefix: string): string => {
  const found = STATEMENTS.find((statement) => statement.startsWith(prefix));
  if (found === undefined) throw new Error(`§3.3b has no statement that starts with "${prefix}"`);
  return found;
};
const BEGIN = statementStarting('BEGIN ISOLATION LEVEL READ COMMITTED');
const WAIT = statementStarting('SET LOCAL lock_timeout');
const ROW_SECURITY = statementStarting('SET LOCAL row_security');
const CHECK = statementStarting("SELECT pg_catalog.current_setting('transaction_isolation')");
const LOCK_SEED = statementStarting('LOCK TABLE');
const LOCK_RESUME = statementStarting(
  'SELECT id, origin, work_email_canonical FROM staff_identity',
);
const READ = statementStarting('SELECT s.work_email_canonical');
const COMMIT = statementStarting('COMMIT');

const filled = (statement: string, values: Readonly<Record<string, string>>): string =>
  Object.entries(values).reduce(
    (text, [placeholder, value]) => text.replaceAll(placeholder, value),
    statement,
  );

interface Row {
  readonly work_email_canonical: string | null;
  readonly grant_id: string | null;
  readonly purpose: string | null;
  readonly state: string | null;
  readonly lapsed: boolean | null;
}

type Outcome = 'NOT_COMMITTED' | 'COMMITTED_CURRENT' | 'COMMITTED_CHANGED' | 'UNRESOLVED';

/** The table of §3.3b, row for row. It is only ever applied to a read that was made **after** every condition held. */
function outcomeOf(rows: readonly Row[]): Outcome {
  if (rows.length === 0) return 'NOT_COMMITTED';
  if (rows.some((row) => row.grant_id === null)) return 'UNRESOLVED';
  if (rows.every((row) => row.state === 'PENDING' && row.lapsed === false)) {
    return 'COMMITTED_CURRENT';
  }
  return 'COMMITTED_CHANGED';
}

/** Why an outcome is unresolved, for the test to name; the document only says that it is. */
type Why =
  | 'ISOLATION'
  | 'NOT_PRIMARY'
  | 'WRONG_DATABASE'
  | 'NOT_VISIBLE'
  | 'IDENTITY_NOT_LOCKED'
  | 'OTHER_IDENTITY'
  | 'LOCK_TIMEOUT'
  | `SQL_ERROR_${string}`;

interface Reconciled {
  readonly outcome: Outcome;
  readonly rows: readonly Row[];
  readonly why?: Why;
  readonly isolation?: string;
}

interface Options {
  /** The bounded wait for the lock. */
  readonly wait?: string;
  /** The role to run as (`SET LOCAL ROLE`), to be a role the policies filter. */
  readonly role?: string;
  /** The default isolation level of the connection: a session whose default is not read committed. */
  readonly defaultIsolation?: string;
  /** Leave the check statement out, to show that `row_security = off` alone fails closed. */
  readonly skipCheck?: boolean;
  /** The database the operator believes is the environment's. */
  readonly expectedDatabase?: string;
}

const unresolved = (why: Why, isolation?: string): Reconciled => ({
  outcome: 'UNRESOLVED',
  rows: [],
  why,
  ...(isolation === undefined ? {} : { isolation }),
});

/**
 * The reconciliation, as §3.3b says: every condition is checked in one short transaction, and a condition that fails or cannot be
 * checked is *unresolved*. After any error the transaction is rolled back explicitly. `command` picks the lock of the seed or of the
 * resume.
 */
async function reconcile(
  command: 'seed' | 'resume',
  label: string,
  canonicalEmail: string,
  options: Options = {},
): Promise<Reconciled> {
  const client = clientFor(database.urlFor('postgres'));
  await client.connect();
  let committed = false;
  try {
    if (options.defaultIsolation !== undefined) {
      await client.query(`set default_transaction_isolation = '${options.defaultIsolation}'`);
    }
    await client.query(BEGIN);
    try {
      if (options.role !== undefined) await client.query(`set local role ${options.role}`);
      await client.query(filled(WAIT, { '<wait>': options.wait ?? '300ms' }));
      await client.query(ROW_SECURITY);
      let isolation: string | undefined;
      if (options.skipCheck !== true) {
        const check = (
          await client.query<{
            isolation: string;
            in_recovery: boolean;
            database: string;
            sees_every_row: boolean | null;
          }>(CHECK)
        ).rows[0];
        isolation = check?.isolation;
        if (check?.isolation !== 'read committed') return unresolved('ISOLATION', isolation);
        if (check.in_recovery) return unresolved('NOT_PRIMARY', isolation);
        if (check.database !== (options.expectedDatabase ?? database.name)) {
          return unresolved('WRONG_DATABASE', isolation);
        }
        if (check.sees_every_row !== true) return unresolved('NOT_VISIBLE', isolation);
      }
      if (command === 'seed') {
        await client.query(LOCK_SEED);
      } else {
        const locked = (
          await client.query<{ id: string; origin: string; work_email_canonical: string }>(
            LOCK_RESUME,
          )
        ).rows;
        const intended = locked.find((row) => row.work_email_canonical === canonicalEmail);
        if (intended?.origin !== 'BOOTSTRAP') return unresolved('IDENTITY_NOT_LOCKED', isolation);
      }
      const { rows } = await client.query<Row>(filled(READ, { '<correlation id>': label }));
      if (command === 'resume' && rows.some((row) => row.work_email_canonical !== canonicalEmail)) {
        return unresolved('OTHER_IDENTITY', isolation);
      }
      await client.query(COMMIT);
      committed = true;
      return { outcome: outcomeOf(rows), rows, ...(isolation === undefined ? {} : { isolation }) };
    } catch (error) {
      const code = serverErrorIn(error)?.code ?? 'ERROR';
      return unresolved(code === '55P03' ? 'LOCK_TIMEOUT' : `SQL_ERROR_${code}`);
    }
  } finally {
    // After any exit that did not commit, the transaction is rolled back explicitly, before the connection is used for anything else.
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

/** What a read with **no** lock and no conditions sees, which is all that "no audit event" ever meant. */
async function plainRead(label: string): Promise<readonly Row[]> {
  return (await admin.query<Row>(filled(READ, { '<correlation id>': label }))).rows;
}

// ---- the originals ---------------------------------------------------------------------------------------------------------------

const label = (): string => `bootstrap-recon-${randomUUID()}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function seedPlan(correlationId = label()) {
  const plan = planSeed(
    [
      { fullName: 'Kofi Boateng', workEmail: `kofi-${correlationId}@melarc.example` },
      { fullName: 'Efua Addo', workEmail: `efua-${correlationId}@melarc.example` },
    ],
    { tokens, clock, correlationId },
  );
  const [first, second] = plan.administrators;
  if (first === undefined || second === undefined) throw new Error('a seed makes two');
  return { plan, first, second, label: correlationId };
}

const asProvisioning = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
  withClient(database.urlFor(PROVISIONING_ROLE), work);

/** A command's transaction that has done its work and not yet committed: what an unknown outcome leaves behind while it is in flight. */
async function openOriginal(statements: readonly [string, unknown[]?][]): Promise<pg.Client> {
  const client = clientFor(database.urlFor(PROVISIONING_ROLE));
  await client.connect();
  await client.query('BEGIN');
  for (const [text, values] of statements) await client.query(text, values);
  return client;
}

const stateOf = async (email: string): Promise<IdentityState> => {
  const result = await asProvisioning((client) =>
    client.query<{
      state: {
        id: string;
        credential_established: boolean;
        pending_factor_ids: string[];
        live_bootstrap_grant_id: string | null;
        lapsed_grants: { id: string; purpose: string }[];
      };
    }>(STATE, [email]),
  );
  const state = result.rows[0]?.state;
  if (state === undefined) throw new Error('no state');
  return {
    id: state.id,
    credentialEstablished: state.credential_established,
    pendingFactorIds: state.pending_factor_ids,
    liveBootstrapGrantId: state.live_bootstrap_grant_id,
    lapsedGrants: state.lapsed_grants,
  };
};

const resumePlan = async (email: string, correlationId = label()) =>
  planResume(await stateOf(email), { tokens, clock, correlationId });

const commitResume = (document: string) =>
  asProvisioning((client) => client.query(RESUME, [document]));

/** The pair, seeded and committed. */
async function committedPair() {
  const made = seedPlan();
  await asProvisioning(async (client) => {
    await client.query('BEGIN');
    await client.query(STATUS);
    await client.query(SEED, [made.plan.document]);
    await client.query('COMMIT');
  });
  return made;
}

describe('the procedure of §3.3b is the one that is run here', () => {
  it('finds every statement it needs in the document, in the order the document gives them', () => {
    expect(STATEMENTS.indexOf(BEGIN)).toBe(0);
    expect(STATEMENTS.indexOf(WAIT)).toBe(1);
    expect(STATEMENTS.indexOf(ROW_SECURITY)).toBe(2);
    expect(STATEMENTS.indexOf(CHECK)).toBe(3);
    expect(STATEMENTS.indexOf(LOCK_SEED)).toBeLessThan(STATEMENTS.indexOf(LOCK_RESUME));
    expect(STATEMENTS.indexOf(LOCK_RESUME)).toBeLessThan(STATEMENTS.indexOf(READ));
    expect(STATEMENTS.at(-1)).toBe(COMMIT);
    // it reads and locks, and writes nothing
    for (const statement of STATEMENTS) {
      // (`FOR NO KEY UPDATE` is the lock, not a write)
      expect(statement.replaceAll('FOR NO KEY UPDATE', '')).not.toMatch(
        /\b(insert|update|delete|truncate|drop|alter)\b/i,
      );
    }
  });

  // Break caught: row-level security switched off as a way round the policies. It is the fail-closed guard: `off` gives an error to a
  // role that the policies would filter, and it gives a role that bypasses them nothing it did not have.
  it('states its isolation level itself and turns row_security off only as a guard', () => {
    expect(BEGIN).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(ROW_SECURITY).toBe('SET LOCAL row_security = off');
    expect(DOCUMENT).toMatch(/fail-closed/);
    expect(DOCUMENT).toMatch(/Owning the tables is not enough/);
  });
});

describe('the isolation level of the session does not change the procedure', () => {
  // Break caught: the isolation level left to the session. A session whose default is REPEATABLE READ takes its snapshot before the
  // wait for the lock, and after the original has committed it reads as if the original had not.
  it('runs at READ COMMITTED on a connection whose default is REPEATABLE READ', async () => {
    const { plan, label: id } = seedPlan();
    const original = await openOriginal([[STATUS], [SEED, [plan.document]]]);
    try {
      const waiting = reconcile('seed', id, '', {
        wait: '10s',
        defaultIsolation: 'repeatable read',
      });
      await sleep(500);
      await original.query('COMMIT');

      const reconciled = await waiting;

      expect(reconciled.isolation).toBe('read committed');
      expect(reconciled.outcome).toBe('COMMITTED_CURRENT');
    } finally {
      await original.end();
    }
  });

  it('is what a plain BEGIN would not give: the same connection, with no level stated, is at REPEATABLE READ and reads the old snapshot', async () => {
    const { plan, label: id } = seedPlan();
    const original = await openOriginal([[STATUS], [SEED, [plan.document]]]);
    const client = clientFor(database.urlFor('postgres'));
    await client.connect();
    try {
      await client.query("set default_transaction_isolation = 'repeatable read'");
      await client.query('BEGIN');
      // the snapshot is taken here, before the original commits
      await client.query('select count(*) from audit_event');
      await original.query('COMMIT');
      const level = (
        await client.query<{ level: string }>(
          "select current_setting('transaction_isolation') as level",
        )
      ).rows[0]?.level;
      const stale = (await client.query<Row>(filled(READ, { '<correlation id>': id }))).rows;
      await client.query('ROLLBACK');

      expect(level).toBe('repeatable read');
      // the committed pair is there, and this read does not see it: the false "not committed" the procedure exists to prevent
      expect(outcomeOf(stale)).toBe('NOT_COMMITTED');
      expect(outcomeOf(await plainRead(id))).toBe('COMMITTED_CURRENT');
    } finally {
      await client.end();
      await original.end();
    }
  });
});

describe('reconciling a seed whose commit outcome is not known', () => {
  // Break caught: "no audit event, so it did not commit". While the original transaction is open a plain read finds nothing, and so
  // would the reconciliation without the lock; with the lock it cannot get it, and says unresolved.
  it('does not take a missing event for a rollback while the original transaction is still open', async () => {
    const { plan, first, label: id } = seedPlan();
    const original = await openOriginal([[STATUS], [SEED, [plan.document]]]);
    try {
      // a plain read: no row, which is all that "not finding the event" ever meant
      expect(await plainRead(id)).toEqual([]);
      expect(outcomeOf(await plainRead(id))).toBe('NOT_COMMITTED');
      // the reconciliation cannot get the lock the original holds, so it does not conclude anything
      const held = await reconcile('seed', id, first.workEmailCanonical);
      expect(held).toMatchObject({ outcome: 'UNRESOLVED', rows: [], why: 'LOCK_TIMEOUT' });
    } finally {
      await original.query('ROLLBACK').catch(() => undefined);
      await original.end();
    }
  });

  // The owner's case: the original commits while the reconciliation waits, and the read that follows sees the committed event.
  it('sees the committed event when the original commits while the reconciliation is waiting for the lock', async () => {
    const { plan, label: id } = seedPlan();
    const original = await openOriginal([[STATUS], [SEED, [plan.document]]]);
    try {
      const waiting = reconcile('seed', id, '', { wait: '10s' });
      await sleep(500);
      expect(await plainRead(id)).toEqual([]);
      await original.query('COMMIT');

      const after = await waiting;

      expect(after.outcome).toBe('COMMITTED_CURRENT');
      expect(after.rows.map((row) => row.work_email_canonical).sort()).toEqual(
        plan.administrators.map((each) => each.workEmailCanonical).sort(),
      );
      expect(after.rows.map((row) => row.grant_id).sort()).toEqual(
        plan.administrators.map((each) => each.grantId).sort(),
      );
      for (const row of after.rows) {
        expect(row).toMatchObject({ purpose: 'BOOTSTRAP_SETUP', state: 'PENDING', lapsed: false });
      }
    } finally {
      await original.end();
    }
  });

  it('says not committed only after the original has rolled back, even if it rolls back while the reconciliation waits', async () => {
    const { plan, label: id } = seedPlan();
    const original = await openOriginal([[STATUS], [SEED, [plan.document]]]);
    try {
      const waiting = reconcile('seed', id, '', { wait: '10s' });
      await sleep(500);
      await original.query('ROLLBACK');

      expect(await waiting).toEqual({
        outcome: 'NOT_COMMITTED',
        rows: [],
        isolation: 'read committed',
      });
      expect(
        (await admin.query<{ n: number }>('select count(*)::int as n from staff_identity')).rows[0]
          ?.n,
      ).toBe(0);
    } finally {
      await original.end();
    }
  });

  // Break caught: a committed secret handed over because its issuance event exists, after the custodian used it.
  it('says committed and since changed when a grant of the pair was used, and names which, and never an orphan', async () => {
    const { plan, first, second, label: id } = await committedPair().then((made) => made);
    await setGrantState(admin, first.grantId, 'CONSUMED');

    const after = await reconcile('seed', id, '');

    expect(after.outcome).toBe('COMMITTED_CHANGED');
    expect(after.outcome).not.toBe('NOT_COMMITTED');
    const states: Record<string, string | null> = Object.fromEntries(
      after.rows.map((row): [string, string | null] => [row.work_email_canonical ?? '', row.state]),
    );
    expect(states).toEqual({
      [first.workEmailCanonical]: 'CONSUMED',
      [second.workEmailCanonical]: 'PENDING',
    });
    expect(plan.administrators).toHaveLength(2);
  });
});

describe('reconciling a resume whose commit outcome is not known', () => {
  it('does not take a missing event for a rollback while the original transaction is still open', async () => {
    const { first } = await committedPair();
    const id = label();
    const resume = await resumePlan(first.workEmailCanonical, id);
    const original = await openOriginal([
      [STATE, [first.workEmailCanonical]],
      [RESUME, [resume.document]],
    ]);
    try {
      expect(await plainRead(id)).toEqual([]);
      expect(await reconcile('resume', id, first.workEmailCanonical)).toMatchObject({
        outcome: 'UNRESOLVED',
        rows: [],
        why: 'LOCK_TIMEOUT',
      });
    } finally {
      await original.query('ROLLBACK').catch(() => undefined);
      await original.end();
    }
  });

  it('sees the committed event when the original commits while the reconciliation is waiting for the lock', async () => {
    const { first } = await committedPair();
    const id = label();
    const resume = await resumePlan(first.workEmailCanonical, id);
    const original = await openOriginal([
      [STATE, [first.workEmailCanonical]],
      [RESUME, [resume.document]],
    ]);
    try {
      const waiting = reconcile('resume', id, first.workEmailCanonical, { wait: '10s' });
      await sleep(500);
      await original.query('COMMIT');

      const after = await waiting;

      expect(after.outcome).toBe('COMMITTED_CURRENT');
      expect(after.rows.map((row) => row.grant_id)).toEqual([resume.grantId]);
    } finally {
      await original.end();
    }
  });

  it('tells a commit from a rollback once the original has ended, and a rollback leaves the first secret current', async () => {
    const { first, second } = await committedPair();

    const committedId = label();
    const committed = await resumePlan(first.workEmailCanonical, committedId);
    const one = await openOriginal([
      [STATE, [first.workEmailCanonical]],
      [RESUME, [committed.document]],
    ]);
    try {
      expect((await reconcile('resume', committedId, first.workEmailCanonical)).outcome).toBe(
        'UNRESOLVED',
      );
      await one.query('COMMIT');
    } finally {
      await one.end();
    }
    const afterCommit = await reconcile('resume', committedId, first.workEmailCanonical);
    expect(afterCommit.outcome).toBe('COMMITTED_CURRENT');
    expect(afterCommit.rows.map((row) => row.grant_id)).toEqual([committed.grantId]);

    const rolledBackId = label();
    const rolledBack = await resumePlan(second.workEmailCanonical, rolledBackId);
    const two = await openOriginal([
      [STATE, [second.workEmailCanonical]],
      [RESUME, [rolledBack.document]],
    ]);
    try {
      expect((await reconcile('resume', rolledBackId, second.workEmailCanonical)).outcome).toBe(
        'UNRESOLVED',
      );
      await two.query('ROLLBACK');
    } finally {
      await two.end();
    }
    expect(await reconcile('resume', rolledBackId, second.workEmailCanonical)).toMatchObject({
      outcome: 'NOT_COMMITTED',
      rows: [],
    });
    // the other administrator's own secret is where it was, and current
    expect(
      (
        await admin.query<{ state: string }>('select state from setup_grant where id = $1', [
          second.grantId,
        ])
      ).rows[0]?.state,
    ).toBe('PENDING');
  });

  // Break caught: the issuance event taken for the secret to hand over. A second resume that committed since supersedes the first, so
  // the first run's event still exists and its bundle holds a secret that no longer works: obsolete, and never an orphan.
  it('says committed and since changed for a run whose secret a later run superseded, and current for the later one', async () => {
    const { first } = await committedPair();
    const firstId = label();
    const secondId = label();
    const one = await resumePlan(first.workEmailCanonical, firstId);
    await commitResume(one.document);
    const two = await resumePlan(first.workEmailCanonical, secondId);
    await commitResume(two.document);

    const earlier = await reconcile('resume', firstId, first.workEmailCanonical);
    const later = await reconcile('resume', secondId, first.workEmailCanonical);

    expect(earlier.outcome).toBe('COMMITTED_CHANGED');
    expect(earlier.outcome).not.toBe('NOT_COMMITTED');
    expect(earlier.rows).toMatchObject([{ grant_id: one.grantId, state: 'SUPERSEDED' }]);
    expect(later.outcome).toBe('COMMITTED_CURRENT');
    expect(later.rows).toMatchObject([{ grant_id: two.grantId, state: 'PENDING' }]);
  });

  it('says committed and since changed for a secret that has been used', async () => {
    const { first } = await committedPair();
    const id = label();
    const resume = await resumePlan(first.workEmailCanonical, id);
    await commitResume(resume.document);
    await setGrantState(admin, resume.grantId, 'CONSUMED');

    const after = await reconcile('resume', id, first.workEmailCanonical);

    expect(after.outcome).toBe('COMMITTED_CHANGED');
    expect(after.rows).toMatchObject([{ grant_id: resume.grantId, state: 'CONSUMED' }]);
  });
});

describe('an identity that was not locked, or not shown to be, is unresolved', () => {
  // Break caught: a mistyped address that names nobody, read as "nothing committed": the lock returned no row, so the original was not
  // waited for, and an empty read proves nothing.
  it('is unresolved for an address that no identity has, whether or not the run committed', async () => {
    const { first } = await committedPair();
    const id = label();
    const resume = await resumePlan(first.workEmailCanonical, id);
    await commitResume(resume.document);

    const missing = await reconcile('resume', id, 'nobody@melarc.example');

    expect(missing).toMatchObject({ outcome: 'UNRESOLVED', rows: [], why: 'IDENTITY_NOT_LOCKED' });
  });

  // Break caught: the lock taken on the typed identity alone: an address of the *other* administrator locks a row the original does
  // not hold, and an empty read would then look like a rollback. Every bootstrap identity is locked, so the original is waited for.
  it('waits for the original even when the address typed is the other administrator’s, and then finds the events are not about that identity', async () => {
    const { first, second } = await committedPair();
    const id = label();
    const resume = await resumePlan(first.workEmailCanonical, id);
    const original = await openOriginal([
      [STATE, [first.workEmailCanonical]],
      [RESUME, [resume.document]],
    ]);
    try {
      // the other administrator's address: the original holds the first identity, and the procedure locks both, so it must not pass
      expect(await reconcile('resume', id, second.workEmailCanonical)).toMatchObject({
        outcome: 'UNRESOLVED',
        why: 'LOCK_TIMEOUT',
      });
      await original.query('COMMIT');
    } finally {
      await original.end();
    }

    // once the original ended, the events are the first identity's and not the typed one's
    expect(await reconcile('resume', id, second.workEmailCanonical)).toMatchObject({
      outcome: 'UNRESOLVED',
      why: 'OTHER_IDENTITY',
    });
    expect((await reconcile('resume', id, first.workEmailCanonical)).outcome).toBe(
      'COMMITTED_CURRENT',
    );
  });

  // Break caught: an ordinary staff member's address accepted as the identity the original held: only a bootstrap identity can be the
  // subject of a resume, and the lock covers the bootstrap identities alone.
  it('is unresolved when the address is a staff member who is not a bootstrap identity', async () => {
    await committedPair();
    const ordinary = await insertStaff(admin, staffRow());

    expect(await reconcile('resume', label(), ordinary.workEmailCanonical)).toMatchObject({
      outcome: 'UNRESOLVED',
      why: 'IDENTITY_NOT_LOCKED',
    });
  });
});

describe('verified visibility on the correct primary', () => {
  /** What a plain run of the procedure's read says to a role that the policies filter: nothing, which reads as "not committed". */
  async function filteredRead(id: string): Promise<readonly Row[]> {
    const client = clientFor(database.urlFor('postgres'));
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`set local role ${PROBE}`);
      const { rows } = await client.query<Row>(filled(READ, { '<correlation id>': id }));
      await client.query('ROLLBACK');
      return rows;
    } finally {
      await client.end();
    }
  }

  // The owner's case: a role that row-level security restricts cannot return "not committed" from rows it was never shown.
  it('cannot return not committed from filtered rows: a role the policies filter is unresolved', async () => {
    const { first, label: id } = await committedPair();
    // the trap: the committed pair is there, and a read by this role finds nothing
    expect(await plainRead(id)).toHaveLength(2);
    const trapped = await filteredRead(id);
    expect(trapped).toEqual([]);
    expect(outcomeOf(trapped)).toBe('NOT_COMMITTED');

    // the check refuses the role, for the seed and for the resume
    expect(await reconcile('seed', id, '', { role: PROBE })).toMatchObject({
      outcome: 'UNRESOLVED',
      why: 'NOT_VISIBLE',
    });
    expect(await reconcile('resume', id, first.workEmailCanonical, { role: PROBE })).toMatchObject({
      outcome: 'UNRESOLVED',
      why: 'NOT_VISIBLE',
    });
  });

  // Break caught: the guard that holds when the check is missing: `row_security = off` turns a filtered read into an error, so the
  // outcome is unresolved by the database itself, and not a short answer.
  it('fails closed on its own: with the check left out, row_security = off turns the filtered read into an error', async () => {
    const { first, label: id } = await committedPair();

    const seed = await reconcile('seed', id, '', { role: PROBE, skipCheck: true });
    const resume = await reconcile('resume', id, first.workEmailCanonical, {
      role: PROBE,
      skipCheck: true,
    });

    // 42501: "query would be affected by row-level security policy": never a result
    expect(seed).toMatchObject({ outcome: 'UNRESOLVED', why: 'SQL_ERROR_42501' });
    expect(resume).toMatchObject({ outcome: 'UNRESOLVED', why: 'SQL_ERROR_42501' });
  });

  // Break caught: ownership taken for visibility. The migration owner owns every table and is filtered like anyone else (FORCE ROW
  // LEVEL SECURITY), so owning them is not what the check can rest on.
  it('does not rest on owning the tables: the table owner is filtered, and fails closed too', async () => {
    const { label: id } = await committedPair();
    const owner = (
      await admin.query<{ tableowner: string; force: boolean }>(
        `select c.relowner::regrole::text as tableowner, c.relforcerowsecurity as force
           from pg_class c where c.oid = 'public.audit_event'::regclass`,
      )
    ).rows[0];
    expect(owner?.force).toBe(true);

    const client = clientFor(database.urlFor('postgres'));
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`set local role ${owner?.tableowner ?? 'melarc_owner'}`);
      await client.query(ROW_SECURITY);
      const visible = (
        await client.query<{ sees: boolean | null }>(
          CHECK.replace(/ AS isolation[\s\S]*$/, ' AS isolation'),
        )
      ).rows;
      expect(visible).toHaveLength(1);
      let refusal: string | undefined;
      try {
        await client.query(filled(READ, { '<correlation id>': id }));
      } catch (error) {
        refusal = serverErrorIn(error)?.code;
      }
      await client.query('ROLLBACK');
      // the owner is filtered (an error under row_security = off, never rows): 42501
      expect(refusal).toBe('42501');
    } finally {
      await client.end();
    }
  });

  it('is unresolved when the connection is not the environment’s database', async () => {
    const { label: id } = await committedPair();

    expect(
      await reconcile('seed', id, '', { expectedDatabase: 'another_environment' }),
    ).toMatchObject({ outcome: 'UNRESOLVED', why: 'WRONG_DATABASE' });
  });

  it('is on a primary: the check reads that the connection is not in recovery', async () => {
    const client = clientFor(database.urlFor('postgres'));
    await client.connect();
    try {
      await client.query(BEGIN);
      const check = (await client.query<{ in_recovery: boolean; sees_every_row: boolean }>(CHECK))
        .rows[0];
      await client.query('ROLLBACK');
      expect(check).toMatchObject({ in_recovery: false, sees_every_row: true });
    } finally {
      await client.end();
    }
  });
});

describe('after a SQL error the transaction is rolled back explicitly', () => {
  // Break caught: a connection reused after an error without a rollback: every later statement of the aborted transaction fails, so
  // the first failure is reported as the answer to the last request.
  it('leaves the transaction aborted until ROLLBACK, after which a new attempt succeeds on the same connection', async () => {
    const { plan, label: id } = seedPlan();
    const original = await openOriginal([[STATUS], [SEED, [plan.document]]]);
    const client = clientFor(database.urlFor('postgres'));
    await client.connect();
    try {
      await client.query(BEGIN);
      await client.query(filled(WAIT, { '<wait>': '200ms' }));
      await client.query(ROW_SECURITY);
      const timedOut = await client.query(LOCK_SEED).then(
        () => undefined,
        (error: unknown) => serverErrorIn(error)?.code,
      );
      expect(timedOut).toBe('55P03');

      // no rollback yet: the transaction is aborted, and a later statement says so (and not what the data says)
      const aborted = await client.query(filled(READ, { '<correlation id>': id })).then(
        () => undefined,
        (error: unknown) => serverErrorIn(error)?.code,
      );
      expect(aborted).toBe('25P02');

      await client.query('ROLLBACK');
      await original.query('COMMIT');

      // a new attempt is a new transaction, and succeeds
      await client.query(BEGIN);
      await client.query(filled(WAIT, { '<wait>': '5s' }));
      await client.query(ROW_SECURITY);
      await client.query(LOCK_SEED);
      const rows = (await client.query<Row>(filled(READ, { '<correlation id>': id }))).rows;
      await client.query(COMMIT);
      expect(outcomeOf(rows)).toBe('COMMITTED_CURRENT');
    } finally {
      await client.end();
      await original.end();
    }
  });

  it('is what the reconciliation does on any exit that did not commit', async () => {
    const { label: id } = await committedPair();

    // an error mid-procedure leaves no transaction behind: the next reconciliation on a fresh connection is not blocked by it
    expect(await reconcile('seed', id, '', { role: PROBE, skipCheck: true })).toMatchObject({
      why: 'SQL_ERROR_42501',
    });
    expect((await reconcile('seed', id, '')).outcome).toBe('COMMITTED_CURRENT');
  });
});

describe('the outcome of a read that proves nothing', () => {
  // Break caught: a row that names a grant that is not there read as "current" or as "not committed".
  it('is unresolved when an issuance event names a grant that cannot be found', () => {
    expect(
      outcomeOf([
        { work_email_canonical: null, grant_id: null, purpose: null, state: null, lapsed: null },
      ]),
    ).toBe('UNRESOLVED');
  });

  it('is changed for a pending grant whose lifetime has run out, and an obsolete committed bundle is never an orphan', () => {
    const outcome = outcomeOf([
      {
        work_email_canonical: 'a@melarc.example',
        grant_id: randomUUID(),
        purpose: 'MFA_REENROLMENT',
        state: 'PENDING',
        lapsed: true,
      },
    ]);

    expect(outcome).toBe('COMMITTED_CHANGED');
    expect(outcome).not.toBe('NOT_COMMITTED');
  });

  it('is described in the document with the two dispositions kept apart: an uncommitted orphan, and an obsolete committed bundle', () => {
    expect(DOCUMENT).toMatch(/\*\*uncommitted orphan\*\*/);
    expect(DOCUMENT).toMatch(/\*\*obsolete\*\*/);
    expect(DOCUMENT).toMatch(/never classified, reported or swept as an uncommitted orphan/);
    // the sentence that contradicted the table is gone
    expect(DOCUMENT).not.toMatch(/Only the first row lets a bundle go, and only because/);
  });
});
