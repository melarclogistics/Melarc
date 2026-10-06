/** Every business route lives under this prefix (`servers` in contracts/openapi.yaml). */
export const API_PREFIX = 'api/v1';

/**
 * Operational probes, deliberately outside the prefix: the edge proxies only `/api/...` to the API
 * runtime (DEPLOYMENT_AND_ENVIRONMENTS.md §12.1), so the edge's own routing does not expose them. That is
 * a routing rule, not isolation: anyone who can reach the runtime's listener directly can request them.
 * Keeping the runtime unreachable from browsers and the Internet is a network requirement
 * (DEPLOYMENT_AND_ENVIRONMENTS.md §12.5). They are not part of the product contract.
 */
export const TECHNICAL_ROUTE_PATHS = ['livez', 'readyz'] as const;
