import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The test configuration of this package (vitest.config.ts): which projects run one file at a time, and the variable it refuses because
 * Vitest would apply it to every project after the configuration (the review of 27 October 2026 found the gate and the affected run
 * setting it, so that the one-at-a-time projects ran four at a time).
 */
interface Project {
  readonly test: {
    readonly name: string;
    readonly include: readonly string[];
    readonly fileParallelism?: boolean;
    readonly maxWorkers?: number;
    readonly setupFiles?: readonly string[];
    readonly testTimeout?: number;
    readonly hookTimeout?: number;
    readonly sequence: { readonly groupOrder: number };
  };
}

const NAMES = ['VITEST_MAX_WORKERS', 'MELARC_TEST_WORKERS', 'MELARC_DB_WORKERS'] as const;

/** The configuration as a run would load it, with the given variables (an empty one is unset), read afresh each time. */
async function configuration(env: Partial<Record<(typeof NAMES)[number], string>>): Promise<{
  maxWorkers: number;
  testTimeout: number;
  hookTimeout: number;
  projects: Project[];
}> {
  for (const name of NAMES) vi.stubEnv(name, env[name] ?? '');
  vi.resetModules();
  const loaded = (await import('../vitest.config.js')) as {
    default: {
      test: { maxWorkers: number; testTimeout: number; hookTimeout: number; projects: Project[] };
    };
  };
  return loaded.default.test;
}

const project = (projects: readonly Project[], name: string): Project['test'] => {
  const found = projects.find((entry) => entry.test.name === name);
  if (found === undefined) throw new Error(`no project ${name}`);
  return found.test;
};

describe('the test configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Break caught: a project that must run one file at a time given parallelism, or the order that keeps the alone files after every other.
  it('runs the process and the alone database tests one file at a time, the alone ones last, each database file holding the server', async () => {
    const { maxWorkers, projects } = await configuration({});
    expect(maxWorkers).toBe(4);
    expect(project(projects, 'process').fileParallelism).toBe(false);
    const database = project(projects, 'database');
    const alone = project(projects, 'database-alone');
    expect([database.fileParallelism, database.maxWorkers]).toEqual([true, 3]);
    expect(alone.fileParallelism).toBe(false);
    expect(alone.sequence.groupOrder).toBeGreaterThan(database.sequence.groupOrder);
    expect(database.include).toEqual(['test/database/*.test.ts']);
    expect(alone.include).toEqual(['test/database/alone/*.test.ts']);
    expect(database.setupFiles).toContain('test/database/support/hold-shared.ts');
    expect(alone.setupFiles).toContain('test/database/support/hold-alone.ts');
  });

  it('takes its bounds from MELARC_TEST_WORKERS and MELARC_DB_WORKERS, and refuses a value that is not a count', async () => {
    const { maxWorkers, projects } = await configuration({
      MELARC_TEST_WORKERS: '2',
      MELARC_DB_WORKERS: '1',
    });
    expect(maxWorkers).toBe(2);
    expect([
      project(projects, 'database').fileParallelism,
      project(projects, 'database').maxWorkers,
    ]).toEqual([false, 1]);
    await expect(configuration({ MELARC_DB_WORKERS: 'many' })).rejects.toThrow(
      /MELARC_DB_WORKERS is "many"/,
    );
  });

  // Break caught (the owner's decision of 27 October 2026): the tests that start processes or use the database held to the unit tests'
  // limit, which the longer waits of test/support/api-process.ts do not fit; or the unit tests given the longer limit as well.
  it('gives a test that starts processes or uses the database 60 seconds, and a unit test 20', async () => {
    const { testTimeout, hookTimeout, projects } = await configuration({});
    expect([testTimeout, hookTimeout]).toEqual([20_000, 20_000]);
    const unit = project(projects, 'unit');
    expect([unit.testTimeout, unit.hookTimeout]).toEqual([undefined, undefined]);
    for (const name of ['process', 'database', 'database-alone']) {
      const own = project(projects, name);
      expect([own.testTimeout, own.hookTimeout], name).toEqual([60_000, 60_000]);
    }
  });

  // Break caught (review of 27 October 2026): VITEST_MAX_WORKERS accepted, which runs the one-at-a-time projects several at a time.
  it('refuses VITEST_MAX_WORKERS', async () => {
    await expect(configuration({ VITEST_MAX_WORKERS: '4' })).rejects.toThrow(
      /VITEST_MAX_WORKERS is set/,
    );
  });
});
