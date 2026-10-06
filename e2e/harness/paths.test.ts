import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requireBuilds, repositoryPaths } from './paths.ts';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'melarc-paths-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function build(paths: ReturnType<typeof repositoryPaths>, which: 'api' | 'ops' | 'database'): void {
  const file = { api: paths.apiMain, ops: paths.opsIndex, database: paths.databaseTool }[which];
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '');
}

describe('requireBuilds', () => {
  // Break caught: a run that starts against a missing or stale build and fails somewhere far from the cause.
  // The harness runs the built output, as production does, so a missing build stops it before anything starts.
  it('names every build that is missing, and the command that makes it', () => {
    const paths = repositoryPaths(root);

    expect(() => {
      requireBuilds(paths);
    }).toThrow(
      /pnpm run build[\s\S]*apps[\\/]api[\\/]dist[\\/]main\.js[\s\S]*apps[\\/]ops-web[\\/]dist[\\/]index\.html/,
    );
  });

  it('passes when the API, the database tool and Ops are all built', () => {
    const paths = repositoryPaths(root);
    for (const which of ['api', 'ops', 'database'] as const) build(paths, which);

    expect(() => {
      requireBuilds(paths);
    }).not.toThrow();
  });

  it('fails if only one of them is missing', () => {
    const paths = repositoryPaths(root);
    build(paths, 'api');
    build(paths, 'ops');

    expect(() => {
      requireBuilds(paths);
    }).toThrow(/e2e-database\.js/);
  });
});
