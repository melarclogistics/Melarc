import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { declaredTypeNames, moduleSpecifiers } from './support/wire-type-scan';

const APP_ROOT = resolve(import.meta.dirname, '..');
const CONTRACT = resolve(APP_ROOT, '../../contracts/openapi.yaml');

const PACKAGE = '@melarc/api-client';
const PUBLIC_ENTRY_POINTS: ReadonlySet<string> = new Set([PACKAGE, `${PACKAGE}/browser`]);
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'test-results',
  '.turbo',
]);

/** Every TypeScript source file of the application, including its tests and configuration. */
async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const schemaNames = new Set(
  Object.keys(
    (parse(readFileSync(CONTRACT, 'utf8')) as { components: { schemas: Record<string, unknown> } })
      .components.schemas,
  ),
);

const files = await sourceFiles(APP_ROOT);
const sources = files.map((path) => ({
  path: relative(APP_ROOT, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

describe('what Ops source is checked', () => {
  // Break caught: a scan over nothing, which would pass whatever the code contains.
  it('is the whole application, and the contract has schemas to collide with', () => {
    expect(schemaNames.size).toBeGreaterThan(100);
    expect(schemaNames.has('Money')).toBe(true);
    expect(sources.length).toBeGreaterThan(30);
    expect(sources.map((source) => source.path)).toEqual(
      expect.arrayContaining(['src/main.tsx', 'vite.config.ts', 'test/build.test.ts']),
    );
  });
});

describe('Ops and the contract', () => {
  // Break caught: a hand-written copy of a contract schema, which is the parallel DTO the plan forbids. It
  // would be correct on the day it is written and silently wrong after the next contract change. UI-only
  // models are allowed, under names that are not the contract's own.
  it('declares no type with the name of a schema in the contract', () => {
    const duplicates = sources.flatMap((source) =>
      declaredTypeNames(source.text, source.path)
        .filter((name) => schemaNames.has(name))
        .map((name) => `${source.path}: ${name}`),
    );

    expect(duplicates).toEqual([]);
  });

  // Break caught: reaching into the package for the generated file, or around the package altogether, so
  // that the entry points stop being the boundary between Ops and the transport.
  it('imports the API client package only through its public entry points', () => {
    const offending = sources.flatMap((source) =>
      moduleSpecifiers(source.text, source.path)
        .filter(
          (specifier) =>
            (specifier.startsWith(PACKAGE) && !PUBLIC_ENTRY_POINTS.has(specifier)) ||
            specifier.includes('packages/api-client') ||
            specifier.includes('generated/schema'),
        )
        .map((specifier) => `${source.path}: ${specifier}`),
    );

    expect(offending).toEqual([]);
  });

  // Break caught: the generated file becoming an entry point, which would let Ops import wire types without
  // going through the package's own index. Node and the bundler both resolve against the exports map.
  it('cannot reach the generated file, because the package does not export it', () => {
    const resolveFromOps = createRequire(import.meta.url).resolve;

    expect(() => resolveFromOps('@melarc/api-client/src/generated/schema.ts')).toThrow(
      expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }),
    );
    expect(resolveFromOps('@melarc/api-client/browser')).toContain('browser');
  });

  // Break caught: relying on the package being hoisted into place instead of declared. A missing dependency
  // works on one machine and fails on a clean install.
  it('declares the API client as a workspace dependency', () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };

    expect(manifest.dependencies[PACKAGE]).toBe('workspace:*');
  });

  // Break caught: an import "proof" that only tests satisfy. The application itself must use the package,
  // or the production build would not contain the transport it is supposed to ship.
  it('uses the browser transport in application code, not only in tests', () => {
    const users = sources
      .filter((source) => source.path.startsWith('src/') && !/\.test\.tsx?$/.test(source.path))
      .filter((source) => moduleSpecifiers(source.text, source.path).includes(`${PACKAGE}/browser`))
      .map((source) => source.path);

    expect(users).toEqual(['src/platform/api/api-client.tsx']);
  });
});
