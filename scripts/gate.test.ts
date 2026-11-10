import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  BASELINE_FILE,
  GATE_STAGE_TARGETS,
  TARGETS,
  baselineOf,
  markRunning,
} from './affected-baselines.ts';
import { REQUIRED_COMMANDS } from './ci-workflow.ts';
import { pnpmCommandProblem, workspaceScripts } from './doc-commands.ts';
import {
  CI_ONLY_COMMANDS,
  DATABASE_CHECK,
  MEMORY_REFUSE_MB,
  PRECHECK_CACHE,
  ROOT_GUARDS,
  ROOT_GUARDS_COMMAND,
  affectedProblems,
  agentRefusal,
  baselineChanges,
  changesSince,
  childEnvironment,
  commandLineGate,
  commandLinePrecheck,
  databaseProblems,
  describeStatus,
  digestOf,
  exitCodeOf,
  gateBase,
  gateEnvironment,
  gateStages,
  isAlive,
  isRunning,
  jdkProblems,
  killTree,
  latestGate,
  parseArguments,
  precheckLanes,
  provenTargets,
  readState,
  recordProvenTargets,
  renderSummary,
  runGate,
  runPrecheck,
  snapshotTree,
  stopGate,
  treeFiles,
  waitForProgress,
  type GateOptions,
  type GateRun,
  type GateState,
  type Stage,
  type StageStatus,
} from './gate.ts';
import { isRecord } from './workflow-shapes.ts';

/**
 * The gate and the precheck (scripts/gate.ts). What they promise is checked by running real commands in a real Git checkout that each test
 * makes: a stage that fails, one that edits the tree, one that is stopped. Nothing here touches this repository's tree or the machine's own
 * gate folder: every run is given a base of its own, and the commands it runs are small Node scripts written below the temporary folder.
 * A stage that must be stopped runs under a runner of its own (a process the test starts), so that no test ever ends the process it runs in.
 */
const root = resolve(import.meta.dirname, '..');
const gateModule = join(root, 'scripts', 'gate.ts');
const created: string[] = [];
let tools = '';

function temp(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `melarc-gate-${label}-`));
  created.push(directory);
  return directory;
}

before(() => {
  tools = temp('tools');
  const write = (name: string, body: string): void => {
    writeFileSync(join(tools, name), body);
  };
  write('pass.mjs', "console.log('hello from the stage');\n");
  write('fail.mjs', "console.log('the stage failed');\nprocess.exit(3);\n");
  // A check that could not decide (the migration guard with no main): its words on stderr and exit 2, which the precheck shows as warned and the gate fails on.
  write(
    'undecided.mjs',
    "console.error('Cannot tell whether a migration was changed: There is no main to compare the migrations with.');\nprocess.exit(2);\n",
  );
  // Writes the time into a file every 40 ms until it is ended: a file that stops moving is a process that is gone.
  write(
    'slow.mjs',
    "import { writeFileSync } from 'node:fs';\nconst file = process.argv[2];\nsetInterval(() => { writeFileSync(file, String(Date.now())); }, 40);\nsetTimeout(() => { process.exit(0); }, 120000);\n",
  );
  // Waits to be ended by the gate; if the gate cannot, it ends itself, so that a broken guard is a failed test and not a hung run.
  write(
    'edit.mjs',
    "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], 'edited\\n');\nsetTimeout(() => { process.exit(0); }, 20000);\n",
  );
  write(
    'make.mjs',
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'new\\n');\n",
  );
  write(
    'transient.mjs',
    "import { rmSync, writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'transient\\n');\nrmSync(process.argv[2]);\n",
  );
  // wait.mjs <milliseconds> [marker]: says it started (a file) and waits.
  write(
    'wait.mjs',
    "import { writeFileSync } from 'node:fs';\nif (process.argv[3] !== undefined) writeFileSync(process.argv[3], 'started\\n');\nsetTimeout(() => undefined, Number(process.argv[2]));\n",
  );
  // rendezvous.mjs <own> <other> <timeout>: passes only when the other one is running at the same time.
  write(
    'rendezvous.mjs',
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      'const [, , own, other, timeout] = process.argv;',
      "writeFileSync(own, 'here\\n');",
      'const deadline = Date.now() + Number(timeout);',
      'while (!existsSync(other)) {',
      '  if (Date.now() > deadline) {',
      "    console.log('the other check never started: the checks did not overlap');",
      '    process.exit(1);',
      '  }',
      '  await new Promise((done) => setTimeout(done, 20));',
      '}',
      '',
    ].join('\n'),
  );
  // runner.mjs <gate.ts> <root> <base> <name> <stages as JSON>: runGate as a process of its own, as `pnpm run gate` is.
  write(
    'runner.mjs',
    [
      "import { pathToFileURL } from 'node:url';",
      'const [, , gate, root, base, name, stages] = process.argv;',
      'const { runGate, exitCodeOf } = await import(pathToFileURL(gate).href);',
      'const run = await runGate({',
      "  root, base, name, profile: 'local', stages: JSON.parse(stages), env: process.env, allowLowMemory: true,",
      '  freeMb: () => 8192, listOrphans: () => [],',
      '  intervals: { watchMs: 50, stopMs: 50, heartbeatMs: 200, sampleMs: 50 },',
      '  handleSignals: true, log: (line) => { console.log(line); },',
      '});',
      'process.exitCode = exitCodeOf(run);',
      '',
    ].join('\n'),
  );
  // stuck-runner.mjs <base> <alive file>: the record of a gate whose runner never reads a stop request, and the stage it started.
  write(
    'stuck-runner.mjs',
    [
      "import { spawn } from 'node:child_process';",
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const [, , base, alive] = process.argv;',
      "const dir = join(base, 'stuck');",
      'mkdirSync(dir, { recursive: true });',
      "const child = spawn(process.execPath, [join(import.meta.dirname, 'slow.mjs'), alive], {",
      "  stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',",
      '});',
      'const state = {',
      "  name: 'stuck', dir, runnerPid: process.pid, verdict: null, childPid: child.pid,",
      '  updatedAt: new Date().toISOString(), stages: [],',
      '};',
      "writeFileSync(join(dir, 'state.json'), JSON.stringify(state));",
      "writeFileSync(join(base, 'current.json'), JSON.stringify({ dir }));",
      'setTimeout(() => { process.exit(0); }, 120000);',
      '',
    ].join('\n'),
  );
});

after(() => {
  for (const directory of created) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // A folder that a process still holds (Windows) stays in the temporary directory, which is the operating system's to clean.
    }
  }
});

const command = (script: string, ...args: string[]): string =>
  [`"${process.execPath}"`, `"${join(tools, script)}"`, ...args.map((arg) => `"${arg}"`)].join(' ');

const stage = (name: string, kind: Stage['kind'], line: string, needs?: string): Stage =>
  needs === undefined ? { name, kind, command: line } : { name, kind, command: line, needs };

/** The smallest gate: one stage that passes. */
const passing = (): Stage[] => [stage('one', 'static', command('pass.mjs'))];

function git(directory: string, ...args: string[]): void {
  const done = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
}

/** A Git checkout with two tracked files, one untracked file and an ignored folder. */
function checkout(): string {
  const directory = temp('repo');
  git(directory, 'init', '--quiet');
  git(directory, 'config', 'user.email', 'gate@example.test');
  git(directory, 'config', 'user.name', 'Gate test');
  writeFileSync(join(directory, '.gitignore'), 'ignored/\n');
  writeFileSync(join(directory, 'a.txt'), 'a\n');
  writeFileSync(join(directory, 'b.txt'), 'b\n');
  mkdirSync(join(directory, 'ignored'));
  writeFileSync(join(directory, 'ignored', 'x.txt'), 'x\n');
  git(directory, 'add', '.');
  git(directory, 'commit', '--quiet', '-m', 'base');
  writeFileSync(join(directory, 'untracked.txt'), 'u\n');
  return directory;
}

function options(directory: string, overrides: Partial<GateOptions> = {}): GateOptions {
  return {
    root: directory,
    base: temp('base'),
    name: 'test',
    profile: 'local',
    stages: [],
    env: process.env,
    allowLowMemory: false,
    freeMb: () => 8192,
    listOrphans: () => [],
    intervals: { watchMs: 50, stopMs: 50, heartbeatMs: 200, sampleMs: 50 },
    handleSignals: false,
    log: () => undefined,
    ...overrides,
  };
}

/** The record of a gate as its runner (this process) keeps it: running while `verdict` is null, and silent when `updatedAt` is old. */
function recordGate(
  base: string,
  updatedAt: string,
  verdict: GateState['verdict'],
  runnerPid = process.pid,
  childPid?: number,
): void {
  const dir = join(base, 'recorded');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(base, 'current.json'), JSON.stringify({ dir }));
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      name: 'recorded',
      dir,
      runnerPid,
      childPid: childPid ?? null,
      verdict,
      updatedAt,
      stages: [],
    }),
  );
}

const digestOfText = (text: string): string => createHash('sha256').update(text).digest('hex');

function defined<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, `${what} is missing`);
  return value;
}

function finished(run: GateRun): GateState {
  if (run.kind === 'refused') assert.fail(`the gate was refused: ${run.problems.join(' | ')}`);
  return run.state;
}

function refusal(run: GateRun): string {
  if (run.kind === 'finished') assert.fail(`the gate ran: ${run.state.verdict ?? 'unfinished'}`);
  return run.problems.join(' ');
}

const statusOf = (state: GateState, name: string): StageStatus | undefined =>
  state.stages.find((record) => record.name === name)?.status;

async function until(
  condition: () => boolean,
  what: string | (() => string),
  milliseconds = 20_000,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(
        `${typeof what === 'string' ? what : what()} did not happen within ${String(milliseconds)} ms`,
      );
    }
    await sleep(25);
  }
}

interface Started {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<number | null>;
}

/** Starts one of the scripts of this file as a process of its own, and keeps what it prints for the message of a failure. */
function start(script: string, ...args: string[]): Started {
  const child = spawn(process.execPath, [join(tools, script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let text = '';
  const keep = (chunk: Buffer): void => {
    text += chunk.toString();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const exited = new Promise<number | null>((done) => {
    child.once('exit', (code) => {
      done(code);
    });
  });
  return { child, output: () => text, exited };
}

/** How a process ended, bounded: a process that is not ended is a failed test and not a run that never returns. */
const exitOf = (
  started: Started,
  milliseconds = 30_000,
): Promise<number | null | 'still running'> =>
  Promise.race([started.exited, sleep(milliseconds).then(() => 'still running' as const)]);

/** After it has been ended, a file that a process wrote every 40 ms does not move again. */
async function assertStopped(file: string, who: string): Promise<void> {
  await sleep(150);
  const last = statSync(file).mtimeMs;
  await sleep(400);
  assert.equal(statSync(file).mtimeMs, last, `${who} is still running: its file is still written`);
}

describe('the stages of the gate', () => {
  // Break caught: a command of CI that the gate does not run (so that a green gate says less than a green CI), or one the gate runs that CI
  // does not. The CI profile is held to the pipeline's own list, word for word, but for the one run only Linux CI can make.
  it('are the commands CI must run, one for one, but for the HTTPS run', () => {
    const ci = gateStages('ci').map((candidate) => candidate.command);
    const required = REQUIRED_COMMANDS.filter((candidate) => !CI_ONLY_COMMANDS.includes(candidate));
    assert.deepEqual(ci.toSorted(), required.toSorted());
    for (const only of CI_ONLY_COMMANDS) assert.ok(REQUIRED_COMMANDS.includes(only), only);
  });

  // Break caught: the local profile running every package at once (which starves the workers of this workstation), or CI's profile running
  // the lower-concurrency one (which is slower and not what CI runs).
  it('run the lower-concurrency suite in the local profile and CI’s in the other', () => {
    const local = gateStages('local');
    const ci = gateStages('ci');
    assert.equal(
      local.find((candidate) => candidate.name === 'unit')?.command,
      'pnpm run test:local --continue',
    );
    assert.equal(ci.find((candidate) => candidate.name === 'unit')?.command, 'pnpm run test');
    assert.deepEqual(
      local.filter((candidate) => candidate.name !== 'unit'),
      ci.filter((candidate) => candidate.name !== 'unit'),
    );
  });

  // Break caught: a stage that names a script that is not there (a rename that left the gate pointing at nothing).
  it('name only commands that exist', () => {
    const packages = workspaceScripts(root);
    for (const profile of ['local', 'ci'] as const) {
      for (const candidate of gateStages(profile)) {
        assert.equal(pnpmCommandProblem(candidate.command, packages), undefined, candidate.command);
      }
    }
  });

  // Break caught: a test stage before a cheap check (an hour spent before a stale client is found), or a stage that reads a build and does
  // not say so, or two stages with one name (one log would overwrite the other).
  it('put every cheap check before every test, name their dependencies and have unique names', () => {
    const stages = gateStages('local');
    const names = stages.map((candidate) => candidate.name);
    assert.equal(new Set(names).size, names.length);
    const firstTest = stages.findIndex((candidate) => candidate.kind === 'test');
    assert.ok(firstTest > 0);
    assert.ok(stages.slice(firstTest).every((candidate) => candidate.kind === 'test'));
    assert.equal(stages.find((candidate) => candidate.name === 'contract')?.needs, 'build');
    assert.ok(names.indexOf('build') < names.indexOf('contract'));
  });
});

describe('the precheck', () => {
  // Break caught: a precheck that runs a different command from the gate (so that it can pass what the gate fails for a reason other than
  // its cache), or one that drops a cheap check; or (the owner's decision of 27 October 2026) one that leaves the dependency audit, which
  // takes seconds, to the gate alone.
  it('runs the cheap commands of the gate and its dependency audit, with the tools’ own cache flags and nothing else', () => {
    const gate = new Map(gateStages('ci').map((candidate) => [candidate.name, candidate.command]));
    const cheap = [
      ...gateStages('ci')
        .filter((candidate) => candidate.kind === 'static')
        .map((candidate) => candidate.name),
      'audit',
    ];
    // (Run 6, Stage 5.3: the lane of the root guards is the precheck's own, and is compared with nothing of the gate's: the gate's unit stage runs every root test. It has its own
    // tests below. What stays held here: every other lane is the gate's command, with the tools' own cache flags and nothing else.)
    const cached = precheckLanes(false)
      .flat()
      .filter((candidate) => candidate.name !== 'guards');
    assert.deepEqual(cached.map((candidate) => candidate.name).toSorted(), cheap.toSorted());
    for (const candidate of cached) {
      const real = defined(gate.get(candidate.name), candidate.name);
      if (candidate.command === real) continue;
      assert.ok(candidate.command.startsWith(`${real} --cache `), candidate.command);
      assert.ok(candidate.command.includes(`${PRECHECK_CACHE}/`), candidate.command);
    }
    assert.deepEqual(
      precheckLanes(true)
        .flat()
        .filter((candidate) => candidate.name !== 'guards')
        .map((candidate) => candidate.command)
        .toSorted(),
      cheap.map((name) => gate.get(name)).toSorted(),
    );
  });

  // Break caught (run 6, Stage 5.3): the root guards that read documents and styles (the design tokens, the lifecycle words, the links, the agent documents) left out of the precheck,
  // so that a document or a stylesheet that breaks one is found only by the final run of a task (run 5 found two of them there); or put into the gate as a stage of its own, which
  // the gate's unit stage already runs and the equivalence with CI's commands does not allow; or run in the same lane as another check (the precheck then costs their sum).
  it('has a lane of the root guards that read only files, beside the others, cached or not, and the gate has no stage for it', () => {
    for (const uncached of [false, true]) {
      const lanes = precheckLanes(uncached);
      const lane = lanes.find((candidate) => candidate.some((entry) => entry.name === 'guards'));
      assert.deepEqual(lane, [{ name: 'guards', kind: 'static', command: ROOT_GUARDS_COMMAND }]);
      assert.ok(lanes.length > 1, 'it runs beside the other lanes');
    }
    assert.ok(!gateStages('ci').some((stage) => stage.command === ROOT_GUARDS_COMMAND));
    assert.ok(!gateStages('local').some((stage) => stage.command === ROOT_GUARDS_COMMAND));
  });

  // Break caught: a guard named that does not exist (the lane then fails, or Node's runner finds no test to run and passes), one `test:root` does not run (the gate's unit stage
  // would never run it), a duplicate, or the lane that has lost one of the four guards the brief of run 6 names.
  it('names root tests that exist, that `test:root` runs, each once, among them the guards of documents and styles', () => {
    const manifestText = readFileSync(join(root, 'package.json'), 'utf8');
    const testRoot = String(
      (JSON.parse(manifestText) as { scripts: Record<string, string> }).scripts['test:root'],
    );
    assert.ok(ROOT_GUARDS.length >= 10, 'the lane holds the guards, not a token few');
    assert.equal(new Set(ROOT_GUARDS).size, ROOT_GUARDS.length);
    for (const guard of ROOT_GUARDS) {
      assert.ok(existsSync(join(root, guard)), `${guard} exists`);
      assert.ok(testRoot.split(/\s+/).includes(guard), `${guard} is run by test:root`);
    }
    for (const named of ['design-tokens', 'design-lifecycle', 'markdown-links', 'agent-docs']) {
      assert.ok(ROOT_GUARDS.includes(`scripts/${named}.test.ts`), `the lane holds ${named}`);
    }
    assert.equal(ROOT_GUARDS_COMMAND, `node --test ${ROOT_GUARDS.join(' ')}`);
  });

  // Break caught: the cache written into the tree (a file nobody meant to add, and one more path for the gate to hold still), or the checks
  // that read a build running before it.
  it('keeps its caches where Git does not look, and runs a check after the build it reads', () => {
    const ignored = spawnSync('git', ['check-ignore', '-q', `${PRECHECK_CACHE}/eslint`], {
      cwd: root,
    });
    assert.equal(ignored.status, 0, `${PRECHECK_CACHE} is not ignored by Git`);
    const lane = precheckLanes(false).find((candidate) =>
      candidate.some((entry) => entry.name === 'contract'),
    );
    assert.deepEqual(
      lane?.map((entry) => entry.name),
      ['typecheck', 'build', 'contract'],
    );
  });

  // Break caught: colour codes in the logs (an agent reads them with `grep` and gets noise), or turbo's cache left on in the gate (a gate
  // that proves what an earlier run proved), or forced off in the precheck (which then costs what the gate does).
  it('gives its commands plain logs, and turbo’s cache off for the gate and on for the precheck', () => {
    const base = { FORCE_COLOR: '1', TURBO_FORCE: 'false', PATH: '/bin' };
    const gate = childEnvironment(base, true);
    const precheck = childEnvironment({ ...base, TURBO_FORCE: 'true' }, false);
    assert.equal(gate.NO_COLOR, '1');
    assert.equal(gate.FORCE_COLOR, undefined);
    assert.equal(gate.TURBO_FORCE, 'true');
    assert.equal(precheck.NO_COLOR, '1');
    assert.equal(precheck.TURBO_FORCE, undefined);
    assert.equal(precheck.PATH, '/bin');
  });
});

describe('the tree the gate holds still', () => {
  // Break caught: ignored files counted (build output would void every gate), untracked files left out (a new file would go unseen), or a
  // tracked file that is gone from the disk listed as if it were there.
  it('is every file Git tracks or sees as new, not ignored, that is there', () => {
    const directory = checkout();
    rmSync(join(directory, 'b.txt'));
    assert.deepEqual(treeFiles(directory).toSorted(), ['.gitignore', 'a.txt', 'untracked.txt']);
  });

  it('has one digest for one content, which moves with a change and with nothing else', () => {
    const directory = checkout();
    const first = digestOf(snapshotTree(directory));
    assert.equal(digestOf(snapshotTree(directory)), first);
    writeFileSync(join(directory, 'ignored', 'x.txt'), 'changed but ignored\n');
    assert.equal(digestOf(snapshotTree(directory)), first);
    writeFileSync(join(directory, 'a.txt'), 'changed\n');
    assert.notEqual(digestOf(snapshotTree(directory)), first);
  });

  // Break caught: an edit, a removal or a new file not seen; or a file merely touched (the same bytes) taken for an edit.
  it('sees an edit, a removal and a new file, and not a touch', () => {
    const directory = checkout();
    const before = snapshotTree(directory);
    assert.deepEqual(changesSince(directory, before), []);

    const later = new Date(Date.now() + 60_000);
    utimesSync(join(directory, 'a.txt'), later, later);
    assert.deepEqual(changesSince(directory, before), []);

    writeFileSync(join(directory, 'a.txt'), 'edited\n');
    rmSync(join(directory, 'b.txt'));
    writeFileSync(join(directory, 'new.txt'), 'new\n');
    assert.deepEqual(changesSince(directory, before), ['a.txt', 'b.txt', 'new.txt']);
  });

  // Break caught: the watch during a stage tripping on a file a test makes and removes (an untracked file appears for a moment), which is
  // not an edit; the boundary check between stages is the one that asks about new files.
  it('is watched during a stage for the files that were there, and not for new ones', () => {
    const directory = checkout();
    const before = snapshotTree(directory);
    writeFileSync(join(directory, 'new.txt'), 'new\n');
    assert.deepEqual(baselineChanges(directory, before), []);
    writeFileSync(join(directory, 'a.txt'), 'edited\n');
    rmSync(join(directory, 'b.txt'));
    assert.deepEqual(baselineChanges(directory, before), ['a.txt', 'b.txt']);
  });

  // Break caught: a folder that is not a checkout taken for an empty tree, which nothing can change (every gate would pass as settled).
  it('is refused when the folder is not a Git checkout', async () => {
    const directory = temp('plain');
    // A temporary folder that sits inside some other checkout (a home folder under version control) is still no checkout of its own.
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = tmpdir();
    try {
      const run = await runGate(options(directory, { stages: passing() }));
      assert.match(refusal(run), /needs a Git checkout/);
      assert.equal(exitCodeOf(run), 2);
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    }
  });
});

describe('a gate', () => {
  // Break caught: a stage that passes recorded as failed (or the reverse), a log that does not say what ran, no record for a reader to find.
  it('runs every stage, once and in order, writes a log, a state and a summary, and passes when all pass', async () => {
    const directory = checkout();
    const given = options(directory, {
      stages: [
        stage('one', 'static', command('pass.mjs')),
        stage('two', 'test', command('pass.mjs')),
      ],
    });

    const run = await runGate(given);

    const state = finished(run);
    assert.equal(state.verdict, 'PASSED');
    assert.equal(exitCodeOf(run), 0);
    assert.deepEqual(
      state.stages.map((record) => [record.name, record.status, record.exitCode]),
      [
        ['one', 'passed', 0],
        ['two', 'passed', 0],
      ],
    );
    const log = readFileSync(join(state.dir, 'one.log'), 'utf8');
    assert.match(log, /^\$ .*pass\.mjs/);
    assert.match(log, /hello from the stage/);
    assert.equal(readState(state.dir)?.verdict, 'PASSED');
    assert.equal(latestGate(given.base), state.dir);
    const summary = readFileSync(join(state.dir, 'summary.txt'), 'utf8');
    assert.match(summary, /Gate test: PASSED/);
    assert.match(summary, /one\s+passed/);
    assert.match(summary, /two\s+passed/);
    assert.match(summary, /Test databases left behind: none/);
  });

  // Break caught: a failing cheap check that lets the tests start (an hour of tests of a tree that is not consistent), or one that stops the
  // other cheap checks (the developer then fixes one problem at a time).
  it('runs every cheap check and starts no test when one of them failed', async () => {
    const directory = checkout();
    const state = finished(
      await runGate(
        options(directory, {
          stages: [
            stage('first', 'static', command('fail.mjs')),
            stage('second', 'static', command('pass.mjs')),
            stage('tests', 'test', command('pass.mjs')),
          ],
        }),
      ),
    );

    assert.equal(state.verdict, 'FAILED');
    assert.equal(statusOf(state, 'first'), 'failed');
    assert.equal(statusOf(state, 'second'), 'passed');
    assert.equal(statusOf(state, 'tests'), 'not-run');
    assert.match(state.stages[2]?.note ?? '', /cheap check failed/);
    assert.equal(state.stages[0]?.exitCode, 3);
  });

  // Break caught: a failing test that hides the others (one run must show everything that is wrong), or a failure counted as a pass.
  it('runs every test whatever one of them did, and fails', async () => {
    const directory = checkout();
    const run = await runGate(
      options(directory, {
        stages: [
          stage('unit', 'test', command('fail.mjs')),
          stage('db', 'test', command('pass.mjs')),
        ],
      }),
    );

    const state = finished(run);
    assert.equal(state.verdict, 'FAILED');
    assert.equal(exitCodeOf(run), 1);
    assert.deepEqual(
      state.stages.map((record) => record.status),
      ['failed', 'passed'],
    );
  });

  // Break caught: the contract check run against a build that failed (a confusing second failure), or a dependency that is not honoured.
  it('skips a check whose build did not pass', async () => {
    const directory = checkout();
    const state = finished(
      await runGate(
        options(directory, {
          stages: [
            stage('build', 'static', command('fail.mjs')),
            stage('contract', 'static', command('pass.mjs'), 'build'),
          ],
        }),
      ),
    );

    assert.deepEqual(
      state.stages.map((record) => record.status),
      ['failed', 'skipped'],
    );
    assert.equal(state.verdict, 'FAILED');
  });

  // Break caught (run 5, Stage 1.4): the gate sharing the precheck's reading of a check that could not decide, and so passing a tree whose migrations it never held. The gate is the
  // full run: the exit the precheck shows as warned is a failure here, with its exit code recorded, and no test starts.
  it('fails a check that could not decide, whatever the precheck makes of that exit, and starts no test', async () => {
    const directory = checkout();
    const state = finished(
      await runGate(
        options(directory, {
          stages: [
            { ...stage('migrations', 'static', command('undecided.mjs')), warnOnExit: 2 },
            stage('tests', 'test', command('pass.mjs')),
          ],
        }),
      ),
    );

    assert.equal(state.verdict, 'FAILED');
    assert.equal(statusOf(state, 'migrations'), 'failed');
    assert.equal(state.stages[0]?.exitCode, 2);
    assert.equal(statusOf(state, 'tests'), 'not-run');
  });

  // Break caught: a command that is not there reported as a pass, or taking the runner down with it.
  it('records a command that is not found as a failure and goes on', async () => {
    const directory = checkout();
    const state = finished(
      await runGate(
        options(directory, {
          stages: [
            stage('missing', 'test', 'melarc-no-such-command-anywhere'),
            stage('after', 'test', command('pass.mjs')),
          ],
        }),
      ),
    );

    assert.equal(statusOf(state, 'missing'), 'failed');
    assert.notEqual(state.stages[0]?.exitCode, 0);
    assert.equal(statusOf(state, 'after'), 'passed');
    assert.equal(state.verdict, 'FAILED');
  });
});

describe('a gate on a tree that changes', () => {
  // Break caught: the gate that goes on, and passes, after a file it was holding still was edited: the result then says nothing of the tree
  // that exists. The running stage is ended at once, the later ones do not start, and the verdict is not a pass.
  it(
    'ends the stage that was running when a file of the tree is edited, and starts no other',
    { timeout: 60_000 },
    async () => {
      const directory = checkout();
      const run = await runGate(
        options(directory, {
          stages: [
            stage('editing', 'test', command('edit.mjs', join(directory, 'a.txt'))),
            stage('later', 'test', command('pass.mjs')),
          ],
        }),
      );

      const state = finished(run);
      assert.equal(state.verdict, 'UNSETTLED');
      assert.equal(exitCodeOf(run), 3);
      assert.equal(statusOf(state, 'editing'), 'interrupted');
      assert.equal(statusOf(state, 'later'), 'not-run');
      assert.deepEqual(state.unsettled, { during: 'editing', paths: ['a.txt'] });
      assert.match(
        readFileSync(join(state.dir, 'summary.txt'), 'utf8'),
        /proves nothing about any tree/,
      );
    },
  );

  // Break caught: a new file between two stages going unseen (a test file added mid-run would be in no result).
  it('asks between stages about new files too', async () => {
    const directory = checkout();
    const state = finished(
      await runGate(
        options(directory, {
          stages: [
            stage('making', 'test', command('make.mjs', join(directory, 'new.txt'))),
            stage('later', 'test', command('pass.mjs')),
          ],
        }),
      ),
    );

    assert.equal(state.verdict, 'UNSETTLED');
    assert.deepEqual(state.unsettled, { during: 'making', paths: ['new.txt'] });
    assert.equal(statusOf(state, 'later'), 'not-run');
  });

  // Break caught: a test that makes a file and removes it again voiding every gate that runs it.
  it('does not take a file that a stage makes and removes for an edit', async () => {
    const directory = checkout();
    const state = finished(
      await runGate(
        options(directory, {
          stages: [stage('transient', 'test', command('transient.mjs', join(directory, 't.txt')))],
        }),
      ),
    );

    assert.equal(state.verdict, 'PASSED');
    assert.equal(state.unsettled, null);
  });
});

describe('stopping a gate', () => {
  // Break caught: a stop that leaves the stage's process tree running (the orphans that held the machine's memory), or that is not
  // recorded as a stop. The runner is a process of its own, as it is when a developer runs `pnpm run gate`.
  it(
    'ends the stage and everything it started, and says the gate was stopped',
    { timeout: 90_000 },
    async () => {
      const directory = checkout();
      const base = temp('base');
      const alive = join(temp('alive'), 'alive.txt');
      const runner = start(
        'runner.mjs',
        gateModule,
        directory,
        base,
        'stopme',
        JSON.stringify([
          stage('slow', 'test', command('slow.mjs', alive)),
          stage('later', 'test', command('pass.mjs')),
        ]),
      );
      await until(
        () => existsSync(alive),
        () => `the stage to start: ${runner.output()}`,
      );

      const messages: string[] = [];
      const code = await stopGate({
        base,
        graceMs: 20_000,
        pollMs: 50,
        log: (line) => {
          messages.push(line);
        },
      });
      const exit = await exitOf(runner);

      assert.equal(code, 0);
      assert.equal(exit, 130, runner.output());
      const state = defined(readState(join(base, 'stopme')), 'the state');
      assert.equal(state.verdict, 'INTERRUPTED');
      assert.equal(statusOf(state, 'slow'), 'interrupted');
      assert.equal(statusOf(state, 'later'), 'not-run');
      assert.deepEqual(messages, ['Stop requested for gate stopme.', 'The gate stopped.']);
      await assertStopped(alive, 'the stage');
    },
  );

  // Break caught: a runner that no longer answers (hung, or killed with its child still running) leaving the stage and itself for the
  // developer to find: after the grace period both are ended. The "runner" here never reads a stop request.
  it(
    'ends the stage and the runner itself when the runner does not answer',
    { timeout: 90_000 },
    async () => {
      const base = temp('base');
      const alive = join(temp('alive'), 'alive.txt');
      const runner = start('stuck-runner.mjs', base, alive);
      await until(
        () => existsSync(alive) && existsSync(join(base, 'stuck', 'state.json')),
        () => `the stuck runner to start: ${runner.output()}`,
      );
      const runnerPid = defined(runner.child.pid, 'the runner’s process');

      const messages: string[] = [];
      const code = await stopGate({
        base,
        graceMs: 300,
        pollMs: 50,
        log: (line) => {
          messages.push(line);
        },
      });
      assert.notEqual(await exitOf(runner, 10_000), 'still running', 'the runner was not ended');

      assert.equal(code, 0);
      assert.match(messages.join(' '), /did not stop in time/);
      assert.equal(isAlive(runnerPid), false);
      await assertStopped(alive, 'the stage');
    },
  );

  // Break caught: a stop that ends a process because a record names it, when the runner that wrote the record is gone and the number may
  // belong to another process by now. It says what it found and ends nothing.
  it(
    'ends nothing when the runner of the record is already gone',
    { timeout: 60_000 },
    async () => {
      const gone = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
      assert.equal(gone.status, 0);
      const bystander = start('wait.mjs', '30000');
      try {
        const base = temp('base');
        // A runner that has ended: its number is free, and nothing is running under it. Its last stage is another process.
        recordGate(
          base,
          new Date().toISOString(),
          null,
          defined(gone.pid, 'the process that ended'),
          bystander.child.pid,
        );
        const messages: string[] = [];

        const code = await stopGate({
          base,
          graceMs: 100,
          pollMs: 20,
          log: (line) => {
            messages.push(line);
          },
        });

        assert.equal(code, 0);
        assert.match(messages.join(' '), /already gone/);
        assert.match(messages.join(' '), new RegExp(`process ${String(bystander.child.pid)}`));
        assert.equal(isAlive(defined(bystander.child.pid, 'the bystander')), true);
      } finally {
        killTree(defined(bystander.child.pid, 'the bystander'));
        await exitOf(bystander);
      }
    },
  );

  // Break caught: a stop that ends the process a stale record names. A runner that was ended long ago may have had its number given to
  // another process, and a number proves nothing: only a record that is being kept up to date names the runner.
  it(
    'ends nothing, and asks nothing, when the record has gone silent, whatever process has the number now',
    { timeout: 60_000 },
    async () => {
      const stranger = start('wait.mjs', '30000');
      try {
        const base = temp('base');
        const strangerPid = defined(stranger.child.pid, 'the stranger');
        recordGate(base, new Date(Date.now() - 120_000).toISOString(), null, strangerPid);
        const messages: string[] = [];

        const code = await stopGate({
          base,
          graceMs: 100,
          pollMs: 20,
          log: (line) => {
            messages.push(line);
          },
        });

        assert.equal(code, 0);
        assert.match(messages.join(' '), /has not reported for 30 seconds/);
        assert.equal(isAlive(strangerPid), true);
        assert.equal(
          existsSync(join(base, 'recorded', 'stop-requested')),
          false,
          'a stop was requested of a process that is not the runner',
        );
      } finally {
        killTree(defined(stranger.child.pid, 'the stranger'));
        await exitOf(stranger);
      }
    },
  );

  it('says so when no gate is running, and when the last one has ended', async () => {
    const directory = checkout();
    const given = options(directory, { stages: passing() });
    const messages: string[] = [];
    const log = (line: string): void => {
      messages.push(line);
    };

    assert.equal(await stopGate({ base: given.base, graceMs: 100, pollMs: 20, log }), 0);
    finished(await runGate(given));
    assert.equal(await stopGate({ base: given.base, graceMs: 100, pollMs: 20, log }), 0);

    assert.deepEqual(messages, ['No gate is running.', 'No gate is running.']);
  });

  // Break caught: Ctrl+C on the runner leaving the stage running on its own (a stage is a group of its own on Linux, so the terminal's
  // signal does not reach it). Windows has no such signal to send to a process: it would only end the runner.
  it(
    'ends the stage when the runner is sent an interrupt',
    {
      timeout: 90_000,
      skip: process.platform === 'win32' ? 'Windows cannot send a process an interrupt' : false,
    },
    async () => {
      const directory = checkout();
      const base = temp('base');
      const alive = join(temp('alive'), 'alive.txt');
      const runner = start(
        'runner.mjs',
        gateModule,
        directory,
        base,
        'interrupted',
        JSON.stringify([stage('slow', 'test', command('slow.mjs', alive))]),
      );
      await until(
        () => existsSync(alive),
        () => `the stage to start: ${runner.output()}`,
      );

      runner.child.kill('SIGINT');
      const exit = await exitOf(runner);

      assert.equal(exit, 130, runner.output());
      const state = defined(readState(join(base, 'interrupted')), 'the state');
      assert.equal(state.verdict, 'INTERRUPTED');
      await assertStopped(alive, 'the stage');
    },
  );
});

describe('refusing to start', () => {
  // Break caught: a gate started with too little memory free, whose failures would be the machine's (a process that cannot start) and
  // would be read as the code's; and the way out, which is a choice and not a default.
  it('is what a machine with too little free memory gets, unless the developer says otherwise', async () => {
    const directory = checkout();
    const low = (): number => MEMORY_REFUSE_MB - 1;
    const refused = await runGate(options(directory, { stages: passing(), freeMb: low }));
    assert.match(refusal(refused), /--allow-low-memory/);
    assert.equal(exitCodeOf(refused), 2);

    const allowed = finished(
      await runGate(options(directory, { stages: passing(), freeMb: low, allowLowMemory: true })),
    );
    assert.equal(allowed.verdict, 'PASSED');
    assert.match(allowed.warnings.join(' '), /memory was free at the start/);
  });

  it('warns, and runs, when memory is short but not too short', async () => {
    const directory = checkout();
    const state = finished(
      await runGate(options(directory, { stages: passing(), freeMb: () => 3000 })),
    );
    assert.equal(state.verdict, 'PASSED');
    assert.match(state.warnings.join(' '), /memory was free at the start/);
    assert.match(renderSummary(state), /Warning:/);
  });

  // Break caught: two gates on one machine (each fails for the load of the other); and a gate that never ran again after one was killed.
  it('is what a second gate gets while one is running, and not when its runner is silent', async () => {
    const directory = checkout();
    const given = options(directory, { stages: passing() });

    recordGate(given.base, new Date().toISOString(), null);
    assert.match(refusal(await runGate(given)), /A gate is running/);

    recordGate(given.base, new Date(Date.now() - 120_000).toISOString(), null);
    assert.equal(finished(await runGate({ ...given, name: 'second' })).verdict, 'PASSED');
  });

  // Break caught: a gate started with the database down, which finds that out at the db stage some thirty minutes in. The check is the
  // developer's own (`pnpm run infra:check`), and reaches the gate as the problems it found.
  it('is what a gate gets when the database does not answer, with every other reason at once', async () => {
    const directory = checkout();
    const down = (): string[] => ['the database does not answer'];

    const alone = await runGate(options(directory, { stages: passing(), preflight: down }));
    assert.match(refusal(alone), /the database does not answer/);
    assert.equal(exitCodeOf(alone), 2);

    const given = options(directory, {
      stages: passing(),
      preflight: down,
      freeMb: () => MEMORY_REFUSE_MB - 1,
    });
    const together = refusal(await runGate(given));
    assert.match(together, /the database does not answer/);
    assert.match(together, /--allow-low-memory/);
    assert.equal(existsSync(join(given.base, given.name)), false, 'a refused gate left a folder');
  });

  it('is what a name that is not a name, or one that is taken, gets', async () => {
    const directory = checkout();
    const given = options(directory, { stages: passing() });
    assert.match(refusal(await runGate({ ...given, name: '../escape' })), /is not a name/);
    finished(await runGate(given));
    assert.match(refusal(await runGate({ ...given, name: 'test' })), /already exists/);
  });
});

describe('what a gate records', () => {
  // Break caught: a stage that died at process start under memory pressure that nothing in the record connects to the memory. The free
  // memory here follows a file the heavy stage makes, so that what is recorded does not depend on how fast the machine starts a process.
  it('keeps the lowest free memory of each stage, and where it was', async () => {
    const directory = checkout();
    const marker = join(temp('marker'), 'heavy-started');
    const state = finished(
      await runGate(
        options(directory, {
          stages: [
            stage('light', 'static', command('pass.mjs')),
            stage('heavy', 'test', command('wait.mjs', '600', marker)),
          ],
          freeMb: () => (existsSync(marker) ? 1500 : 8000),
        }),
      ),
    );

    assert.equal(state.stages[0]?.lowestFreeMb, 8000);
    assert.equal(state.stages[1]?.lowestFreeMb, 1500);
    assert.equal(state.lowestFreeMb, 1500);
    assert.equal(state.lowestFreeDuring, 'heavy');
    assert.match(renderSummary(state), /lowest 1\.5 GB \(during heavy\)/);
  });

  // Break caught: leftover test databases unreported, or reported as the gate's when they were there before it began.
  it('lists the test databases that were left, and the ones that are new', async () => {
    const directory = checkout();
    const lists = [['melarc_test_aaaa1111'], ['melarc_test_aaaa1111', 'melarc_test_bbbb2222']];
    const state = finished(
      await runGate(
        options(directory, {
          stages: passing(),
          listOrphans: () => lists.shift() ?? null,
        }),
      ),
    );

    const summary = renderSummary(state);
    assert.match(summary, /melarc_test_aaaa1111, melarc_test_bbbb2222/);
    assert.match(summary, /new since the start: melarc_test_bbbb2222/);
    assert.match(summary, /never dropped here/);
  });

  it('says when the databases could not be listed, and does not fail for it', async () => {
    const directory = checkout();
    const state = finished(
      await runGate(options(directory, { stages: passing(), listOrphans: () => null })),
    );

    assert.equal(state.verdict, 'PASSED');
    assert.match(renderSummary(state), /could not be listed/);
  });
});

describe('what a gate proves for the affected run', () => {
  // Break caught: a stage that failed, did not run or was a cheap check recorded as proof, so that the affected run skips tests that never
  // passed on this tree; or a passed stage not recorded, so that the next affected run repeats what the gate has just shown.
  it('records the targets of each test stage that passed, on the tree it held, and nothing for the rest', async () => {
    const directory = checkout();
    const lines: string[] = [];
    const state = finished(
      await runGate(
        options(directory, {
          stages: [
            stage('dbcheck', 'static', command('pass.mjs')),
            stage('unit', 'test', command('pass.mjs')),
            stage('db', 'test', command('fail.mjs')),
            stage('e2e', 'test', command('pass.mjs')),
            stage('audit', 'test', command('pass.mjs')),
          ],
          recordProven: (finishedState, held) =>
            recordProvenTargets(directory, finishedState, held),
          log: (line) => lines.push(line),
        }),
      ),
    );

    assert.equal(state.verdict, 'FAILED');
    const proven = [...(GATE_STAGE_TARGETS.unit ?? []), ...(GATE_STAGE_TARGETS.e2e ?? [])];
    assert.deepEqual(provenTargets(state), proven);
    for (const target of TARGETS) {
      const recorded = baselineOf(directory, target);
      assert.equal(recorded !== undefined, proven.includes(target), `${target} recorded`);
      if (recorded === undefined) continue;
      assert.equal(recorded.record.by, 'gate test');
      // The tree as the gate held it: tracked and new files, never an ignored one.
      assert.deepEqual([...recorded.files.keys()].toSorted(), [
        '.gitignore',
        'a.txt',
        'b.txt',
        'untracked.txt',
      ]);
      assert.equal(recorded.files.get('a.txt'), digestOfText('a\n'));
    }
    assert.ok(
      lines.some((line) =>
        line.startsWith('Recorded for pnpm run test:affected as passed on this tree: root, '),
      ),
    );
  });

  // Break caught: a gate whose tree changed under it counted as proof for the tree it ended on.
  it('proves nothing when the tree changed while it ran', async () => {
    const directory = checkout();
    const state = finished(
      await runGate(options(directory, { stages: [stage('unit', 'test', command('pass.mjs'))] })),
    );
    assert.deepEqual(provenTargets(state), GATE_STAGE_TARGETS.unit);
    assert.deepEqual(
      provenTargets({ ...state, unsettled: { during: 'unit', paths: ['a.txt'] } }),
      [],
    );
  });

  // Break caught: a record that cannot be written turning a passed gate into a failed one, or ending it before it reports.
  it('says when the record could not be written, and keeps its verdict', async () => {
    const directory = checkout();
    const lines: string[] = [];
    const run = await runGate(
      options(directory, {
        stages: [stage('unit', 'test', command('pass.mjs'))],
        recordProven: () => {
          throw new Error('the disk is full');
        },
        log: (line) => lines.push(line),
      }),
    );
    assert.equal(finished(run).verdict, 'PASSED');
    assert.equal(exitCodeOf(run), 0);
    assert.ok(
      lines.some(
        (line) => line.includes('could not be recorded') && line.includes('the disk is full'),
      ),
    );
    assert.equal(existsSync(join(directory, BASELINE_FILE)), false);
  });
});

describe('looking at a gate', () => {
  // Break caught (the first real run): a gate that is still running said its databases "could not be listed", because they are listed
  // again only when it ends; the status of a running gate shows the ones that were there at the start and says when the rest comes.
  it('shows a running gate without claiming that its databases could not be listed', async () => {
    const directory = checkout();
    const state = finished(await runGate(options(directory, { stages: passing() })));
    const running: GateState = {
      ...state,
      verdict: null,
      endedAt: null,
      orphansBefore: ['melarc_test_aaaa1111'],
      orphansAfter: null,
    };

    const text = renderSummary(running);

    assert.match(
      text,
      /Test databases at the start: melarc_test_aaaa1111; listed again when the gate ends/,
    );
    assert.doesNotMatch(text, /could not be listed/);
    const unlisted = renderSummary({ ...running, orphansBefore: null });
    assert.match(unlisted, /not listed at the start/);
    assert.doesNotMatch(unlisted, /could not be listed/);
  });

  it('says that none has been started', () => {
    assert.equal(describeStatus(temp('empty')).text, 'No gate has been started on this machine.');
  });

  it('shows the latest gate, finished or not, and says when its runner is gone', async () => {
    const directory = checkout();
    const given = options(directory, { stages: passing() });
    const state = finished(await runGate(given));
    assert.match(describeStatus(given.base).text, /Gate test: PASSED/);

    writeFileSync(
      join(state.dir, 'state.json'),
      JSON.stringify({
        ...state,
        verdict: null,
        endedAt: null,
        updatedAt: new Date(Date.now() - 120_000).toISOString(),
      }),
    );
    const text = describeStatus(given.base).text;
    assert.match(text, /RUNNING/);
    assert.match(text, /runner of this gate is gone/);
  });

  // Break caught: a wait that returns at once (a busy loop of status calls), or never returns (a tool blocked for ever): it returns when
  // a stage ends, or at the limit.
  it('waits for the next stage to end, and no longer than it was told', async () => {
    const directory = checkout();
    const given = options(directory, { stages: passing() });
    const state = finished(await runGate(given));
    const record = (status: StageStatus): void => {
      writeFileSync(
        join(state.dir, 'state.json'),
        JSON.stringify({
          ...state,
          verdict: null,
          endedAt: null,
          runnerPid: process.pid,
          updatedAt: new Date().toISOString(),
          stages: state.stages.map((entry) => ({ ...entry, status })),
        }),
      );
    };
    record('running');
    assert.equal(isRunning(defined(readState(state.dir), 'the state')), true);

    const began = Date.now();
    const waiting = waitForProgress(given.base, 20, 20);
    await sleep(150);
    record('passed');
    await waiting;
    assert.ok(Date.now() - began < 10_000, 'the wait did not end with the stage');

    record('running');
    const limited = Date.now();
    await waitForProgress(given.base, 0.3, 20);
    assert.ok(Date.now() - limited < 10_000, 'the wait went past its limit');
  });
});

describe('the precheck run', () => {
  const given = (lanes: readonly (readonly Stage[])[], lines: string[]) => ({
    root: temp('root'),
    dir: temp('logs'),
    uncached: true,
    lanes,
    env: process.env,
    freeMb: () => 8192,
    log: (...entries: string[]) => {
      lines.push(...entries);
    },
    tailLines: 5,
  });

  // Break caught: lanes run one after the other (the precheck then costs the sum of its checks), or a failing check that is not shown with
  // the end of its log (the agent has to go and find it). The two lanes here pass only if both are running at the same time.
  it(
    'runs the lanes at the same time, the checks of a lane in order, and shows what failed',
    { timeout: 90_000 },
    async () => {
      const lines: string[] = [];
      const meeting = temp('meeting');
      const a = join(meeting, 'a');
      const b = join(meeting, 'b');
      const run = given(
        [
          [stage('lane-a', 'static', command('rendezvous.mjs', a, b, '20000'))],
          [stage('lane-b', 'static', command('rendezvous.mjs', b, a, '20000'))],
          [
            stage('broken', 'static', command('fail.mjs')),
            stage('after', 'static', command('pass.mjs'), 'broken'),
          ],
        ],
        lines,
      );

      const exit = await runPrecheck(run);

      assert.equal(exit, 1);
      const text = lines.join('\n');
      assert.match(text, /lane-a\s+passed/);
      assert.match(text, /lane-b\s+passed/);
      assert.match(text, /broken\s+failed/);
      assert.match(text, /after\s+skipped/);
      assert.match(text, /--- broken: the end of .*broken\.log/);
      assert.match(text, /the stage failed/);
      assert.match(text, /2 of 4 cheap checks did not pass/);
    },
  );

  it('exits 0 when every check passed', async () => {
    const lines: string[] = [];

    assert.equal(await runPrecheck(given([passing()], lines)), 0);
    assert.match(lines.join('\n'), /Every cheap check passed/);
  });

  // Break caught (run 5, Stage 1.4): a check that could not decide shown as "passed" with its warning in a log nobody opens (the migration guard on a tree with no main),
  // which let the precheck say it was all well. A check that marks an exit as "cannot tell" is shown as warned, with its words in the summary and the count, and the
  // precheck still exits 0; a check that did not mark that exit, or any other exit, is a failure.
  it('shows an exit a check marks as "cannot tell" as warned, with its message in the summary, and exits 0', async () => {
    const lines: string[] = [];
    const run = given(
      [
        [
          { ...stage('migrations', 'static', command('undecided.mjs')), warnOnExit: 2 },
          stage('other', 'static', command('pass.mjs')),
        ],
      ],
      lines,
    );

    const exit = await runPrecheck(run);

    assert.equal(exit, 0);
    const text = lines.join('\n');
    assert.match(text, /migrations\s+warned/);
    assert.match(text, /other\s+passed/);
    assert.match(text, /--- migrations: warned \(exit 2\)/);
    assert.match(text, /Cannot tell whether a migration was changed: There is no main/);
    assert.match(text, /1 warned/);
    assert.doesNotMatch(text, /Every cheap check passed\./, 'a warning is not a pass');
  });

  // Break caught: the mark read as "any non-zero exit is a warning", so that a check that failed with 2 for its own reasons is let through.
  it('fails a check that exits 2 without marking that exit, and one that exits something else', async () => {
    const lines: string[] = [];
    const unmarked = given([[stage('guard', 'static', command('undecided.mjs'))]], lines);
    assert.equal(await runPrecheck(unmarked), 1);
    assert.match(lines.join('\n'), /guard\s+failed/);

    const other: string[] = [];
    const marked = given(
      [[{ ...stage('guard', 'static', command('fail.mjs')), warnOnExit: 2 }]],
      other,
    );
    assert.equal(await runPrecheck(marked), 1, 'exit 3 is not the marked exit 2');
    assert.match(other.join('\n'), /guard\s+failed/);
  });

  // Break caught: the migration guard marked in the gate's list but not in the precheck's, or the real check not marked at all, so that the precheck says "passed" again.
  it('marks the migration check, and only it, as one whose exit 2 is a warning', () => {
    const marked = precheckLanes(false)
      .flat()
      .filter((candidate) => candidate.warnOnExit !== undefined)
      .map((candidate) => [candidate.name, candidate.warnOnExit]);

    assert.deepEqual(marked, [['migrations', 2]]);
    assert.deepEqual(
      gateStages('local').filter((candidate) => candidate.warnOnExit !== undefined),
      [],
      'the gate marks none: for it every exit but 0 fails',
    );
  });

  // Break caught: a refusal that is only said (the checks run all the same, beside the gate they were refused for).
  it('exits 2 and runs nothing when it is refused', async () => {
    const lines: string[] = [];
    const marker = join(temp('marker'), 'ran');
    const run = {
      ...given([[stage('one', 'static', command('wait.mjs', '1', marker))]], lines),
      refusal: () => 'A gate is running (x): wait for it.',
    };

    assert.equal(await runPrecheck(run), 2);
    assert.deepEqual(lines, ['A gate is running (x): wait for it.']);
    assert.equal(existsSync(marker), false, 'the precheck ran although it was refused');
  });
});

describe('the command line', () => {
  it('knows four commands and their options, and refuses the rest by name', () => {
    assert.deepEqual(parseArguments(['precheck']).problems, []);
    assert.deepEqual(parseArguments(['precheck', '--uncached']).problems, []);
    assert.deepEqual(
      parseArguments(['run', '--name', 'x', '--profile', 'ci', '--allow-low-memory']).problems,
      [],
    );
    assert.deepEqual(parseArguments(['status', '--wait', '60']).problems, []);
    assert.deepEqual(parseArguments(['stop']).problems, []);
    assert.match(parseArguments(['bogus']).problems.join(' '), /Unknown command "bogus"/);
    assert.match(parseArguments([]).problems.join(' '), /Unknown command ""/);
    assert.match(
      parseArguments(['stop', '--force']).problems.join(' '),
      /"--force" is not an option of stop/,
    );
    assert.match(
      parseArguments(['run', '--wait', '5']).problems.join(' '),
      /"--wait" is not an option of run/,
    );
    assert.match(parseArguments(['run', '--name']).problems.join(' '), /--name needs a value/);
  });

  /**
   * The entry point itself, in a process of its own with a temporary folder of its own: it does not read this machine's gate record.
   * By default it runs as the owner's terminal does, with no `CLAUDECODE`; `agent` runs it as an agent's shell does.
   */
  function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    return run(false, args);
  }
  function agent(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    return run(true, args);
  }
  function run(
    asAgent: boolean,
    args: readonly string[],
  ): { status: number | null; stdout: string; stderr: string } {
    const empty = temp('cli');
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: empty, TEMP: empty, TMP: empty };
    if (asAgent) env.CLAUDECODE = '1';
    else delete env.CLAUDECODE;
    const done = spawnSync(process.execPath, [gateModule, ...args], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    return { status: done.status, stdout: done.stdout, stderr: done.stderr };
  }

  // Break caught: the refusal of an agent wired into a function nobody calls, so the real command starts the gate anyway.
  it('refuses an agent that starts the gate without --asked, before it looks at anything else', () => {
    const refused = agent('run', '--profile', 'fast');
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /The gate is the owner's run/);
    // With --asked it goes on to judge the options, and refuses the profile for what it is.
    const asked = agent('run', '--asked', '--profile', 'fast');
    assert.equal(asked.status, 2);
    assert.match(asked.stderr, /--profile is local or ci/);
  });

  it('answers status when no gate was ever started', () => {
    const done = cli('status');
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /No gate has been started on this machine/);
  });

  // Break caught: an option that is wrong going on as if it were right (a gate started with the profile the developer did not mean).
  it('exits 2, and says why, for a command, a profile or a wait that is not one', () => {
    const unknown = cli('bogus');
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown command "bogus"/);
    assert.match(unknown.stderr, /Usage: node scripts\/gate\.ts/);

    const profile = cli('run', '--profile', 'fast');
    assert.equal(profile.status, 2);
    assert.match(profile.stderr, /--profile is local or ci/);

    const wait = cli('status', '--wait', 'soon');
    assert.equal(wait.status, 2);
    assert.match(wait.stderr, /--wait is a number of seconds/);
  });
});

describe('what the command line starts', () => {
  // Break caught: a safeguard dropped from the one place that wires them: a gate that does not look at the database, does not end its
  // stage on an interrupt, lets turbo answer from its cache, runs another list of stages from the one that is tested, or writes its
  // record somewhere other than the machine's gate folder.
  it('is every stage of the profile, with turbo’s cache off, interrupts handled and the database looked at', () => {
    const local = commandLineGate(root, 'local', 'x', false);
    assert.deepEqual(local.stages, gateStages('local'));
    assert.deepEqual(commandLineGate(root, 'ci', 'x', false).stages, gateStages('ci'));
    assert.equal(local.profile, 'local');
    assert.equal(local.root, root);
    assert.equal(local.base, gateBase());
    assert.equal(local.env.TURBO_FORCE, 'true');
    assert.equal(local.env.NO_COLOR, '1');
    assert.equal(local.handleSignals, true);
    assert.equal(typeof local.preflight, 'function');
    assert.equal(typeof local.recordProven, 'function');
    assert.equal(local.env.VITEST_MAX_WORKERS, undefined);
    assert.equal(local.allowLowMemory, false);
    assert.equal(commandLineGate(root, 'local', 'x', true).allowLowMemory, true);
  });

  // Break caught (review of 27 October 2026): `VITEST_MAX_WORKERS` reaching a suite, which Vitest applies to every project after its
  // configuration, so the API's one-at-a-time projects (process, database-alone) ran four at a time; or the variables the configurations
  // bound their workers by, and the JDK the attested enrolment test starts, dropped by Turborepo's strict environment.
  it('passes no VITEST_MAX_WORKERS, and lets through the bounds and the JDK the suites read', () => {
    const base = { PATH: '/bin', VITEST_MAX_WORKERS: '4' };
    assert.equal(gateEnvironment(base).VITEST_MAX_WORKERS, undefined);
    assert.equal(gateEnvironment(base).TURBO_FORCE, 'true');
    const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { passThroughEnv?: string[] }>;
    };
    const passed = (task: string): string[] => turbo.tasks[task]?.passThroughEnv ?? [];
    assert.ok(passed('test').includes('MELARC_TEST_WORKERS'));
    for (const name of ['MELARC_TEST_WORKERS', 'MELARC_DB_WORKERS', 'JAVA_HOME'])
      assert.ok(passed('test:db').includes(name), name);
    for (const task of Object.keys(turbo.tasks))
      assert.ok(!passed(task).includes('VITEST_MAX_WORKERS'), task);
  });

  // Break caught: a `MELARC_BROWSER_SHARD` left in the owner's shell (from reproducing one job of CI) reaching the browser stage, which
  // the Ops Portal's configuration would then run as one shard of its engine: a gate that is green for a part of the browser tests.
  it('passes no MELARC_BROWSER_SHARD, which would make the browser stage run a part of its tests', () => {
    const base = { PATH: '/bin', MELARC_BROWSER_SHARD: '2/7', MELARC_BROWSERS: 'chromium' };
    const env = gateEnvironment(base);
    assert.equal(env.MELARC_BROWSER_SHARD, undefined);
    assert.equal(env.MELARC_BROWSERS, 'chromium', 'only the shard is taken out');
  });

  // Break caught (task CI.2): a `MELARC_DB_SHARD` or a `MELARC_SKIP_TIMING_TESTS` left in the owner's shell (from reproducing a job of CI)
  // reaching the database stage, which the API's configuration would then run as one shard of its files, or without the tests whose bounds
  // are wall-clock time: a gate that is green for a part of the database tests.
  it('passes no MELARC_DB_SHARD and no MELARC_SKIP_TIMING_TESTS, which would make the database stage run a part of its files', () => {
    const base = {
      PATH: '/bin',
      MELARC_DB_SHARD: '2/8',
      MELARC_SKIP_TIMING_TESTS: '1',
      MELARC_DB_WORKERS: '3',
    };
    const env = gateEnvironment(base);
    assert.equal(env.MELARC_DB_SHARD, undefined);
    assert.equal(env.MELARC_SKIP_TIMING_TESTS, undefined);
    assert.equal(env.MELARC_DB_WORKERS, '3', 'only the two variables of the CI jobs are taken out');
  });

  // Break caught: an agent starting the hour-long gate the owner did not ask for; or the owner's own terminal, which Claude Code does
  // not mark, being asked for a flag.
  it('refuses an agent that does not say the owner asked, and asks nothing of the owner', () => {
    assert.match(agentRefusal({ CLAUDECODE: '1' }, false) ?? '', /The gate is the owner's run/);
    assert.equal(agentRefusal({ CLAUDECODE: '1' }, true), undefined);
    assert.equal(agentRefusal({}, false), undefined);
    assert.equal(agentRefusal({ CLAUDECODE: '' }, false), undefined);
    assert.equal(parseArguments(['run', '--asked']).flags.get('--asked'), true);
    assert.match(
      parseArguments(['status', '--asked']).problems.join(),
      /is not an option of status/,
    );
  });

  // Break caught (review of 27 October 2026): `pnpm run gate:status -- --wait 0` refused in Git Bash, where pnpm passes the `--` on.
  it('takes a `--` for nothing', () => {
    const parsed = parseArguments(['status', '--', '--wait', '0']);
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.flags.get('--wait'), '0');
  });

  // Break caught: a gate started beside an affected run, which shares its browsers' ports, its roles, its build and the memory; or the
  // refusal written and never wired into the gate the command line starts.
  it('will not start beside an affected run', () => {
    const runs = temp('affected');
    const { preflight } = commandLineGate(
      root,
      'local',
      'x',
      false,
      runs,
      command('pass.mjs'),
      () => USABLE_JDK,
    );
    assert.ok(preflight !== undefined);
    assert.deepEqual(preflight(), []);
    const stop = markRunning(runs);
    try {
      assert.match(preflight().join(), /An affected run is running \(process \d+/);
    } finally {
      stop();
    }
    assert.deepEqual(affectedProblems(undefined), []);
    const problems = affectedProblems({
      pid: 4242,
      startedAt: '2026-10-27T12:00:00.000Z',
      updatedAt: '2026-10-27T12:00:05.000Z',
    });
    assert.match(problems.join(), /An affected run is running \(process 4242/);
  });

  it('looks at the database with the developer’s own check, which exists', () => {
    assert.equal(pnpmCommandProblem(DATABASE_CHECK, workspaceScripts(root)), undefined);
  });

  // Break caught: a failing check that lets the gate start (an hour spent before the database is found missing), or a passing one that
  // stops it.
  it('has no problem when the check passes, and the way out when it fails', () => {
    assert.deepEqual(databaseProblems(root, command('pass.mjs')), []);
    const failed = databaseProblems(root, command('fail.mjs')).join(' ');
    assert.match(failed, /The database does not answer/);
    assert.match(failed, /pnpm run infra:up/);
    assert.match(failed, /The developer starts the database/);
    assert.notDeepEqual(databaseProblems(root, 'melarc-no-such-command-anywhere'), []);
  });

  // Break caught (27 October 2026): a gate started without the JDK that its verifier stage and the attested-enrolment test of its db
  // stage need, found out only after the cheap checks and the unit tests; or a usable JDK refused; or the check never wired in.
  it('has no problem with a usable JDK, and refuses to start without one, saying how to set it', () => {
    assert.deepEqual(jdkProblems(USABLE_JDK), []);
    const missing = {
      ok: false,
      problem: 'No JDK answers (`java -version` on the path failed). The verifier needs JDK 21.',
      installHelp: true,
    } as const;
    const problems = jdkProblems(missing).join(' ');
    assert.match(problems, /No JDK answers/);
    assert.match(
      problems,
      /The verifier stage, and the test of the db stage that starts the verifier/,
    );
    assert.match(problems, /JAVA_HOME/);
    const { preflight } = commandLineGate(
      root,
      'local',
      'x',
      false,
      temp('affected-jdk'),
      command('pass.mjs'),
      () => missing,
    );
    assert.ok(preflight !== undefined);
    assert.match(preflight().join(' '), /No JDK answers/);
  });

  // Break caught: a precheck started beside a gate (it builds and lints, so it starves the gate and rebuilds what the gate's stages
  // read), or one refused for a gate that has ended or whose runner has gone.
  it('is a precheck of the mode asked for, which a running gate refuses', () => {
    const base = temp('base');
    const cached = commandLinePrecheck(root, false, base);
    assert.deepEqual(cached.lanes, precheckLanes(false));
    assert.equal(cached.uncached, false);
    assert.deepEqual(commandLinePrecheck(root, true, base).lanes, precheckLanes(true));
    assert.equal(cached.dir, join(base, 'precheck'));

    assert.equal(cached.refusal?.(), undefined);
    recordGate(base, new Date().toISOString(), null);
    assert.match(cached.refusal?.() ?? '', /A gate is running \(recorded, process \d+\)/);
    recordGate(base, new Date().toISOString(), 'PASSED');
    assert.equal(cached.refusal?.(), undefined);
    recordGate(base, new Date(Date.now() - 120_000).toISOString(), null);
    assert.equal(cached.refusal?.(), undefined);
  });
});

const USABLE_JDK = {
  ok: true,
  jdk: { source: 'JAVA_HOME', major: 21, hasCompiler: true },
} as const;

describe('the agents are told', () => {
  const read = (path: string): string => readFileSync(join(root, path), 'utf8');
  const manifest: unknown = JSON.parse(read('package.json'));
  const scripts = isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};

  // Break caught: the commands dropped from the root manifest, or pointing at something else.
  it('through five commands of the root manifest that run the scripts', () => {
    assert.equal(scripts.precheck, 'node scripts/gate.ts precheck');
    assert.equal(scripts.gate, 'node scripts/gate.ts run');
    assert.equal(scripts['gate:status'], 'node scripts/gate.ts status');
    assert.equal(scripts['gate:stop'], 'node scripts/gate.ts stop');
    assert.equal(scripts['test:affected'], 'node scripts/affected.ts');
  });

  // Break caught: the pointer in the file every agent reads first deleted in a tidy-up, so that the loop lives in a document nobody is sent to;
  // and (27 October 2026) the rules that keep the gate the owner's run, and the worker variable out, dropped from it.
  it('through the root CLAUDE.md, which names the commands, links the loop and keeps the gate for the owner', () => {
    const text = read('CLAUDE.md');
    assert.ok(text.includes('`pnpm run precheck`'));
    assert.ok(text.includes('`pnpm run gate`'));
    assert.ok(text.includes('DEVELOPMENT.md#the-development-loop-and-the-gate'));
    const rule =
      text.split('\n').find((line) => line.startsWith('- Run checks in the loop of')) ?? '';
    assert.ok(rule.includes('`pnpm run test:affected`'));
    assert.ok(rule.includes('with `--asked`'));
    assert.ok(text.includes("the gate is the owner's run"));
    assert.ok(text.includes('- Set `VITEST_MAX_WORKERS`'));
  });

  it('through the rules of the folder that holds the scripts', () => {
    const text = read('scripts/CLAUDE.md');
    assert.ok(text.includes('`gate.ts`'));
    assert.ok(text.includes('`affected.ts`'));
  });

  // Break caught (review of 27 October 2026): the loop said one thing and the plan another. The plan's cadence still sent a task to whole
  // suites and to `TURBO_FORCE=true pnpm test`, and DEVELOPMENT.md sent its reader back to the plan for when to run them.
  it('through the loop of DEVELOPMENT.md and the testing cadence of the plan, which say the same', () => {
    const development = read('DEVELOPMENT.md');
    const start = development.indexOf('### The development loop and the gate');
    const loop = development.slice(start, development.indexOf('\n### ', start + 1));
    assert.ok(start >= 0);
    assert.ok(loop.includes('`pnpm run test:affected`'));
    assert.ok(loop.includes('`--asked`'));
    assert.ok(loop.includes('Never set `VITEST_MAX_WORKERS`'));
    assert.ok(!loop.includes('says when each run is due'));
    // Run 6, Stage 5.3: the precheck's lane of root guards, and the affected root and journey targets to run after a screen, a stylesheet or a journey's page changes (the finding
    // of run 5: five breakages the precheck cannot see were found only in the final run).
    assert.ok(loop.includes('`guards` lane'));
    assert.ok(loop.includes("After a screen, a stylesheet or a journey's page changes"));
    assert.ok(loop.includes('`pnpm run test:affected --only root,e2e --with-e2e`'));
    const plan = read('delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md');
    const cadence =
      plan.split(/\r?\n/).find((line) => line.startsWith('**Testing cadence**')) ?? '';
    assert.ok(cadence.includes('DEVELOPMENT.md#the-development-loop-and-the-gate'));
    assert.ok(cadence.includes('`pnpm run test:affected`'));
    assert.ok(!plan.includes('a verifying run uses'));
    assert.ok(!plan.includes('which commands count'));
  });
});
