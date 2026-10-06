import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';

import { inspectRoutes } from '../routes/route-inventory.js';
import { buildOpenApiDocument } from './build-openapi-document.js';

/**
 * Writes what the running application derives about itself, for comparison with the canonical
 * contract: its OpenAPI description, and the route inventory read from the live router and from the
 * controllers' decorators. Neither file is ever copied from contracts/.
 */
export async function writeGeneratedArtifacts(
  app: INestApplication,
  outDir: string,
): Promise<void> {
  await app.init();
  const { live, declared } = inspectRoutes(app);
  const document = buildOpenApiDocument(app);

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'openapi.generated.json'), `${JSON.stringify(document, null, 2)}\n`);
  await writeFile(
    join(outDir, 'route-inventory.generated.json'),
    `${JSON.stringify({ live, declared }, null, 2)}\n`,
  );
}
