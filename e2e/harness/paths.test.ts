import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requireBuilds, repositoryPaths } from './paths.ts';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'melarc-paths-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Which = 'api' | 'ops' | 'database';

/** The files of each build: the API's entry point, the worker's and the two bootstrap commands are built together. */
const filesOf = (paths: ReturnType<typeof repositoryPaths>, which: Which): string[] =>
  ({
    api: [paths.apiMain, paths.workerMain, paths.bootstrapSeed, paths.bootstrapResume],
    ops: [paths.opsIndex],
    database: [paths.databaseTool],
  })[which];

function build(paths: ReturnType<typeof repositoryPaths>, which: Which): void {
  for (const file of filesOf(paths, which)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
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

  // Break caught (S0.45): a stack that starts the delivery worker or the bootstrap commands from a build that does not hold them, and
  // fails in the middle of a run. Each of them is a file of the API's build, and each is named when it is missing.
  it.each(['workerMain', 'bootstrapSeed', 'bootstrapResume'] as const)(
    'names %s when it alone is missing',
    (key) => {
      const paths = repositoryPaths(root);
      for (const which of ['api', 'ops', 'database'] as const) build(paths, which);
      rmSync(paths[key]);

      expect(() => {
        requireBuilds(paths);
      }).toThrow(paths[key]);
    },
  );

  // Break caught: a missing build whose message names another file, or all of them, so that the person who
  // reads it does not know which build to make. Each of the three is left out in turn: the message names the
  // files of that build, with their whole paths, and names none of the two that exist.
  it.each([
    ['api', 'apiMain'],
    ['ops', 'opsIndex'],
    ['database', 'databaseTool'],
  ] as const)('names the %s build, and only it, when that one is missing', (which, key) => {
    const paths = repositoryPaths(root);
    for (const other of ['api', 'ops', 'database'] as const)
      if (other !== which) build(paths, other);
    const present = (['api', 'ops', 'database'] as const)
      .filter((other) => other !== which)
      .flatMap((other) => filesOf(paths, other));

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
