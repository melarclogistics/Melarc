/**
 * Central redaction for every log line (OBSERVABILITY_AND_RECOVERY.md §2.3). Redaction lives here, in
 * the one place all logging passes through, rather than at each call site: a rule enforced per call
 * site is enforced at review level, which engineering-standards.md §2 ranks lowest.
 *
 * Two layers. Keys are redacted by name, at any depth. Strings are scrubbed for secrets that travel
 * inside text (URLs, bearer headers, key=value pairs). Free-text scrubbing is best-effort defence in
 * depth: the primary control is never putting request data into a log in the first place.
 */

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 10;
const MAX_CAUSE_DEPTH = 3;

/** Words that mark a key sensitive wherever they appear in it, after lowercasing and dropping punctuation. */
const SENSITIVE_SUBSTRINGS = [
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
  'authorization',
  'cookie',
  'csrf',
  'signature',
  'privatekey',
  'apikey',
  'signedurl',
  'setupgrant',
  'recovery',
  'totp',
  // The session credential is the `melarc_session` cookie, and a session id is as good as the credential.
  'session',
];

/** Short words that count only as a whole key: they sit inside ordinary ones ("shipping", "footprint"). */
const SENSITIVE_WHOLE_KEYS = new Set(['pin', 'otp', 'seed', 'sig', 'melarcvendordevice']);

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    SENSITIVE_WHOLE_KEYS.has(normalised) ||
    SENSITIVE_SUBSTRINGS.some((word) => normalised.includes(word))
  );
}

const SECRET_WORDS =
  'password|passwd|secret|token|api[_-]?key|signature|authorization|cookie|credential|session|csrf';
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JSON_SECRET = new RegExp(
  `("(?:[A-Za-z0-9_-]*(?:${SECRET_WORDS})[A-Za-z0-9_-]*|pin|otp|sig)"\\s*:\\s*")[^"]*(")`,
  'gi',
);
const PAIR_SECRET = new RegExp(
  `\\b((?:[A-Za-z0-9_-]*(?:${SECRET_WORDS})[A-Za-z0-9_-]*)|pin|otp|sig)=([^&\\s;,'"]+)`,
  'gi',
);

/** Removes secrets that travel inside text: URL credentials, bearer headers, key=value pairs, JSON. */
export function scrubText(text: string): string {
  return text
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(JSON_SECRET, `$1${REDACTED}$2`)
    .replace(PAIR_SECRET, `$1=${REDACTED}`);
}

export interface DescribedError {
  type: string;
  message: string;
  stack?: string;
  cause?: DescribedError;
}

const QUERY_PARAMETERS_MARK = '\nparams: ';

/**
 * drizzle-orm ends the message of a failed query with its bound values ("Failed query: <sql>\nparams: <values>").
 * On a statement that stores a credential those values are the credential, and no text pattern can recognize a
 * value by where it sits, so everything after the mark goes. The statement stays: it names no value.
 */
function withoutQueryParameters(message: string): string {
  if (!message.startsWith('Failed query: ')) return message;
  const at = message.indexOf(QUERY_PARAMETERS_MARK);
  return at === -1 ? message : `${message.slice(0, at)}${QUERY_PARAMETERS_MARK}${REDACTED}`;
}

/**
 * The only form in which an error reaches a log: type, scrubbed message, scrubbed stack and the
 * cause chain. Every other property is dropped, because the likeliest leak is not a logger call but
 * an exception that carries the request (headers, body) along with it.
 */
export function describeError(error: unknown, depth = 0): DescribedError {
  if (!(error instanceof Error)) {
    return {
      type: 'NonError',
      message:
        typeof error === 'string'
          ? scrubText(error)
          : `a non-error value of type ${typeof error} was thrown`,
    };
  }
  const message = withoutQueryParameters(error.message);
  const described: DescribedError = {
    type: scrubText(error.name),
    message: scrubText(message),
  };
  // The stack repeats the message verbatim on its first line. A function replaces it, because a statement can
  // hold `$$` or `$&`, which a replacement string would read as patterns.
  if (error.stack !== undefined)
    described.stack = scrubText(error.stack.replace(error.message, () => message));
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    described.cause = describeError(error.cause, depth + 1);
  }
  return described;
}

function walk(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Date) return value;
  if (value instanceof Error) return describeError(value);
  if (ArrayBuffer.isView(value)) return `[Binary ${String(value.byteLength)} bytes]`;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (ancestors.has(value)) return '[Circular]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item: unknown) => walk(item, depth + 1, ancestors));
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveKey(key) ? REDACTED : walk(entry, depth + 1, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

/** A redacted copy of anything that is about to be logged. Never modifies its input. */
export function redactValue(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}
