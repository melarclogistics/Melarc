import type { ProxyOptions } from 'vite';

/** The API base the browser uses: relative, on the browser's own origin (DEPLOYMENT_AND_ENVIRONMENTS.md §12.1). */
export const API_BASE_PATH = '/api/v1';

/** Where the API listens in local development (apps/api/.env.example). */
export const DEFAULT_API_TARGET = 'http://127.0.0.1:3000';

/**
 * Forwards /api/v1 to the API so the browser only ever talks to its own origin, as it does behind the
 * edge in production. Only that exact prefix is forwarded: /api/v10 and the API's technical probes
 * (/livez, /readyz) stay unreachable from the browser origin.
 *
 * `changeOrigin` stays false so the API receives the browser's host, not its own, exactly as it will
 * behind the edge. Host-only cookies and exact Origin checks depend on that.
 */
export function createApiProxy(target: string): Record<string, ProxyOptions> {
  return {
    [`^${API_BASE_PATH}(/|\\?|$)`]: { target, changeOrigin: false },
  };
}
