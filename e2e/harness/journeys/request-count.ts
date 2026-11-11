import type { BrowserContext, Request, Response } from '@playwright/test';

/**
 * How many requests each session of a journey made, by operation (run 7, Stage 3.5). The API limits an authenticated session to 120 requests in a rolling minute
 * (`rate_limit_authenticated_api`, answered with a 429), and the journeys go at the speed of a machine: the manifest journey, in one session, made 107 of them in 40 seconds, thirteen
 * under the limit, and CI runs it under HTTPS in three engines on every push to main, where one engine's extra read or one retried 503 would turn main red for a reason that is the
 * journey's and not the code's. So every journey is watched: the harness prints the count of each session by operation, and **fails the journey, with those counts, when a session
 * passes 100 requests in any rolling minute** (`SESSION_REQUEST_BUDGET`), twenty under the limit, while the 429 would still be a surprise rather than the cause.
 *
 * A session is what the Ops browser holds between one successful sign-in and the next (`POST /auth/staff/sign-in` and its second step answering 200), which is how a person's session
 * starts: the requests before the first are anonymous. The count is taken from the browser, the Ops origin's `/api/v1/` requests, whatever answered them; a handset or a vendor browser
 * of the journeys is an API client of its own with a session of its own, and makes a handful of requests.
 */
export const SESSION_REQUEST_BUDGET = 100;
/** The rolling minute the limit counts in. */
export const WINDOW_MS = 60_000;

const API_PREFIX = '/api/v1/';
/** The operations that open a session when they answer 200: the password step (a browser that is trusted, or a person without a second step) and the second step. */
const SESSION_STARTS: ReadonlySet<string> = new Set([
  'POST /auth/staff/sign-in',
  'POST /auth/staff/sign-in/mfa',
]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CODE = /ACC-[A-Z]{2}-[2-9A-HJKMNP-Z]{4,8}/g;

/** The operation a request is, as the counts name it: the method and the path without `/api/v1`, an identifier or a code or a number as a placeholder, no query. */
export function operationOf(method: string, pathname: string): string {
  const path = (pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length - 1) : pathname)
    .replace(UUID, '{id}')
    .replace(CODE, '{code}')
    .split('/')
    .map((segment) => (/^\d+$/.test(segment) ? '{n}' : segment))
    .join('/');
  return `${method.toUpperCase()} ${path}`;
}

interface Counted {
  readonly at: number;
  readonly operation: string;
}

/** One session's requests, in the order they were made. */
export interface SessionRecord {
  readonly label: string;
  readonly requests: Counted[];
}

/** The busiest rolling minute of a session. */
export interface BusiestMinute {
  readonly count: number;
  /** The requests of that minute by operation, the most frequent first. */
  readonly byOperation: readonly (readonly [string, number])[];
}

export class SessionRequestLog {
  readonly #sessions: SessionRecord[] = [{ label: 'before a sign-in', requests: [] }];

  /** A new session begins: the requests that follow are its own. */
  startSession(label: string): void {
    this.#sessions.push({ label, requests: [] });
  }

  record(operation: string, at: number): void {
    this.#sessions.at(-1)?.requests.push({ at, operation });
  }

  sessions(): readonly SessionRecord[] {
    return this.#sessions;
  }

  /** The most requests the session made inside any rolling `WINDOW_MS`, with the operations of that minute. */
  busiestMinute(session: SessionRecord): BusiestMinute {
    const requests = session.requests;
    let best = { count: 0, from: 0, to: -1 };
    let from = 0;
    for (const [to, request] of requests.entries()) {
      while (request.at - (requests[from]?.at ?? request.at) >= WINDOW_MS) from += 1;
      const count = to - from + 1;
      if (count > best.count) best = { count, from, to };
    }
    const counts = new Map<string, number>();
    for (const request of requests.slice(best.from, best.to + 1)) {
      counts.set(request.operation, (counts.get(request.operation) ?? 0) + 1);
    }
    return {
      count: best.count,
      byOperation: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    };
  }

  /** Each session that made a request, as lines: the total, the busiest minute and the operations of that minute. */
  report(): string {
    const lines: string[] = [];
    for (const session of this.#sessions) {
      if (session.requests.length === 0) continue;
      const busiest = this.busiestMinute(session);
      const operations = busiest.byOperation
        .map(([operation, count]) => `${operation} x${String(count)}`)
        .join(', ');
      lines.push(
        `${session.label}: ${String(session.requests.length)} requests, ${String(busiest.count)} in the busiest minute (${operations})`,
      );
    }
    return lines.join('\n');
  }

  /** The sessions that passed `budget` requests in a rolling minute, with their busiest minute. */
  overBudget(
    budget = SESSION_REQUEST_BUDGET,
  ): readonly { session: SessionRecord; busiest: BusiestMinute }[] {
    return this.#sessions
      .map((session) => ({ session, busiest: this.busiestMinute(session) }))
      .filter(({ busiest }) => busiest.count > budget);
  }
}

/** The words of the failure for a session over the budget, or nothing when no session is. The counts of every session follow, so that the one to look at is in front of the reader. */
export function budgetFailure(
  log: SessionRequestLog,
  budget = SESSION_REQUEST_BUDGET,
): string | undefined {
  const over = log.overBudget(budget);
  if (over.length === 0) return undefined;
  const first = over[0];
  const names = over.map(({ session }) => session.label).join(', ');
  return `${names} passed ${String(budget)} requests in a rolling minute (${String(first?.busiest.count ?? 0)} at the busiest; the API refuses a session past 120 with a 429, and CI runs this journey in three engines, where one extra read turns the run red). The requests by session and operation:\n${log.report()}\nLook for a page that reads more than it did (GET /ops/queue-summary and the reads after an act are the usual ones), or give the journey a session of its own for its second half.`;
}

/** The part of a journey that counting needs: its title, and a run that is given the browser context it makes its requests in. */
interface CountableJourney<Context extends { readonly context: BrowserContext }> {
  readonly title: string;
  run(journey: Context): Promise<void>;
}

/**
 * A journey that counts its sessions' requests: the count of each session by operation is printed when the journey ends, and a session that passed `SESSION_REQUEST_BUDGET` requests
 * in a rolling minute fails it with those counts, before the API's limit of 120 makes the failure a 429 that names no page. A journey that failed on its own is rethrown with the counts
 * after its words. `say` is where the counts are printed (the standard output of the run) and `now` the monotonic clock.
 */
export function countingRequests<Context extends { readonly context: BrowserContext }>(
  journey: CountableJourney<Context>,
  say: (text: string) => void = (text) => process.stdout.write(text),
  now: () => number = () => performance.now(),
): CountableJourney<Context> {
  return {
    title: journey.title,
    run: async (context) => {
      const watched = watchRequests(context.context, now);
      try {
        await journey.run(context);
      } catch (error) {
        watched.stop();
        const reason = error instanceof Error ? error.message : String(error);
        const counts = `The requests of the sessions of this journey:\n${watched.log.report()}`;
        throw new Error(`${reason}\n\n${counts}`, { cause: error });
      }
      watched.stop();
      say(
        `The requests of the sessions of "${journey.title.slice(0, 60)}...":\n${watched.log.report()}\n`,
      );
      const over = budgetFailure(watched.log);
      if (over !== undefined) throw new Error(over);
    },
  };
}

/** What a journey's browser emits that is watched: a request, and a response to one. */
export interface Watched {
  readonly log: SessionRequestLog;
  /** Stops watching; the log keeps what it has. */
  stop(): void;
}

/** Watches the Ops origin's API requests of a browser context, by session. `now` is the monotonic clock (the tests give one they hold). */
export function watchRequests(
  context: BrowserContext,
  now: () => number = () => performance.now(),
): Watched {
  const log = new SessionRequestLog();
  let sessions = 0;
  const onRequest = (request: Request): void => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith(API_PREFIX)) return;
    log.record(operationOf(request.method(), url.pathname), now());
  };
  const onResponse = (response: Response): void => {
    const request = response.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith(API_PREFIX) || response.status() !== 200) return;
    if (SESSION_STARTS.has(operationOf(request.method(), url.pathname))) {
      sessions += 1;
      log.startSession(`session ${String(sessions)}`);
    }
  };
  context.on('request', onRequest);
  context.on('response', onResponse);
  return {
    log,
    stop: () => {
      context.off('request', onRequest);
      context.off('response', onResponse);
    },
  };
}
