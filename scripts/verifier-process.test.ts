import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  childEnvironment,
  looksLikeTheVerifier,
  parseState,
  portOf,
  jvmOptionsOf,
  launchPlan,
  settingsFrom,
  startVerifier,
  statusVerifier,
  stateFilePath,
  stopVerifier,
  INSTALL_DIRECTORY,
  MAIN_CLASS,
  type ProcessDependencies,
  type StatusAnswer,
} from './verifier-process.ts';

const ROOT = join('/', 'checkout');
const INSTALL = join(ROOT, INSTALL_DIRECTORY);
const TMP = join('/', 'tmp');
const SECRET = 'S'.repeat(43);
const STATE = stateFilePath(TMP);

/** The two start scripts Gradle writes, as far as the options go: the same words, spelled the way each script spells them. */
const POSIX_SCRIPT = `#!/bin/sh\nDEFAULT_JVM_OPTS='"-Xms64m" "-Xmx384m" "-XX:+ExitOnOutOfMemoryError"'\nexec java $DEFAULT_JVM_OPTS\n`;
const WINDOWS_SCRIPT = `@rem start script\r\nset DEFAULT_JVM_OPTS="-Xms64m" "-Xmx384m" "-XX:+ExitOnOutOfMemoryError"\r\n`;
const OPTIONS = ['-Xms64m', '-Xmx384m', '-XX:+ExitOnOutOfMemoryError'];

/** A machine in memory: files, processes, a clock that only `sleep` moves. */
function machine(
  options: {
    files?: Record<string, string>;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    answers?: (attempt: number) => StatusAnswer | undefined;
    launches?: boolean;
    lives?: boolean;
    /** Whether something answers on the port before the service is launched (a service started elsewhere). */
    answersAlways?: boolean;
  } = {},
) {
  const files = new Map(Object.entries(options.files ?? {}));
  const alive = new Set<number>();
  const commandLines = new Map<number, string>();
  const killed: number[] = [];
  const launched: {
    start: { file: string; args: string[] };
    cwd: string;
    env: NodeJS.ProcessEnv;
    log: string;
  }[] = [];
  const printed: string[] = [];
  let clock = 1_000_000;
  let asked = 0;
  let nextPid = 4000;
  const platform = options.platform ?? 'linux';
  const script = join(
    INSTALL,
    'bin',
    platform === 'win32' ? 'attestation-verifier.bat' : 'attestation-verifier',
  );
  if (options.files?.[script] === undefined && options.launches !== false)
    files.set(script, platform === 'win32' ? WINDOWS_SCRIPT : POSIX_SCRIPT);

  const deps: ProcessDependencies = {
    platform,
    env: options.env ?? { PATH: '/bin', JAVA_HOME: '/jdk' },
    tmp: TMP,
    now: () => new Date(clock),
    exists: (path) => files.has(path),
    read: (path) => files.get(path),
    write: (path, text) => {
      files.set(path, text);
    },
    remove: (path) => {
      files.delete(path);
    },
    alive: (pid) => alive.has(pid),
    commandLineOf: (pid) => commandLines.get(pid),
    kill: (pid) => {
      killed.push(pid);
      if (options.lives !== true) alive.delete(pid);
    },
    launch: (start, cwd, env, log) => {
      if (options.launches === false) return undefined;
      const pid = nextPid++;
      launched.push({ start, cwd, env, log });
      alive.add(pid);
      commandLines.set(
        pid,
        `java -classpath ${INSTALL}/lib/service.jar com.melarc.attestation.MainKt`,
      );
      return pid;
    },
    ask: () => {
      asked += 1;
      if (launched.length === 0 && options.answersAlways !== true)
        return Promise.resolve(undefined);
      return Promise.resolve(options.answers?.(asked));
    },
    sleep: (milliseconds) => {
      clock += milliseconds;
      return Promise.resolve();
    },
    tail: () => ['the last log line'],
    print: (line) => {
      printed.push(line);
    },
  };
  return {
    deps,
    files,
    alive,
    commandLines,
    killed,
    launched,
    printed,
    setClock: (value: number) => (clock = value),
  };
}

const ready: StatusAnswer = {
  httpStatus: 200,
  state: 'READY',
  trustDataAgeSeconds: 12.4,
  inFlight: 0,
};
const state = (pid: number, port = 8765) =>
  JSON.stringify({
    pid,
    port,
    startedAt: '2026-10-26T10:00:00.000Z',
    log: join(TMP, 'v.log'),
    install: INSTALL,
  });

describe('the state file', () => {
  it('is read only when it is whole', () => {
    const good = { pid: 1234, port: 8765, startedAt: 'x', log: 'l', install: 'i' };
    assert.deepEqual(parseState(JSON.stringify(good)), good);
    for (const bad of [
      '',
      'not json',
      '[]',
      'null',
      '1',
      JSON.stringify({ ...good, pid: 1 }),
      JSON.stringify({ ...good, pid: 0 }),
      JSON.stringify({ ...good, pid: -5 }),
      JSON.stringify({ ...good, pid: 12.5 }),
      JSON.stringify({ ...good, pid: '1234' }),
      JSON.stringify({ ...good, port: 0 }),
      JSON.stringify({ ...good, port: 70000 }),
      JSON.stringify({ ...good, port: '8765' }),
      JSON.stringify({ ...good, startedAt: 5 }),
      JSON.stringify({ ...good, log: undefined }),
      JSON.stringify({ ...good, install: null }),
    ]) {
      assert.equal(parseState(bad), undefined, bad);
    }
  });
});

describe('the settings and the environment of the service', () => {
  it('takes VERIFIER_ settings from the file, the caller winning, and nothing else', () => {
    const file =
      'VERIFIER_PORT=9000\nVERIFIER_PACKAGE_NAME=a.b\nDATABASE_URL=postgres://x\nOTHER=1\n';
    assert.deepEqual(
      settingsFrom(file, { VERIFIER_PORT: '9100', PATH: '/bin', MELARC_PG_ADMIN_PASSWORD: 'p' }),
      {
        VERIFIER_PORT: '9100',
        VERIFIER_PACKAGE_NAME: 'a.b',
      },
    );
    assert.deepEqual(settingsFrom(undefined, { VERIFIER_PORT: '1' }), { VERIFIER_PORT: '1' });
    assert.deepEqual(settingsFrom('', {}), {});
  });

  // Break caught: the whole environment of the developer handed to a process that is meant to hold no database credential.
  it('hands the service what a program needs and its settings, and none of the rest', () => {
    const child = childEnvironment(
      {
        Path: 'C:\\bin',
        JAVA_HOME: 'C:\\jdk',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\cmd.exe',
        TEMP: 'C:\\tmp',
        DATABASE_URL: 'postgres://user:pass@host/db',
        MELARC_PG_ADMIN_PASSWORD: 'admin',
        SESSION_SECRET: 'abc',
        VERIFIER_CALLER_SECRET: 'from the caller',
        NODE_OPTIONS: '--require x',
      },
      { VERIFIER_PORT: '9000' },
    );
    assert.deepEqual(child, {
      Path: 'C:\\bin',
      JAVA_HOME: 'C:\\jdk',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\cmd.exe',
      TEMP: 'C:\\tmp',
      VERIFIER_PORT: '9000',
    });
  });

  it('reads the port the settings give, the default when they give none', () => {
    assert.equal(portOf({}), 8765);
    assert.equal(portOf({ VERIFIER_PORT: '' }), 8765);
    assert.equal(portOf({ VERIFIER_PORT: '9000' }), 9000);
    for (const bad of ['0', '65536', '80a', '-1', '1.5', ' 80', '0x50']) {
      assert.equal(portOf({ VERIFIER_PORT: bad }), undefined, bad);
    }
  });

  it('reads the JVM options from either start script, and from nothing else', () => {
    assert.deepEqual(jvmOptionsOf(POSIX_SCRIPT), OPTIONS);
    assert.deepEqual(jvmOptionsOf(WINDOWS_SCRIPT), OPTIONS);
    assert.deepEqual(jvmOptionsOf('  set DEFAULT_JVM_OPTS="-Dfile.encoding=UTF-8"'), [
      '-Dfile.encoding=UTF-8',
    ]);
    // No line, no words, or words that are not quoted: no options, and then nothing is started without the heap cap and the exit on out of memory.
    for (const bad of [
      '',
      '#!/bin/sh\nexec java\n',
      "DEFAULT_JVM_OPTS=''",
      'DEFAULT_JVM_OPTS=-Xmx384m',
      '# DEFAULT_JVM_OPTS="-Xmx1g"',
    ]) {
      assert.equal(jvmOptionsOf(bad), undefined, bad);
    }
  });

  // Break caught: a service started with whatever the JVM defaults to, without the heap cap or the exit on out of memory the build chose.
  it('starts the JVM itself, with the options of the script, the jars of the install and the main class', () => {
    assert.deepEqual(launchPlan('linux', { JAVA_HOME: '/jdk' }, '/i', POSIX_SCRIPT), {
      file: join('/jdk', 'bin', 'java'),
      args: [...OPTIONS, '-classpath', join('/i', 'lib', '*'), MAIN_CLASS],
    });
    const windows = launchPlan('win32', { JAVA_HOME: 'C:\\jdk' }, 'C:\\i j', WINDOWS_SCRIPT);
    assert.ok(windows !== undefined);
    assert.equal(windows.file, join('C:\\jdk', 'bin', 'java.exe'));
    assert.deepEqual(windows.args.slice(-3), [
      '-classpath',
      join('C:\\i j', 'lib', '*'),
      MAIN_CLASS,
    ]);
    assert.equal(
      launchPlan('linux', {}, '/i', POSIX_SCRIPT)?.file,
      'java',
      'the path, when no JAVA_HOME is set',
    );
    assert.equal(launchPlan('linux', { JAVA_HOME: '' }, '/i', POSIX_SCRIPT)?.file, 'java');
    assert.equal(launchPlan('linux', { JAVA_HOME: '/jdk' }, '/i', '#!/bin/sh\n'), undefined);
  });
});

describe('recognising the verifier by its command line', () => {
  it('knows the JVM and the start script of this install, whatever the slashes and the case', () => {
    assert.ok(looksLikeTheVerifier(`java -cp ${INSTALL}/lib/a.jar x.Main`, INSTALL));
    assert.ok(looksLikeTheVerifier('java -cp /x com.melarc.attestation.MainKt', INSTALL));
    assert.ok(
      looksLikeTheVerifier(
        '"C:\\Repo\\apps\\attestation-verifier\\service\\build\\install\\attestation-verifier\\bin\\attestation-verifier.bat"',
        'c:/repo/apps/attestation-verifier/service/build/install/attestation-verifier',
      ),
    );
  });

  // Break caught: a process id that outlived a reboot and belongs to something else, ended because a file said so.
  it('does not take another program for it', () => {
    for (const other of [
      '',
      'node server.js',
      'java -jar other.jar',
      'chrome.exe --type=renderer',
      '/usr/bin/postgres -D /data',
    ]) {
      assert.equal(looksLikeTheVerifier(other, INSTALL), false, other);
    }
  });
});

describe('start', () => {
  const settingsFile = `VERIFIER_PORT=9000\nVERIFIER_CALLER_SECRET=${SECRET}\nVERIFIER_PACKAGE_NAME=com.melarc.rider\n`;
  const built = () => Promise.resolve(0);

  it('builds, starts the service detached with its settings and nothing of the rest, and says where it listens', async () => {
    const m = machine({
      files: { [join(ROOT, 'apps/attestation-verifier/.env')]: settingsFile },
      env: {
        PATH: '/bin',
        JAVA_HOME: '/jdk',
        DATABASE_URL: 'postgres://u:p@h/d',
        MELARC_PG_ADMIN_PASSWORD: 'admin',
      },
      answers: () => ready,
    });
    assert.equal(await startVerifier(ROOT, m.deps, built), 0);
    assert.equal(m.launched.length, 1);
    const launch = m.launched[0];
    assert.ok(launch !== undefined);
    assert.deepEqual(launch.start, {
      file: join('/jdk', 'bin', 'java'),
      args: [...OPTIONS, '-classpath', join(INSTALL, 'lib', '*'), MAIN_CLASS],
    });
    assert.equal(launch.cwd, join(ROOT, 'apps', 'attestation-verifier'));
    assert.deepEqual(launch.env, {
      PATH: '/bin',
      JAVA_HOME: '/jdk',
      VERIFIER_PORT: '9000',
      VERIFIER_CALLER_SECRET: SECRET,
      VERIFIER_PACKAGE_NAME: 'com.melarc.rider',
    });
    const text = m.printed.join('\n');
    assert.match(text, /listens on port 9000 \(process 4000\)/);
    assert.match(text, /pnpm run verifier:stop/);
    assert.ok(!text.includes(SECRET), 'a secret was printed');
    assert.deepEqual(parseState(m.files.get(STATE) ?? ''), {
      pid: 4000,
      port: 9000,
      startedAt: new Date(1_000_000).toISOString(),
      log: launch.log,
      install: INSTALL,
    });
  });

  it('does nothing when the verifier it started already runs', async () => {
    const m = machine({ answers: () => ready });
    m.alive.add(777);
    m.commandLines.set(777, `java -cp ${INSTALL}/lib/s.jar com.melarc.attestation.MainKt`);
    m.files.set(STATE, state(777));
    let builds = 0;
    assert.equal(await startVerifier(ROOT, m.deps, () => Promise.resolve(++builds * 0)), 0);
    assert.equal(builds, 0);
    assert.equal(m.launched.length, 0);
    assert.match(m.printed.join('\n'), /already runs \(process 777, port 8765/);
  });

  // Break caught: the answer of a service started elsewhere taken for the answer of the new process, which then dies on the port in use.
  it('refuses to start while something already answers on the port', async () => {
    const m = machine({ answers: () => ready, answersAlways: true });
    assert.equal(await startVerifier(ROOT, m.deps, built), 1);
    assert.equal(m.launched.length, 0);
    assert.match(m.printed.join('\n'), /Something already answers on port 8765/);
    assert.equal(m.files.has(STATE), false);
  });

  it('forgets a state whose process is gone and starts afresh', async () => {
    const m = machine({ answers: () => ready });
    m.files.set(STATE, state(777));
    assert.equal(await startVerifier(ROOT, m.deps, built), 0);
    assert.equal(m.launched.length, 1);
    assert.equal(parseState(m.files.get(STATE) ?? '')?.pid, 4000);
  });

  // Break caught: a stale state naming a process id that is somebody else's now, which a stop would then end.
  it('leaves alone a process that is no longer the verifier, says so and starts afresh', async () => {
    const m = machine({ answers: () => ready });
    m.alive.add(777);
    m.commandLines.set(777, 'chrome.exe --type=renderer');
    m.files.set(STATE, state(777));
    assert.equal(await startVerifier(ROOT, m.deps, built), 0);
    assert.deepEqual(m.killed, []);
    assert.match(m.printed.join('\n'), /Process 777 is not the verifier any more/);
    assert.ok(m.alive.has(777));
    assert.equal(m.launched.length, 1);
  });

  it('forgets a state that is not one', async () => {
    const m = machine({ answers: () => ready });
    m.files.set(STATE, '{"pid": "one"}');
    assert.equal(await startVerifier(ROOT, m.deps, built), 0);
    assert.equal(m.launched.length, 1);
  });

  it('stops where the build stops, with its status', async () => {
    for (const status of [1, 2]) {
      const m = machine({ answers: () => ready });
      assert.equal(await startVerifier(ROOT, m.deps, () => Promise.resolve(status)), status);
      assert.equal(m.launched.length, 0);
      assert.equal(m.files.has(STATE), false);
    }
  });

  it('says so when the build left no start script, or one whose options it cannot read', async () => {
    const none = machine({ launches: false });
    none.files.clear();
    assert.equal(await startVerifier(ROOT, none.deps, built), 1);
    assert.match(none.printed.join('\n'), /left no start script/);
    // A script it cannot read the options of is not run without them.
    const unreadable = machine({
      files: { [join(INSTALL, 'bin', 'attestation-verifier')]: '#!/bin/sh\nexec java\n' },
    });
    assert.equal(await startVerifier(ROOT, unreadable.deps, built), 1);
    assert.equal(unreadable.launched.length, 0);
    assert.match(unreadable.printed.join('\n'), /cannot be read: it is not started without them/);
  });

  it('refuses a port it cannot use, before it starts anything', async () => {
    const m = machine({ env: { PATH: '/bin', VERIFIER_PORT: 'eighty' } });
    assert.equal(await startVerifier(ROOT, m.deps, built), 2);
    assert.equal(m.launched.length, 0);
  });

  it('reports a process that could not be started', async () => {
    const m = machine({ launches: false });
    m.files.set(join(INSTALL, 'bin', 'attestation-verifier'), POSIX_SCRIPT);
    assert.equal(await startVerifier(ROOT, m.deps, built), 1);
    assert.match(m.printed.join('\n'), /could not be started/);
    assert.equal(m.files.has(STATE), false);
  });

  it('shows the end of the log of a service that ends while it starts, and keeps no state', async () => {
    const m = machine({ answers: () => undefined });
    let polls = 0;
    const answers = m.deps.ask;
    const deps: ProcessDependencies = {
      ...m.deps,
      ask: async (port, secret) => {
        polls += 1;
        m.alive.clear();
        return answers(port, secret);
      },
    };
    assert.equal(await startVerifier(ROOT, deps, built), 1);
    assert.equal(polls, 2, 'one look at the port before the launch, one after it');
    assert.match(m.printed.join('\n'), /ended while it started[\s\S]*the last log line/);
    assert.equal(m.files.has(STATE), false);
  });

  it('ends a service that never answers, after a minute, and keeps no state', async () => {
    const m = machine({ answers: () => undefined });
    assert.equal(await startVerifier(ROOT, m.deps, built), 1);
    assert.deepEqual(m.killed, [4000]);
    assert.match(m.printed.join('\n'), /did not answer in time/);
    assert.equal(m.files.has(STATE), false);
  });

  it('tells a wrong caller secret from a service that is not there', async () => {
    const m = machine({
      answers: () => ({
        httpStatus: 401,
        state: undefined,
        trustDataAgeSeconds: undefined,
        inFlight: undefined,
      }),
    });
    assert.equal(await startVerifier(ROOT, m.deps, built), 0);
    assert.match(m.printed.join('\n'), /HTTP 401 to its status: check VERIFIER_CALLER_SECRET/);
  });

  it('reads the options of the batch file on Windows and starts the JVM, not the shell', async () => {
    const m = machine({ platform: 'win32', env: { JAVA_HOME: 'C:\\jdk' }, answers: () => ready });
    assert.equal(await startVerifier(ROOT, m.deps, built), 0);
    const launch = m.launched[0];
    assert.ok(launch !== undefined);
    assert.equal(launch.start.file, join('C:\\jdk', 'bin', 'java.exe'));
    assert.deepEqual(launch.start.args.slice(0, OPTIONS.length), OPTIONS);
  });
});

describe('stop', () => {
  it('says so when nothing was started from here', async () => {
    const m = machine();
    assert.equal(await stopVerifier(m.deps), 0);
    assert.match(m.printed.join('\n'), /No verifier started from here is running/);
    assert.deepEqual(m.killed, []);
  });

  it('ends the process it started and forgets it', async () => {
    const m = machine();
    m.alive.add(777);
    m.commandLines.set(777, `java -cp ${INSTALL}/lib/s.jar com.melarc.attestation.MainKt`);
    m.files.set(STATE, state(777));
    assert.equal(await stopVerifier(m.deps), 0);
    assert.deepEqual(m.killed, [777]);
    assert.equal(m.files.has(STATE), false);
    assert.match(m.printed.join('\n'), /process 777\) is stopped/);
  });

  // Break caught: a stale file naming a process id that belongs to another program now.
  it('does not end a process that is not the verifier', async () => {
    const m = machine();
    m.alive.add(777);
    m.commandLines.set(777, '/usr/bin/postgres -D /data');
    m.files.set(STATE, state(777));
    assert.equal(await stopVerifier(m.deps), 0);
    assert.deepEqual(m.killed, []);
    assert.ok(m.alive.has(777));
    assert.equal(m.files.has(STATE), false);
  });

  it('does not end a process whose command line it cannot read', async () => {
    const m = machine();
    m.alive.add(777);
    m.files.set(STATE, state(777));
    assert.equal(await stopVerifier(m.deps), 0);
    assert.deepEqual(m.killed, []);
  });

  it('forgets a process that is already gone', async () => {
    const m = machine();
    m.files.set(STATE, state(777));
    assert.equal(await stopVerifier(m.deps), 0);
    assert.deepEqual(m.killed, []);
    assert.equal(m.files.has(STATE), false);
  });

  it('fails, and keeps the state, when the process will not end', async () => {
    const m = machine({ lives: true });
    m.alive.add(777);
    m.commandLines.set(777, `java -cp ${INSTALL}/lib/s.jar com.melarc.attestation.MainKt`);
    m.files.set(STATE, state(777));
    assert.equal(await stopVerifier(m.deps), 1);
    assert.match(m.printed.join('\n'), /did not end/);
    assert.equal(m.files.has(STATE), true);
  });
});

describe('status', () => {
  function running(answers: StatusAnswer | undefined) {
    const m = machine({ answers: () => answers, answersAlways: true });
    m.alive.add(777);
    m.commandLines.set(777, `java -cp ${INSTALL}/lib/s.jar com.melarc.attestation.MainKt`);
    m.files.set(STATE, state(777));
    return m;
  }

  it('says it is not running', async () => {
    const m = machine();
    assert.equal(await statusVerifier(ROOT, m.deps), 0);
    assert.match(m.printed.join('\n'), /is not running/);
  });

  it('says what the service says of itself, and succeeds only when it is ready', async () => {
    const ok = running(ready);
    assert.equal(await statusVerifier(ROOT, ok.deps), 0);
    assert.match(
      ok.printed.join('\n'),
      /It says: READY; trust data 12 s old; 0 verifications in flight/,
    );
    const loading = running({ ...ready, state: 'NOT_LOADED' });
    assert.equal(await statusVerifier(ROOT, loading.deps), 1);
    assert.match(loading.printed.join('\n'), /It says: NOT_LOADED/);
  });

  it('fails when the process does not answer or refuses the secret', async () => {
    const silent = running(undefined);
    assert.equal(await statusVerifier(ROOT, silent.deps), 1);
    assert.match(silent.printed.join('\n'), /does not answer/);
    const refused = running({
      httpStatus: 401,
      state: undefined,
      trustDataAgeSeconds: undefined,
      inFlight: undefined,
    });
    assert.equal(await statusVerifier(ROOT, refused.deps), 1);
    assert.match(refused.printed.join('\n'), /HTTP 401/);
  });
});
