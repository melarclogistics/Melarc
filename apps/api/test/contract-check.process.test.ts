import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CHECK_CONTRACT, killAll, requireBuild, run } from './support/api-process.js';

beforeAll(requireBuild);

const scratch: string[] = [];

afterEach(async () => {
  await killAll();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('the contract conformance command, run as CI runs it', () => {
  // Break caught: the check failing, or not running, on the application as it is. The real application and
  // the real contract, in a real process: the build fails here when a route or its description drifts.
  it('passes for the application as it is, and says what it compared', async () => {
    const result = await run(CHECK_CONTRACT, {});

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no findings');
    expect(result.stdout).toMatch(/0 operations? in the implemented scope/);
  });

  // Break caught: a check that exits 0 whatever it finds, which would make it decoration. A scope that
  // claims an operation nothing serves must fail the process, name the operation and say where.
  it('fails, naming the operation, when the scope claims one that is not implemented', async () => {
    const result = await run(CHECK_CONTRACT, {}, ['--scope', 'getPickupRequest']);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('OPERATION_NOT_LIVE');
    expect(result.stdout).toContain('OPERATION_NOT_DESCRIBED');
    expect(result.stdout).toContain('getPickupRequest');
    expect(result.stdout).toContain('GET /pickup-requests/{id}');
  });

  it('fails for an operation id the contract does not have', async () => {
    const result = await run(CHECK_CONTRACT, {}, ['--scope', 'noSuchOperation']);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('SCOPE_OPERATION_UNKNOWN');
  });

  // Break caught: a tool that cannot run being read as a tool that found nothing wrong.
  it('exits 2, not 0 or 1, when it cannot run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'melarc-contract-check-'));
    scratch.push(directory);
    const broken = join(directory, 'broken.yaml');
    writeFileSync(broken, 'title: not a contract\n');

    const missing = await run(CHECK_CONTRACT, {}, ['--contract', join(directory, 'absent.yaml')]);
    const invalid = await run(CHECK_CONTRACT, {}, ['--contract', broken]);
    const unknownOption = await run(CHECK_CONTRACT, {}, ['--nope']);

    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('Cannot read the contract');
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('not an OpenAPI 3 document');
    expect(unknownOption.code).toBe(2);
    expect(unknownOption.stderr).toContain('Usage:');
  });
});
