import { CONTENT_SECURITY_POLICY, EDGE_HEADERS } from '../harness/https-front.ts';
import { expect, test } from '../harness/https-test.ts';

/**
 * The response headers of a browser surface over the trusted HTTPS origin (S0.23; security matrix `GBT-W8`, `GBT-W9`): the edge's
 * headers on the page and on an API response, and the API's own `Cache-Control: no-store`. They are read the way the browser sees
 * them, from the engine under test: the page's response, and an in-page `fetch`.
 */
test.describe('the headers of a browser surface over HTTPS', () => {
  // Break caught: a page served without the policy that forbids inline code and framing, without nosniff, or with a referrer policy
  // that leaks the address; in this engine, over the real TLS origin.
  test('serves the shell with the content security policy, nosniff, a restrictive referrer policy and HSTS (GBT-W9)', async ({
    page,
  }) => {
    const response = await page.goto('/');

    const headers = response?.headers() ?? {};
    for (const [name, value] of Object.entries(EDGE_HEADERS)) {
      expect(headers[name], name).toBe(value);
    }
    expect(headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  // Break caught: an API response the browser may keep: every response of the API is `no-store` (GBT-W8), the platform's rule and not
  // a per-operation detail, and it reaches the browser through the edge unchanged.
  test('serves an API response with Cache-Control: no-store, and with the edge headers (GBT-W8, GBT-W9)', async ({
    page,
  }) => {
    await page.goto('/');

    const seen = await page.evaluate(async () => {
      const response = await fetch('/api/v1/e2e/echo');
      return {
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        nosniff: response.headers.get('x-content-type-options'),
        policy: response.headers.get('content-security-policy'),
      };
    });

    expect(seen).toEqual({
      status: 200,
      cacheControl: 'no-store',
      nosniff: 'nosniff',
      policy: CONTENT_SECURITY_POLICY,
    });
  });
});
