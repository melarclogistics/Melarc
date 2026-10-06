import 'reflect-metadata';

import { resolve } from 'node:path';

import { AppModule } from '../app.module.js';
import { createApp } from '../create-app.js';
import { writeGeneratedArtifacts } from '../platform/openapi/generate-artifacts.js';
import { assertRoutesAreSound } from '../platform/routes/route-inventory.js';
import { DESCRIBE_CONFIG } from './describe-config.js';

/**
 * Describes the application to itself: starts it without listening, derives its OpenAPI description
 * and route inventory, and writes them where the conformance checks (B0.6) can read them. It needs no
 * environment and must never need a live dependency, so it can run anywhere, including CI.
 *
 * Usage: node dist/tools/generate-openapi.js [output directory, default dist/generated]
 */
const outDir = resolve(process.argv[2] ?? 'dist/generated');
const app = await createApp({
  config: DESCRIBE_CONFIG,
  rootModule: (options) => AppModule.register(options),
});
try {
  await app.init();
  assertRoutesAreSound(app);
  await writeGeneratedArtifacts(app, outDir);
  process.stdout.write(
    `Wrote openapi.generated.json and route-inventory.generated.json to ${outDir}\n`,
  );
} finally {
  await app.close();
}
