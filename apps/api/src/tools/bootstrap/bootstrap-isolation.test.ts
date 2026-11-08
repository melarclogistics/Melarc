import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * "No API operation or screen can invoke it" (MIGRATION_AND_SEEDING.md §3.2 and §3.3a; AC-SLICE-000-93; S0.30), shown as facts of the
 * repository and not as a promise: nothing the API process loads reaches the folder of the commands, no operation of the contract
 * is one of them, no screen of the Ops Portal names them, and the only way to start either is the script of the package that an
 * operator runs as the provisioning login. A reader of the test sees what would make it fail: an import of `tools/bootstrap` from
 * the application, an operation named for the seed or the resume, or a screen that calls them.
 */

const SRC = resolve(import.meta.dirname, '../..');
const REPOSITORY = resolve(SRC, '../../..');

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

const toSource = (path: string): string => relative(SRC, path).split(sep).join('/');

/** The relative modules a file imports or re-exports (`from './x.js'`), as source files that exist. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const specifier = (match[1] ?? '').replace(/\.js$/, '');
    for (const candidate of [`${specifier}.ts`, `${specifier}.tsx`, join(specifier, 'index.ts')]) {
      const path = resolve(dirname(file), candidate);
      if (existsSync(path)) {
        found.push(path);
        break;
      }
    }
  }
  return found;
}

/** Every source file the entry reaches through relative imports. */
function reachableFrom(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    queue.push(...importsOf(file));
  }
  return seen;
}

describe('the bootstrap commands are not reachable from the API (S0.30)', () => {
  const production = sourceFiles(SRC).filter(
    (file) => !/\.test\.tsx?$/.test(file) && !toSource(file).startsWith('test-support/'),
  );

  // Break caught: the application, a module, a controller or the platform importing the commands, which would make a request able
  // to run what is a provisioning-only mechanism.
  it('has no file outside the commands that imports the folder of the commands or their entry points', () => {
    const importers = production
      .filter((file) => {
        const source = toSource(file);
        return (
          !source.startsWith('tools/bootstrap/') &&
          !/^tools\/bootstrap-(seed|resume)\.ts$/.test(source)
        );
      })
      .filter((file) =>
        importsOf(file).some((imported) => {
          const target = toSource(imported);
          return (
            target.startsWith('tools/bootstrap/') ||
            /^tools\/bootstrap-(seed|resume)\.ts$/.test(target)
          );
        }),
      )
      .map(toSource);
    expect(importers).toEqual([]);
  });

  // Break caught: the same through a chain of imports (a module that imports a helper that imports the commands): the test follows
  // every relative import from the two files the API process starts from.
  it('reaches nothing under tools/ from the API process, through any chain of imports', () => {
    const reached = reachableFrom([join(SRC, 'main.ts'), join(SRC, 'app.module.ts')]);
    const tools = [...reached].map(toSource).filter((source) => source.startsWith('tools/'));
    expect(tools).toEqual([]);
    expect(reached.size).toBeGreaterThan(50);
  });

  // The worker derives its own local login the way the tooling does (tools/delivery, tools/database), so tools/ as a whole is not
  // out of its reach; the commands are.
  it('reaches none of the commands from the delivery worker process either', () => {
    const reached = reachableFrom([join(SRC, 'delivery-worker-main.ts')]);
    expect(
      [...reached]
        .map(toSource)
        .filter(
          (source) => source.startsWith('tools/bootstrap') || source.startsWith('tools/seed/'),
        ),
    ).toEqual([]);
    expect(reached.size).toBeGreaterThan(20);
  });

  it('opens the bootstrap capability only under tools/bootstrap/', () => {
    const openers = production
      .filter((file) => /taskCapability:\s*'bootstrap'/.test(readFileSync(file, 'utf8')))
      .map(toSource)
      .filter((source) => source !== 'platform/database/capability-access.ts');
    expect(openers.length).toBeGreaterThan(0);
    for (const opener of openers) expect(opener, opener).toMatch(/^tools\/bootstrap\//);
  });
});

describe('no operation of the contract and no screen is one of the commands (S0.30)', () => {
  // Break caught: an operation that would run the seed or the resume over the network, which is the one way the bypass of
  // maker-checker could become reachable by a caller.
  it('names no operation, path or tag for the seed, the resume or the setup of a bootstrap identity', () => {
    const contract = readFileSync(join(REPOSITORY, 'contracts/openapi.yaml'), 'utf8');
    const operations = [...contract.matchAll(/^\s+operationId:\s*(\S+)/gm)].map(
      (match) => match[1] ?? '',
    );
    expect(operations.length).toBeGreaterThan(50);
    expect(operations.filter((name) => /bootstrap|resume|seed/i.test(name))).toEqual([]);
    const paths = [...contract.matchAll(/^ {2}(\/\S*):\s*$/gm)].map((match) => match[1] ?? '');
    expect(paths.length).toBeGreaterThan(50);
    expect(paths.filter((path) => /bootstrap|resume|seed/i.test(path))).toEqual([]);
  });

  it('has no operation of the implemented scope that is one of the commands', () => {
    const scope = readFileSync(join(SRC, 'tools/contract/implemented-scope.ts'), 'utf8');
    expect(scope).not.toMatch(/bootstrap|resumeBootstrap|seedBootstrap/i);
  });

  it('is not named by any screen or client of the Ops Portal or the generated client', () => {
    for (const directory of ['apps/ops-web/src', 'packages/api-client/src']) {
      const root = join(REPOSITORY, directory);
      if (!existsSync(root)) continue;
      const mentions = sourceFiles(root).filter((file) =>
        /bootstrap:(seed|resume)|resume_bootstrap_identity|seed_bootstrap_administrators|tools\/bootstrap/.test(
          readFileSync(file, 'utf8'),
        ),
      );
      expect(
        mentions.map((file) => relative(REPOSITORY, file)),
        directory,
      ).toEqual([]);
    }
  });
});

describe('the one way to start them (S0.30)', () => {
  const manifest = JSON.parse(readFileSync(join(SRC, '../package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('is a script of the API package that runs a process, as the provisioning login does for the seed', () => {
    expect(manifest.scripts['bootstrap:seed']).toBe('node dist/tools/bootstrap-seed.js');
    expect(manifest.scripts['bootstrap:resume']).toBe('node dist/tools/bootstrap-resume.js');
    expect(existsSync(join(SRC, 'tools/bootstrap-seed.ts'))).toBe(true);
    expect(existsSync(join(SRC, 'tools/bootstrap-resume.ts'))).toBe(true);
  });

  it('has no script that starts the API or the worker with the commands, and none that the start scripts call', () => {
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (name.startsWith('bootstrap:')) continue;
      expect(command, name).not.toMatch(/bootstrap-(seed|resume)/);
    }
  });
});
