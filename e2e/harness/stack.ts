import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { apiEnvironment, runKeys } from './api-environment.ts';
import type { ArtifactSource, StackDescription } from './artifacts.ts';
import { artifactSourceOf, describeConnection, type StackConnection } from './connection.ts';
import { makeCustodyDirectory, removeDirectory } from './custody.ts';
import {
  bootstrapAdministrators,
  createDatabase,
  dropDatabase,
  type HarnessDatabase,
} from './database.ts';
import { failWithCleanup } from './cleanup.ts';
import { startHttpsFront } from './https-front.ts';
import { ManagedProcess } from './managed-process.ts';
import { makeCaptureDirectory } from './messages.ts';
import { repositoryPaths, requireBuilds } from './paths.ts';
import { ADMINISTRATOR_ARGUMENTS, ADMINISTRATORS, type Person } from './personas.ts';
import { freePort } from './ports.ts';
import type { TlsMaterial } from './tls-material.ts';
import { workerEnvironment } from './worker-environment.ts';

export interface StartStackOptions {
  /** Where logs and the sandbox capture go. Emptied first. Defaults to e2e/test-results/stack. */
  readonly runDirectory?: string;
  /** Extra API settings. The ones that make a run local and safe cannot be replaced (see apiEnvironment). */
  readonly apiEnvironment?: Readonly<Record<string, string>>;
  /**
   * The test certificates of the trusted HTTPS origin (S0.23), already judged by `checkTlsMaterial`. With them, a TLS front is
   * started in front of the Ops origin and the API is configured with its origin; without them the run is the plain HTTP one.
   */
  readonly tls?: Pick<TlsMaterial, 'leafPath' | 'leafKeyPath'>;
  /**
   * The stack of the journeys (S0.45): the two bootstrap administrators the real `bootstrap:seed` makes, with their one-time secrets in
   * custody bundles; the delivery worker, as a process of its own; and the folder its capture adapter writes the messages into. A stack
   * without it is the bare one the harness's own tests start (the API, Ops and an empty, seeded database).
   */
  readonly journeys?: boolean;
}

/** The real system under test: a database of its own, the API process, and the Ops build behind a same-origin proxy. */
export interface Stack {
  /** What a browser opens: the Ops origin. Its /api/v1 is proxied to the API, as the production edge does. */
  readonly origin: string;
  /** The trusted HTTPS origin in front of it, when the run was given test certificates. */
  readonly httpsOrigin?: string;
  /** The API's own address. Tests go through `origin`; this is for the checks that must not. */
  readonly apiOrigin: string;
  readonly database: HarnessDatabase;
  readonly captureFile: string;
  readonly runDirectory: string;
  readonly api: ManagedProcess;
  readonly ops: ManagedProcess;
  /** The delivery worker, in a stack of the journeys. */
  readonly worker?: ManagedProcess;
  /** Where the worker's capture adapter writes the messages (a stack of the journeys). Outside the checkout; removed with the run. */
  readonly captureDirectory?: string;
  /** Where the bootstrap commands leave the administrators' one-time secrets (a stack of the journeys). Outside the checkout; removed with the run. */
  readonly custodyDirectory?: string;
  /** The two bootstrap administrators (a stack of the journeys). */
  readonly administrators?: readonly Person[];
  /** The part of the stack a test worker needs, as data. */
  connection(): StackConnection;
  describe(): StackDescription;
  artifactSource(): ArtifactSource;
  /** Ends the processes, removes the folders, then drops the database. Always completes every step; safe to call twice. */
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
 * Nothing outside the machine is reachable from it: the API and the worker run under the outbound guard, the database is
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

  const journeys = options.journeys === true;
  const database = await createDatabase();
  const started: { readonly name: string; stop(): Promise<void> }[] = [];
  const folders: string[] = [];
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
    // The folders hold secrets in clear (the bundles, the links of the messages): they go as soon as nothing uses them.
    for (const folder of folders) {
      try {
        removeDirectory(folder);
      } catch (error) {
        failures.push(
          `a run folder: ${error instanceof Error ? error.message : 'could not be removed'}`,
        );
      }
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
    let captureDirectory: string | undefined;
    let custodyDirectory: string | undefined;
    if (journeys) {
      captureDirectory = makeCaptureDirectory();
      folders.push(captureDirectory);
      custodyDirectory = makeCustodyDirectory();
      folders.push(custodyDirectory);
      // The real seed of the two administrators, as an operator runs it: the pair, and a bundle for each with the one-time secret.
      await bootstrapAdministrators(database.name, custodyDirectory, ADMINISTRATOR_ARGUMENTS);
    }

    // The ports of the browser-facing origins are chosen first, so that the API can be started knowing the exact origin the browser
    // will send: the API judges the `Origin` of every browser mutation against it, and a real sign-in is one.
    const frontPort = options.tls === undefined ? undefined : await freePort();
    const httpsOrigin =
      frontPort === undefined ? undefined : `https://localhost:${String(frontPort)}`;
    const opsPort = await freePort();
    const origin = `http://127.0.0.1:${String(opsPort)}`;

    const keys = runKeys();
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
        keys,
        opsOrigin: httpsOrigin ?? origin,
        ...(options.apiEnvironment === undefined ? {} : { extra: options.apiEnvironment }),
      }),
      logDirectory,
      ready: { url: `${apiOrigin}/readyz`, timeoutMs: 30_000 },
    });
    started.push(api);

    let worker: ManagedProcess | undefined;
    if (journeys && captureDirectory !== undefined) {
      worker = await ManagedProcess.start({
        name: 'worker',
        command: process.execPath,
        args: ['--import', pathToFileURL(paths.outboundGuard).href, paths.workerMain],
        env: workerEnvironment({
          databaseWorkerUrl: database.workerUrl,
          captureDirectory,
          captureFile,
          keys,
        }),
        logDirectory,
        // The worker has no listener: it is ready when it says its lanes are running.
        ready: { log: /delivery worker started/, timeoutMs: 30_000 },
      });
      started.push(worker);
    }

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

    if (options.tls !== undefined && frontPort !== undefined) {
      const front = await startHttpsFront({ upstream: origin, tls: options.tls, port: frontPort });
      started.push({ name: 'https-front', stop: () => front.stop() });
      if (front.origin !== httpsOrigin) {
        throw new Error('The HTTPS front is not at the origin the API was configured with.');
      }
    }

    const connection = (): StackConnection => ({
      origin,
      ...(httpsOrigin === undefined ? {} : { httpsOrigin }),
      apiOrigin,
      runDirectory,
      captureFile,
      database,
      logFiles: [
        { name: 'api', ...api.logFiles() },
        ...(worker === undefined ? [] : [{ name: 'worker', ...worker.logFiles() }]),
        { name: 'ops', ...ops.logFiles() },
      ],
      ...(captureDirectory === undefined ? {} : { captureDirectory }),
      ...(custodyDirectory === undefined ? {} : { custodyDirectory }),
      ...(journeys ? { administrators: ADMINISTRATORS } : {}),
    });

    return {
      origin,
      ...(httpsOrigin === undefined ? {} : { httpsOrigin }),
      apiOrigin,
      database,
      captureFile,
      runDirectory,
      api,
      ops,
      ...(worker === undefined ? {} : { worker }),
      ...(captureDirectory === undefined ? {} : { captureDirectory }),
      ...(custodyDirectory === undefined ? {} : { custodyDirectory }),
      ...(journeys ? { administrators: ADMINISTRATORS } : {}),
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
