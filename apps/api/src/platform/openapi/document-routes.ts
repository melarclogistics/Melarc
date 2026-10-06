import type { OpenAPIObject } from '@nestjs/swagger';

import type { RouteEntry } from '../routes/route-inventory.js';

const OPERATION_KEYS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

const key = (route: RouteEntry) => `${route.method} ${route.path}`;
const byKey = (a: RouteEntry, b: RouteEntry) => key(a).localeCompare(key(b));

/**
 * The routes a generated description documents, written the way the route inventory writes them: the
 * documented server prefix restored and `{name}` written `:name`.
 */
export function listDocumentedRoutes(document: OpenAPIObject): RouteEntry[] {
  const serverPrefix = (document.servers?.[0]?.url ?? '').replace(/\/$/, '');
  return Object.entries(document.paths)
    .flatMap(([path, item]) =>
      OPERATION_KEYS.filter((operation) => item[operation] !== undefined).map((operation) => ({
        method: operation.toUpperCase(),
        path: `${serverPrefix}${path.replace(/\{([^}]+)\}/g, ':$1')}`,
      })),
    )
    .toSorted(byKey);
}

export interface RouteDiff {
  /** Registered, but absent from the description. Must be exactly the technical probes. */
  readonly liveButNotDocumented: readonly RouteEntry[];
  /** Described, but not registered. Always a defect. */
  readonly documentedButNotLive: readonly RouteEntry[];
}

export function diffRoutes(
  live: readonly RouteEntry[],
  documented: readonly RouteEntry[],
): RouteDiff {
  const liveKeys = new Set(live.map(key));
  const documentedKeys = new Set(documented.map(key));
  return {
    liveButNotDocumented: live.filter((route) => !documentedKeys.has(key(route))),
    documentedButNotLive: documented.filter((route) => !liveKeys.has(key(route))),
  };
}
