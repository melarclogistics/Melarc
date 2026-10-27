import type pg from 'pg';

/**
 * Synchronisation for the tests of a race on a row lock (the audit of 26 October 2026, decision 9). A test of a *business* race holds a
 * lock in one transaction, starts the work that has to meet it, **observes** that the work is waiting and only then lets go: the wait
 * ends when the test says so, however slow or fast the machine is, and the production deadlines are untouched. A fixed sleep proved only
 * that "some time" had passed, and the database's own clock (which on this workstation steps forward by about a second every half
 * minute) could end a lock wait before the test released it. A test of the *timeout* itself is a different test and keeps its own bound.
 */

/** How long a test waits for something it caused to be observed: a generous bound for a slow machine, not a measure of anything. */
const OBSERVATION_BOUND_MS = 30_000;
const POLL_MS = 15;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** The server process of a client, for `waitUntilBlockedBy`. */
export async function backendPidOf(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
  const row = result.rows[0];
  if (row === undefined) throw new Error('The database did not say which backend answered.');
  return row.pid;
}

/**
 * Resolves when some other backend is waiting for a lock that the backend `holderPid` holds, as the database itself reports it
 * (`pg_blocking_pids`). `observer` is a connection that is not the holder and is not itself waiting. Fails, saying so, if no backend
 * waits within the bound: a test whose work never reached the lock proved nothing and must not pass. `unless` is the work itself: if it
 * ends before it was seen waiting, it never met the lock, and that is said at once and not after the bound.
 */
export async function waitUntilBlockedBy(
  observer: pg.Client,
  holderPid: number,
  what = 'the work under test',
  unless?: Promise<unknown>,
): Promise<void> {
  const work = { ended: false };
  void unless?.then(
    () => {
      work.ended = true;
    },
    () => {
      work.ended = true;
    },
  );
  const deadline = Date.now() + OBSERVATION_BOUND_MS;
  for (;;) {
    const result = await observer.query<{ waiting: string }>(
      `select count(*) as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and $1::int = any (pg_blocking_pids(pid))`,
      [holderPid],
    );
    if (Number(result.rows[0]?.waiting ?? 0) > 0) return;
    if (work.ended) throw new Error(`${what} ended before it was seen waiting for the lock.`);
    if (Date.now() > deadline) {
      throw new Error(
        `${what} was not seen waiting for the lock within ${String(OBSERVATION_BOUND_MS)} ms.`,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * Resolves when a statement the database answers `true` to is true: for something that only the database's clock can bring about (a
 * moment passing), asked of the database and never of this process's clock. `text` selects one boolean column named `ready`.
 */
export async function waitUntilTrue(
  observer: pg.Client,
  text: string,
  values: unknown[] = [],
  what = 'the condition',
): Promise<void> {
  const deadline = Date.now() + OBSERVATION_BOUND_MS;
  for (;;) {
    const result = await observer.query<{ ready: boolean }>(text, values);
    if (result.rows[0]?.ready === true) return;
    if (Date.now() > deadline) {
      throw new Error(`${what} was not true within ${String(OBSERVATION_BOUND_MS)} ms.`);
    }
    await sleep(POLL_MS);
  }
}
