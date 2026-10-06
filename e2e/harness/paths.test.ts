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

  // Break caught: a missing build whose message names another file, or all of them, so that the person who
  // reads it does not know which build to make. Each of the three is left out in turn: the message names that
  // file, with its whole path, and names neither of the two that exist.
  it.each([
    ['api', 'apiMain'],
    ['ops', 'opsIndex'],
    ['database', 'databaseTool'],
  ] as const)('names the %s build, and only it, when that one is missing', (which, key) => {
    const paths = repositoryPaths(root);
    for (const other of ['api', 'ops', 'database'] as const)
      if (other !== which) build(paths, other);
    const present = [paths.apiMain, paths.opsIndex, paths.databaseTool].filter(
      (file) => file !== paths[key],
    );

    let message = '';
    try {
      requireBuilds(paths);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(`  ${paths[key]}`);
    for (const file of present) expect(message).not.toContain(file);
    expect(message).toContain('pnpm run build');
  });
});
