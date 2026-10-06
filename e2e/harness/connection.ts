import type { ArtifactSource, StackDescription } from './artifacts.ts';
import { readNotes, type HarnessDatabase } from './database.ts';

/**
 * What a test worker needs to reach the stack that global setup started: addresses, the database credentials
 * and where the logs are. Workers are separate processes, so this is the part of the stack that travels, as
 * JSON in the environment.
 */
export interface StackConnection {
  readonly origin: string;
  readonly apiOrigin: string;
  readonly runDirectory: string;
  readonly captureFile: string;
  readonly database: HarnessDatabase;
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

export function artifactSourceOf(connection: StackConnection): ArtifactSource {
  return {
    info: describeConnection(connection),
    logFiles: connection.logFiles,
    captureFile: connection.captureFile,
    databaseSummary: async () => ({ notes: await readNotes(connection.database) }),
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
