/**
 * What the browser under test may reach. An origin is a scheme, a host and a port, and it is compared as that,
 * after the URL has been parsed the way the browser parses it. It is never compared as text: a URL that begins
 * with the stack's origin is not necessarily a URL on it. `http://127.0.0.1:4173@elsewhere.example/` begins with
 * `http://127.0.0.1:4173` and is a request to `elsewhere.example`, because what comes before the @ is a username
 * and password; `http://127.0.0.1:41730/` begins with it too and is another port.
 */

/** Schemes whose URLs name no server at all. */
const WITHOUT_A_SERVER = new Set(['data:', 'about:']);

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * The origin the browser is limited to, checked to be exactly an origin: an http or https scheme, a host, a port
 * that is not the default one written out, and no path, no credentials, no query. A boundary built on anything
 * else would compare as a different origin from the one meant.
 */
export function canonicalOrigin(origin: string): string {
  const parsed = parse(origin);
  if (
    parsed === undefined ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.origin !== origin
  ) {
    throw new TypeError(
      'The browser boundary was given something that is not an origin (an http or https scheme, a host and a port, nothing more).',
    );
  }
  return parsed.origin;
}

/**
 * Whether a request the browser makes may go ahead: it is to exactly the stack's origin, or it names no server.
 * A URL that cannot be parsed is refused. A `blob:` URL carries the origin of the page that made it, so it is
 * judged on that.
 */
export function isAllowedRequest(url: string, origin: string): boolean {
  const stack = canonicalOrigin(origin);
  const parsed = parse(url);
  if (parsed === undefined) return false;
  if (WITHOUT_A_SERVER.has(parsed.protocol)) return true;
  return parsed.origin === stack;
}

/**
 * Whether a WebSocket may connect: `ws` stands for http and `wss` for https, and the host and port must be the
 * stack's exactly. Any other scheme is refused.
 */
export function isAllowedWebSocket(url: string, origin: string): boolean {
  const stack = canonicalOrigin(origin);
  const parsed = parse(url);
  if (parsed === undefined) return false;
  const scheme =
    parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : undefined;
  if (scheme === undefined) return false;
  return parse(`${scheme}//${parsed.host}`)?.origin === stack;
}
