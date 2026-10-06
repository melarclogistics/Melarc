import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectFailureArtifacts, type ArtifactSource } from './artifacts.ts';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'melarc-artifacts-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const PASSWORD = 'canary-password-5f2e';

function source(overrides: Partial<ArtifactSource> = {}): ArtifactSource {
  const logs = join(root, 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'api.stdout.log'), 'api said something\n');
  writeFileSync(join(logs, 'api.stderr.log'), 'api complained\n');
  writeFileSync(join(logs, 'ops.stdout.log'), 'ops said something\n');
  const capture = join(root, 'capture.jsonl');
  writeFileSync(
    capture,
    `${JSON.stringify({ at: '2026-10-05T09:00:00.000Z', kind: 'blocked-connection', host: 'sms.example', port: 25 })}\n`,
  );
  return {
    info: {
      origin: 'http://127.0.0.1:4173',
      apiOrigin: 'http://127.0.0.1:4000',
      database: 'melarc_test_0a1b2c3d',
      databaseUrls: {
        migration: `postgres://melarc_migration_elevated:${PASSWORD}@127.0.0.1:5432/melarc_test_0a1b2c3d`,
        runtime: `postgres://melarc_api_runtime:${PASSWORD}@127.0.0.1:5432/melarc_test_0a1b2c3d`,
      },
    },
    logFiles: [
      { name: 'api', stdout: join(logs, 'api.stdout.log'), stderr: join(logs, 'api.stderr.log') },
      { name: 'ops', stdout: join(logs, 'ops.stdout.log'), stderr: join(logs, 'ops.stderr.log') },
    ],
    captureFile: capture,
    databaseSummary: () => Promise.resolve({ notes: 2 }),
    ...overrides,
  };
}

const read = (directory: string, file: string) => readFileSync(join(directory, file), 'utf8');

describe('collectFailureArtifacts', () => {
  // Break caught: a failure that leaves nothing to read. A failed run is understood from the logs of every
  // process, what the sandbox refused, and what was in the database; each is written next to the report.
  it('writes the logs of every process, the sandbox capture and a database summary', async () => {
    const out = join(root, 'out');

    const written = await collectFailureArtifacts(out, source());

    expect(written.toSorted()).toEqual([
      'api.stderr.log',
      'api.stdout.log',
      'capture.json',
      'database.json',
      'ops.stdout.log',
      'stack.json',
    ]);
    expect(read(out, 'api.stdout.log')).toBe('api said something\n');
    expect(read(out, 'api.stderr.log')).toBe('api complained\n');
    expect(JSON.parse(read(out, 'capture.json'))).toEqual([
      { at: '2026-10-05T09:00:00.000Z', kind: 'blocked-connection', host: 'sms.example', port: 25 },
    ]);
    expect(JSON.parse(read(out, 'database.json'))).toEqual({ notes: 2 });
  });

  // Break caught: a credential written into an artifact. These files are attached to reports and kept by CI,
  // so the description of the stack hides every password.
  it('never writes a password', async () => {
    const out = join(root, 'out');

    await collectFailureArtifacts(out, source());

    for (const file of readdirSync(out)) expect(read(out, file)).not.toContain(PASSWORD);
    expect(JSON.parse(read(out, 'stack.json'))).toMatchObject({
      origin: 'http://127.0.0.1:4173',
      database: 'melarc_test_0a1b2c3d',
      databaseUrls: {
        runtime: 'postgres://melarc_api_runtime:***@127.0.0.1:5432/melarc_test_0a1b2c3d',
      },
    });
  });

  // Break caught: the collection of evidence being the thing that fails. A database that is already gone, or a
  // log that was never written, must not turn a failed test into a different, confusing failure.
  it('records that it could not read the database, and goes on', async () => {
    const out = join(root, 'out');

    const written = await collectFailureArtifacts(
      out,
      source({ databaseSummary: () => Promise.reject(new Error('connection refused')) }),
    );

    expect(written).toContain('database.json');
    expect(JSON.parse(read(out, 'database.json'))).toEqual({ unavailable: 'connection refused' });
  });

  it('skips a log that does not exist, and an empty capture is an empty list', async () => {
    const out = join(root, 'out');
    const bare = source();

    await collectFailureArtifacts(out, { ...bare, captureFile: join(root, 'nothing.jsonl') });

    expect(existsSync(join(out, 'ops.stderr.log'))).toBe(false);
    expect(JSON.parse(read(out, 'capture.json'))).toEqual([]);
  });

  // Break caught: artifacts from an earlier failure being overwritten or mixed with this one's, because the
  // directory is the test's own.
  it('creates the directory, and can be run twice into the same one', async () => {
    const out = join(root, 'deep', 'er', 'out');

    await collectFailureArtifacts(out, source());
    await collectFailureArtifacts(out, source());

    expect(readdirSync(out)).toHaveLength(6);
  });
});
