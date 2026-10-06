import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';

import { listBoundOperations } from '../../platform/contract/contract-operation.js';
import { TECHNICAL_ROUTE_PATHS } from '../../platform/http/routes.constants.js';
import { buildOpenApiDocument } from '../../platform/openapi/build-openapi-document.js';
import { listLiveRoutes, type RouteEntry } from '../../platform/routes/route-inventory.js';
import { checkConformance, type ConformanceReport } from './check-conformance.js';
import type { JsonObject } from '../../platform/contract/json.js';

/** The routes the application answers that are not part of the product contract: the two probes. */
export const TECHNICAL_ROUTES: readonly RouteEntry[] = TECHNICAL_ROUTE_PATHS.map((path) => ({
  method: 'GET',
  path: `/${path}`,
}));

/**
 * Checks a running application against the contract. The description is derived from the application's own
 * controllers and the live routes are read from its HTTP router, two independent accounts of what exists,
 * so neither can vouch for the other. Nothing here reads the contract's own text into either of them.
 */
export async function checkApplication(
  app: INestApplication,
  options: { readonly contract: JsonObject; readonly scope: readonly string[] },
): Promise<ConformanceReport> {
  await app.init();
  return checkConformance({
    contract: options.contract,
    // Through JSON, as it would be when written to a file: the check sees plain data and nothing else.
    generated: JSON.parse(JSON.stringify(buildOpenApiDocument(app))) as JsonObject,
    live: listLiveRoutes(app),
    scope: options.scope,
    technicalRoutes: TECHNICAL_ROUTES,
    bound: listBoundOperations(app.get(ModulesContainer, { strict: false })),
  });
}
