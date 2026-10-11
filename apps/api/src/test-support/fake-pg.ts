import { EventEmitter } from 'node:events';

import pg from 'pg';
import { vi } from 'vitest';

import type { StatementCanceller } from '../platform/database/statement-canceller.js';
import { INERT_DEADLINES } from '../platform/config/inert-config.js';
import type { DatabaseDeadlines } from '../platform/config/load-config.js';
import { SystemClock } from '../platform/auth/clock/system.clock.adapter.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import { asError } from '../platform/database/database-failures.js';
import type { DatabaseRuntime } from '../platform/database/database.service.js';

/** An error as the server sends it: a node-postgres `DatabaseError` with its SQLSTATE and severity. */
export function serverError(code: string, message = `server error ${code}`, severity = 'ERROR') {
  const error = new pg.DatabaseError(message, 0, 'error');
  error.code = code;
  error.severity = severity;
  return error;
}

export interface Failure {
  readonly match: RegExp;
  readonly error: unknown;
}

interface Pending {
  readonly text: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
}

const RESULT = { rows: [] as unknown[], rowCount: 0, fields: [] as unknown[] };

/**
 * The command tag the server completes a statement with, as node-postgres reports it in `result.command`: the statement's own
 * first word, upper case (`COMMIT` for a COMMIT, `ROLLBACK` for a ROLLBACK). A real server completes a COMMIT with `ROLLBACK`
 * when the transaction had failed (the probe in the plan, S0.6 correction F01); a test makes it so with `completeWith`.
 */
export function commandTagOf(text: string): string | undefined {
  return /^\s*([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase();
}

/**
 * A connection the way the service uses one: it records the statements it is sent, answers each at once, and can be told to
 * fail a statement or to leave one unanswered (as a statement that is still running is) until the test settles it. `role`
 * is what the statement that sets the context reports as the connection's role.
 */
export class FakeConnection extends EventEmitter {
  readonly statements: string[] = [];
  readonly pending: Pending[] = [];
  readonly failures: Failure[] = [];
  readonly hangs: RegExp[] = [];
  /** The values bound to each statement, in the order of `statements`. */
  readonly values: unknown[][] = [];
  private readonly answers: { match: RegExp; rows: unknown[] }[] = [];
  private readonly completions: (
    { match: RegExp; kind: 'tag'; command: string | undefined } | { match: RegExp; kind: 'nothing' }
  )[] = [];
  readonly release = vi.fn<(error?: Error | boolean) => void>();
  processID: number | null;
  private readonly role: string | undefined;

  constructor(options: { fail?: Failure; role?: string; processID?: number | null } = {}) {
    super();
    if (options.fail !== undefined) this.failures.push(options.fail);
    this.role = options.role;
    this.processID = options.processID === undefined ? 4242 : options.processID;
  }

  readonly query = vi.fn((query: string | { text: string }, values?: unknown[]) => {
    const text = typeof query === 'string' ? query : query.text;
    this.statements.push(text);
    this.values.push(values ?? []);
    const failure = this.failures.find((candidate) => candidate.match.test(text));
    if (failure !== undefined) return Promise.reject(asError(failure.error));
    if (this.hangs.some((match) => match.test(text))) {
      return new Promise((resolve, reject) => {
        this.pending.push({ text, resolve, reject });
      });
    }
    const answered = this.answers.find((candidate) => candidate.match.test(text));
    const rows =
      answered?.rows ??
      (this.role !== undefined && text.includes('set_config')
        ? [{ database_role: this.role }]
        : []);
    const completion = this.completions.find((candidate) => candidate.match.test(text));
    if (completion?.kind === 'nothing') return Promise.resolve(undefined);
    const command = completion?.kind === 'tag' ? completion.command : commandTagOf(text);
    return Promise.resolve({
      ...RESULT,
      rows,
      rowCount: rows.length,
      ...(command === undefined ? {} : { command }),
    });
  });

  /** The statements sent that are not the ones that begin or end the transaction. */
  get workStatements(): string[] {
    return this.statements.filter((text) => !/^(begin|commit|rollback)\b/i.test(text));
  }

  /** Answer statements matching `match` with `rows`. */
  answer(match: RegExp, rows: unknown[]): this {
    this.answers.push({ match, rows });
    return this;
  }

  /**
   * Complete statements matching `match` with this command tag (`result.command`), or with none when `command` is undefined: the
   * way a server completes a COMMIT with `ROLLBACK` when the transaction had failed, or the way a result that says nothing arrives.
   */
  completeWith(match: RegExp, command: string | undefined): this {
    this.completions.push({ match, kind: 'tag', command });
    return this;
  }

  /** Answer statements matching `match` with no result at all (the promise resolves to `undefined`). */
  answerNothing(match: RegExp): this {
    this.completions.push({ match, kind: 'nothing' });
    return this;
  }

  /** Leave statements matching `match` unanswered, as a running statement is. */
  hang(match: RegExp): this {
    this.hangs.push(match);
    return this;
  }

  /** Make statements matching `match` fail with `error`. */
  fail(match: RegExp, error: unknown): this {
    this.failures.push({ match, error });
    return this;
  }

  /** Settle every unanswered statement with a rejection, as the server does when it cancels them. */
  rejectPending(error: unknown): void {
    for (const each of this.pending.splice(0)) each.reject(error);
  }

  /** Settle every unanswered statement successfully. */
  resolvePending(): void {
    for (const each of this.pending.splice(0)) {
      const command = commandTagOf(each.text);
      each.resolve({ ...RESULT, ...(command === undefined ? {} : { command }) });
    }
  }

  /** What the connection was last released with: `undefined` returned it to the pool, an error destroyed it. */
  get releasedWith(): Error | boolean | undefined {
    return this.release.mock.calls.at(-1)?.[0];
  }

  /** True when the connection was destroyed instead of being returned to the pool. */
  get destroyed(): boolean {
    const last = this.release.mock.calls.at(-1);
    return last?.[0] !== undefined && last[0] !== false;
  }
}

/** The part of a node-postgres Pool the service uses. */
export class FakePool extends EventEmitter {
  query = vi.fn();
  connect = vi.fn();
  end = vi.fn(() => Promise.resolve());

  /** Hands out `connections` one after another, then fresh ones. */
  hand(...connections: FakeConnection[]): this {
    for (const connection of connections) this.connect.mockResolvedValueOnce(connection);
    return this;
  }
}

export interface FakeCanceller extends StatementCanceller {
  readonly cancel: ReturnType<typeof vi.fn<StatementCanceller['cancel']>>;
}

/** A canceller that answers `signalled`, and that a test can make do what the server would (reject a statement, say). */
export function fakeCanceller(
  outcome: Awaited<ReturnType<StatementCanceller['cancel']>> = 'signalled',
): FakeCanceller {
  return { cancel: vi.fn<StatementCanceller['cancel']>(() => Promise.resolve(outcome)) };
}

/** What the service is given besides the pool: a clock, the deadlines, the pool size and a canceller. */
export function testRuntime(
  overrides: {
    clock?: Clock;
    deadlines?: Partial<DatabaseDeadlines>;
    poolMax?: number;
    canceller?: StatementCanceller;
  } = {},
): DatabaseRuntime {
  return {
    clock: overrides.clock ?? new SystemClock(),
    poolMax: overrides.poolMax ?? 10,
    deadlines: { ...INERT_DEADLINES, ...overrides.deadlines },
    canceller: overrides.canceller ?? fakeCanceller(),
  };
}
