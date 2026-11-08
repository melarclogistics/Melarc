import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { stringify } from 'yaml';

import {
  browserCoverageProblems,
  findShardProblems,
  listingFrom,
  playwrightLister,
  runListing,
  type TestLister,
} from './browser-shards.ts';
import {
  BROWSERS,
  PULL_REQUEST_SKIP,
  RUN_EVENTS,
  browserJobsOf,
  jobRunsOn,
  type BrowserShard,
} from './ci-workflow.ts';

const root = resolve(import.meta.dirname, '..');
const BROWSER_TESTS = 'pnpm run test:browser';

/**
 * Playwright's own cut of a run into shards (packages/playwright/src/runner/testGroups.ts and loadUtils.ts, version 1.63): the tests
 * in the order of the projects, each test a group of its own (the specs run fully parallel and use no serial mode), the shards ranges
 * of equal numbers of groups, the first shards taking the remainder. The double below uses it, and the real run shows below that the
 * real Playwright cuts this repository's tests into shards of the same sizes.
 */
function shardOf(tests: readonly string[], current: number, total: number): string[] {
  const sizes = Array.from({ length: total }, () => Math.floor(tests.length / total));
  const remainder = tests.length - sizes.reduce((sum, size) => sum + size, 0);
  for (let index = 0; index < remainder; index += 1) {
    sizes[index % total] = (sizes[index % total] ?? 0) + 1;
  }
  const from = sizes.slice(0, current - 1).reduce((sum, size) => sum + size, 0);
  return tests.slice(from, from + (sizes[current - 1] ?? 0));
}

/** A configuration, as far as the listing can see it. */
interface FakeConfig {
  /** The projects named for an engine (`<name>-<engine>`), with the number of tests each holds. */
  readonly projects: Readonly<Record<string, number>>;
  /** Projects named for no engine, which every run holds once. */
  readonly unnamed?: Readonly<Record<string, number>>;
  /** A configuration that ignores MELARC_BROWSER_SHARD. */
  readonly ignoresShard?: boolean;
  /** A configuration with two tests of one key. */
  readonly twinTests?: boolean;
}

/** Playwright as far as the proof asks of it: the tests and projects of a run, cut into the shard asked for. */
function fakePlaywright(config: FakeConfig): TestLister {
  return ({ engines, shard }) => {
    const projects = [
      ...engines.flatMap((engine) =>
        Object.entries(config.projects).map(([name, count]) => ({
          name: `${name}-${engine}`,
          count,
        })),
      ),
      ...Object.entries(config.unnamed ?? {}).map(([name, count]) => ({ name, count })),
    ];
    const tests = projects.flatMap(({ name, count }) =>
      Array.from(
        { length: count },
        (_, index) => `${name}|${name}.spec.ts:${String(index + 1)}:1|test ${String(index + 1)}`,
      ),
    );
    const first = tests[0];
    if (config.twinTests === true && first !== undefined) tests.push(first);
    const names = projects.map((project) => project.name);
    if (shard === undefined || config.ignoresShard === true) {
      return Promise.resolve({ tests, projects: names, shard: null });
    }
    if (!Number.isInteger(shard.current) || shard.current < 1 || shard.current > shard.total) {
      return Promise.reject(
        new Error(
          `MELARC_BROWSER_SHARD is "${String(shard.current)}/${String(shard.total)}", which is not a shard.`,
        ),
      );
    }
    return Promise.resolve({
      tests: shardOf(tests, shard.current, shard.total),
      projects: names,
      shard: `${String(shard.current)}/${String(shard.total)}`,
    });
  };
}

const SMALL: FakeConfig = { projects: { shell: 10, components: 7, pickup: 12, 'pickup-dev': 12 } };

/** The shards of every engine, as the matrix lists them: 1 to N each, with the number of shards of each engine. */
function matrix(counts: Readonly<Record<string, number>>): BrowserShard[] {
  return Object.entries(counts).flatMap(([engine, shards]) =>
    Array.from({ length: shards }, (_, index) => ({ engine, shard: index + 1, shards })),
  );
}

const GOOD = matrix({ chromium: 3, firefox: 4, webkit: 2 });

describe('the proof that the shards hold every test once, on a double of Playwright', () => {
  it('finds nothing wrong with a matrix whose shards cover every engine', async () => {
    assert.deepEqual(await findShardProblems(GOOD, fakePlaywright(SMALL)), []);
  });

  it('finds nothing wrong whatever the number of shards of each engine, up to the tests', async () => {
    for (const counts of [
      { chromium: 1, firefox: 1, webkit: 1 },
      { chromium: 41, firefox: 20, webkit: 7 },
      { chromium: 5, firefox: 3, webkit: 11 },
    ]) {
      assert.deepEqual(await findShardProblems(matrix(counts), fakePlaywright(SMALL)), []);
    }
  });

  // Break caught: a shard taken out of the matrix, so that the tests Playwright puts in it are run by no job.
  it('reports a dropped shard, with the engine, the number of tests and the projects they belong to', async () => {
    const without = GOOD.filter((entry) => !(entry.engine === 'firefox' && entry.shard === 2));
    const problems = await findShardProblems(without, fakePlaywright(SMALL));
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0] ?? '', /^firefox: 10 of 41 tests are run by no job \(/);
    assert.match(problems[0] ?? '', /the entries run shard 1\/4, 3\/4, 4\/4/);
  });

  it('reports the last shard of an engine dropped, which no neighbour can make up for', async () => {
    const without = GOOD.filter((entry) => !(entry.engine === 'chromium' && entry.shard === 3));
    const problems = await findShardProblems(without, fakePlaywright(SMALL));
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0] ?? '', /^chromium: 13 of 41 tests are run by no job \(/);
  });

  // Break caught: an engine taken out of the matrix, so that none of its projects is run.
  for (const engine of BROWSERS) {
    it(`reports ${engine} missing from the matrix`, async () => {
      const without = GOOD.filter((entry) => entry.engine !== engine);
      const problems = await findShardProblems(without, fakePlaywright(SMALL));
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(
        problems[0] ?? '',
        new RegExp(`^no job runs ${engine}: its 41 tests \\(.*shell-${engine} 10`),
      );
    });
  }

  it('reports every engine missing from an empty matrix', async () => {
    const problems = await findShardProblems([], fakePlaywright(SMALL));
    assert.equal(problems.length, BROWSERS.length);
  });

  // Break caught: a shard run twice, or entries that cut one engine into different numbers of parts, so the parts overlap.
  it('reports a shard listed twice, as tests run by more than one job', async () => {
    const problems = await findShardProblems(
      [...GOOD, { engine: 'webkit', shard: 1, shards: 2 }],
      fakePlaywright(SMALL),
    );
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(
      problems[0] ?? '',
      /^webkit: 21 tests are run by more than one job \(.*for one by webkit 1\/2 and webkit 1\/2/,
    );
  });

  it('reports entries that cut an engine into different numbers of parts: some tests twice, some never', async () => {
    const mixed = [
      ...GOOD.filter((entry) => entry.engine !== 'firefox'),
      { engine: 'firefox', shard: 1, shards: 4 },
      { engine: 'firefox', shard: 2, shards: 4 },
      { engine: 'firefox', shard: 3, shards: 5 },
      { engine: 'firefox', shard: 4, shards: 5 },
    ];
    const problems = await findShardProblems(mixed, fakePlaywright(SMALL));
    assert.ok(
      problems.some((problem) => /^firefox: \d+ of 41 tests are run by no job/.test(problem)),
      problems.join('\n'),
    );
    assert.ok(
      problems.some((problem) => /^firefox: \d+ tests are run by more than one job/.test(problem)),
      problems.join('\n'),
    );
  });

  // Break caught: more jobs than tests, or a shard that Playwright refuses, which a green job does not show.
  it('reports a shard that holds no test', async () => {
    const tiny: FakeConfig = { projects: { shell: 1 } };
    const problems = await findShardProblems(
      matrix({ chromium: 3, firefox: 1, webkit: 1 }),
      fakePlaywright(tiny),
    );
    assert.deepEqual(
      problems.map((problem) => problem.split(' holds no test')[0]),
      ['chromium 2/3', 'chromium 3/3'],
    );
    assert.match(
      problems[0] ?? '',
      /holds no test: it runs nothing, and a job that runs nothing proves nothing/,
    );
  });

  it('reports a shard Playwright refuses, and an engine it cannot list', async () => {
    const problems = await findShardProblems(
      [...GOOD, { engine: 'chromium', shard: 4, shards: 3 }],
      fakePlaywright(SMALL),
    );
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(
      problems[0] ?? '',
      /^chromium 4\/3: the tests could not be listed \(MELARC_BROWSER_SHARD is "4\/3"/,
    );

    const broken: TestLister = () => Promise.reject(new Error('the spec does not load'));
    assert.deepEqual(await findShardProblems(GOOD, broken), [
      'all engines: the tests could not be listed (the spec does not load)',
    ]);
  });

  // Break caught: the variable not reaching the run (an environment Turborepo does not pass, a configuration that no longer reads it):
  // every job would then run the whole of its engine, and the run is as long as before it was split.
  it('reports a configuration that ignores the shard', async () => {
    const problems = await findShardProblems(
      GOOD,
      fakePlaywright({ ...SMALL, ignoresShard: true }),
    );
    assert.ok(
      problems.some((problem) =>
        problem.includes(
          'the configuration says it ran whole, so MELARC_BROWSER_SHARD does not reach the run',
        ),
      ),
      problems.join('\n'),
    );
    assert.ok(
      problems.some((problem) => problem.includes('tests are run by more than one job')),
      problems.join('\n'),
    );
  });

  // Break caught: a project that no engine's name claims, which the matrix cannot be said to run: every job of every engine would run
  // it (and the same tests are run three times), or none.
  it('reports a project named for no engine', async () => {
    const problems = await findShardProblems(
      GOOD,
      fakePlaywright({ ...SMALL, unnamed: { global: 5 } }),
    );
    assert.ok(
      problems.some((problem) =>
        problem.startsWith('the project global is not named for one engine'),
      ),
      problems.join('\n'),
    );
    assert.ok(
      problems.some((problem) =>
        /^the engines list \d+ tests one by one and \d+ together/.test(problem),
      ),
      problems.join('\n'),
    );
  });

  it('reports a project that lists no test, and two tests that cannot be told apart', async () => {
    const empty = await findShardProblems(
      GOOD,
      fakePlaywright({ projects: { shell: 10, silent: 0 } }),
    );
    assert.deepEqual(
      empty.filter((problem) => problem.includes('lists no test')).length,
      BROWSERS.length,
    );
    const twins = await findShardProblems(GOOD, fakePlaywright({ ...SMALL, twinTests: true }));
    assert.ok(
      twins.some((problem) => problem.includes('two tests have one key')),
      twins.join('\n'),
    );
  });

  it('reports an entry for an engine that is not run', async () => {
    const problems = await findShardProblems(
      [...GOOD, { engine: 'msedge', shard: 1, shards: 1 }],
      fakePlaywright(SMALL),
    );
    assert.deepEqual(problems, [
      'an entry of the matrix names the engine msedge, which is not run here',
    ]);
  });
});

describe('the browser jobs of a workflow, and what each kind of run runs of them', () => {
  const step = { name: 'Browser tests', run: BROWSER_TESTS };
  const matrixJob = (
    entries: BrowserShard[],
    condition: string | null = null,
  ): Record<string, unknown> => ({
    ...(condition === null ? {} : { if: condition }),
    strategy: { 'fail-fast': false, matrix: { include: entries } },
    steps: [step],
  });
  // The job's condition is the plan's answer and the event (task CI.2): `needs.plan.outputs.run == 'true' && github.event_name != 'pull_request'`.
  const CONDITION = PULL_REQUEST_SKIP;
  const of = (...engines: string[]): BrowserShard[] =>
    GOOD.filter((entry) => engines.includes(entry.engine));
  /** The workflow of the decision: Chromium in a job every run makes, Firefox and WebKit in a job a pull request does not. */
  const workflowOf = (
    chromium: BrowserShard[] = of('chromium'),
    others: BrowserShard[] = of('firefox', 'webkit'),
    condition: string | null = CONDITION,
  ): string =>
    stringify({
      jobs: {
        unit: { steps: [] },
        'browser-chromium': matrixJob(chromium),
        'browser-firefox-webkit': matrixJob(others, condition),
      },
    });
  const coverage = (text: string) => browserCoverageProblems(text, fakePlaywright(SMALL));

  it('finds the jobs that run the browser tests, with the shards of each', () => {
    const found = browserJobsOf(workflowOf());
    assert.deepEqual(
      found.map((job) => job.id),
      ['browser-chromium', 'browser-firefox-webkit'],
    );
    assert.deepEqual(
      found.map((job) => job.entries.length),
      [of('chromium').length, of('firefox', 'webkit').length],
    );
    assert.deepEqual(
      found.flatMap((job) => job.faults),
      [],
    );
  });

  // Break caught: a job that runs nothing of the browser tests is not looked at, and a workflow with none has nothing to prove.
  it('finds no browser job in a workflow without one, and says so', async () => {
    assert.deepEqual(browserJobsOf(stringify({ jobs: { unit: { steps: [] } } })), []);
    assert.deepEqual(browserJobsOf(''), []);
    assert.deepEqual(await coverage(stringify({ jobs: {} })), [
      'no job of the workflow runs pnpm run test:browser',
    ]);
  });

  // Which kind of run makes which job, by the one condition the rules allow (a job with none is made by every run).
  it('reads which jobs each kind of run makes from the condition of the job', () => {
    const [chromium, others] = browserJobsOf(workflowOf());
    assert.ok(chromium !== undefined && others !== undefined);
    for (const event of Object.keys(RUN_EVENTS)) {
      assert.equal(jobRunsOn(chromium.body, event), true, event);
      assert.equal(jobRunsOn(others.body, event), event !== 'pull_request', event);
    }
    // A condition of any other form says nothing: the job is not counted as run by any kind of run.
    for (const condition of ["github.event_name == 'push'", 'always()', 'false']) {
      const [, odd] = browserJobsOf(workflowOf(of('chromium'), of('firefox', 'webkit'), condition));
      assert.ok(odd !== undefined);
      for (const event of Object.keys(RUN_EVENTS))
        assert.equal(jobRunsOn(odd.body, event), undefined);
    }
  });

  it('is accepted when a pull request runs Chromium, and every other kind of run every engine', async () => {
    assert.deepEqual(await coverage(workflowOf()), []);
  });

  // (a) Break caught: a Chromium shard taken out of the workflow, so that a pull request, and every other run, leaves tests unrun.
  it('(a) reports a Chromium shard dropped, on every kind of run', async () => {
    const problems = await coverage(workflowOf(of('chromium').slice(1)));
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(
      problems.find((problem) => problem.includes('tests are run by no job')) ?? '',
      /^on a pull request, on a push to main, in the nightly run, in a manual run: chromium: 14 of 41 tests are run by no job/,
    );
    assert.match(
      problems.join('\n'),
      /job browser-chromium: chromium has no entry for shard 1 of 3/,
    );
  });

  // (b) Break caught: a Firefox or WebKit shard taken out, so that main and the nightly run leave tests unrun while every pull request is as green as before.
  for (const [engine, others] of [
    ['firefox', of('webkit').concat(of('firefox').slice(1))],
    ['webkit', of('firefox').concat(of('webkit').slice(1))],
  ] as const) {
    it(`(b) reports a ${engine} shard dropped on a push, at night and by hand, and not on a pull request`, async () => {
      const problems = await coverage(workflowOf(undefined, others));
      assert.ok(
        problems.some((problem) =>
          problem.startsWith(`on a push to main, in the nightly run, in a manual run: ${engine}: `),
        ),
        problems.join('\n'),
      );
      assert.ok(
        problems.every((problem) => !problem.includes('on a pull request')),
        problems.join('\n'),
      );
    });
  }

  it('(b) reports an engine missing altogether from the jobs that run on main', async () => {
    const problems = await coverage(workflowOf(undefined, of('firefox')));
    assert.ok(
      problems.some((problem) =>
        problem.startsWith(
          'on a push to main, in the nightly run, in a manual run: no job runs webkit: its 41 tests',
        ),
      ),
      problems.join('\n'),
    );
  });

  // (c) Break caught: the Firefox and WebKit shards run on a pull request (the condition taken off the job, or the shards moved into
  // the job that every run makes), which the Product Owner decided against.
  it('(c) reports Firefox and WebKit shards run on a pull request, and only there', async () => {
    const noCondition = await coverage(workflowOf(undefined, undefined, null));
    assert.equal(noCondition.length, 2, noCondition.join('\n'));
    for (const engine of ['firefox', 'webkit']) {
      assert.ok(
        noCondition.some(
          (problem) =>
            problem.startsWith(`on a pull request: ${engine}: `) && problem.includes('run here'),
        ),
        noCondition.join('\n'),
      );
    }
    const moved = await coverage(workflowOf([...of('chromium'), ...of('firefox')], of('webkit')));
    assert.ok(
      moved.some(
        (problem) =>
          problem.startsWith('on a pull request: firefox: ') &&
          problem.includes('and only chromium may'),
      ),
      moved.join('\n'),
    );
  });

  it('(c) reports a condition that no kind of run satisfies, as Firefox and WebKit run nowhere', async () => {
    const problems = await coverage(
      workflowOf(undefined, undefined, "github.event_name == 'push'"),
    );
    assert.ok(
      problems.some((problem) =>
        problem.startsWith(
          'on a push to main, in the nightly run, in a manual run: no job runs firefox',
        ),
      ),
      problems.join('\n'),
    );
  });

  // Break caught: the matrices of two jobs both listing an engine, which a run that makes both would run twice.
  it('reports an engine whose shards are in both jobs, as tests run by more than one job', async () => {
    const problems = await coverage(
      workflowOf(of('chromium'), [...of('firefox', 'webkit'), ...of('chromium')]),
    );
    assert.ok(
      problems.some(
        (problem) => problem.includes('chromium: ') && problem.includes('run by more than one job'),
      ),
      problems.join('\n'),
    );
  });
});

describe('reading the listing of Playwright', () => {
  const listing = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      config: {
        projects: [{ name: 'shell-chromium' }, { name: 'logo-chromium' }],
        shard: { current: 2, total: 5 },
      },
      suites: [
        {
          file: 'shell.spec.ts',
          specs: [
            {
              title: 'a',
              file: 'shell.spec.ts',
              line: 3,
              column: 5,
              tests: [{ projectName: 'shell-chromium' }],
            },
          ],
          suites: [
            {
              title: 'group',
              specs: [
                {
                  title: 'b',
                  file: 'shell.spec.ts',
                  line: 9,
                  column: 7,
                  tests: [{ projectName: 'shell-chromium' }, { projectName: 'logo-chromium' }],
                },
              ],
            },
          ],
        },
      ],
      errors: [],
      ...extra,
    });

  it('names each test by project, file, place and title, in nested groups too', () => {
    assert.deepEqual(listingFrom(listing()), {
      tests: [
        'shell-chromium|shell.spec.ts:3:5|a',
        'shell-chromium|shell.spec.ts:9:7|b',
        'logo-chromium|shell.spec.ts:9:7|b',
      ],
      projects: ['shell-chromium', 'logo-chromium'],
      shard: '2/5',
    });
  });

  it('says a run was whole when the configuration holds no shard', () => {
    assert.equal(listingFrom(listing({ config: { projects: [], shard: null } })).shard, null);
  });

  // Break caught: a listing that failed to load a spec read as a shorter list of tests, which would pass for a smaller suite.
  it('refuses a listing with errors, and anything that is not a listing', () => {
    assert.throws(
      () => listingFrom(listing({ errors: [{ message: 'cannot load shell.spec.ts' }] })),
      /Playwright reported 1 error/,
    );
    assert.throws(() => listingFrom('[]'), /not a JSON object/);
    assert.throws(() => listingFrom('not json'));
  });
});

/** The text of the Ops Portal's configuration, for what only its text can say. */
const configuration = readFileSync(resolve(root, 'apps/ops-web/playwright.config.ts'), 'utf8');

// The proof itself: the real workflow, the real configuration and the real Playwright, which lists the tests of every shard of
// every engine (about thirty runs of `playwright test --list`, which starts no browser and no server).
describe('this repository: what each kind of run runs of the browser tests', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const list = playwrightLister(root);
  const jobs = browserJobsOf(workflow);
  /** The shards a kind of run makes: those of the jobs it runs. */
  const entriesOn = (event: string): BrowserShard[] =>
    jobs.filter((job) => jobRunsOn(job.body, event) === true).flatMap((job) => job.entries);
  const onPullRequest = entriesOn('pull_request');
  const onMain = entriesOn('push');

  it('has the Chromium shards in a job every run makes and the others in a job a pull request does not, without a fault', () => {
    assert.deepEqual(
      jobs.map((job) => job.id),
      ['browser-chromium', 'browser-firefox-webkit'],
    );
    assert.deepEqual(
      jobs.flatMap((job) => job.faults),
      [],
    );
    assert.deepEqual(
      [...new Set(onPullRequest.map((entry) => entry.engine))],
      ['chromium'],
      'a pull request runs the Chromium shards and no other',
    );
    assert.deepEqual(
      [...new Set(onMain.map((entry) => entry.engine))].toSorted(),
      [...BROWSERS].toSorted(),
    );
    for (const event of ['push', 'schedule', 'workflow_dispatch']) {
      assert.deepEqual(entriesOn(event), onMain, event);
    }
  });

  // Break caught: the engines of the configuration and of the supported browsers parting, so that an engine is added where the matrix
  // and the rules do not look (or one is dropped from the configuration while the matrix still lists it).
  it('runs the engines CI is held to, and no other', () => {
    const block = /const ENGINES = \{([\s\S]*?)\n\} as const;/.exec(configuration);
    const engines = [...(block?.[1] ?? '').matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);
    assert.deepEqual(engines.toSorted(), BROWSERS.toSorted());
  });

  it('holds every test of every project in exactly one job: Chromium on a pull request, every engine on main', async () => {
    assert.deepEqual(await browserCoverageProblems(workflow, list), []);
    assert.deepEqual(await findShardProblems(onPullRequest, list, ['chromium']), []);
    for (const event of ['push', 'schedule', 'workflow_dispatch']) {
      assert.deepEqual(await findShardProblems(entriesOn(event), list), [], event);
    }
  });

  it('gives each engine more than one job, none of which runs the whole of it', async (context) => {
    for (const engine of BROWSERS) {
      const whole = await list({ engines: [engine] });
      const own = onMain.filter((entry) => entry.engine === engine);
      assert.ok(own.length > 1, `${engine} has ${String(own.length)} job`);
      const sizes: number[] = [];
      for (const job of own) {
        const part = await list({
          engines: [engine],
          shard: { current: job.shard, total: job.shards },
        });
        assert.ok(
          part.tests.length > 0 && part.tests.length < whole.tests.length,
          `${engine} ${String(job.shard)}/${String(job.shards)}`,
        );
        sizes.push(part.tests.length);
      }
      context.diagnostic(
        `${engine}: ${String(whole.tests.length)} tests in ${String(whole.projects.length)} projects, ${String(own.length)} jobs of ${sizes.join(', ')} tests`,
      );
    }
  });

  // The double above is only as good as its agreement with Playwright. Every test of these specs is a group of its own (no serial
  // mode, no all-hooks), so Playwright cuts the real tests into shards of equal numbers of tests, the first shards taking the
  // remainder, as the double does; a spec that grouped its tests would make a shard larger than that, and this fails.
  it('cuts the real tests into shards of equal numbers of tests, as the double above does', async () => {
    for (const engine of BROWSERS) {
      const whole = await list({ engines: [engine] });
      for (const job of onMain.filter((entry) => entry.engine === engine)) {
        const part = await list({
          engines: [engine],
          shard: { current: job.shard, total: job.shards },
        });
        const expected = shardOf(whole.tests, job.shard, job.shards).length;
        assert.equal(
          part.tests.length,
          expected,
          `${engine} ${String(job.shard)}/${String(job.shards)}`,
        );
      }
    }
  });

  // Break caught (the failure to show, on the real tests): a shard taken out of the workflow's matrix leaves tests that no job runs, on
  // main and at night for Firefox and WebKit, and on every kind of run for Chromium.
  for (const engine of BROWSERS) {
    it(`fails when a shard of ${engine} is taken out of the matrix`, async (context) => {
      const taken = onMain.filter((entry) => entry.engine === engine)[1];
      assert.ok(taken !== undefined);
      const problems = await findShardProblems(
        onMain.filter((entry) => entry !== taken),
        list,
      );
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(
        problems[0] ?? '',
        new RegExp(`^${engine}: \\d+ of \\d+ tests are run by no job \\(`),
      );
      context.diagnostic(
        `without ${engine} ${String(taken.shard)}/${String(taken.shards)}: ${problems[0] ?? ''}`,
      );
    });

    it(`fails when ${engine} is taken out of the matrix`, async (context) => {
      const problems = await findShardProblems(
        onMain.filter((entry) => entry.engine !== engine),
        list,
      );
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(problems[0] ?? '', new RegExp(`^no job runs ${engine}: its \\d+ tests`));
      context.diagnostic(`without ${engine}: ${problems[0] ?? ''}`);
    });
  }

  // Break caught: the shard of an engine counted for another (a typo that moves a job to the wrong part of the list).
  it('fails when two jobs of an engine run one shard', async () => {
    const [first] = onMain;
    assert.ok(first !== undefined);
    const problems = await findShardProblems([...onMain, first], list);
    assert.ok(
      problems.some((problem) => problem.includes('tests are run by more than one job')),
      problems.join('\n'),
    );
  });

  // The decision of 7 November 2026, broken once each way on the real tests (the failures to show). A pull request: a Chromium shard
  // out, and a Firefox or WebKit shard in.
  it('fails when a pull request leaves a Chromium shard out, and when it runs a Firefox or WebKit shard', async (context) => {
    const chromium = onPullRequest.filter((entry) => entry.engine === 'chromium');
    const [dropped] = chromium;
    assert.ok(dropped !== undefined && chromium.length > 1);
    const left = await findShardProblems(
      onPullRequest.filter((entry) => entry !== dropped),
      list,
      ['chromium'],
    );
    assert.equal(left.length, 1, left.join('\n'));
    assert.match(left[0] ?? '', /^chromium: \d+ of \d+ tests are run by no job/);
    context.diagnostic(
      `a pull request without chromium 1/${String(dropped.shards)}: ${left[0] ?? ''}`,
    );

    for (const engine of ['firefox', 'webkit']) {
      const extra = onMain.find((entry) => entry.engine === engine);
      assert.ok(extra !== undefined);
      const added = await findShardProblems([...onPullRequest, extra], list, ['chromium']);
      assert.equal(added.length, 1, added.join('\n'));
      assert.match(added[0] ?? '', new RegExp(`^${engine}: 1 of its shards run here \\(`));
      context.diagnostic(
        `a pull request that runs ${engine} 1/${String(extra.shards)}: ${added[0] ?? ''}`,
      );
    }
  });

  // The same, on the text of the real workflow, changed as a person would change it: the shards, the condition, the job.
  describe('with the real workflow changed by one line', () => {
    const without = (line: string): string => {
      assert.ok(workflow.includes(line), line);
      return workflow.replace(line, '');
    };
    const CONDITION_LINE = `    if: ${PULL_REQUEST_SKIP}\n`;
    const ON_MAIN = 'on a push to main, in the nightly run, in a manual run';
    const check = async (
      text: string,
      context: { diagnostic: (message: string) => void },
    ): Promise<string[]> => {
      const problems = await browserCoverageProblems(text, list);
      for (const problem of problems) context.diagnostic(problem.slice(0, 260));
      return problems;
    };

    it('reports the condition taken off the Firefox and WebKit job: both run on a pull request', async (context) => {
      const problems = await check(without(CONDITION_LINE), context);
      assert.equal(problems.length, 2, problems.join('\n'));
      assert.ok(
        problems.every((problem) => problem.startsWith('on a pull request: ')),
        problems.join('\n'),
      );
    });

    it('reports a Firefox shard taken out of the workflow: main and the nightly run lose it, a pull request does not', async (context) => {
      const problems = await check(
        without('          - { engine: firefox, shard: 2, shards: 9 }\n'),
        context,
      );
      assert.ok(
        problems.some((problem) => problem.startsWith(`${ON_MAIN}: firefox: `)),
        problems.join('\n'),
      );
      assert.ok(
        problems.every((problem) => !problem.startsWith('on a pull request')),
        problems.join('\n'),
      );
    });

    it('reports a WebKit shard taken out of the workflow', async (context) => {
      const problems = await check(
        without('          - { engine: webkit, shard: 8, shards: 8 }\n'),
        context,
      );
      assert.ok(
        problems.some((problem) => problem.startsWith(`${ON_MAIN}: webkit: `)),
        problems.join('\n'),
      );
    });

    it('reports a Chromium shard taken out of the workflow, on every kind of run', async (context) => {
      const problems = await check(
        without('          - { engine: chromium, shard: 7, shards: 7 }\n'),
        context,
      );
      assert.ok(
        problems.some((problem) =>
          problem.startsWith(
            'on a pull request, on a push to main, in the nightly run, in a manual run: chromium: ',
          ),
        ),
        problems.join('\n'),
      );
    });

    it('reports a condition that is not the decided one: Firefox and WebKit run nowhere', async (context) => {
      const problems = await check(
        workflow.replace(CONDITION_LINE, "    if: github.event_name == 'push'\n"),
        context,
      );
      assert.ok(
        problems.some((problem) => problem.startsWith(`${ON_MAIN}: no job runs firefox`)),
        problems.join('\n'),
      );
    });
  });

  // Break caught: a value that is not a shard read as "no shard", so that a typo in the workflow runs the whole engine in every job.
  it('refuses the values of MELARC_BROWSER_SHARD that are not a shard, and reads the empty one as the whole run', async () => {
    const refused = ['0/5', '6/5', '2', 'a/b', '1/0', '1/2/3', '-1/5', '1.5/5', '01/5', '1/'];
    const runs = await Promise.all(
      refused.map((value) =>
        runListing(root, { MELARC_BROWSERS: 'chromium', MELARC_BROWSER_SHARD: value }),
      ),
    );
    runs.forEach((run, index) => {
      const value = refused[index] ?? '';
      assert.notEqual(run.status, 0, `${value} was accepted`);
      assert.match(
        `${run.stderr}${run.stdout}`,
        /MELARC_BROWSER_SHARD is ".*", which is not a shard/,
        value,
      );
    });
    for (const value of ['', '   ']) {
      const run = await runListing(root, {
        MELARC_BROWSERS: 'chromium',
        MELARC_BROWSER_SHARD: value,
      });
      assert.equal(run.status, 0);
      assert.equal(listingFrom(run.stdout).shard, null, JSON.stringify(value));
    }
    const padded = await runListing(root, {
      MELARC_BROWSERS: 'chromium',
      MELARC_BROWSER_SHARD: ' 3/7 ',
    });
    assert.equal(listingFrom(padded.stdout).shard, '3/7');
  });
});
