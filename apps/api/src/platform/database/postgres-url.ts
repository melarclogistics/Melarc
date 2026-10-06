/** The parts of a PostgreSQL connection URL that decisions are made on. Never includes the password. */
export interface PostgresTarget {
  /** The host, without the brackets of an IPv6 literal. */
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
}

/**
 * What a client connects with: the facts of {@link PostgresTarget} and the password, nothing else. It is
 * the only thing made from a URL. The URL itself is never handed to the driver, which would read the query
 * string too and let it replace the user, host or port that were checked. Carries the password, so it is
 * never logged or echoed.
 */
export interface PostgresConnectionSettings extends PostgresTarget {
  readonly password?: string;
}

const DEFAULT_PORT = 5432;

/** A host name or IPv4 address as written, or the text of an IPv6 literal. No percent-escapes, no path. */
const HOST_NAME = /^[A-Za-z0-9._-]+$/;
const IPV6_LITERAL = /^\[[0-9A-Fa-f:.]+\]$/;

/**
 * Why a URL is not accepted, as fixed text that is never built from the URL. A connection URL carries a
 * password, and what was pasted into the wrong variable is not ours to repeat.
 */
const PROBLEMS = {
  unreadable: 'is not a readable URL',
  scheme: 'must be a postgres:// or postgresql:// URL',
  query: 'must not carry a query string: connection options are not supported',
  fragment: 'must not carry a fragment',
  host: 'must name a host: a host name, an IPv4 address or an IPv6 address in brackets',
  user: 'must name a user',
  port: 'must use a port from 1 to 65535',
  database: 'must name exactly one database',
} as const;

export type PostgresUrlProblem = keyof typeof PROBLEMS;

/** A connection URL was refused. The message is fixed text: it never contains any part of the URL. */
export class PostgresUrlError extends Error {
  readonly problem: PostgresUrlProblem;

  constructor(problem: PostgresUrlProblem) {
    super(`the database URL ${PROBLEMS[problem]}`);
    this.name = 'PostgresUrlError';
    this.problem = problem;
  }
}

type Reading =
  { readonly settings: PostgresConnectionSettings } | { readonly problem: PostgresUrlProblem };

/**
 * The one interpretation of a connection URL: `postgres://user[:password]@host[:port]/database`, and
 * nothing else. A query string and a fragment are refused, whatever they hold, because the driver would
 * act on a query string (`user`, `host`, `port`, TLS, the session role) and the last repeat of a name wins.
 * Connection options are not supported until a deployment specifies them.
 */
function read(url: string): Reading {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { problem: 'unreadable' };
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return { problem: 'scheme' };
  }
  // Read off the text and not off `search` and `hash`: a bare `?` or `#` leaves both of those empty.
  if (url.includes('?')) return { problem: 'query' };
  if (url.includes('#')) return { problem: 'fragment' };

  const bracketed = parsed.hostname.startsWith('[');
  if (!(bracketed ? IPV6_LITERAL : HOST_NAME).test(parsed.hostname)) return { problem: 'host' };
  const host = bracketed ? parsed.hostname.slice(1, -1) : parsed.hostname;

  const port = parsed.port === '' ? DEFAULT_PORT : Number(parsed.port);
  // Zero is not a port the driver can be given: it treats it as unset and falls back to another.
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { problem: 'port' };

  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return { problem: 'unreadable' };
  }
  if (user === '') return { problem: 'user' };
  if (database === '' || database.includes('/')) return { problem: 'database' };

  return { settings: { host, port, database, user, ...(password === '' ? {} : { password }) } };
}

/**
 * Reads a PostgreSQL connection URL. Returns undefined, and never throws, for anything that is not a
 * usable target: another scheme, a query string or fragment, no host, no user, no database or one with a
 * path. The password is deliberately not part of the result, so nothing built on it can log one.
 */
export function parsePostgresUrl(url: string): PostgresTarget | undefined {
  const reading = read(url);
  if (!('settings' in reading)) return undefined;
  const { host, port, database, user } = reading.settings;
  return { host, port, database, user };
}

/** Why a URL is not accepted, as fixed text that starts with a verb ("must ..."), or undefined if it is. */
export function postgresUrlProblem(url: string): string | undefined {
  const reading = read(url);
  return 'problem' in reading ? PROBLEMS[reading.problem] : undefined;
}

/**
 * The settings to give a driver client or pool for a URL, built from the same facts {@link parsePostgresUrl}
 * reports, so the identity that was checked is the identity that connects. Throws {@link PostgresUrlError},
 * with fixed text, for a URL that is not accepted.
 */
export function postgresConnectionSettings(url: string): PostgresConnectionSettings {
  const reading = read(url);
  if ('problem' in reading) throw new PostgresUrlError(reading.problem);
  return reading.settings;
}
