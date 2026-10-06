import { describe, expect, it } from 'vitest';

import type { ConfigProblem } from './load-config.js';
import { reportConfigProblems } from './report-config-problems.js';

const PROBLEMS: ConfigProblem[] = [
  { key: 'HTTP_PORT', problem: 'missing', expected: 'an integer from 1 to 65535' },
  { key: 'APP_ENV', problem: 'invalid', expected: 'one of: local, staging, production' },
];

describe('reportConfigProblems', () => {
  // Break caught: a startup refusal nobody can act on, or one that is not a structured log line.
  it('writes one JSON log line that names every problem key and what was expected', () => {
    const output = reportConfigProblems(PROBLEMS, new Date('2026-10-04T12:00:00.000Z'));

    expect(output.endsWith('\n')).toBe(true);
    expect(output.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(output)).toEqual({
      level: 'fatal',
      time: '2026-10-04T12:00:00.000Z',
      service: 'melarc-api',
      msg: 'Invalid configuration: the API will not start',
      problems: PROBLEMS,
    });
  });
});
