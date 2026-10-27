/**
 * Starting, stopping and asking after the attestation verifier on a developer machine (apps/attestation-verifier, S0.55c):
 *
 *   node scripts/verifier.ts start    builds the service, starts it in the background from apps/attestation-verifier/.env and waits until it answers
 *   node scripts/verifier.ts stop     ends the process `start` started, and nothing else
 *   node scripts/verifier.ts status   says whether it runs and what it says of itself
 *
 * What it keeps is one small state file below the operating system's temporary folder (`melarc-verifier/state.json`: the process id, the
 * port, the log). `stop` ends a process only when the state names it, it is alive **and its command line is the verifier's**: a process id
 * that outlived a reboot and now belongs to something else is never touched. The service gets the settings of its own `.env` (under any
 * `VERIFIER_*` the caller's environment sets) and a short list of what a program needs to run, and nothing else of the developer's
 * environment: it holds no database credential and none arrives by accident. No value of the settings is ever printed.
 *
 * Nothing here is used by the gate, CI or the tests, which start the service themselves where they need it.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

import { killTree } from './gate.ts';

export const INSTALL_DIRECTORY =
  'apps/attestation-verifier/service/build/install/attestation-verifier';
export const SETTINGS_FILE = 'apps/attestation-verifier/.env';
export const DEFAULT_PORT = 8765;

export interface State {
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
  readonly log: string;
  /** The install folder the process was started from: what its command line must name. */
  readonly install: string;
}

export function stateFilePath(tmp: string): string {
  return join(tmp, 'melarc-verifier', 'state.json');
}

/** The state a file holds, or undefined when it is not one (a file written by hand or half written is no state). */
export function parseState(text: string): State | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { pid, port, startedAt, log, install } = value as Record<string, unknown>;
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    pid <= 1 ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof startedAt !== 'string' ||
    typeof log !== 'string' ||
    typeof install !== 'string'
  ) {
    return undefined;
  }
  return { pid, port, startedAt, log, install };
}

/** What a program needs to run and nothing else of the caller's environment (compared without regard to case: Windows spells `Path`). */
const PASSED_THROUGH = new Set(
  [
    'PATH',
    'JAVA_HOME',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
  ].map((name) => name.toLowerCase()),
);

/**
 * The settings of the process: the `VERIFIER_*` of the settings file, under the `VERIFIER_*` of the caller's environment (which wins, as it
 * does for the API). Anything else in the file is ignored.
 */
export function settingsFrom(
  fileText: string | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(fileText === undefined ? {} : parseEnv(fileText))) {
    if (key.startsWith('VERIFIER_') && value !== undefined) settings[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('VERIFIER_') && value !== undefined) settings[key] = value;
  }
  return settings;
}

/** The whole environment of the service: what it needs to run, and its settings. */
export function childEnvironment(
  env: NodeJS.ProcessEnv,
  settings: Record<string, string>,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && PASSED_THROUGH.has(key.toLowerCase())) child[key] = value;
  }
  return { ...child, ...settings };
}

/** The port the service will listen on, as its settings say (its own default otherwise); undefined when they say something it cannot use. */
export function portOf(settings: Record<string, string>): number | undefined {
  const text = settings.VERIFIER_PORT;
  if (text === undefined || text === '') return DEFAULT_PORT;
  const port = Number(text);
  return /^\d+$/.test(text) && port >= 1 && port <= 65535 ? port : undefined;
}

const normalise = (text: string): string => text.replaceAll('\\', '/').toLowerCase();

/** Whether a command line is the verifier's: the start script or the JVM running from the install folder the state names. */
export function looksLikeTheVerifier(commandLine: string, install: string): boolean {
  const line = normalise(commandLine);
  return line.includes(normalise(install)) || line.includes('com.melarc.attestation.mainkt');
}

export const MAIN_CLASS = 'com.melarc.attestation.MainKt';

/**
 * The JVM options the installed start script passes (`DEFAULT_JVM_OPTS`: the heap cap, the exit on out of memory, the IPv4 preference),
 * read from the script the build wrote, so that they live once, in the build. Both scripts spell them as double-quoted words on one line.
 */
export function jvmOptionsOf(scriptText: string): string[] | undefined {
  const line = /^\s*(?:set\s+)?DEFAULT_JVM_OPTS=(.*)$/m.exec(scriptText)?.[1];
  if (line === undefined) return undefined;
  const options = [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
  return options.length > 0 ? options : undefined;
}

/**
 * How the service is started for a developer: the JVM itself, with the script's options, the install's jars and the main class. Not the
 * start script, which on Windows runs under `cmd.exe`: a detached `cmd.exe` loses the redirected output of the JVM (the log stays empty), and
 * one that is not detached is ended with its parent while the JVM lives on, so that the process the state names is not the service. Started
 * itself, the JVM is the process that is recorded, ended and recognised.
 */
export function launchPlan(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  install: string,
  scriptText: string,
): { file: string; args: string[] } | undefined {
  const options = jvmOptionsOf(scriptText);
  if (options === undefined) return undefined;
  const home = env.JAVA_HOME;
  const java =
    home !== undefined && home !== ''
      ? join(home, 'bin', platform === 'win32' ? 'java.exe' : 'java')
      : 'java';
  return { file: java, args: [...options, '-classpath', join(install, 'lib', '*'), MAIN_CLASS] };
}

export interface StatusAnswer {
  readonly httpStatus: number;
  /** The `state` the service reports, when it answered with its status document. */
  readonly state: string | undefined;
  readonly trustDataAgeSeconds: number | undefined;
  readonly inFlight: number | undefined;
}

export interface ProcessDependencies {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly tmp: string;
  readonly now: () => Date;
  readonly exists: (path: string) => boolean;
  readonly read: (path: string) => string | undefined;
  readonly write: (path: string, text: string) => void;
  readonly remove: (path: string) => void;
  readonly alive: (pid: number) => boolean;
  readonly commandLineOf: (pid: number) => string | undefined;
  readonly kill: (pid: number) => void;
  /** Starts the service detached with its output in the log, and returns its process id. */
  readonly launch: (
    start: { file: string; args: string[] },
    cwd: string,
    env: NodeJS.ProcessEnv,
    log: string,
  ) => number | undefined;
  /** Asks the service for its status, with its caller secret when it has one; undefined when nothing answers. */
  readonly ask: (port: number, secret: string | undefined) => Promise<StatusAnswer | undefined>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** The last lines of a log, for the message of a service that ended. */
  readonly tail: (path: string) => string[];
  readonly print: (line: string) => void;
}

const START_WAIT_MS = 60_000;
const POLL_MS = 250;
const STOP_WAIT_MS = 10_000;

/** The state of a running verifier of this checkout, or undefined (a state that names a dead or foreign process is removed). */
function runningState(deps: ProcessDependencies): State | undefined {
  const path = stateFilePath(deps.tmp);
  const text = deps.read(path);
  if (text === undefined) return undefined;
  const state = parseState(text);
  if (state === undefined) {
    deps.remove(path);
    return undefined;
  }
  if (!deps.alive(state.pid)) {
    deps.remove(path);
    return undefined;
  }
  const commandLine = deps.commandLineOf(state.pid);
  if (commandLine === undefined || !looksLikeTheVerifier(commandLine, state.install)) {
    // The process id is somebody else's now. It is not ours to end; the state is only a stale note.
    deps.print(
      `Process ${String(state.pid)} is not the verifier any more (a stale state): it is left alone.`,
    );
    deps.remove(path);
    return undefined;
  }
  return state;
}

export async function startVerifier(
  root: string,
  deps: ProcessDependencies,
  build: () => Promise<number>,
): Promise<number> {
  const running = runningState(deps);
  if (running !== undefined) {
    deps.print(
      `The verifier already runs (process ${String(running.pid)}, port ${String(running.port)}, log ${running.log}). Stop it with: pnpm run verifier:stop`,
    );
    return 0;
  }

  const built = await build();
  if (built !== 0) return built;

  const install = join(root, INSTALL_DIRECTORY);
  const script = deps.read(
    join(
      install,
      'bin',
      deps.platform === 'win32' ? 'attestation-verifier.bat' : 'attestation-verifier',
    ),
  );
  const start =
    script === undefined ? undefined : launchPlan(deps.platform, deps.env, install, script);
  if (start === undefined) {
    deps.print(
      `The build left no start script in ${INSTALL_DIRECTORY}/bin, or one whose JVM options (DEFAULT_JVM_OPTS) cannot be read: it is not started without them.`,
    );
    return 1;
  }

  const settings = settingsFrom(deps.read(join(root, SETTINGS_FILE)), deps.env);
  const port = portOf(settings);
  if (port === undefined) {
    deps.print('VERIFIER_PORT is not a port (1 to 65535).');
    return 2;
  }
  const secret =
    settings.VERIFIER_CALLER_SECRET === '' ? undefined : settings.VERIFIER_CALLER_SECRET;

  // A service that answers on the port before this one starts is not this one: its answer must never be taken for the new process's (which
  // would then fail to bind and leave a state naming a dead process).
  if ((await deps.ask(port, secret)) !== undefined) {
    deps.print(
      `Something already answers on port ${String(port)} and was not started from here (or its state is lost). Stop it, or change VERIFIER_PORT.`,
    );
    return 1;
  }

  const log = join(
    deps.tmp,
    'melarc-verifier',
    `verifier-${deps.now().toISOString().replaceAll(':', '-')}.log`,
  );
  const pid = deps.launch(
    start,
    join(root, 'apps', 'attestation-verifier'),
    childEnvironment(deps.env, settings),
    log,
  );
  if (pid === undefined) {
    deps.print('The verifier could not be started.');
    return 1;
  }
  deps.write(
    stateFilePath(deps.tmp),
    JSON.stringify({ pid, port, startedAt: deps.now().toISOString(), log, install }, null, 2),
  );

  const deadline = deps.now().getTime() + START_WAIT_MS;
  while (deps.now().getTime() < deadline) {
    if (!deps.alive(pid)) {
      deps.print('The verifier ended while it started. The end of its log:');
      deps.tail(log).forEach(deps.print);
      deps.remove(stateFilePath(deps.tmp));
      return 1;
    }
    const answer = await deps.ask(port, secret);
    if (answer !== undefined) {
      deps.print(
        `The verifier listens on port ${String(port)} (process ${String(pid)}), its log is ${log}`,
      );
      deps.print(
        answer.httpStatus === 200
          ? `It says: ${answer.state ?? 'no state'}. Its trust data loads in the background; \`pnpm run verifier:status\` says when it is READY, and its log says why it is not.`
          : `It answers HTTP ${String(answer.httpStatus)} to its status: check VERIFIER_CALLER_SECRET.`,
      );
      deps.print('Stop it with: pnpm run verifier:stop');
      return 0;
    }
    await deps.sleep(POLL_MS);
  }
  deps.print('The verifier did not answer in time; it is stopped. The end of its log:');
  deps.tail(log).forEach(deps.print);
  deps.kill(pid);
  deps.remove(stateFilePath(deps.tmp));
  return 1;
}

export async function stopVerifier(deps: ProcessDependencies): Promise<number> {
  const state = runningState(deps);
  if (state === undefined) {
    deps.print('No verifier started from here is running.');
    return 0;
  }
  deps.kill(state.pid);
  const deadline = deps.now().getTime() + STOP_WAIT_MS;
  while (deps.alive(state.pid) && deps.now().getTime() < deadline) await deps.sleep(POLL_MS);
  if (deps.alive(state.pid)) {
    deps.print(`Process ${String(state.pid)} did not end.`);
    return 1;
  }
  deps.remove(stateFilePath(deps.tmp));
  deps.print(`The verifier (process ${String(state.pid)}) is stopped.`);
  return 0;
}

export async function statusVerifier(root: string, deps: ProcessDependencies): Promise<number> {
  const state = runningState(deps);
  if (state === undefined) {
    deps.print('The verifier is not running.');
    return 0;
  }
  const settings = settingsFrom(deps.read(join(root, SETTINGS_FILE)), deps.env);
  const secret =
    settings.VERIFIER_CALLER_SECRET === '' ? undefined : settings.VERIFIER_CALLER_SECRET;
  deps.print(
    `The verifier runs: process ${String(state.pid)}, port ${String(state.port)}, started ${state.startedAt}, log ${state.log}`,
  );
  const answer = await deps.ask(state.port, secret);
  if (answer === undefined) {
    deps.print('It does not answer.');
    return 1;
  }
  if (answer.httpStatus !== 200) {
    deps.print(
      `It answers HTTP ${String(answer.httpStatus)} to its status: check VERIFIER_CALLER_SECRET.`,
    );
    return 1;
  }
  deps.print(
    `It says: ${answer.state ?? 'no state'}; trust data ${answer.trustDataAgeSeconds === undefined ? 'age unknown' : `${String(Math.round(answer.trustDataAgeSeconds))} s old`}; ${String(answer.inFlight ?? 0)} verifications in flight.`,
  );
  return answer.state === 'READY' ? 0 : 1;
}

// ------------------------------------------------------------------------------------------------ the real thing

function commandLineOf(pid: number, platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${String(Math.trunc(pid))}').CommandLine`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    const text = result.status === 0 ? result.stdout.trim() : '';
    return text === '' ? undefined : text;
  }
  try {
    return readFileSync(`/proc/${String(Math.trunc(pid))}/cmdline`, 'utf8')
      .replaceAll('\0', ' ')
      .trim();
  } catch {
    const result = spawnSync('ps', ['-p', String(Math.trunc(pid)), '-o', 'command='], {
      encoding: 'utf8',
    });
    const text = result.status === 0 ? result.stdout.trim() : '';
    return text === '' ? undefined : text;
  }
}

export function realDependencies(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ProcessDependencies {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
  };
  return {
    platform,
    env,
    tmp: tmpdir(),
    now: () => new Date(),
    exists: existsSync,
    read: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    write: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    remove: (path) => {
      rmSync(path, { force: true });
    },
    alive,
    commandLineOf: (pid) => commandLineOf(pid, platform),
    kill: killTree,
    launch: (start, cwd, childEnv, log) => {
      mkdirSync(dirname(log), { recursive: true });
      const descriptor = openSync(log, 'a');
      try {
        const child = spawn(start.file, start.args, {
          cwd,
          env: childEnv,
          // A group of its own on POSIX, so that `stop` ends the process and anything it started; detached on Windows, where it has no
          // console and no job of this process to be ended with.
          detached: true,
          stdio: ['ignore', descriptor, descriptor],
          windowsHide: true,
        });
        child.on('error', () => undefined);
        child.unref();
        return child.pid;
      } finally {
        closeSync(descriptor);
      }
    },
    ask: async (port, secret) => {
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/v1/status`, {
          headers: secret === undefined ? {} : { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(2_000),
        });
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        const document =
          typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
        return {
          httpStatus: response.status,
          state: typeof document.state === 'string' ? document.state : undefined,
          trustDataAgeSeconds:
            typeof document.trust_data_age_seconds === 'number'
              ? document.trust_data_age_seconds
              : undefined,
          inFlight: typeof document.in_flight === 'number' ? document.in_flight : undefined,
        };
      } catch {
        return undefined;
      }
    },
    sleep: (milliseconds) =>
      new Promise((done) => {
        setTimeout(done, milliseconds);
      }),
    tail: (path) => {
      try {
        return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-15);
      } catch {
        return ['(no log)'];
      }
    },
    print: (line) => {
      console.log(line);
    },
  };
}
