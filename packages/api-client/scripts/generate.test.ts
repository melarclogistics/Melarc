import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FIXTURE_CONTRACT } from './fixture-contract.ts';
import { GENERATE_COMMAND, normalizeLineEndings } from './generate-wire-types.ts';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(PACKAGE_ROOT, 'scripts/generate.ts');
const REAL_CONTRACT = resolve(PACKAGE_ROOT, '../../contracts/openapi.yaml');

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the command exactly as `pnpm run generate` and `pnpm run check` do: the script under Node itself. */
function runCli(...args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let workDirectory = '';
let counter = 0;

/** A path inside this run's private directory; nothing here is ever the real contract or output. */
function scratch(name: string): string {
  counter += 1;
  return join(workDirectory, `${String(counter)}-${name}`);
}

/** The real contract with one exact piece of text replaced. A mutation that changes nothing proves nothing. */
function mutated(original: string, from: string, to: string): string {
  expect(original, `the contract no longer contains the text this test edits: ${from}`).toContain(
    from,
  );
  return original.replace(from, to);
}

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'api-client-generate-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

describe('generate', () => {
  // Break caught: a generate that does not write the file, or writes something the check then rejects.
  it('writes the output from a contract, and the check then accepts it', async () => {
    const contract = scratch('contract.yaml');
    const output = scratch('schema.ts');
    await writeFile(contract, FIXTURE_CONTRACT);

    const generated = runCli('--contract', contract, '--output', output);
    const checked = runCli('--check', '--contract', contract, '--output', output);

    expect(generated.status).toBe(0);
    expect(await readFile(output, 'utf8')).toContain('export interface paths');
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain('current');
  });

  // Break caught: generation that is not repeatable, so that running it again changes the file.
  it('leaves the file untouched when it is run again on unchanged input', async () => {
    const contract = scratch('contract.yaml');
    const output = scratch('schema.ts');
    await writeFile(contract, FIXTURE_CONTRACT);
    runCli('--contract', contract, '--output', output);
    const first = await readFile(output, 'utf8');

    const second = runCli('--contract', contract, '--output', output);

    expect(second.status).toBe(0);
    expect(second.stdout).toContain('nothing written');
    expect(await readFile(output, 'utf8')).toBe(first);
  });

  // Break caught: a failed generation that truncates or replaces the previous good client with nothing.
  it('fails without touching the existing output when the contract is not valid', async () => {
    const contract = scratch('bad.yaml');
    const output = scratch('schema.ts');
    await writeFile(contract, 'title: not a contract\n');
    await writeFile(output, 'KEEP');

    const result = runCli('--contract', contract, '--output', output);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not an OpenAPI 3 document');
    expect(await readFile(output, 'utf8')).toBe('KEEP');
  });

  // Break caught: a contract path that does not exist being reported as a stale client, which would send
  // someone to regenerate when the real problem is the path.
  it('reports a missing contract as an error, not as a stale client', () => {
    const result = runCli('--contract', scratch('absent.yaml'), '--output', scratch('schema.ts'));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Cannot read the contract');
  });

  // Break caught: a mistyped flag being ignored, so that `--chek` quietly rewrites the output.
  it('rejects an unknown option and prints how to use the command', () => {
    const result = runCli('--chek');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });
});

describe('the freshness check', () => {
  // Break caught: a check that writes. It must be safe to run anywhere, including on a checkout where an
  // unexpected write would itself hide the staleness it exists to report.
  it('never writes: a missing output stays missing and a stale one stays as it was', async () => {
    const contract = scratch('contract.yaml');
    const missing = scratch('missing.ts');
    const stale = scratch('stale.ts');
    await writeFile(contract, FIXTURE_CONTRACT);
    await writeFile(stale, '// stale\n');

    const missingResult = runCli('--check', '--contract', contract, '--output', missing);
    const staleResult = runCli('--check', '--contract', contract, '--output', stale);

    expect(missingResult.status).toBe(1);
    expect(missingResult.stderr).toContain('does not exist');
    expect(existsSync(missing)).toBe(false);
    expect(staleResult.status).toBe(1);
    expect(await readFile(stale, 'utf8')).toBe('// stale\n');
  });

  // Break caught: a stale client with no instruction, leaving the person who sees the failure to guess.
  it('names the command that fixes a stale client', async () => {
    const contract = scratch('contract.yaml');
    const stale = scratch('stale.ts');
    await writeFile(contract, FIXTURE_CONTRACT);
    await writeFile(stale, '// stale\n');

    const result = runCli('--check', '--contract', contract, '--output', stale);

    expect(result.stderr).toContain('stale');
    expect(result.stderr).toContain(GENERATE_COMMAND);
  });

  // Break caught: the committed client drifting from the canonical contract. This is the check CI runs.
  it('accepts the committed client for the canonical contract', () => {
    const result = runCli('--check');

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('current');
  });

  // Break caught: the freshness verdict depending on the machine that wrote the contract's line endings.
  // The Windows working copy uses CRLF and a Linux checkout uses LF; both must be current.
  it.each([
    ['LF', (text: string) => text.replaceAll('\r\n', '\n')],
    ['CRLF', (text: string) => text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')],
  ])('accepts the canonical contract written with %s line endings', async (_label, convert) => {
    const copy = scratch('contract.yaml');
    await writeFile(copy, convert(readFileSync(REAL_CONTRACT, 'utf8')));

    const result = runCli('--check', '--contract', copy);

    expect(result.status).toBe(0);
  });

  // Break caught, one case per row: a deliberate edit to the canonical contract that the check lets pass.
  // The first changes a type. The second changes only the security a browser must satisfy, which produces
  // no type difference at all. The third changes nothing but a comment. All three must fail, because the
  // client is only known to be current when it was generated from exactly this contract.
  it.each([
    [
      'an enum value, which changes a generated type',
      (text: string) => mutated(text, 'enum: [GHS]', 'enum: [GHS, USD]'),
    ],
    [
      'the CSRF requirement of the default security, which changes no generated type',
      (text: string) =>
        mutated(
          text,
          '  - browserSession: []\n    csrfToken: []\n  - riderSession: []',
          '  - browserSession: []\n  - riderSession: []',
        ),
    ],
    ['a comment only', (text: string) => `# a comment and nothing else\n${text}`],
  ])('fails when the canonical contract is edited: %s', async (_label, edit) => {
    const copy = scratch('contract.yaml');
    await writeFile(copy, edit(normalizeLineEndings(readFileSync(REAL_CONTRACT, 'utf8'))));

    const result = runCli('--check', '--contract', copy);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stale');
    expect(result.stderr).toContain(GENERATE_COMMAND);
  });
});
