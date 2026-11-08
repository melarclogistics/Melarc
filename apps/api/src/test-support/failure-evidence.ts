import { scrubText } from '../platform/logging/redaction.js';
import type { CapturedLogs } from './captured-logs.js';
import type { RequestOptions, TestClient, TestResponse } from './test-client.js';

/**
 * What a test keeps of a request the application answered with a server error (`500` and above), so that a failure of the test says why
 * the request failed and not only that it did. The server's diagnostic is already written for that: each failure is one line of the
 * application's own log, stamped with the request's id and with the error reduced to its safe form by the logger's central redaction (a
 * type, a scrubbed message, the cause chain: no property of the error, no bound value of a statement, no key that names a credential).
 * The test application keeps those lines in memory (`CapturedLogs`); this reads the ones that belong to one response and passes them
 * through the scrubber once more.
 *
 * **Bounded, and an allow-list.** Of the lines of the request it keeps the warnings and errors and the completion line; of each, its
 * level, its message, its scalar fields (the ones the platform writes: a deadline's label and phase, a commit's reason, the status and
 * the duration), and the type and message of the error and of its causes, each text cut to a length. It keeps **no stack**, no nested
 * object, no request header, cookie, body or query, and no more than a few lines and a few failures. It is test support: nothing in the
 * production tree imports it.
 */
const MAX_TEXT = 400;
const MAX_RECORDS = 12;
const MAX_FAILURES = 20;
const CAUSE_DEPTH = 3;
/** The fields of a line that are kept apart from the scalar ones, or that every line carries and say nothing of a failure. */
const NOT_FIELDS = new Set(['level', 'msg', 'time', 'service', 'env', 'request_id', 'err']);

export interface EvidenceError {
  readonly type: string;
  readonly message: string;
}

export interface EvidenceRecord {
  readonly level: string;
  readonly msg: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
  readonly errors: readonly EvidenceError[];
}

export interface FailureEvidence {
  readonly request_id: string | null;
  readonly status: number;
  /** The `code` of the body, when it carries one (the platform's own failures carry none). */
  readonly code: string | null;
  readonly records: readonly EvidenceRecord[];
}

const cut = (text: string): string => {
  const scrubbed = scrubText(text);
  return scrubbed.length > MAX_TEXT ? `${scrubbed.slice(0, MAX_TEXT)}…` : scrubbed;
};

function bodyOf(response: TestResponse): { request_id?: unknown; code?: unknown } {
  try {
    const parsed: unknown = JSON.parse(response.text);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function errorsOf(value: unknown): EvidenceError[] {
  const chain: EvidenceError[] = [];
  let current: unknown = value;
  for (let depth = 0; depth <= CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) break;
    const { type, message, cause } = current as Record<string, unknown>;
    chain.push({
      type: typeof type === 'string' ? cut(type) : 'unknown',
      message: typeof message === 'string' ? cut(message) : '',
    });
    current = cause;
  }
  return chain;
}

function recordOf(line: Record<string, unknown>): EvidenceRecord {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(line)) {
    if (NOT_FIELDS.has(key)) continue;
    if (typeof value === 'string') fields[key] = cut(value);
    else if (typeof value === 'number' || typeof value === 'boolean') fields[key] = value;
  }
  return {
    level: typeof line.level === 'string' ? line.level : 'unknown',
    msg: typeof line.msg === 'string' ? cut(line.msg) : '',
    fields,
    errors: errorsOf(line.err),
  };
}

const KEPT_LEVELS = new Set(['warn', 'error', 'fatal']);

/** The evidence of one response: its request id, status and code, and the lines the application logged for that request. */
export function failureEvidence(logs: CapturedLogs, response: TestResponse): FailureEvidence {
  const body = bodyOf(response);
  const requestId =
    response.header('x-request-id') ??
    (typeof body.request_id === 'string' ? body.request_id : null);
  const records =
    requestId === null
      ? []
      : logs
          .records()
          .filter(
            (line) =>
              line.request_id === requestId &&
              (KEPT_LEVELS.has(String(line.level)) || line.msg === 'request completed'),
          )
          .slice(0, MAX_RECORDS)
          .map(recordOf);
  return {
    request_id: requestId === null ? null : cut(requestId),
    status: response.status,
    code: typeof body.code === 'string' ? cut(body.code) : null,
    records,
  };
}

export interface ServerFailureWatch {
  /** The evidence of every server error the client (and the clients made from it) has seen since the watch began or was last cleared (at most twenty). */
  seen(): readonly FailureEvidence[];
  clear(): void;
}

/**
 * Makes `client` keep the evidence of each of its responses of `500` or more, as the application's own log has it, for the test that
 * is running to print if it fails. The client answers exactly as before, and so do the clients made from it (`fork`, `bearer`): a
 * session presented by value is a fork, and a Rider's request is a bearer client.
 */
export function watchServerFailures(client: TestClient, logs: CapturedLogs): ServerFailureWatch {
  const seen: FailureEvidence[] = [];
  const instrument = (each: TestClient): TestClient => {
    const request = each.request.bind(each);
    each.request = async (
      method: string,
      path: string,
      options?: RequestOptions,
    ): Promise<TestResponse> => {
      const response = await request(method, path, options);
      if (response.status >= 500 && seen.length < MAX_FAILURES) {
        seen.push(failureEvidence(logs, response));
      }
      return response;
    };
    const fork = each.fork.bind(each);
    each.fork = () => instrument(fork());
    const bearer = each.bearer.bind(each);
    each.bearer = (token: string) => instrument(bearer(token));
    return each;
  };
  instrument(client);
  return {
    seen: () => [...seen],
    clear: () => {
      seen.length = 0;
    },
  };
}

/**
 * The watches of the clients a test file has made, so that one setup of the database project can print what any of them saw when a
 * test fails (`test/database/support/failure-evidence-setup.ts`), without each file wiring it. A watch is registered when the kit that
 * owns its client starts and forgotten when that kit stops.
 */
const registered = new Set<ServerFailureWatch>();

export function registerWatch(watch: ServerFailureWatch): () => void {
  registered.add(watch);
  return () => {
    registered.delete(watch);
  };
}

/** What every registered watch has seen, in the order the watches were registered. */
export function everyWatchedFailure(): readonly FailureEvidence[] {
  return [...registered].flatMap((watch) => watch.seen());
}

export function clearEveryWatch(): void {
  for (const watch of registered) watch.clear();
}

/** The evidence as text for a failed test's output: JSON, one failure after another. */
export function describeFailures(failures: readonly FailureEvidence[]): string {
  return failures
    .map((failure) => `server failure evidence: ${JSON.stringify(failure, null, 2)}`)
    .join('\n');
}
