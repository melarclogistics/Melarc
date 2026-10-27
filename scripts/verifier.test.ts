import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  checkJdk,
  findJdk,
  javaMajorOf,
  pinnedJavaMajor,
  type Run,
  type RunResult,
} from './jdk.ts';
import { GRADLE_TASKS, gradleInvocation, main, type Dependencies } from './verifier.ts';
import { stateFilePath, type ProcessDependencies } from './verifier-process.ts';

/** A program table: what each program answers. Paths are compared with forward slashes, whatever the platform joined them with. */
function runWith(table: Record<string, RunResult>): Run & { calls: string[] } {
  const calls: string[] = [];
  const run = ((file: string, args: readonly string[]) => {
    const name = file.replaceAll('\\', '/');
    calls.push(`${name} ${args.join(' ')}`);
    return table[name] ?? { status: null, output: '' };
  }) as Run & { calls: string[] };
  run.calls = calls;
  return run;
}

const JAVA_21: RunResult = {
  status: 0,
  output: 'openjdk version "21.0.12" 2026-07-21 LTS\nOpenJDK Runtime Environment',
};

describe('the versions it reads', () => {
  it('takes the major version out of what java prints', () => {
    assert.equal(javaMajorOf('openjdk version "21.0.12" 2026-07-21 LTS'), 21);
    assert.equal(javaMajorOf('openjdk version "21" 2026-09-16'), 21);
    assert.equal(javaMajorOf('java version "17.0.9" 2023-10-17 LTS'), 17);
    assert.equal(javaMajorOf('java version "1.8.0_402"'), 8, 'Java 8 calls itself 1.8');
    assert.equal(
      javaMajorOf('Picked up JAVA_TOOL_OPTIONS: -Xmx1g\nopenjdk version "21.0.12" 2026-07-21'),
      21,
    );
    assert.equal(javaMajorOf('command not found'), undefined);
    assert.equal(javaMajorOf(''), undefined);
  });

  it('takes the major version out of .java-version, which holds one exact version and nothing else', () => {
    assert.equal(pinnedJavaMajor('21.0.12\n'), 21);
    assert.equal(pinnedJavaMajor('25.1.3'), 25);
    for (const bad of [
      '21',
      '21.0',
      '21.0.12+8',
      '21.0.12.1',
      'v21.0.12',
      '^21.0.12',
      '',
      '21.0.12\n17.0.1',
    ]) {
      assert.equal(pinnedJavaMajor(bad), undefined, bad);
    }
  });
});

describe('finding the JDK', () => {
  const present = new Set<string>();
  const exists = (path: string): boolean => present.has(path.replaceAll('\\', '/'));

  it('uses JAVA_HOME when it is set, and only then', () => {
    present.clear();
    present.add('/jdk/bin/java');
    present.add('/jdk/bin/javac');
    const run = runWith({ '/jdk/bin/java': JAVA_21 });
    const jdk = findJdk({ JAVA_HOME: '/jdk' }, 'linux', run, exists);
    assert.deepEqual(jdk, { source: 'JAVA_HOME', major: 21, hasCompiler: true });
    assert.deepEqual(run.calls, ['/jdk/bin/java -version'], 'the path is not consulted');
  });

  it('does not fall back to the path when JAVA_HOME holds no java', () => {
    present.clear();
    const run = runWith({ java: JAVA_21, javac: { status: 0, output: 'javac 21.0.12' } });
    const jdk = findJdk({ JAVA_HOME: '/nowhere' }, 'linux', run, exists);
    assert.deepEqual(jdk, { source: 'JAVA_HOME', major: undefined, hasCompiler: false });
    assert.deepEqual(run.calls, []);
  });

  it('says a JRE has no compiler', () => {
    present.clear();
    present.add('/jre/bin/java');
    const jdk = findJdk(
      { JAVA_HOME: '/jre' },
      'linux',
      runWith({ '/jre/bin/java': JAVA_21 }),
      exists,
    );
    assert.equal(jdk.major, 21);
    assert.equal(jdk.hasCompiler, false);
  });

  it('names the programs by the platform', () => {
    present.clear();
    present.add('/jdk/bin/java.exe');
    present.add('/jdk/bin/javac.exe');
    const jdk = findJdk(
      { JAVA_HOME: '/jdk' },
      'win32',
      runWith({ '/jdk/bin/java.exe': JAVA_21 }),
      exists,
    );
    assert.deepEqual(jdk, { source: 'JAVA_HOME', major: 21, hasCompiler: true });
  });

  it('reads the path when JAVA_HOME is not set or is empty', () => {
    for (const env of [{}, { JAVA_HOME: '' }]) {
      const run = runWith({ java: JAVA_21, javac: { status: 0, output: 'javac 21.0.12' } });
      assert.deepEqual(findJdk(env, 'linux', run, exists), {
        source: 'PATH',
        major: 21,
        hasCompiler: true,
      });
    }
  });

  it('is not fooled by a java that failed or printed nothing it can read', () => {
    present.clear();
    assert.equal(
      findJdk(
        {},
        'linux',
        runWith({ java: { status: 1, output: 'openjdk version "21.0.12"' } }),
        exists,
      ).major,
      undefined,
    );
    assert.equal(
      findJdk({}, 'linux', runWith({ java: { status: 0, output: 'weird' } }), exists).major,
      undefined,
    );
    assert.equal(findJdk({}, 'linux', runWith({}), exists).major, undefined);
  });
});

describe('checking the JDK for what needs the verifier', () => {
  function pinned(pin: string): string {
    const root = mkdtempSync(join(tmpdir(), 'melarc-verifier-check-'));
    writeFileSync(join(root, '.java-version'), pin);
    return root;
  }

  // Break caught (27 October 2026): the gate or the affected run told that a JDK is usable where Gradle would refuse it, or the reverse.
  it('judges the JDK as test and build do, and says what is wrong', () => {
    const root = pinned('21.0.12\n');
    try {
      const good = runWith({ java: JAVA_21, javac: { status: 0, output: 'javac 21.0.12' } });
      assert.deepEqual(checkJdk(root, {}, 'linux', good), {
        ok: true,
        jdk: { source: 'PATH', major: 21, hasCompiler: true },
      });
      const cases: [string, Run, RegExp][] = [
        [
          'no java',
          runWith({}),
          /^No JDK answers \(`java -version` on the path failed\)\. The verifier needs JDK 21\.$/,
        ],
        [
          'java 17',
          runWith({
            java: { status: 0, output: 'openjdk version "17.0.9"' },
            javac: { status: 0, output: 'javac 17' },
          }),
          /is version 17; the verifier is built and tested with 21/,
        ],
        [
          'a JRE',
          runWith({ java: JAVA_21, javac: { status: 1, output: '' } }),
          /has no compiler \(a JRE\)/,
        ],
      ];
      for (const [what, run, expected] of cases) {
        const check = checkJdk(root, {}, 'linux', run);
        assert.ok(!check.ok, what);
        assert.match(check.problem, expected, what);
        assert.equal(check.installHelp, true, what);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the pin first, and runs no java when it cannot read it', () => {
    const root = pinned('21\n');
    try {
      const run = runWith({ java: JAVA_21 });
      assert.deepEqual(checkJdk(root, {}, 'linux', run), {
        ok: false,
        problem: '.java-version must contain one exact version such as 21.0.12.',
        installHelp: false,
      });
      assert.deepEqual(run.calls, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('starting Gradle', () => {
  it('runs the wrapper without a daemon, through sh on Linux and the batch file on Windows', () => {
    assert.deepEqual(gradleInvocation('linux', 'test'), {
      file: 'sh',
      args: ['./gradlew', '--no-daemon', '--console=plain', 'check'],
      shell: false,
    });
    // One command line for the shell, from fixed words, started from the verifier's folder (a shell does not look there by itself).
    assert.deepEqual(gradleInvocation('win32', 'build'), {
      file: '.\\gradlew.bat --no-daemon --console=plain installDist',
      args: [],
      shell: true,
    });
    assert.deepEqual(GRADLE_TASKS, { test: ['check'], build: ['installDist'] });
  });
});

describe('main', () => {
  function checkout(pin: string): string {
    const root = mkdtempSync(join(tmpdir(), 'melarc-verifier-'));
    writeFileSync(join(root, '.java-version'), pin);
    mkdirSync(join(root, 'apps', 'attestation-verifier'), { recursive: true });
    return root;
  }

  /** The process side of the script, for a test that must not reach it: every way in throws, but reading a file finds nothing. */
  function untouchedProcess(printed: string[]): ProcessDependencies {
    const unused = (): never => {
      throw new Error('the process side was used');
    };
    return {
      platform: 'linux',
      env: {},
      tmp: join('/', 'tmp'),
      now: () => new Date(0),
      exists: unused,
      read: () => undefined,
      write: unused,
      remove: unused,
      alive: unused,
      commandLineOf: unused,
      kill: unused,
      launch: unused,
      ask: unused,
      sleep: unused,
      tail: unused,
      print: (line) => printed.push(line),
    };
  }

  function dependencies(options: { run: Run; env?: NodeJS.ProcessEnv; gradleStatus?: number }): {
    deps: Dependencies;
    printed: string[];
    gradleCalls: { file: string; args: string[]; cwd: string }[];
  } {
    const printed: string[] = [];
    const gradleCalls: { file: string; args: string[]; cwd: string }[] = [];
    return {
      printed,
      gradleCalls,
      deps: {
        env: options.env ?? {},
        platform: 'linux',
        run: options.run,
        gradle: (invocation, cwd) => {
          gradleCalls.push({ file: invocation.file, args: invocation.args, cwd });
          return Promise.resolve(options.gradleStatus ?? 0);
        },
        print: (line) => printed.push(line),
        process: untouchedProcess(printed),
      },
    };
  }

  const goodPath = (): Run =>
    runWith({ java: JAVA_21, javac: { status: 0, output: 'javac 21.0.12' } });

  it('runs Gradle in the verifier folder with the tasks of the command', async () => {
    const root = checkout('21.0.12\n');
    try {
      const { deps, gradleCalls, printed } = dependencies({ run: goodPath() });
      assert.equal(await main(['test'], root, deps), 0);
      assert.deepEqual(gradleCalls, [
        {
          file: 'sh',
          args: ['./gradlew', '--no-daemon', '--console=plain', 'check'],
          cwd: join(root, 'apps', 'attestation-verifier'),
        },
      ]);
      assert.match(printed.join('\n'), /Gradle check with JDK 21 \(PATH\)/);
      assert.equal(await main(['build'], root, dependencies({ run: goodPath() }).deps), 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when Gradle fails, whatever its status', async () => {
    const root = checkout('21.0.12\n');
    try {
      for (const gradleStatus of [1, 2, 137, -1]) {
        assert.equal(
          await main(['test'], root, dependencies({ run: goodPath(), gradleStatus }).deps),
          1,
          String(gradleStatus),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('will not start without a JDK of the pinned major version, and says how to get one', async () => {
    const root = checkout('21.0.12\n');
    try {
      const cases: Record<string, Run> = {
        'no java': runWith({}),
        'java 17': runWith({
          java: { status: 0, output: 'openjdk version "17.0.9"' },
          javac: { status: 0, output: 'javac 17' },
        }),
        'a JRE': runWith({ java: JAVA_21, javac: { status: 1, output: '' } }),
      };
      for (const [what, run] of Object.entries(cases)) {
        const { deps, printed, gradleCalls } = dependencies({ run });
        assert.equal(await main(['test'], root, deps), 2, what);
        assert.deepEqual(gradleCalls, [], `${what}: Gradle ran without a JDK`);
        assert.match(printed.join('\n'), /winget install EclipseAdoptium\.Temurin\.21\.JDK/, what);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says what is running without a JDK, and ends nothing when nothing runs', async () => {
    const root = checkout('21.0.12\n');
    try {
      for (const [command, message] of [
        ['status', /is not running/],
        ['stop', /No verifier started from here is running/],
      ] as const) {
        const { deps, printed, gradleCalls } = dependencies({ run: runWith({}) });
        assert.equal(await main([command], root, deps), 0, command);
        assert.match(printed.join('\n'), message);
        assert.deepEqual(gradleCalls, [], `${command} built something`);
      }
      assert.ok(stateFilePath('/tmp').endsWith('state.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds before it starts, and starts nothing when there is no JDK to build with', async () => {
    const root = checkout('21.0.12\n');
    try {
      const { deps, printed, gradleCalls } = dependencies({ run: runWith({}) });
      assert.equal(await main(['start'], root, deps), 2);
      assert.match(printed.join('\n'), /winget install EclipseAdoptium.Temurin.21.JDK/);
      assert.deepEqual(gradleCalls, []);
      // With a JDK it builds (installDist) and goes on to the process side, which finds no start script in a folder that holds none.
      const good = dependencies({ run: goodPath() });
      assert.equal(await main(['start'], root, good.deps), 1);
      assert.match(good.printed.join('\n'), /left no start script/);
      assert.deepEqual(
        good.gradleCalls.map((call) => call.args.at(-1)),
        ['installDist'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an unknown command and a pin it cannot read', async () => {
    const root = checkout('21.0.12\n');
    const bad = checkout('twenty-one\n');
    try {
      for (const args of [
        [],
        ['deploy'],
        ['test', 'extra'],
        ['--help'],
        ['toString'],
        ['constructor'],
      ]) {
        const { deps, gradleCalls } = dependencies({ run: goodPath() });
        assert.equal(await main(args, root, deps), 2, args.join(' '));
        assert.deepEqual(gradleCalls, []);
      }
      const { deps, gradleCalls } = dependencies({ run: goodPath() });
      assert.equal(await main(['test'], bad, deps), 2);
      assert.deepEqual(gradleCalls, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bad, { recursive: true, force: true });
    }
  });
});
