/**
 * The JDK the attestation verifier needs (DEVELOPMENT.md, "The attestation verifier"): which one Gradle would use, and whether it is the
 * major version `.java-version` pins. `scripts/verifier.ts` asks before it starts Gradle; the gate and the affected run ask before they
 * start what needs the verifier (its own stage, and the database test that starts it), so that a machine without the JDK is told so at
 * the start and not after the tests that come first. It imports Node built-ins only, so that each of them can load it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The major version of the JDK `.java-version` pins: one exact `major.minor.patch`, as `.node-version` is. */
export function pinnedJavaMajor(fileText: string): number | undefined {
  const match = /^(\d+)\.\d+\.\d+$/.exec(fileText.trim());
  return match === null ? undefined : Number(match[1]);
}

/** The major version in the first line `java -version` prints: `openjdk version "21.0.12" ...`, and the old `"1.8.0_402"` (Java 8). */
export function javaMajorOf(versionOutput: string): number | undefined {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (match === null) return undefined;
  const first = Number(match[1]);
  return first === 1 ? Number(match[2]) : first;
}

export interface RunResult {
  readonly status: number | null;
  readonly output: string;
}

/** Runs a program to its end and returns what it printed (`java -version` prints to the error stream). */
export type Run = (file: string, args: readonly string[]) => RunResult;

/** The real `Run`: the program started without a shell. */
export function runProgram(file: string, args: readonly string[]): RunResult {
  const result = spawnSync(file, [...args], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

export interface Jdk {
  /** Where the JDK came from, for the message: `JAVA_HOME` or `PATH`. */
  readonly source: string;
  readonly major: number | undefined;
  readonly hasCompiler: boolean;
}

const executable = (name: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? `${name}.exe` : name;

/**
 * The JDK Gradle will use, which is the one it finds: `JAVA_HOME` when that is set (and then only that one), else the path's. A JRE has no
 * compiler and Kotlin cannot be built with it.
 */
export function findJdk(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  run: Run,
  exists: (path: string) => boolean = existsSync,
): Jdk {
  const home = env.JAVA_HOME;
  if (home !== undefined && home !== '') {
    const java = join(home, 'bin', executable('java', platform));
    const javac = join(home, 'bin', executable('javac', platform));
    if (!exists(java)) return { source: 'JAVA_HOME', major: undefined, hasCompiler: false };
    const result = run(java, ['-version']);
    return {
      source: 'JAVA_HOME',
      major: result.status === 0 ? javaMajorOf(result.output) : undefined,
      hasCompiler: exists(javac),
    };
  }
  const java = run('java', ['-version']);
  const javac = run('javac', ['-version']);
  return {
    source: 'PATH',
    major: java.status === 0 ? javaMajorOf(java.output) : undefined,
    hasCompiler: javac.status === 0,
  };
}

/** A usable JDK, or what is wrong and whether the way to install one (`INSTALL_HELP`) applies. */
export type JdkCheck =
  | { readonly ok: true; readonly jdk: Jdk }
  | { readonly ok: false; readonly problem: string; readonly installHelp: boolean };

/** Whether the JDK Gradle would use is the pinned one, judged as the verifier's `test` and `build` judge it before Gradle starts. */
export function checkJdk(
  root: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  run: Run,
  exists: (path: string) => boolean = existsSync,
): JdkCheck {
  const pinned = pinnedJavaMajor(readFileSync(join(root, '.java-version'), 'utf8'));
  if (pinned === undefined) {
    return {
      ok: false,
      problem: '.java-version must contain one exact version such as 21.0.12.',
      installHelp: false,
    };
  }
  const jdk = findJdk(env, platform, run, exists);
  if (jdk.major === undefined) {
    return {
      ok: false,
      problem: `No JDK answers (${jdk.source === 'JAVA_HOME' ? 'JAVA_HOME is set, and holds no usable bin/java' : '`java -version` on the path failed'}). The verifier needs JDK ${String(pinned)}.`,
      installHelp: true,
    };
  }
  if (jdk.major !== pinned) {
    return {
      ok: false,
      problem: `The JDK found through ${jdk.source} is version ${String(jdk.major)}; the verifier is built and tested with ${String(pinned)} (.java-version).`,
      installHelp: true,
    };
  }
  if (!jdk.hasCompiler) {
    return {
      ok: false,
      problem: `The JDK found through ${jdk.source} has no compiler (a JRE): the verifier needs a JDK ${String(pinned)}.`,
      installHelp: true,
    };
  }
  return { ok: true, jdk };
}

export const INSTALL_HELP: readonly string[] = [
  'Install a JDK of that major version (Eclipse Temurin is the one CI uses), then set JAVA_HOME to it or put its bin folder on the path:',
  '  Windows:  winget install EclipseAdoptium.Temurin.21.JDK',
  '  Linux:    your distribution\'s "temurin-21-jdk" or "openjdk-21-jdk" package',
  'DEVELOPMENT.md, "The attestation verifier", has the rest.',
];
