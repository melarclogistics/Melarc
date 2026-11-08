import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  citationsIn,
  citationsOfFile,
  conditionalOnly,
  findCitationProblems,
  readCriteria,
  readInventory,
  registeredJourneyModules,
  type Citation,
} from './slice-000-citations.ts';

const root = resolve(import.meta.dirname, '..');
const cited = (text: string): string[] => [
  ...new Set(citationsIn(text).map((found) => found.criterion)),
];
const standings = (text: string): Record<string, string> =>
  Object.fromEntries(
    citationsOfFile('fixture.test.ts', text).map((citation) => [
      citation.criterion,
      citation.condition === undefined
        ? citation.standing
        : `${citation.standing} ${citation.condition}`,
    ]),
  );

describe('what a citation is', () => {
  it('reads a full identifier, and pads it as the criteria are written', () => {
    assert.deepEqual(cited("it('signs in (AC-SLICE-000-04)', () => {})"), ['AC-SLICE-000-04']);
    assert.deepEqual(cited('// AC-SLICE-000-130: one order'), ['AC-SLICE-000-130']);
  });

  it('reads the abbreviated identifiers that continue it, with commas, "and", and backticks', () => {
    assert.deepEqual(cited('(AC-SLICE-000-92, -94 and -126)'), [
      'AC-SLICE-000-92',
      'AC-SLICE-000-94',
      'AC-SLICE-000-126',
    ]);
    assert.deepEqual(cited('`AC-SLICE-000-17`, `-22`, `-104`'), [
      'AC-SLICE-000-17',
      'AC-SLICE-000-22',
      'AC-SLICE-000-104',
    ]);
    assert.deepEqual(cited('AC-SLICE-000-74, -108 and -112'), [
      'AC-SLICE-000-74',
      'AC-SLICE-000-108',
      'AC-SLICE-000-112',
    ]);
  });

  // Break caught: a range that credits every criterion between its ends, so that a comment naming two of them is evidence of the rest.
  it('reads a range as its two ends only, and across a comment’s line break', () => {
    assert.deepEqual(cited('(AC-SLICE-000-61 to -63, -72)'), [
      'AC-SLICE-000-61',
      'AC-SLICE-000-63',
      'AC-SLICE-000-72',
    ]);
    assert.deepEqual(cited(' * (`AC-SLICE-000-08`, `-47` to\n * `-49`)'), [
      'AC-SLICE-000-08',
      'AC-SLICE-000-47',
      'AC-SLICE-000-49',
    ]);
  });

  it('does not read a longer number, another slice, or a number that does not continue the list', () => {
    assert.deepEqual(cited('AC-SLICE-000-1234 AC-SLICE-001-80 AC-SLICE-000-12 -13'), [
      'AC-SLICE-000-12',
    ]);
  });
});

describe('how a citation’s test runs', () => {
  it('runs plainly in a test, a suite or a file header', () => {
    const text = `/** The file (AC-SLICE-000-01). */\ndescribe('a (AC-SLICE-000-02)', () => {\n  // Break caught (AC-SLICE-000-03).\n  it('b', () => {});\n});\n`;
    assert.deepEqual(standings(text), {
      'AC-SLICE-000-01': 'RUNS',
      'AC-SLICE-000-02': 'RUNS',
      'AC-SLICE-000-03': 'RUNS',
    });
  });

  // Break caught: a criterion kept "cited" by a test that never runs, which is what "no hidden skip" forbids.
  it('is skipped in a skipped test or suite, the comment block directly above it included', () => {
    const text = [
      '// Break caught (AC-SLICE-000-01).',
      "it.skip('a', () => {});",
      '',
      "describe.skip('b (AC-SLICE-000-02)', () => { it('c (AC-SLICE-000-03)', () => {}); });",
      "xit('d (AC-SLICE-000-04)', () => {});",
      "test.skip('e (AC-SLICE-000-05)', async () => {});",
      "it.todo('f (AC-SLICE-000-06)');",
      '',
    ].join('\n');
    assert.deepEqual(standings(text), {
      'AC-SLICE-000-01': 'SKIPPED',
      'AC-SLICE-000-02': 'SKIPPED',
      'AC-SLICE-000-03': 'SKIPPED',
      'AC-SLICE-000-04': 'SKIPPED',
      'AC-SLICE-000-05': 'SKIPPED',
      'AC-SLICE-000-06': 'SKIPPED',
    });
  });

  it('keeps a comment separated by a blank line out of the test below it, and gives it to the file', () => {
    const text = "// The file (AC-SLICE-000-01).\n\nit.skip('a', () => {});\nit('b', () => {});\n";
    assert.deepEqual(standings(text), { 'AC-SLICE-000-01': 'RUNS' });
  });

  // Break caught: a file header that cites a criterion over tests that never run, which read as a guarantee.
  it('runs a file’s header as the best of the file’s tests runs: skipped over skipped tests, conditional over conditional ones', () => {
    const header = '// The file (AC-SLICE-000-01).\n\n';
    assert.deepEqual(standings(`${header}it.skip('a', () => {});\n`), {
      'AC-SLICE-000-01': 'SKIPPED',
    });
    assert.deepEqual(standings(`${header}describe.skip('a', () => { it('b', () => {}); });\n`), {
      'AC-SLICE-000-01': 'SKIPPED',
    });
    assert.deepEqual(standings(`${header}it.todo('a');\n`), { 'AC-SLICE-000-01': 'SKIPPED' });
    assert.deepEqual(
      standings(`${header}describe.skipIf(!ON)('a', () => { it('b', () => {}); });\n`),
      {
        'AC-SLICE-000-01': 'CONDITIONAL !ON',
      },
    );
    assert.deepEqual(
      standings(`${header}it.skip('a', () => {});\nit.skipIf(x)('b', () => {});\n`),
      { 'AC-SLICE-000-01': 'CONDITIONAL x' },
    );
    assert.deepEqual(standings(`${header}it.skipIf(x)('a', () => {});\nit('b', () => {});\n`), {
      'AC-SLICE-000-01': 'RUNS',
    });
    assert.deepEqual(standings(`${header}it.each([1])('a %i', () => {});\n`), {
      'AC-SLICE-000-01': 'RUNS',
    });
  });

  // Break caught: a header over a file with no test at all (a helper, a fixture), which proves nothing.
  it('skips a file’s header where the file has no test', () => {
    assert.deepEqual(standings('// The file (AC-SLICE-000-01).\n\nexport const a = 1;\n'), {
      'AC-SLICE-000-01': 'SKIPPED',
    });
    assert.deepEqual(standings("// (AC-SLICE-000-01).\n\ntest.step('a', () => {});\n"), {
      'AC-SLICE-000-01': 'SKIPPED',
    });
  });

  // Break caught: a journey module that no spec registers, which runs nothing and still cited its criteria.
  it('runs a journey module only when a spec registers it', () => {
    const text = '// (AC-SLICE-000-01)\nexport const journey = async () => {};\n';
    const runs = citationsOfFile('e2e/harness/journeys/a.ts', text, { journeyRuns: true });
    const idle = citationsOfFile('e2e/harness/journeys/a.ts', text, { journeyRuns: false });
    assert.deepEqual(
      runs.map((one) => one.standing),
      ['RUNS'],
    );
    assert.deepEqual(
      idle.map((one) => one.standing),
      ['SKIPPED'],
    );
  });

  it('is conditional where a test or suite runs only somewhere, and names the condition', () => {
    const text = [
      "it.skipIf(process.platform === 'win32')('a (AC-SLICE-000-01)', () => {});",
      "describe.runIf(linux)('b', () => { it('c (AC-SLICE-000-02)', () => {}); });",
      "test('d (AC-SLICE-000-03)', async ({ browserName }) => {",
      "  test.skip(browserName === 'webkit', 'WebKit cannot');",
      '});',
      "test('e (AC-SLICE-000-04)', async () => {});",
      '',
    ].join('\n');
    assert.deepEqual(standings(text), {
      'AC-SLICE-000-01': "CONDITIONAL process.platform === 'win32'",
      'AC-SLICE-000-02': 'CONDITIONAL linux',
      'AC-SLICE-000-03': "CONDITIONAL browserName === 'webkit'",
      'AC-SLICE-000-04': 'RUNS',
    });
  });

  // Break caught: a condition that is a literal and never changes read as "runs somewhere", which keeps a test that never runs in the count.
  it('is skipped where the condition is a literal that decides the same way every time', () => {
    const text = [
      "it.skipIf(true)('a (AC-SLICE-000-01)', () => {});",
      "it.runIf(false)('b (AC-SLICE-000-02)', () => {});",
      "it.skipIf(false)('c (AC-SLICE-000-03)', () => {});",
      "test('d (AC-SLICE-000-04)', async () => { test.skip(true, 'never'); });",
      '',
    ].join('\n');
    assert.deepEqual(standings(text), {
      'AC-SLICE-000-01': 'SKIPPED',
      'AC-SLICE-000-02': 'SKIPPED',
      'AC-SLICE-000-03': 'CONDITIONAL false',
      'AC-SLICE-000-04': 'SKIPPED',
    });
  });

  // Break caught: a `.ts` file read as if it had JSX, in which a generic arrow function opens an element and every skip after it is lost.
  it('reads a .ts file without JSX, so that a generic arrow does not hide a skip after it', () => {
    const text = [
      "describe('x', () => {",
      '  const same = <T>(value: T) => {',
      '    return value;',
      '  };',
      "  it.skip('a (AC-SLICE-000-01)', () => {});",
      '});',
      '',
    ].join('\n');
    assert.deepEqual(standings(text), { 'AC-SLICE-000-01': 'SKIPPED' });
  });

  it('is skipped where a skipped suite holds a conditional test', () => {
    const text = "describe.skip('a', () => { it.skipIf(x)('b (AC-SLICE-000-01)', () => {}); });\n";
    assert.deepEqual(standings(text), { 'AC-SLICE-000-01': 'SKIPPED' });
  });
});

describe('the problems of an inventory', () => {
  const citation = (
    criterion: string,
    standing: Citation['standing'],
    file = 'a.test.ts',
  ): Citation => ({
    criterion,
    file,
    standing,
    ...(standing === 'CONDITIONAL' ? { condition: 'linux' } : {}),
  });

  it('reads the criteria from the headings of the feature files', () => {
    const text =
      '### `AC-SLICE-000-01` — one\n\ntext AC-SLICE-000-09\n### `AC-SLICE-000-130` — two\n';
    assert.deepEqual(readCriteria([text]), ['AC-SLICE-000-01', 'AC-SLICE-000-130']);
  });

  it('fails a criterion no test cites, one only skipped tests cite, and a citation of a criterion the slice does not define', () => {
    const problems = findCitationProblems(
      ['AC-SLICE-000-01', 'AC-SLICE-000-02', 'AC-SLICE-000-03', 'AC-SLICE-000-04'],
      [
        citation('AC-SLICE-000-02', 'SKIPPED'),
        citation('AC-SLICE-000-03', 'SKIPPED'),
        citation('AC-SLICE-000-03', 'RUNS', 'b.test.ts'),
        citation('AC-SLICE-000-04', 'CONDITIONAL'),
        citation('AC-SLICE-000-12', 'RUNS'),
      ],
    );
    assert.deepEqual(
      problems.map((problem) => `${problem.code} ${problem.criterion}`),
      ['UNCITED AC-SLICE-000-01', 'ONLY_SKIPPED AC-SLICE-000-02', 'UNKNOWN AC-SLICE-000-12'],
    );
  });

  it('lists the criteria whose evidence runs only where a condition holds', () => {
    const only = conditionalOnly(
      ['AC-SLICE-000-01', 'AC-SLICE-000-02'],
      [
        citation('AC-SLICE-000-01', 'CONDITIONAL'),
        citation('AC-SLICE-000-02', 'CONDITIONAL'),
        citation('AC-SLICE-000-02', 'RUNS'),
      ],
    );
    assert.deepEqual([...only.keys()], ['AC-SLICE-000-01']);
  });
});

describe('which journey modules run', () => {
  // Break caught: a journey module no spec reaches taken for one that runs, or one that a registered module imports taken for one that does not.
  it('reaches the modules a spec imports, and those they import in turn, and no other', () => {
    const base = mkdtempSync(join(tmpdir(), 'citations-'));
    try {
      const write = (file: string, text: string): void => {
        mkdirSync(dirname(join(base, file)), { recursive: true });
        writeFileSync(join(base, file), text);
      };
      write('e2e/tests/a.spec.ts', "import { one } from '../harness/journeys/one.ts';\n");
      write(
        'e2e/harness/journeys/one.ts',
        "import { two } from './two.ts';\nexport const one = 1;\n",
      );
      write('e2e/harness/journeys/two.ts', 'export const two = 2;\n');
      write('e2e/harness/journeys/three.ts', 'export const three = 3;\n');
      const files = [
        'e2e/tests/a.spec.ts',
        'e2e/harness/journeys/one.ts',
        'e2e/harness/journeys/two.ts',
        'e2e/harness/journeys/three.ts',
      ];
      assert.deepEqual([...registeredJourneyModules(base, files)].toSorted(), [
        'e2e/harness/journeys/one.ts',
        'e2e/harness/journeys/two.ts',
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('the repository (S0.67)', () => {
  // Break caught: a criterion of the slice that no running test cites, or a test that cites a criterion the slice moved out.
  it('cites every criterion of the slice by a test that runs, and cites nothing the slice does not define', () => {
    const inventory = readInventory(root);
    assert.equal(
      inventory.criteria.length,
      new Set(inventory.criteria).size,
      'a criterion is defined twice',
    );
    assert.equal(inventory.criteria.length, 133);
    assert.deepEqual(inventory.problems, []);
  });

  // Today every criterion has a test that runs, with no condition, citing it. A criterion whose every evidence runs only where a condition
  // holds is named in the acceptance record with the condition; it is named here too, so that it cannot become so unseen.
  it('has no criterion whose evidence runs only where a condition holds', () => {
    const inventory = readInventory(root);
    assert.deepEqual([...conditionalOnly(inventory.criteria, inventory.citations).keys()], []);
  });

  // Break caught: a journey module that nothing registers, which would read as evidence of the criteria it cites.
  it('counts the citations of the journey modules a spec registers, and only those', () => {
    const inventory = readInventory(root);
    const journeys = inventory.citations.filter((citation) =>
      citation.file.startsWith('e2e/harness/journeys/'),
    );
    assert.ok(journeys.length > 0, 'the journey modules cite criteria');
    assert.deepEqual(
      [...new Set(journeys.filter((one) => one.standing === 'SKIPPED').map((one) => one.file))],
      [],
    );
  });

  // The check is live: removing every citation of one criterion is what makes it fail.
  it('fails when the citations of a criterion are removed', () => {
    const inventory = readInventory(root);
    const [first] = inventory.criteria;
    assert.ok(first !== undefined);
    const without = inventory.citations.filter((citation) => citation.criterion !== first);
    assert.deepEqual(
      findCitationProblems(inventory.criteria, without).map((problem) => problem.code),
      ['UNCITED'],
    );
  });
});
