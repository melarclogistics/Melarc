import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { apiEnvironment } from './api-environment.ts';
import type { ArtifactSource, StackDescription } from './artifacts.ts';
import { artifactSourceOf, describeConnection, type StackConnection } from './connection.ts';
import {
  createDatabase,
  dropDatabase,
  provisionHarnessSchema,
  type HarnessDatabase,
} from './database.ts';
import { failWithCleanup } from './cleanup.ts';
import { ManagedProcess } from './managed-process.ts';
import { repositoryPaths, requireBuilds } from './paths.ts';
import { freePort } from './ports.ts';

export interface StartStackOptions {
  /** Where logs and the sandbox capture go. Emptied first. Defaults to e2e/test-results/stack. */
  readonly runDirectory?: string;
  /** Extra API settings. The ones that make a run local and safe cannot be replaced (see apiEnvironment). */
  readonly apiEnvironment?: Readonly<Record<string, string>>;
}

/** The real system under test: a database of its own, the API process, and the Ops build behind a same-origin proxy. */
export interface Stack {
  /** What a browser opens: the Ops origin. Its /api/v1 is proxied to the API, as the production edge does. */
  readonly origin: string;
  /** The API's own address. Tests go through `origin`; this is for the checks that must not. */
  readonly apiOrigin: string;
  readonly database: HarnessDatabase;
  readonly captureFile: string;
  readonly runDirectory: string;
  readonly api: ManagedProcess;
  readonly ops: ManagedProcess;
  /** The part of the stack a test worker needs, as data. */
  connection(): StackConnection;
  describe(): StackDescription;
  artifactSource(): ArtifactSource;
  /** Ends the API and Ops, then drops the database. Always completes every step; safe to call twice. */
  stop(): Promise<void>;
}

/**
 * Starts the stack and returns it, or fails having left nothing behind: whatever was already started when a
 * step fails is stopped and the database is dropped before the error reaches the caller. If that cleanup
 * cannot be completed (a process that was never seen to end), the error says so.
 *
 * It removes only what it made. Another run's database is never touched, however idle it looks: leftovers of
 * a run that was killed are listed and removed by name with `db:orphans`.
 *
 * Nothing outside the machine is reachable from it: the API runs under the outbound guard, the database is
 * local, and the browser talks to one origin. It runs the built applications, never a build of its own.
 */
export async function startStack(options: StartStackOptions = {}): Promise<Stack> {
  const paths = repositoryPaths();
  requireBuilds(paths);

  const runDirectory = options.runDirectory ?? join(paths.testResults, 'stack');
  rmSync(runDirectory, { recursive: true, force: true });
  const logDirectory = join(runDirectory, 'logs');
  mkdirSync(logDirectory, { recursive: true });
  const captureFile = join(runDirectory, 'outbound-capture.jsonl');

  const database = await createDatabase();
  const started: ManagedProcess[] = [];
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const failures: string[] = [];
    // The API holds connections to the database, so it ends first; the database is dropped last.
    for (const process_ of [...started].reverse()) {
      await process_.stop().catch((error: unknown) => {
        failures.push(
          `${process_.name}: ${error instanceof Error ? error.message : 'could not be stopped'}`,
        );
      });
    }
    await dropDatabase(database.name).catch((error: unknown) => {
      failures.push(
        `database ${database.name}: ${error instanceof Error ? error.message : 'could not be dropped'}`,
      );
    });
    if (failures.length > 0)
      throw new Error(`The stack did not stop cleanly:\n${failures.join('\n')}`);
  };

  try {
    await provisionHarnessSchema(database);

    const apiPort = await freePort();
    const apiOrigin = `http://127.0.0.1:${String(apiPort)}`;
    const api = await ManagedProcess.start({
      name: 'api',
      command: process.execPath,
      // The guard is loaded into the API process itself, so it covers every connection that process makes.
      args: ['--import', pathToFileURL(paths.outboundGuard).href, paths.apiE2eEntry],
      env: apiEnvironment({
        port: apiPort,
        runtimeUrl: database.runtimeUrl,
        captureFile,
        ...(options.apiEnvironment === undefined ? {} : { extra: options.apiEnvironment }),
      }),
      logDirectory,
      ready: { url: `${apiOrigin}/readyz`, timeoutMs: 30_000 },
    });
    started.push(api);

    const opsPort = await freePort();
    const origin = `http://127.0.0.1:${String(opsPort)}`;
    const ops = await ManagedProcess.start({
      name: 'ops',
      command: process.execPath,
      args: [
        paths.viteBin,
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(opsPort),
        '--strictPort',
      ],
      cwd: paths.opsRoot,
      // Where the dev and preview servers forward /api/v1: the same-origin arrangement the edge provides.
      env: { NODE_ENV: 'production', OPS_API_PROXY_TARGET: apiOrigin },
      logDirectory,
      ready: { url: `${origin}/`, timeoutMs: 30_000 },
    });
    started.push(ops);

    const connection = (): StackConnection => ({
      origin,
      apiOrigin,
      runDirectory,
      captureFile,
      database,
      logFiles: [
        { name: 'api', ...api.logFiles() },
        { name: 'ops', ...ops.logFiles() },
      ],
    });

    return {
      origin,
      apiOrigin,
      database,
      captureFile,
      runDirectory,
      api,
      ops,
      connection,
      describe: () => describeConnection(connection()),
      artifactSource: () => artifactSourceOf(connection()),
      stop,
    };
  } catch (error) {
    // The failure that came first is what the caller needs. A cleanup that fails too is reported next to it,
    // because a process that could not be ended is what the next run trips over.
    return failWithCleanup(error, stop);
  }
}
