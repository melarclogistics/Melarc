import { test, type Page } from '@playwright/test';

/**
 * A strict policy used as a compatibility baseline: no inline script, no eval, nothing from another origin. It is the policy the edge of the
 * HTTPS run really sends (e2e/harness/https-front.ts, CONTENT_SECURITY_POLICY). A page that works under this one does not force the policy
 * to weaken script-src.
 *
 * style-src allows inline style, and only style-src does (Product Owner, 5 November 2026; architecture/SECURITY_DESIGN.md): the UI library
 * under the shadcn primitives (Radix) inserts <style> elements at run time, which `style-src 'self'` refuses. script-src is the protection
 * against injected code acting as the officer, and inline style cannot run code. The refusals are proved, in a browser, by test/browser/shell.spec.ts.
 */
export const STRICT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Whether a failure of the route handler is only the end of the test. A request still being answered when the test ends fails with
 * `route.fetch: Test ended.` (or a closed page or context), and Playwright then raises that failure after the test, where it fails the
 * next test of the worker. Once the page is gone there is nobody left to answer, so the handler lets it go; any other failure is thrown.
 */
function endedWithTheTest(page: Page, error: unknown): boolean {
  return (
    page.isClosed() ||
    (error instanceof Error && /Test ended|has been closed|Target closed/i.test(error.message))
  );
}

/**
 * Sends STRICT_POLICY with every response of the page and returns the violations the browser reports, which the caller
 * reads after the page has run.
 *
 * **The policy is proved against the production build**, so a test that enforces it is skipped in a `-dev-` project (the same spec file runs there
 * against the development server): that server puts an inline script in the page (the React refresh preamble), which `script-src 'self'` refuses by
 * design, and what the test would report is the server's and not the application's.
 */
export async function enforceStrictPolicy(page: Page): Promise<string[]> {
  test.skip(
    test.info().project.name.includes('-dev-'),
    'The strict policy is proved against the production build: the development server puts an inline script in the page.',
  );
  await page.route('**/*', async (route) => {
    try {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': STRICT_POLICY },
      });
    } catch (error) {
      if (endedWithTheTest(page, error)) return;
      throw error;
    }
  });
  const violations: string[] = [];
  await page.exposeFunction('reportViolation', (detail: string) => {
    violations.push(detail);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void (
        window as unknown as { reportViolation: (detail: string) => Promise<void> }
      ).reportViolation(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return violations;
}
