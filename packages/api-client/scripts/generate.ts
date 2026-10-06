import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  GENERATE_COMMAND,
  generateWireTypes,
  normalizeLineEndings,
} from './generate-wire-types.ts';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_CONTRACT = resolve(PACKAGE_ROOT, '../../contracts/openapi.yaml');
const DEFAULT_OUTPUT = resolve(PACKAGE_ROOT, 'src/generated/schema.ts');

const USAGE = `Usage: node scripts/generate.ts [--check] [--contract <file>] [--output <file>]

  (no flag)   generate the wire types and write them
  --check     write nothing; exit 1 when the output is missing or does not match the contract
  --contract  the OpenAPI contract (default: contracts/openapi.yaml)
  --output    the generated file (default: src/generated/schema.ts)

Exit codes: 0 done or current, 1 the output is missing or stale (--check), 2 the command could not run.
`;

/** The line on which two texts first differ, with both versions, so a failed check says where to look. */
function firstDifference(expected: string, actual: string): string {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const length = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < length; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      const shorten = (line: string | undefined) =>
        line === undefined
          ? '(end of file)'
          : line.length > 110
            ? `${line.slice(0, 110)}...`
            : line;
      return `first difference at line ${String(index + 1)}:\n  expected: ${shorten(expectedLines[index])}\n  found:    ${shorten(actualLines[index])}`;
    }
  }
  return 'the texts are identical';
}

function readTextIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function displayPath(path: string): string {
  return relative(process.cwd(), path) || path;
}

/** Runs the command and returns its exit code. Everything it says goes to the two streams, nothing else. */
export async function main(argv: readonly string[]): Promise<number> {
  let values: { check?: boolean; contract?: string; output?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        check: { type: 'boolean' },
        contract: { type: 'string' },
        output: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`api-client: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const contractPath = values.contract === undefined ? DEFAULT_CONTRACT : resolve(values.contract);
  const outputPath = values.output === undefined ? DEFAULT_OUTPUT : resolve(values.output);
  const contract = displayPath(contractPath);
  const output = displayPath(outputPath);

  const contractText = readTextIfPresent(contractPath);
  if (contractText === undefined) {
    process.stderr.write(`api-client: Cannot read the contract ${contract}: no such file.\n`);
    return 2;
  }

  let expected: string;
  try {
    expected = await generateWireTypes(contractText);
  } catch (error) {
    process.stderr.write(
      `api-client: generation failed for ${contract}: ${(error as Error).message}\n`,
    );
    return 2;
  }

  const existing = readTextIfPresent(outputPath);

  if (values.check === true) {
    if (existing === undefined) {
      process.stderr.write(`api-client: ${output} does not exist. Run: ${GENERATE_COMMAND}\n`);
      return 1;
    }
    // Line endings are compared as LF: a working copy may carry CRLF, and git normalizes it either way.
    const found = normalizeLineEndings(existing);
    if (found !== expected) {
      process.stderr.write(
        `api-client: ${output} is stale: it was not generated from the current ${contract}.\n` +
          `${firstDifference(expected, found)}\nRun: ${GENERATE_COMMAND}\n`,
      );
      return 1;
    }
    process.stdout.write(`api-client: ${output} is current with ${contract}.\n`);
    return 0;
  }

  if (existing === expected) {
    process.stdout.write(`api-client: ${output} is already current; nothing written.\n`);
    return 0;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, expected);
  process.stdout.write(
    `api-client: wrote ${output} (${String(Buffer.byteLength(expected))} bytes) from ${contract}.\n`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
