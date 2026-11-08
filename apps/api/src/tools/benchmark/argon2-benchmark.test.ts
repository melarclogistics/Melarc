import { describe, expect, it } from 'vitest';

import { CliUsageError } from '../database/cli.js';
import type { Argon2idParameters } from '../../platform/auth/crypto/argon2-parameters.js';
import {
  DEFAULT_CANDIDATES,
  TARGET_MEDIAN_MS,
  environmentRecord,
  formatReport,
  measure,
  parseBenchmarkArguments,
  runBenchmark,
  selectCandidate,
  summarise,
  type CandidateResult,
} from './argon2-benchmark.js';

const result = (parameters: Argon2idParameters, medianMs: number): CandidateResult => ({
  parameters,
  runs: 5,
  minMs: medianMs - 1,
  medianMs,
  p95Ms: medianMs + 2,
  maxMs: medianMs + 3,
});

describe('summarise', () => {
  it('reports the minimum, median, 95th percentile and maximum of the runs', () => {
    const summary = summarise([30, 10, 50, 20, 40]);

    expect(summary).toEqual({ runs: 5, minMs: 10, medianMs: 30, p95Ms: 50, maxMs: 50 });
  });

  it('takes the mean of the middle pair for an even number of runs', () => {
    expect(summarise([10, 20, 30, 40]).medianMs).toBe(25);
  });

  it('uses the nearest-rank percentile: the 19th of 20 runs is the 95th percentile', () => {
    const runs = Array.from({ length: 20 }, (_, index) => index + 1);

    expect(summarise(runs).p95Ms).toBe(19);
    expect(summarise(runs).maxMs).toBe(20);
  });

  it('does not reorder what it was given', () => {
    const runs = [3, 1, 2];

    summarise(runs);

    expect(runs).toEqual([3, 1, 2]);
  });

  it('refuses to summarise nothing', () => {
    expect(() => summarise([])).toThrow(RangeError);
  });
});

describe('parseBenchmarkArguments', () => {
  it('measures the default grid, with nine measured runs, when given nothing', () => {
    const options = parseBenchmarkArguments([]);

    expect(options.candidates).toEqual(DEFAULT_CANDIDATES);
    expect(options.runs).toBe(9);
    expect(options.note).toBeUndefined();
  });

  it('measures one candidate when all three of its parameters are given', () => {
    const options = parseBenchmarkArguments([
      '--memory-kib',
      '19456',
      '--passes',
      '2',
      '--parallelism',
      '1',
    ]);

    expect(options.candidates).toEqual([{ memoryKiB: 19456, passes: 2, parallelism: 1 }]);
  });

  it('takes the number of runs and a note', () => {
    const options = parseBenchmarkArguments([
      '--runs',
      '20',
      '--note',
      'machine idle, no other work',
    ]);

    expect(options.runs).toBe(20);
    expect(options.note).toBe('machine idle, no other work');
  });

  it.each([
    ['an unknown option', ['--threads', '4']],
    ['a bare word', ['fast']],
    ['an option with no value', ['--runs']],
    ['one of the three cost options alone', ['--memory-kib', '19456']],
    ['two of the three cost options', ['--memory-kib', '19456', '--passes', '2']],
    ['a cost the limits refuse', ['--memory-kib', '65537', '--passes', '2', '--parallelism', '1']],
    ['text for a number', ['--runs', 'many']],
    ['a fraction', ['--runs', '2.5']],
    ['too few runs to take a median of', ['--runs', '2']],
    ['too many runs', ['--runs', '1000']],
    ['a note with a control character', ['--note', 'two\nlines']],
    ['a note that is too long', ['--note', 'x'.repeat(201)]],
    ['a repeated option', ['--runs', '5', '--runs', '6']],
  ])('refuses %s', (_label, argv) => {
    expect(() => parseBenchmarkArguments(argv)).toThrow(CliUsageError);
  });
});

describe('the default grid', () => {
  it('holds only costs the design allows, each once', () => {
    const keys = DEFAULT_CANDIDATES.map(
      (c) => `${String(c.memoryKiB)}/${String(c.passes)}/${String(c.parallelism)}`,
    );

    expect(new Set(keys).size).toBe(keys.length);
    expect(DEFAULT_CANDIDATES.length).toBeGreaterThanOrEqual(5);
  });

  it('contains the development-qualified cost that the application uses', async () => {
    const { DEVELOPMENT_QUALIFIED_ARGON2ID } =
      await import('../../platform/auth/crypto/argon2-parameters.js');

    expect(DEFAULT_CANDIDATES).toContainEqual(DEVELOPMENT_QUALIFIED_ARGON2ID);
  });
});

describe('selectCandidate (the rule that chose the development-qualified cost)', () => {
  it('states the target: a median of at least 100 ms', () => {
    expect(TARGET_MEDIAN_MS).toBe(100);
  });

  it('picks the lowest-memory single-lane candidate whose median reaches the target', () => {
    const grid = [
      result({ memoryKiB: 19456, passes: 2, parallelism: 1 }, 30),
      result({ memoryKiB: 131072, passes: 2, parallelism: 1 }, 226),
      result({ memoryKiB: 65536, passes: 2, parallelism: 1 }, 112),
      result({ memoryKiB: 32768, passes: 2, parallelism: 1 }, 53),
    ];

    expect(selectCandidate(grid)?.parameters).toEqual({
      memoryKiB: 65536,
      passes: 2,
      parallelism: 1,
    });
  });

  it('counts a median exactly at the target', () => {
    const grid = [result({ memoryKiB: 65536, passes: 2, parallelism: 1 }, 100)];

    expect(selectCandidate(grid)).toBeDefined();
  });

  // Break caught: a rule that prefers a faster-looking multi-lane cost, which spends several cores on one hash.
  it('never picks a candidate with more than one lane', () => {
    const grid = [
      result({ memoryKiB: 65536, passes: 3, parallelism: 4 }, 500),
      result({ memoryKiB: 32768, passes: 2, parallelism: 1 }, 40),
    ];

    expect(selectCandidate(grid)).toBeUndefined();
  });

  it('returns nothing when no candidate reaches the target', () => {
    expect(
      selectCandidate([result({ memoryKiB: 19456, passes: 2, parallelism: 1 }, 30)]),
    ).toBeUndefined();
    expect(selectCandidate([])).toBeUndefined();
  });
});

describe('measure', () => {
  it('runs one unmeasured warm-up and then the measured runs, one at a time, and times each', async () => {
    const order: string[] = [];
    let clock = 0;
    let running = 0;
    let overlapped = false;
    const derive = async (): Promise<Buffer> => {
      running += 1;
      overlapped ||= running > 1;
      order.push('derive');
      await Promise.resolve();
      running -= 1;
      clock += 10;
      return Buffer.alloc(32);
    };

    const durations = await measure({ memoryKiB: 64, passes: 1, parallelism: 1 }, 4, {
      derive,
      now: () => clock,
    });

    expect(order).toHaveLength(5);
    expect(durations).toHaveLength(4);
    expect(overlapped).toBe(false);
    expect(durations).toEqual([10, 10, 10, 10]);
  });

  it('hashes a synthetic input with a throwaway salt and pepper, and the cost it was asked to measure', async () => {
    const seen: {
      message: string;
      parameters: Argon2idParameters;
      saltLength: number;
      pepperLength: number;
    }[] = [];

    await measure({ memoryKiB: 64, passes: 1, parallelism: 1 }, 3, {
      derive: (input) => {
        seen.push({
          message: Buffer.from(input.message).toString('utf8'),
          parameters: input.parameters,
          saltLength: input.salt.length,
          pepperLength: input.pepper.length,
        });
        return Promise.resolve(Buffer.alloc(32));
      },
      now: () => 0,
    });

    expect(seen).toHaveLength(4);
    for (const call of seen) {
      expect(call.message).toBe('synthetic benchmark input, not a credential');
      expect(call.parameters).toEqual({ memoryKiB: 64, passes: 1, parallelism: 1 });
      expect(call.saltLength).toBe(16);
      expect(call.pepperLength).toBe(32);
    }
  });
});

describe('environmentRecord', () => {
  it('records the machine and the runtime, and nothing that identifies a person or a host', () => {
    const record = environmentRecord();

    expect(record.node).toBe(process.versions.node);
    expect(record.openssl).toBe(process.versions.openssl);
    expect(record.logicalCpus).toBeGreaterThan(0);
    expect(record.totalMemoryMiB).toBeGreaterThan(0);
    expect(record.cpuModel.length).toBeGreaterThan(0);
    expect(record.platform.length).toBeGreaterThan(0);
    expect(record.architecture.length).toBeGreaterThan(0);
    expect(record.postgresql).toMatch(/not involved/i);
    expect(typeof record.threadpoolSize).toBe('number');

    const text = JSON.stringify(record);
    expect(text).not.toContain(process.env.USERNAME ?? '\u0000unset');
    expect(text).not.toContain(process.env.COMPUTERNAME ?? '\u0000unset');
  });

  it('reports the libuv thread pool size the process runs with: the default of 4 unless the environment says otherwise', () => {
    const saved = process.env.UV_THREADPOOL_SIZE;
    try {
      delete process.env.UV_THREADPOOL_SIZE;
      expect(environmentRecord().threadpoolSize).toBe(4);
      process.env.UV_THREADPOOL_SIZE = '8';
      expect(environmentRecord().threadpoolSize).toBe(8);
    } finally {
      if (saved === undefined) delete process.env.UV_THREADPOOL_SIZE;
      else process.env.UV_THREADPOOL_SIZE = saved;
    }
  });
});

describe('runBenchmark and formatReport', () => {
  const fakeEnvironment = {
    platform: 'test',
    release: '1',
    architecture: 'x64',
    cpuModel: 'Test CPU',
    logicalCpus: 4,
    totalMemoryMiB: 8192,
    node: '24.21.0',
    openssl: '3.5.0',
    threadpoolSize: 4,
    postgresql: 'not involved: no database is used by this measurement',
  };

  it('measures every candidate and says which one the rule picks', async () => {
    const report = await runBenchmark(
      {
        candidates: [
          { memoryKiB: 64, passes: 1, parallelism: 1 },
          { memoryKiB: 128, passes: 1, parallelism: 1 },
        ],
        runs: 3,
        note: 'unit test',
      },
      {
        derive: () => Promise.resolve(Buffer.alloc(32)),
        // Every reading of this clock is 60 ms after the last, so each measured run lasts 60 ms: below the 100 ms target.
        now: (() => {
          let t = 0;
          return () => (t += 60);
        })(),
        environment: () => fakeEnvironment,
        measuredAt: () => '2026-10-09T12:00:00.000Z',
      },
    );

    expect(report.candidates).toHaveLength(2);
    expect(report.candidates.every((c) => c.runs === 3 && c.medianMs === 60)).toBe(true);
    expect(report.environment).toEqual(fakeEnvironment);
    expect(report.measuredAt).toBe('2026-10-09T12:00:00.000Z');
    expect(report.note).toBe('unit test');
    expect(report.targetMedianMs).toBe(100);
    expect(report.status).toBe('development-qualified, not production-qualified');
    // Said outright, not left out: no candidate reached the target, so none is selected.
    expect(report.selected).toBeNull();
  });

  it('selects the candidate the rule picks when one reaches the target', async () => {
    const report = await runBenchmark(
      { candidates: [{ memoryKiB: 64, passes: 1, parallelism: 1 }], runs: 3, note: undefined },
      {
        derive: () => Promise.resolve(Buffer.alloc(32)),
        now: (() => {
          let t = 0;
          return () => (t += 150);
        })(),
        environment: () => fakeEnvironment,
        measuredAt: () => '2026-10-09T12:00:00.000Z',
      },
    );

    expect(report.selected).toEqual({ memoryKiB: 64, passes: 1, parallelism: 1 });
  });

  it('prints the report as JSON, with no input, salt or pepper in it', async () => {
    const inputs: { message: Uint8Array; salt: Uint8Array; pepper: Uint8Array }[] = [];
    const report = await runBenchmark(
      { candidates: [{ memoryKiB: 64, passes: 1, parallelism: 1 }], runs: 3, note: undefined },
      {
        derive: (input) => {
          inputs.push({ message: input.message, salt: input.salt, pepper: input.pepper });
          return Promise.resolve(Buffer.alloc(32));
        },
        now: () => 0,
        environment: () => fakeEnvironment,
        measuredAt: () => '2026-10-09T12:00:00.000Z',
      },
    );

    const text = formatReport(report);

    expect(JSON.parse(text)).toMatchObject({
      status: 'development-qualified, not production-qualified',
    });
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('synthetic benchmark input');
    for (const { salt, pepper } of inputs) {
      expect(text).not.toContain(Buffer.from(salt).toString('hex'));
      expect(text).not.toContain(Buffer.from(salt).toString('base64'));
      expect(text).not.toContain(Buffer.from(pepper).toString('hex'));
      expect(text).not.toContain(Buffer.from(pepper).toString('base64'));
    }
  });
});
