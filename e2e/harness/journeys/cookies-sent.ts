/**
 * Which cookies a browser request carried, as the journeys judge it (S0.46). Playwright can report the request's own `Cookie` header, and
 * where it does, that header is what went on the wire and it decides. WebKit does not report it: in the hosted run of 8 November 2026 the
 * server answered a remembered sign-in with 200 and no second step, which it does only for a request that carried the trusted-browser
 * cookie, while `allHeaders()` showed no cookie at all. A check that read the header alone failed there for a reason that is not the
 * product's, and a check that a cookie was NOT sent would have passed there whatever was sent.
 *
 * Where the header is absent, the answer is the browser's own jar for the request's address: the cookies whose domain, path and `Secure`
 * apply to it, which is what the browser sends and is the same in every engine. A cookie that is not sent to a business operation, because
 * its path stops short of it, is not in that answer either, so the check has teeth in WebKit too.
 *
 * The types are the parts of Playwright's `Request` and `BrowserContext` that are used, so that the rule is tested without a browser.
 */
export interface SentRequest {
  allHeaders(): Promise<Record<string, string>>;
  url(): string;
}

export interface CookieJar {
  cookies(url: string): Promise<readonly { readonly name: string }[]>;
}

/** The names in a `Cookie` header (`a=1; b=2`): never the values, which are credentials. */
export function namesInCookieHeader(header: string): string[] {
  return header
    .split(';')
    .map((pair) => pair.trim().split('=')[0] ?? '')
    .filter((name) => name !== '');
}

/** The names of the cookies the request carried: the header where the engine reports it, otherwise the jar's answer for its address. */
export async function cookieNamesSent(jar: CookieJar, request: SentRequest): Promise<string[]> {
  const header = (await request.allHeaders()).cookie;
  if (header !== undefined && header !== '') return namesInCookieHeader(header);
  return (await jar.cookies(request.url())).map((cookie) => cookie.name);
}
