/**
 * The commands of the attestation verifier (apps/attestation-verifier, S0.55): a JVM service built by Gradle, which no pnpm package reaches,
 * so the CI job, the gate and a developer all run it through here, and nothing else needs to know how.
 *
 *   node scripts/verifier.ts test     Gradle `check`: the vendored library against its checksums, the compiler, and every test of the service
 *   node scripts/verifier.ts build    Gradle `installDist`: the service as a runnable folder,
 *                                     apps/attestation-verifier/service/build/install/attestation-verifier
 *   node scripts/verifier.ts start    build, then start it in the background from apps/attestation-verifier/.env (verifier-process.ts)
 *   node scripts/verifier.ts stop     end the process `start` started, and nothing else
 *   node scripts/verifier.ts status   whether it runs, and what it says of itself
 *
 * The JDK is the developer's (DEVELOPMENT.md, "The attestation verifier"): `JAVA_HOME`, or `java` and `javac` on the path, of the major
 * version `.java-version` pins. Gradle is the wrapper's, at the version and checksum gradle/wrapper/gradle-wrapper.properties pins; it
 * resolves only artifacts whose checksum is in gradle/verification-metadata.xml, and it runs without a daemon, so that nothing is left
 * running when the command ends. Nothing here is skipped when a JDK is missing: a check that cannot run is a check that failed.
 *
 *   exit 0  it passed
 *   exit 1  Gradle failed (a check did not pass)
 *   exit 2  it would not start (no JDK of the pinned major version, an unknown command)
 */

import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

import { INSTALL_HELP, checkJdk, runProgram, type Run } from './jdk.ts';
import {
  realDependencies,
  startVerifier,
  statusVerifier,
  stopVerifier,
  type ProcessDependencies,
} from './verifier-process.ts';

export const VERIFIER_DIRECTORY = 'apps/attestation-verifier';

export type VerifierCommand = 'test' | 'build';

/** The Gradle tasks of each command. */
export const GRADLE_TASKS: Readonly<Record<VerifierCommand, readonly string[]>> = {
  test: ['check'],
  build: ['installDist'],
};

const isCommand = (word: string | undefined): word is VerifierCommand =>
  word !== undefined && Object.hasOwn(GRADLE_TASKS, word);

export type ProcessCommand = 'start' | 'stop' | 'status';
const PROCESS_COMMANDS: readonly string[] = ['start', 'stop', 'status'];
const isProcessCommand = (word: string | undefined): word is ProcessCommand =>
  word !== undefined && PROCESS_COMMANDS.includes(word);

/**
 * How Gradle's wrapper is started, from the verifier's folder: its batch file as one command line for the shell on Windows (a shell does
 * not look in the current folder unless it is told to, and an argument list given with a shell is only concatenated, so the line is
 * written whole, from fixed words), its script through `sh` elsewhere (so that no mode bit matters).
 */
export function gradleInvocation(
  platform: NodeJS.Platform,
  command: VerifierCommand,
): { file: string; args: string[]; shell: boolean } {
  const tasks = [...GRADLE_TASKS[command]];
  const common = ['--no-daemon', '--console=plain'];
  return platform === 'win32'
    ? { file: ['.\\gradlew.bat', ...common, ...tasks].join(' '), args: [], shell: true }
    : { file: 'sh', args: ['./gradlew', ...common, ...tasks], shell: false };
}

export interface Dependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly run: Run;
  /** Runs Gradle in the folder, with its output on this process's, and resolves with its exit status. */
  readonly gradle: (
    invocation: ReturnType<typeof gradleInvocation>,
    cwd: string,
  ) => Promise<number>;
  readonly print: (line: string) => void;
  /** What `start`, `stop` and `status` act through. */
  readonly process: ProcessDependencies;
}

/** Gradle's `command`, once the JDK is the pinned one: 0 when it passed, 1 when Gradle failed, 2 when it would not start. */
async function runGradle(
  command: VerifierCommand,
  root: string,
  deps: Dependencies,
): Promise<number> {
  const check = checkJdk(root, deps.env, deps.platform, deps.run);
  if (!check.ok) {
    deps.print(check.problem);
    if (check.installHelp) INSTALL_HELP.forEach(deps.print);
    return 2;
  }
  const { jdk } = check;

  const invocation = gradleInvocation(deps.platform, command);
  deps.print(
    `Gradle ${GRADLE_TASKS[command].join(' ')} with JDK ${String(jdk.major)} (${jdk.source}), in ${VERIFIER_DIRECTORY}`,
  );
  const status = await deps.gradle(invocation, join(root, VERIFIER_DIRECTORY));
  return status === 0 ? 0 : 1;
}

export async function main(
  args: readonly string[],
  root: string,
  deps: Dependencies,
): Promise<number> {
  const command = args[0];
  if (args.length !== 1) {
    deps.print('Usage: node scripts/verifier.ts test|build|start|stop|status');
    return 2;
  }
  if (isCommand(command)) return runGradle(command, root, deps);
  if (isProcessCommand(command)) {
    if (command === 'start') {
      return startVerifier(root, deps.process, () => runGradle('build', root, deps));
    }
    return command === 'stop' ? stopVerifier(deps.process) : statusVerifier(root, deps.process);
  }
  deps.print('Usage: node scripts/verifier.ts test|build|start|stop|status');
  return 2;
}

function realGradle(env: NodeJS.ProcessEnv): Dependencies['gradle'] {
  return (invocation, cwd) =>
    new Promise((resolveStatus) => {
      const child = spawn(invocation.file, invocation.args, {
        cwd,
        env,
        stdio: 'inherit',
        shell: invocation.shell,
      });
      child.on('error', () => {
        resolveStatus(1);
      });
      child.on('close', (status) => {
        resolveStatus(status ?? 1);
      });
    });
}

if (import.meta.main) {
  const env = process.env;
  process.exitCode = await main(process.argv.slice(2), resolve(import.meta.dirname, '..'), {
    env,
    platform: process.platform,
    run: runProgram,
    gradle: realGradle(env),
    print: (line) => {
      console.log(line);
    },
    process: realDependencies(env, process.platform),
  });
}
