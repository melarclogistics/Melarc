import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { parse } from 'yaml';

import { AppModule } from '../app.module.js';
import { createApp } from '../create-app.js';
import { locateContract } from '../platform/contract/locate-contract.js';
import { assertRoutesAreSound } from '../platform/routes/route-inventory.js';
import { checkApplication } from './contract/check-application.js';
import { formatFinding } from './contract/findings.js';
import { IMPLEMENTED_OPERATIONS } from './contract/implemented-scope.js';
import { isJsonObject, type JsonObject } from '../platform/contract/json.js';
import { DESCRIBE_CONFIG } from './describe-config.js';

/**
 * Checks the application against contracts/openapi.yaml and fails when they disagree: every route that is
 * live must be in the contract and in the declared scope, every operation in the scope must be live and
 * described, and each described operation must say what the contract says (parameters, headers, bodies,
 * responses, cookies, security, extensions). It needs no environment and no database.
 *
 * usage: node dist/tools/check-contract.js [--contract <file>] [--scope <id,id,...>]
 *
 * Exit codes: 0 conforms, 1 findings, 2 the check could not run.
 */
const USAGE = `Usage: node dist/tools/check-contract.js [--contract <file>] [--scope <id,id,...>]

  --contract  the OpenAPI contract (default: contracts/openapi.yaml)
  --scope     operation ids to treat as implemented, instead of the declared scope. For trying a scope
              before it is true: it is how a missing route is shown to fail.

Exit codes: 0 conforms, 1 findings, 2 the check could not run.
`;

function readContract(path: string): JsonObject {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Cannot read the contract ${path}.`);
  }
  const document: unknown = parse(text);
  if (
    !isJsonObject(document) ||
    typeof document.openapi !== 'string' ||
    !document.openapi.startsWith('3.')
  ) {
    throw new Error(`${path} is not an OpenAPI 3 document: it has no "openapi: 3.x" field.`);
  }
  return document;
}

async function main(): Promise<number> {
  let values: { contract?: string; scope?: string };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: { contract: { type: 'string' }, scope: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  let contract: JsonObject;
  try {
    contract = readContract(
      values.contract === undefined
        ? locateContract(import.meta.dirname)
        : resolve(values.contract),
    );
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const scope =
    values.scope === undefined
      ? IMPLEMENTED_OPERATIONS
      : values.scope
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id !== '');

  const app = await createApp({
    config: DESCRIBE_CONFIG,
    rootModule: (options) => AppModule.register(options),
  });
  try {
    await app.init();
    assertRoutesAreSound(app);
    const report = await checkApplication(app, { contract, scope });

    const operations = `${String(report.checkedOperations.length)} operation${report.checkedOperations.length === 1 ? '' : 's'} in the implemented scope compared`;
    if (report.findings.length === 0) {
      process.stdout.write(`Contract conformance: ${operations}, no findings.\n`);
      return 0;
    }
    process.stdout.write(
      `Contract conformance: ${operations}, ${String(report.findings.length)} finding${report.findings.length === 1 ? '' : 's'}.\n\n` +
        `${report.findings.map(formatFinding).join('\n\n')}\n`,
    );
    return 1;
  } finally {
    await app.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`The contract check could not run: ${(error as Error).message}\n`);
  process.exitCode = 2;
}
