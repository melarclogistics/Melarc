import type { ArtifactSource, StackDescription } from './artifacts.ts';
import { observe, type HarnessDatabase } from './database.ts';
import type { Person } from './personas.ts';

/**
 * What a test worker needs to reach the stack that global setup started: addresses, the database credentials
 * and where the logs are. Workers are separate processes, so this is the part of the stack that travels, as
 * JSON in the environment.
 */
export interface StackConnection {
  readonly origin: string;
  /**
   * The trusted HTTPS origin in front of `origin` (S0.23): present only when the run was given test certificates
   * (`MELARC_E2E_TLS_DIR`). The API's `OPS_ORIGIN` is this origin, exactly, so that its CSRF and CORS judgements are made against
   * the origin the browser really sends.
   */
  readonly httpsOrigin?: string;
  readonly apiOrigin: string;
  readonly runDirectory: string;
  readonly captureFile: string;
  readonly database: HarnessDatabase;
  /** Where the delivery worker's capture adapter writes the messages (a stack of the journeys). */
  readonly captureDirectory?: string;
  /** Where the bootstrap commands leave the administrators' one-time secrets (a stack of the journeys). */
  readonly custodyDirectory?: string;
  /** The two bootstrap administrators (a stack of the journeys). */
  readonly administrators?: readonly Person[];
  readonly logFiles: readonly {
    readonly name: string;
    readonly stdout: string;
    readonly stderr: string;
  }[];
}

export const STACK_ENVIRONMENT_KEY = 'MELARC_E2E_STACK';

export function describeConnection(connection: StackConnection): StackDescription {
  return {
    origin: connection.origin,
    apiOrigin: connection.apiOrigin,
    database: connection.database.name,
    databaseUrls: {
      migration: connection.database.migrationUrl,
      runtime: connection.database.runtimeUrl,
    },
  };
}

/**
 * What a person reading a failed run needs to know of the database, from the observations of the database command: for each
 * bootstrap administrator the state of their authenticators, sessions and grants, and the audit events that name them. Nothing in it is
 * a secret (the observations read no column that holds one), and the tables themselves are read by no login the harness holds.
 */
async function databaseSummaryOf(connection: StackConnection): Promise<unknown> {
  const summary: Record<string, unknown> = {};
  for (const person of connection.administrators ?? []) {
    summary[person.fullName] = {
      factors: await observe(connection.database.name, 'factors', person.workEmail),
      sessions: await observe(connection.database.name, 'sessions', person.workEmail),
      grants: await observe(connection.database.name, 'setup-grants', person.workEmail),
      lock: await observe(connection.database.name, 'lock', person.workEmail),
      audit: await observe(connection.database.name, 'audit-codes', person.workEmail),
    };
  }
  return summary;
}

export function artifactSourceOf(connection: StackConnection): ArtifactSource {
  return {
    info: describeConnection(connection),
    logFiles: connection.logFiles,
    captureFile: connection.captureFile,
    databaseSummary: () => databaseSummaryOf(connection),
  };
}

export function connectionFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StackConnection {
  const raw = env[STACK_ENVIRONMENT_KEY];
  if (raw === undefined || raw === '') {
    throw new Error(
      `${STACK_ENVIRONMENT_KEY} is not set: the stack is started by global setup, so run these tests with ` +
        '`pnpm run test:e2e`, not by pointing a test runner at a spec file directly.',
    );
  }
  return JSON.parse(raw) as StackConnection;
}
