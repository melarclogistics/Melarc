/**
 * What the integrated harness (`e2e/`) does to the data of its own disposable database that no operation of the application will ever
 * do, and what it reads there that no operation shows (S0.45; plan section 3, "Time": a test ages a row with SQL, because there is no
 * production time-travel switch). It is the harness's counterpart of the database kit's `admin()` and `observe()`
 * (`test/database/support/`): the same arrangements, reachable from a process that depends on nothing inside the API.
 *
 * Both lists are closed. An arrangement or an observation has a name, takes its arguments in a fixed order and sends every one of them
 * as a statement parameter, never in the text of a statement. An arrangement that changes no row fails, so that a journey can never pass
 * for a lapse that did not happen. An observation reads no column that holds a secret: a hash, a token, a sealed seed, a payload.
 *
 * It runs only through `e2e-database` (`tools/e2e-database.ts`), as the cluster administrator, on a database that tool made.
 */

/** The smallest surface the arrangements need from a connection, so that they can be read and tested without one. */
export interface ArrangementClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly unknown[]; readonly rowCount: number | null }>;
}

const SETUP_PURPOSES: ReadonlySet<string> = new Set([
  'STAFF_CREDENTIAL_SETUP',
  'MFA_ENROLMENT',
  'MFA_REENROLMENT',
  'BOOTSTRAP_SETUP',
]);

/** A period in whole minutes, as the argument of `make_interval`. */
function minutes(value: string | undefined): number {
  const text = value ?? '';
  if (!/^[0-9]{1,6}$/.test(text) || Number(text) < 1 || Number(text) > 100_000) {
    throw new Error('minutes is a whole number from 1 to 100000');
  }
  return Number(text);
}

function workEmail(value: string | undefined): string {
  const text = value ?? '';
  if (text === '' || text.length > 320 || /\s/.test(text) || !text.includes('@')) {
    throw new Error('the work email is the canonical address of a staff identity');
  }
  return text;
}

export interface Arrangement {
  /** The arguments, by name, in the order they are given. */
  readonly arguments: readonly string[];
  /** Arguments that make a valid call, for the tests of the list. */
  readonly sample: readonly string[];
  /** Makes the change and returns how many rows it reached. */
  run(client: ArrangementClient, args: readonly string[]): Promise<number>;
}

const IDENTITY = `(select id from staff_identity where work_email_canonical = $1)`;
const VENDOR_ACCOUNT = `(select id from vendor_account where account_identifier = $1)`;

/** A vendor account's identifier: eight characters of its alphabet (SECURITY_DESIGN.md section 13.7a). */
function accountIdentifier(value: string | undefined): string {
  const text = value ?? '';
  if (!/^[2-9A-HJKMNP-Z]{8}$/.test(text))
    throw new Error('the account identifier is eight characters of its alphabet');
  return text;
}

/**
 * Runs `work` with a guard trigger of `table` switched off, and switches it on again whatever happened. The tables guard their own
 * history on purpose (a grant keeps its moments, a session is never back-dated, a challenge keeps its times), and the application
 * must never be able to change them; letting time pass is the one thing a test must do to them, and only as the administrator of its own
 * disposable database.
 */
async function withTriggerOff<T>(
  client: ArrangementClient,
  table: string,
  trigger: string,
  work: () => Promise<T>,
): Promise<T> {
  await client.query(`alter table ${table} disable trigger ${trigger}`);
  try {
    return await work();
  } finally {
    await client.query(`alter table ${table} enable trigger ${trigger}`);
  }
}

export const ARRANGEMENTS: Readonly<Record<string, Arrangement>> = {
  /**
   * Lets the time of a pending grant pass: it ends a minute ago and was issued two hours before that. The application then finds it
   * lapsed by the database's own clock, which is the clock a persisted expiry is judged by. A grant with no expiry (the bootstrap
   * secret) is not reached: it does not lapse.
   */
  'expire-setup-grant': {
    arguments: ['work email', 'purpose'],
    sample: ['a@b.example', 'STAFF_CREDENTIAL_SETUP'],
    async run(client, args) {
      const purpose = args[1] ?? '';
      if (!SETUP_PURPOSES.has(purpose)) throw new Error('purpose is not a staff grant purpose');
      const email = workEmail(args[0]);
      const result = await withTriggerOff(client, 'setup_grant', 'all', () =>
        client.query(
          `update setup_grant
              set issued_at = issued_at - interval '2 hours',
                  expires_at = clock_timestamp() - interval '1 minute'
            where principal_type = 'STAFF' and principal_id = ${IDENTITY}
              and purpose = $2 and state = 'PENDING' and expires_at is not null`,
          [email, purpose],
        ),
      );
      return result.rowCount ?? 0;
    },
  },

  /**
   * The same passing of time for a vendor's pending setup grant (row 12, the vendor half; S0.62), named by the account's identifier: the
   * one key a vendor has that is not a person's.
   */
  'expire-vendor-setup-grant': {
    arguments: ['account identifier'],
    sample: ['ABCDEFGH'],
    async run(client, args) {
      const identifier = accountIdentifier(args[0]);
      const result = await withTriggerOff(client, 'setup_grant', 'all', () =>
        client.query(
          `update setup_grant
              set issued_at = issued_at - interval '2 hours',
                  expires_at = clock_timestamp() - interval '1 minute'
            where principal_type = 'VENDOR' and principal_id = ${VENDOR_ACCOUNT}
              and purpose = 'VENDOR_CREDENTIAL_SETUP' and state = 'PENDING' and expires_at is not null`,
          [identifier],
        ),
      );
      return result.rowCount ?? 0;
    },
  },

  /** Lets the five minutes of a pending sign-in challenge pass. */
  'expire-mfa-challenge': {
    arguments: ['work email'],
    sample: ['a@b.example'],
    async run(client, args) {
      const email = workEmail(args[0]);
      const result = await withTriggerOff(
        client,
        'mfa_challenge',
        'mfa_challenge_update_guard',
        () =>
          client.query(
            `update mfa_challenge
              set issued_at = clock_timestamp() - interval '10 minutes',
                  expires_at = clock_timestamp() - interval '1 second'
            where staff_identity_id = ${IDENTITY} and state = 'PENDING'`,
            [email],
          ),
      );
      return result.rowCount ?? 0;
    },
  },

  /**
   * Lets `minutes` pass for the live sessions of an identity: issued, last active and expiring that much earlier. The guard that stops
   * the application from back-dating a session is switched off for the one update, and on again whatever happened.
   */
  'idle-session': {
    arguments: ['work email', 'minutes'],
    sample: ['a@b.example', '31'],
    async run(client, args) {
      const email = workEmail(args[0]);
      const period = minutes(args[1]);
      const result = await withTriggerOff(client, 'session', 'session_guard', () =>
        client.query(
          `update session
              set issued_at = issued_at - make_interval(mins => $2),
                  last_activity_at = last_activity_at - make_interval(mins => $2),
                  expires_at = expires_at - make_interval(mins => $2)
            where principal_type = 'STAFF' and principal_id = ${IDENTITY} and terminated_at is null`,
          [email, period],
        ),
      );
      return result.rowCount ?? 0;
    },
  },

  /**
   * Lets `days` pass for the trusted browsers an identity holds that are not removed: each was created, and ends, that much earlier. The
   * guard that keeps a trusted browser's moments write-once is switched off for the one update, and on again whatever happened. The
   * application then finds the seven days over by the database's own clock, which is the clock a persisted expiry is judged by.
   */
  'age-trusted-browsers': {
    arguments: ['work email', 'days'],
    sample: ['a@b.example', '8'],
    async run(client, args) {
      const email = workEmail(args[0]);
      const text = args[1] ?? '';
      if (!/^[0-9]{1,3}$/.test(text) || Number(text) < 1 || Number(text) > 400) {
        throw new Error('days is a whole number from 1 to 400');
      }
      const result = await withTriggerOff(
        client,
        'trusted_browser',
        'trusted_browser_update_guard',
        () =>
          client.query(
            `update trusted_browser
              set created_at = created_at - make_interval(days => $2),
                  expires_at = expires_at - make_interval(days => $2)
            where staff_identity_id = ${IDENTITY} and revoked_at is null`,
            [email, Number(text)],
          ),
      );
      return result.rowCount ?? 0;
    },
  },

  /**
   * Lets the minute of the rider challenge limit pass (`rate_limit_rider_challenge`: a rolling 60 seconds, counted on the database's clock):
   * every admission of that bucket is a minute and a second older. The limiter is the product's and is not gone around; only the time it
   * counts by moves, as it would in a minute. No argument: the run's database holds the run's admissions and no others, and a run that has
   * made none has nothing to age (it fails, as every arrangement that reaches no row does).
   */
  'lapse-rider-challenge-window': {
    arguments: [],
    sample: [],
    async run(client) {
      const result = await client.query(
        `update rate_limit_admission set admitted_at = admitted_at - interval '61 seconds'
          where bucket = 'rate_limit_rider_challenge'`,
      );
      return result.rowCount ?? 0;
    },
  },

  /** Lets the fifteen minutes of a lock pass: the lock has ended and the count of failures is as it was. */
  'lapse-lock': {
    arguments: ['work email'],
    sample: ['a@b.example'],
    async run(client, args) {
      const result = await client.query(
        `update staff_identity set locked_until = clock_timestamp() - interval '1 second'
          where work_email_canonical = $1 and locked_until is not null`,
        [workEmail(args[0])],
      );
      return result.rowCount ?? 0;
    },
  },
};

/** Runs a named arrangement and returns how many rows it reached. Refuses a name that is not in the list, and a change that reached none. */
export async function arrange(
  client: ArrangementClient,
  name: string,
  args: readonly string[],
): Promise<number> {
  const arrangement = Object.hasOwn(ARRANGEMENTS, name) ? ARRANGEMENTS[name] : undefined;
  if (arrangement === undefined) throw new Error(`${name} is not an arrangement`);
  if (args.length !== arrangement.arguments.length) {
    throw new Error(
      `${name} takes ${String(arrangement.arguments.length)} arguments (${arrangement.arguments.join(', ')})`,
    );
  }
  const reached = await arrangement.run(client, args);
  if (reached === 0) throw new Error(`${name} changed no row: the thing to arrange is not there`);
  return reached;
}

export interface Observation {
  readonly text: string;
  /** What names the identity: a staff member's work email unless said otherwise, a vendor account's identifier, a rider's phone. */
  readonly key?: 'account identifier' | 'phone';
}

/** A rider's phone, as it signs in: E.164. */
function phone(value: string | undefined): string {
  const text = value ?? '';
  if (!/^\+[1-9][0-9]{7,14}$/.test(text))
    throw new Error('the phone is a number in the form of E.164');
  return text;
}

export const OBSERVATIONS: Readonly<Record<string, Observation>> = {
  /** The authenticators of an identity, oldest first, by status. */
  factors: {
    text: `select f.status, f.created_by_purpose as purpose
             from mfa_factor f join staff_identity s on s.id = f.staff_identity_id
            where s.work_email_canonical = $1 order by f.ordinal`,
  },
  /** The sessions of an identity, oldest first: whether each is live and, if not, why it ended. */
  sessions: {
    text: `select (x.terminated_at is null) as live, x.termination_reason as reason
             from session x join staff_identity s on s.id = x.principal_id
            where x.principal_type = 'STAFF' and s.work_email_canonical = $1 order by x.issued_at, x.id`,
  },
  /** The grants an identity has been given, oldest first, by purpose and state. */
  'setup-grants': {
    text: `select g.purpose, g.state
             from setup_grant g join staff_identity s on s.id = g.principal_id
            where g.principal_type = 'STAFF' and s.work_email_canonical = $1 order by g.issued_at, g.id`,
  },
  /** The failed-sign-in count of an identity and whether it is locked now. */
  lock: {
    text: `select failed_attempt_count as failures,
                  (locked_until is not null and locked_until > clock_timestamp()) as locked
             from staff_identity where work_email_canonical = $1`,
  },
  /**
   * The trusted browsers of an identity, oldest first: whether each is valid now, whether it has stood in for a code, and why it was
   * removed. It reads no credential and no hash.
   */
  'trusted-browsers': {
    text: `select (t.revoked_at is null and t.expires_at > clock_timestamp()) as valid,
                  (t.last_used_at is not null) as used, t.revocation_cause as cause
             from trusted_browser t join staff_identity s on s.id = t.staff_identity_id
            where s.work_email_canonical = $1 order by t.created_at, t.id`,
  },
  /** The sessions of a vendor account, by its identifier, oldest first: whether each is live and, if not, why it ended (S0.62). */
  'vendor-sessions': {
    key: 'account identifier',
    text: `select (x.terminated_at is null) as live, x.termination_reason as reason
             from session x join vendor_account a on a.id = x.principal_id
            where x.principal_type = 'VENDOR' and a.account_identifier = $1 order by x.issued_at, x.id`,
  },
  /** The failed-sign-in count of a vendor account, by its identifier, and whether it is locked now (row 13, the vendor). */
  'vendor-lock': {
    key: 'account identifier',
    text: `select c.failed_attempt_count as failures,
                  (c.locked_until is not null and c.locked_until > clock_timestamp()) as locked
             from vendor_credential c join vendor_account a on a.id = c.vendor_account_id
            where a.account_identifier = $1`,
  },
  /** The sessions of a rider, by the phone it signs in with, oldest first: whether each is live and, if not, why it ended (rows 7, 9). */
  'rider-sessions': {
    key: 'phone',
    text: `select (x.terminated_at is null) as live, x.termination_reason as reason
             from session x join rider_identity r on r.id = x.principal_id
            where x.principal_type = 'RIDER' and r.phone = $1 order by x.issued_at, x.id`,
  },
  /** The failed-sign-in count of a rider, by phone, and whether it is locked now (row 13, the rider). */
  'rider-lock': {
    key: 'phone',
    text: `select failed_attempt_count as failures,
                  (locked_until is not null and locked_until > clock_timestamp()) as locked
             from rider_identity where phone = $1`,
  },
  /** The audit events that name an identity as their actor or their object, oldest first. */
  'audit-codes': {
    text: `select e.event_code as code, e.outcome
             from audit_event e join staff_identity s on (e.actor_id = s.id or e.object_id = s.id)
            where s.work_email_canonical = $1 order by e.recorded_at, e.id`,
  },
};

/** Runs a named observation and returns its rows. */
export async function observe(
  client: ArrangementClient,
  name: string,
  args: readonly string[],
): Promise<readonly unknown[]> {
  const observation = Object.hasOwn(OBSERVATIONS, name) ? OBSERVATIONS[name] : undefined;
  if (observation === undefined) throw new Error(`${name} is not an observation`);
  const key = observation.key ?? 'work email';
  if (args.length !== 1) throw new Error(`${name} takes 1 argument (${key})`);
  const value =
    key === 'account identifier'
      ? accountIdentifier(args[0])
      : key === 'phone'
        ? phone(args[0])
        : workEmail(args[0]);
  return (await client.query(observation.text, [value])).rows;
}
