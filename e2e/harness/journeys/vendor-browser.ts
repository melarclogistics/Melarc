import { VENDOR_ORIGIN } from '../api-environment.ts';

/**
 * A vendor's browser for the journeys of rows 10a and 11 (S0.52). **The Vendor PWA does not exist** (plan, Stage 6: the vendor operations are
 * built and verified at API level), so a vendor is this: a client of the run's API that sends what the Vendor PWA's pages would send (its
 * `Origin`, its cookies, the synchronizer token of its session) and keeps the cookies the API sets, as a browser's jar would. It reaches the
 * real API of the run and nothing else, and it reads only what a vendor is given: the answers, the cookies and a captured message.
 *
 * The jar ignores `Secure` (the run is plain HTTP on a loopback address, a diagnostic as the staff journeys' plain run is) and honours
 * `Max-Age=0` as a removal. The values are never printed: a failed assertion names a cookie, never its value.
 */
export interface VendorAnswer {
  readonly status: number;
  readonly body: unknown;
  /** The names of the cookies the answer set, in order. */
  readonly setCookies: readonly string[];
}

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class VendorBrowser {
  readonly #api: string;
  readonly #jar = new Map<string, string>();

  constructor(apiOrigin: string) {
    this.#api = apiOrigin;
  }

  /** Whether the jar holds a cookie of that name. */
  holds(name: string): boolean {
    return this.#jar.has(name);
  }

  /** A browser holding the same cookies as this one: the same person's other tab, or a copy kept to try later. */
  copy(): VendorBrowser {
    const twin = new VendorBrowser(this.#api);
    for (const [name, value] of this.#jar) twin.#jar.set(name, value);
    return twin;
  }

  async send(method: string, path: string, body?: unknown): Promise<VendorAnswer> {
    const headers: Record<string, string> = { origin: VENDOR_ORIGIN, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.#jar.size > 0) {
      headers.cookie = [...this.#jar].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const csrf = this.#jar.get('melarc_csrf');
    if (MUTATIONS.has(method) && csrf !== undefined) headers['x-csrf-token'] = csrf;
    const response = await fetch(`${this.#api}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });
    const setCookies: string[] = [];
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';');
      const at = pair.indexOf('=');
      if (at < 1) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      setCookies.push(name);
      const expired = attributes.some((attribute) => /^\s*max-age\s*=\s*0\s*$/i.test(attribute));
      if (expired) this.#jar.delete(name);
      else this.#jar.set(name, value);
    }
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed, setCookies };
  }

  /** `vendorSignIn` with the account identifier and the shared secret, from this browser. */
  signIn(accountIdentifier: string, secret: string): Promise<VendorAnswer> {
    return this.send('POST', '/api/v1/auth/vendor/sign-in', {
      account_identifier: accountIdentifier,
      secret,
    });
  }

  /** `getCurrentSession`: whether this browser holds a live session. */
  session(): Promise<VendorAnswer> {
    return this.send('GET', '/api/v1/auth/session');
  }
}
