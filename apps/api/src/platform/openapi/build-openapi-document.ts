import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

import { API_PREFIX } from '../http/routes.constants.js';

/**
 * The OpenAPI description of what the running application actually registers, built from its
 * controllers and decorators. It exists to be compared with contracts/openapi.yaml, which stays the
 * source of truth (SOLUTION_ARCHITECTURE.md §3): generation is a check, not an authoring tool, and this
 * output must never be copied over the contract or presented as proof by itself.
 *
 * Paths are relative to the documented server (`/api/v1`), as the contract's are. The technical probes
 * are excluded from it on purpose; the live route inventory is what accounts for them.
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
  return SwaggerModule.createDocument(app, options, { ignoreGlobalPrefix: true });
}
