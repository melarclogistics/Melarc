import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface RepositoryPaths {
  readonly root: string;
  readonly apiMain: string;
  /** The test-only API entry point: the real application plus the harness's own routes. */
  readonly apiE2eEntry: string;
  /** The API command that makes and removes disposable databases. */
  readonly databaseTool: string;
  readonly opsRoot: string;
  readonly opsIndex: string;
  readonly viteBin: string;
  readonly outboundGuard: string;
  readonly testResults: string;
}

export function repositoryPaths(
  root: string = resolve(import.meta.dirname, '../..'),
): RepositoryPaths {
  const opsRoot = join(root, 'apps', 'ops-web');
  return {
    root,
    apiMain: join(root, 'apps', 'api', 'dist', 'main.js'),
    apiE2eEntry: join(root, 'apps', 'api', 'test', 'support', 'e2e-main.mjs'),
    databaseTool: join(root, 'apps', 'api', 'dist', 'tools', 'e2e-database.js'),
    opsRoot,
    opsIndex: join(opsRoot, 'dist', 'index.html'),
    viteBin: join(opsRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    outboundGuard: join(root, 'e2e', 'harness', 'outbound-guard.mjs'),
    testResults: join(root, 'e2e', 'test-results'),
  };
}

/**
 * The harness runs the built API and the built Ops bundle, as production does, and never a build of its own:
 * a stale or missing build is a failure here, before anything starts, and not a mystery in the middle of a run.
 */
export function requireBuilds(paths: RepositoryPaths): void {
  const missing = [paths.apiMain, paths.databaseTool, paths.opsIndex].filter(
    (file) => !existsSync(file),
  );
  if (missing.length > 0) {
    throw new Error(
      `The integrated harness needs the built applications. Build first: pnpm run build\nMissing:\n${missing
        .map((file) => `  ${file}`)
        .join('\n')}`,
    );
  }
}
