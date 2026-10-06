import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { readCaptured } from './capture.ts';
import { redactUrl } from './database.ts';

/** What a person needs to know about the stack that a test ran against. Passwords are hidden when it is written. */
export interface StackDescription {
  readonly origin: string;
  readonly apiOrigin: string;
  readonly database: string;
  readonly databaseUrls: { readonly migration: string; readonly runtime: string };
}

export interface ArtifactSource {
  readonly info: StackDescription;
  readonly logFiles: readonly {
    readonly name: string;
    readonly stdout: string;
    readonly stderr: string;
  }[];
  readonly captureFile: string;
  /** What is in the database, however the caller knows how to read it. It may fail, and failing is recorded. */
  readonly databaseSummary: () => Promise<unknown>;
}

/**
 * Writes what is needed to understand a failed run: the logs of every process, what the sandbox refused, what
 * was in the database, and a description of the stack with its passwords hidden. Collecting evidence must
 * never be what fails, so a part that cannot be read is skipped or noted. Returns the names written.
 */
export async function collectFailureArtifacts(
  directory: string,
  source: ArtifactSource,
): Promise<string[]> {
  mkdirSync(directory, { recursive: true });
  const written: string[] = [];
  const write = (name: string, content: string) => {
    writeFileSync(join(directory, name), content);
    written.push(name);
  };

  for (const log of source.logFiles) {
    for (const file of [log.stdout, log.stderr]) {
      if (!existsSync(file)) continue;
      const name = basename(file);
      copyFileSync(file, join(directory, name));
      written.push(name);
    }
  }

  write('capture.json', `${JSON.stringify(readCaptured(source.captureFile), null, 2)}\n`);

  let summary: unknown;
  try {
    summary = await source.databaseSummary();
  } catch (error) {
    summary = { unavailable: error instanceof Error ? error.message : 'unknown error' };
  }
  write('database.json', `${JSON.stringify(summary, null, 2)}\n`);

  const { info } = source;
  write(
    'stack.json',
    `${JSON.stringify(
      {
        origin: info.origin,
        apiOrigin: info.apiOrigin,
        database: info.database,
        databaseUrls: {
          migration: redactUrl(info.databaseUrls.migration),
          runtime: redactUrl(info.databaseUrls.runtime),
        },
      },
      null,
      2,
    )}\n`,
  );
  return written;
}
