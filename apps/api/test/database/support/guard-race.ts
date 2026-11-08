/**
 * Arranges the one race a test cannot reach by timing alone (the audit of 21 October 2026, A06): a consumption whose `where` clause
 * passed, and whose expiry passed before the table's own guard looked at the row. PostgreSQL judges a statement's `where` before it
 * waits for a lock that left the row unchanged, and a `BEFORE UPDATE` trigger after it, so a trigger that sleeps in front of the guard
 * makes the guard meet a later clock than the `where` did, whenever the test wants it to.
 *
 * The trigger is named so that it fires before the table's guard (`a_...` sorts first), acts only on the update that consumes a
 * `PENDING` row, and counts each time it is reached in a sequence, which a rolled-back transaction does not undo: a test then asserts
 * that the race happened (`hits() === 1`) and does not pass because an expiry came early and was refused somewhere else.
 *
 * It is test support for a disposable database, and the administrator's: the function is `SECURITY DEFINER` so that the API's login,
 * which owns no sequence, can fire it. Table names are checked against the three this serves (the recovery request since S0.51a); every other word is a fixed one.
 */

export type RaceTable = 'setup_grant' | 'mfa_challenge' | 'recovery_request';

/** What a test hands in: the administrator's statements, whatever the client that runs them. */
export type AdminQuery = (statement: string) => Promise<readonly unknown[]>;

export interface InstalledRace {
  /** How many consumptions reached the trigger: the ones whose `where` passed. */
  hits(): Promise<number>;
  /** Removes the trigger, its function and its sequence. Idempotent. */
  remove(): Promise<void>;
}

const TABLES: readonly RaceTable[] = ['setup_grant', 'mfa_challenge', 'recovery_request'];
const DETAIL = /^reason=[A-Z_]+$/;

function checked(table: RaceTable): RaceTable {
  if (!TABLES.includes(table)) throw new Error(`"${table}" is not a table this serves`);
  return table;
}

async function install(
  query: AdminQuery,
  table: RaceTable,
  body: string,
  triggerArguments: string,
): Promise<InstalledRace> {
  checked(table);
  const sequence = `public.melarc_test_race_hits_${table}`;
  const fn = `public.melarc_test_race_${table}`;
  await query(`drop trigger if exists a_melarc_test_race on ${table}`);
  await query(`drop function if exists ${fn}()`);
  await query(`drop sequence if exists ${sequence}`);
  await query(`create sequence ${sequence}`);
  await query(`
    create function ${fn}() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$
    begin
      if old.state = 'PENDING' and new.state = 'CONSUMED' then
        perform nextval('${sequence}');
        ${body}
      end if;
      return new;
    end $$`);
  await query(
    `create trigger a_melarc_test_race before update on ${table}
       for each row execute function ${fn}(${triggerArguments})`,
  );
  let removed = false;
  return {
    async hits() {
      const rows = (await query(
        `select case when is_called then last_value else 0 end::int as n from ${sequence}`,
      )) as readonly { n: number }[];
      return rows[0]?.n ?? 0;
    },
    async remove() {
      if (removed) return;
      removed = true;
      await query(`drop trigger if exists a_melarc_test_race on ${table}`);
      await query(`drop function if exists ${fn}()`);
      await query(`drop sequence if exists ${sequence}`);
    },
  };
}

/** Every consumption sleeps `seconds` before the guard looks at the row. */
export function delayConsumption(
  query: AdminQuery,
  table: RaceTable,
  seconds: number,
): Promise<InstalledRace> {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) {
    throw new RangeError('a delay is a number of seconds between 0 and 30');
  }
  return install(query, table, 'perform pg_sleep(tg_argv[0]::float8);', `'${String(seconds)}'`);
}

/**
 * Every consumption is refused as a check violation (SQLSTATE 23514) with the given DETAIL, or with none: the refusals the
 * application must not mistake for an expiry, and the one it must (`reason=GRANT_EXPIRED`, `reason=CHALLENGE_EXPIRED`).
 */
export function refuseConsumption(
  query: AdminQuery,
  table: RaceTable,
  detail: string | null,
): Promise<InstalledRace> {
  if (detail !== null && !DETAIL.test(detail)) {
    throw new Error('a detail is `reason=` and capital letters');
  }
  const using = detail === null ? '' : `, detail = '${detail}'`;
  return install(
    query,
    table,
    `raise exception 'refused by the test' using errcode = '23514'${using};`,
    '',
  );
}
