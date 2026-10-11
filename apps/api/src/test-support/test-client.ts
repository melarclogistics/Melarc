/**
 * The kit's HTTP client (S0.10): a test's stand-in for a browser and for a native app, sending real requests to the real
 * application (or to a double, through `fetch`). It is test support and is excluded from the build.
 *
 * **As a browser** (the default) it keeps a cookie jar that follows the parts of RFC 6265 the specifications depend on:
 * name and path, `Max-Age` and `Expires` (judged by the clock it is given, so a test moves time and does not wait), `Secure`
 * (withheld from plain http except to the machine itself, as a browser does), and `HttpOnly` (kept and sent, but not readable by
 * the page). On an unsafe request it echoes the readable `melarc_csrf` cookie in `X-CSRF-Token` and sends `Origin`, as the
 * Ops Portal does (SECURITY_DESIGN.md section 13.8); a request can send a wrong token, none, or another origin, which are the
 * refusals a server has to be shown.
 *
 * **As a bearer client** (`bearer(token)`) it sends `Authorization: Bearer` and nothing a browser attaches: no cookie, no
 * token and no origin, and a cookie the server sets is not kept (a Rider request is not a browser's).
 *
 * It does not follow redirects, because the test is about the answer the server gave. It knows no operation of the contract.
 *
 * **What it does not model** (plan section 7.11): `SameSite` is read and not applied, so a request that names a foreign `Origin`
 * still carries the jar's cookies where a browser would withhold a `SameSite=Lax` cookie from a cross-site POST (a test of the
 * `Origin` check shows the check, not the path a browser takes); a `Secure` cookie set over plain http to a host that is not
 * loopback is stored, where a browser refuses it (it is still not sent); no `Sec-Fetch-*` header is sent; `Domain` is ignored
 * (every cookie is host-only).
 */

export const CSRF_COOKIE = 'melarc_csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string | undefined;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: string | undefined;
  readonly maxAge: number | undefined;
  readonly expires: Date | undefined;
}

export class TestResponse {
  readonly setCookies: readonly SetCookie[];

  constructor(
    readonly status: number,
    private readonly headers: Headers,
    readonly text: string,
  ) {
    this.setCookies = headers.getSetCookie().map(parseSetCookie);
  }

  header(name: string): string | null {
    return this.headers.get(name);
  }

  json(): unknown {
    return JSON.parse(this.text);
  }
}

function parseSetCookie(line: string): SetCookie {
  const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
  const equals = pair.indexOf('=');
  const name = equals < 0 ? '' : pair.slice(0, equals).trim();
  const value = equals < 0 ? pair : pair.slice(equals + 1).trim();
  let path: string | undefined;
  let secure = false;
  let httpOnly = false;
  let sameSite: string | undefined;
  let maxAge: number | undefined;
  let expires: Date | undefined;
  for (const attribute of attributes) {
    const split = attribute.indexOf('=');
    const key = (split < 0 ? attribute : attribute.slice(0, split)).trim().toLowerCase();
    const given = split < 0 ? '' : attribute.slice(split + 1).trim();
    if (key === 'path') path = given;
    else if (key === 'secure') secure = true;
    else if (key === 'httponly') httpOnly = true;
    else if (key === 'samesite') sameSite = given;
    else if (key === 'max-age' && /^-?\d+$/.test(given)) maxAge = Number(given);
    else if (key === 'expires') {
      const date = new Date(given);
      if (!Number.isNaN(date.getTime())) expires = date;
    }
  }
  return { name, value, path, secure, httpOnly, sameSite, maxAge, expires };
}

interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Milliseconds since the epoch, on the client's clock; absent for a session cookie. */
  readonly expiresAt: number | undefined;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** RFC 6265 section 5.1.4: the path a cookie gets when the server names none. */
function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/';
  const last = requestPath.lastIndexOf('/');
  return last <= 0 ? '/' : requestPath.slice(0, last);
}

/** RFC 6265 section 5.1.4: whether a cookie of `cookiePath` is sent for `requestPath`. */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

export interface TestClientOptions {
  /** Where the application listens: `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /** The origin an unsafe browser request names. Defaults to the origin of `baseUrl`. */
  readonly origin?: string;
  readonly fetch?: FetchLike;
  /** The clock cookie expiry is judged by. Defaults to the machine's. */
  readonly now?: () => Date;
  /** Makes this a bearer client. */
  readonly bearer?: string;
}

export interface RequestOptions {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** `'auto'` (default) echoes the token the jar holds; `'omit'` sends none; any other text is sent as the token. */
  readonly csrf?: 'auto' | 'omit' | (string & {});
  /** `undefined` sends the client's origin; `null` sends none; text sends that origin. Unsafe browser requests only. */
  readonly origin?: string | null;
}

export class TestClient {
  private readonly jar: StoredCookie[] = [];
  private readonly fetchLike: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly options: TestClientOptions) {
    this.fetchLike = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
  }

  /** A client for the same server with a jar of its own and no credential: another user, another browser. */
  fork(): TestClient {
    const { baseUrl, origin, fetch: fetchLike, now } = this.options;
    return new TestClient({
      baseUrl,
      ...(origin === undefined ? {} : { origin }),
      ...(fetchLike === undefined ? {} : { fetch: fetchLike }),
      ...(now === undefined ? {} : { now }),
    });
  }

  /** A native client for the same server, with the given bearer credential. */
  bearer(token: string): TestClient {
    return new TestClient({ ...this.options, bearer: token });
  }

  /** The value of a cookie in the jar (whether or not a page could read it), for assertions about what the server set. */
  cookie(name: string): string | undefined {
    this.expire();
    return this.jar.find((cookie) => cookie.name === name)?.value;
  }

  get(path: string, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request('GET', path, options);
  }

  post(path: string, body?: unknown, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request('POST', path, { ...options, body });
  }

  put(path: string, body?: unknown, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request('PUT', path, { ...options, body });
  }

  patch(path: string, body?: unknown, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request('PATCH', path, { ...options, body });
  }

  delete(path: string, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request('DELETE', path, options);
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<TestResponse> {
    const url = new URL(path, this.options.baseUrl);
    const verb = method.toUpperCase();
    const unsafe = !SAFE_METHODS.has(verb);
    const headers = new Headers(options.headers);

    if (this.options.bearer !== undefined) {
      headers.set('authorization', `Bearer ${this.options.bearer}`);
    } else {
      const sent = this.applicable(url);
      if (sent.length > 0) {
        headers.set('cookie', sent.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '));
      }
      if (unsafe) {
        const origin =
          options.origin === undefined ? (this.options.origin ?? url.origin) : options.origin;
        if (origin !== null) headers.set('origin', origin);
        const csrf = options.csrf ?? 'auto';
        if (csrf === 'auto') {
          // What a page can do: read the token from a cookie it is allowed to read, and echo it.
          const readable = sent.find((cookie) => cookie.name === CSRF_COOKIE && !cookie.httpOnly);
          if (readable !== undefined) headers.set(CSRF_HEADER, readable.value);
        } else if (csrf !== 'omit') {
          headers.set(CSRF_HEADER, csrf);
        }
      }
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }

    const response = await this.fetchLike(url, {
      method: verb,
      headers,
      redirect: 'manual',
      ...(body === undefined ? {} : { body }),
    });
    const result = new TestResponse(response.status, response.headers, await response.text());
    if (this.options.bearer === undefined) this.store(result.setCookies, url);
    return result;
  }

  private expire(): void {
    const now = this.now().getTime();
    for (let at = this.jar.length - 1; at >= 0; at -= 1) {
      const expiresAt = this.jar[at]?.expiresAt;
      if (expiresAt !== undefined && expiresAt <= now) this.jar.splice(at, 1);
    }
  }

  /** The cookies sent for `url`: longer paths first, then the order they were set (RFC 6265 section 5.4). */
  private applicable(url: URL): StoredCookie[] {
    this.expire();
    const secureTransport = url.protocol === 'https:' || LOOPBACK_HOSTS.has(url.hostname);
    return this.jar
      .map((cookie, order) => ({ cookie, order }))
      .filter(
        ({ cookie }) =>
          pathMatches(cookie.path, url.pathname) && (!cookie.secure || secureTransport),
      )
      .toSorted((a, b) => b.cookie.path.length - a.cookie.path.length || a.order - b.order)
      .map(({ cookie }) => cookie);
  }

  private store(cookies: readonly SetCookie[], url: URL): void {
    const now = this.now().getTime();
    for (const set of cookies) {
      if (set.name === '') continue;
      const path = set.path?.startsWith('/') === true ? set.path : defaultPath(url.pathname);
      const expiresAt =
        set.maxAge !== undefined
          ? now + set.maxAge * 1000
          : set.expires === undefined
            ? undefined
            : set.expires.getTime();
      const at = this.jar.findIndex((each) => each.name === set.name && each.path === path);
      if (at >= 0) this.jar.splice(at, 1);
      // A cookie that is already expired is a deletion.
      if (expiresAt !== undefined && expiresAt <= now) continue;
      this.jar.push({
        name: set.name,
        value: set.value,
        path,
        secure: set.secure,
        httpOnly: set.httpOnly,
        expiresAt,
      });
    }
  }
}
