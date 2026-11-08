import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

import { API_PREFIX } from '../http/routes.constants.js';
import { applyOperationStatements } from './operation-statements.js';

/**
 * The OpenAPI description of what the running application actually registers, built from its
 * controllers and decorators. It exists to be compared with contracts/openapi.yaml, which stays the
 * source of truth (SOLUTION_ARCHITECTURE.md §3): generation is a check, not an authoring tool, and this
 * output must never be copied over the contract or presented as proof by itself.
 *
 * Paths are relative to the documented server (`/api/v1`), as the contract's are. The technical probes
 * are excluded from it on purpose; the live route inventory is what accounts for them.
 *
 * It carries the security scheme definitions, the default posture (a browser session with its CSRF token, or a rider session)
 * and what each operation states about its credentials, response cookies and servers (`operation-statements.ts`), so that the
 * conformance check compares them with the contract instead of reporting their absence as drift.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const options = new DocumentBuilder()
    .setTitle('Melarc Platform API (derived from the implementation)')
    .setDescription(
      'Generated from the running NestJS application so it can be compared with contracts/openapi.yaml. ' +
        'It is not the contract.',
    )
    .setVersion('implementation')
    // The contract is OpenAPI 3.1; a test pins this to the contract's declared version.
    .setOpenAPIVersion('3.1.0')
    .addServer(`/${API_PREFIX}`)
    .build();
  const document = SwaggerModule.createDocument(app, options, { ignoreGlobalPrefix: true });
  // What a decorated class cannot say: the schemes and the default posture, each operation's credentials, response cookies and servers.
  applyOperationStatements(document, app);
  return document;
}
