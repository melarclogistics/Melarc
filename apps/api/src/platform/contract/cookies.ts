import { isJsonObject, type Json } from './json.js';

/**
 * The cookies of a `Cookie` request header, by exact name. A name that repeats keeps its first value, as the
 * browser sends the most specific cookie first. A value in double quotes is read without them. Names are
 * the request's own, so the result is only ever searched by the names a contract declares.
 */
export function parseCookieHeader(
  header: string | readonly string[] | undefined,
): Map<string, string> {
  const joined = typeof header === 'string' ? header : (header ?? []).join('; ');
  const cookies = new Map<string, string>();
  for (const pair of joined.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (name === '' || cookies.has(name)) continue;
    const raw = pair.slice(separator + 1).trim();
    cookies.set(
      name,
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw,
    );
  }
  return cookies;
}

/** One `Set-Cookie` line, without its value: the value of a cookie is a credential and is never kept. */
export interface SetCookie {
  readonly name: string;
  /** Attributes with no value (`HttpOnly`, `Secure`), lower-cased. */
  readonly flags: ReadonlySet<string>;
  /** Attributes with a value (`SameSite`, `Path`, `Domain`, `Max-Age`), by lower-cased name. */
  readonly values: ReadonlyMap<string, string>;
}

/** The cookies a response sets, from the value of its `set-cookie` header (one line, or a list). */
export function parseSetCookies(header: unknown): SetCookie[] {
  const lines = typeof header === 'string' ? [header] : Array.isArray(header) ? header : [];
  return lines
    .filter((line): line is string => typeof line === 'string')
    .map((line) => {
      const [pair = '', ...attributes] = line.split(';');
      const separator = pair.indexOf('=');
      const flags = new Set<string>();
      const values = new Map<string, string>();
      for (const attribute of attributes) {
        const text = attribute.trim();
        if (text === '') continue;
        const equals = text.indexOf('=');
        if (equals === -1) flags.add(text.toLowerCase());
        else values.set(text.slice(0, equals).trim().toLowerCase(), text.slice(equals + 1).trim());
      }
      return { name: (separator === -1 ? pair : pair.slice(0, separator)).trim(), flags, values };
    });
}

/** What the contract's root `x-cookies` says a cookie must carry. */
export interface ExpectedCookie {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  /** No `Domain` attribute: the cookie belongs to the host that set it and to no subdomain. */
  readonly hostOnly: boolean;
  /** Script on the page reads it, so it cannot be `HttpOnly`. */
  readonly readableByScript: boolean;
}

/**
 * Reads a cookie's definition from `x-cookies`: `attributes` is the `Set-Cookie` attribute text the contract
 * promises, and `host_only` and `read_by_javascript` are facts about the cookie. A cookie `x-cookies` does not
 * define, or whose definition contradicts itself, cannot be checked, and a validator that quietly skipped it
 * would run unprotected, so this throws.
 */
export function expectedCookie(name: string, definition: Json | undefined): ExpectedCookie {
  if (!isJsonObject(definition) || typeof definition.attributes !== 'string') {
    throw new Error(
      `A response sets the cookie ${name}, and the contract's x-cookies does not define its attributes.`,
    );
  }
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (const part of definition.attributes.split(';')) {
    const text = part.trim();
    if (text === '') continue;
    const equals = text.indexOf('=');
    if (equals === -1) flags.add(text.toLowerCase());
    else values.set(text.slice(0, equals).trim().toLowerCase(), text.slice(equals + 1).trim());
  }

  const readableByScript = definition.read_by_javascript === true;
  if (readableByScript && flags.has('httponly')) {
    throw new Error(
      `The contract's x-cookies says ${name} is HttpOnly and also readable by script, which cannot both hold.`,
    );
  }
  if (definition.read_by_javascript === false) flags.add('httponly');
  return { flags, values, hostOnly: definition.host_only === true, readableByScript };
}

/**
 * The attributes of a cookie that was set which the contract does not allow, named in the contract's own words
 * (`httponly`, `secure`, `samesite`, `path`, `domain`), sorted.
 */
export function brokenAttributes(actual: SetCookie, expected: ExpectedCookie): string[] {
  const broken = new Set<string>();
  for (const flag of expected.flags) if (!actual.flags.has(flag)) broken.add(flag);
  if (expected.readableByScript && actual.flags.has('httponly')) broken.add('httponly');
  for (const [key, value] of expected.values) {
    const got = actual.values.get(key);
    const same = key === 'samesite' ? got?.toLowerCase() === value.toLowerCase() : got === value;
    if (!same) broken.add(key);
  }
  if (expected.hostOnly && actual.values.has('domain')) broken.add('domain');
  return [...broken].toSorted();
}
