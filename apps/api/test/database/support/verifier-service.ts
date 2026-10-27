import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The real attestation verifier service (apps/attestation-verifier, S0.55), started for a test that drives the API against it (S0.57, J): the
 * JVM, from the folder `pnpm run verifier:build` makes, with the settings a deployment gives it and a stand-in for Google's revocation list on
 * a loopback port (the service's one outbound call). **Nothing here skips**: no JDK, or a build that fails, is a failed test, because the
 * evidence it exists for is the service's own verdict on chains it did not write (the plan's rule: a check that cannot run has failed).
 *
 * The service gets its settings and what a program needs to run, and nothing else of the environment (it holds no database credential; none
 * arrives by accident). It is ended with the test, and its output is kept for the message of a failure and printed nowhere else.
 */
const ROOT = resolve(import.meta.dirname, '../../../../..');
const INSTALL = join(
  ROOT,
  'apps',
  'attestation-verifier',
  'service',
  'build',
  'install',
  'attestation-verifier',
);
const WINDOWS = process.platform === 'win32';
const SCRIPT = join(INSTALL, 'bin', WINDOWS ? 'attestation-verifier.bat' : 'attestation-verifier');
const MAIN_CLASS = 'com.melarc.attestation.MainKt';

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

export interface VerifierSettings {
  readonly packageName: string;
  /** The approved signing-certificate digests: 64 hexadecimal characters each. */
  readonly signingDigests: readonly string[];
  /** The accepted attestation roots, as PEM texts. */
  readonly acceptedRoots: readonly string[];
  /** The serial numbers (hexadecimal) the stand-in for Google's list reports as revoked. */
  readonly revokedSerials: readonly string[];
  /** A setting of the service beyond these, by its name. */
  readonly extra?: Readonly<Record<string, string>>;
}

export interface RunningVerifier {
  /** The base URL the API is given (`ATTESTATION_VERIFIER_URL`). */
  readonly url: string;
  /** What the service has printed so far, for the message of a failure. */
  output(): string;
  stop(): Promise<void>;
}

let installed = false;

/**
 * Builds the service as it stands: the one command `pnpm run verifier:build` is, run by the same script, every time a test file starts one
 * (Gradle finds the build up to date and does nothing but say so, in seconds). A folder an earlier build left is **not** taken as current:
 * the evidence is the service's verdict, and a stale build would give the verdict of a service that is no longer the one in the tree.
 */
function ensureInstalled(): void {
  if (installed) return;
  const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'verifier.ts'), 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  if (built.status !== 0 || !existsSync(SCRIPT)) {
    throw new Error(
      `The attestation verifier could not be built (pnpm run verifier:build, which needs the JDK of .java-version):\n${built.stdout}\n${built.stderr}`,
    );
  }
  installed = true;
}

/** The JVM options the start script passes (`DEFAULT_JVM_OPTS`), read from the script the build wrote so that they live once, in the build. */
function jvmOptions(): string[] {
  const line = /^\s*(?:set\s+)?DEFAULT_JVM_OPTS=(.*)$/m.exec(readFileSync(SCRIPT, 'utf8'))?.[1];
  const options = [...(line ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
  if (options.length === 0)
    throw new Error('The start script of the verifier states no JVM options');
  return options;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      resolveListen((server.address() as AddressInfo).port);
    });
  });
}

/** A free loopback port, found by asking for one and giving it back. */
async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((done) =>
    probe.close(() => {
      done();
    }),
  );
  return port;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function ready(port: number, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `The verifier ended while it started (${String(child.exitCode)}):\n${output()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/v1/status`);
      if (response.status === 200) {
        const status = (await response.json()) as { state?: string };
        if (status.state === 'READY') return;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`The verifier was not READY within 90 seconds:\n${output()}`);
}

export async function startVerifierService(settings: VerifierSettings): Promise<RunningVerifier> {
  ensureInstalled();
  const directory = mkdtempSync(join(tmpdir(), 'melarc-verifier-test-'));
  const rootsFile = join(directory, 'roots.json');
  writeFileSync(rootsFile, JSON.stringify(settings.acceptedRoots));

  // Google's list, as the service reads it: `{"entries": {"<serial>": {"status": ...}}}`. Never empty (the service refuses an empty list).
  const entries = Object.fromEntries(
    settings.revokedSerials.map((serial) => [
      serial,
      { status: 'REVOKED', reason: 'KEY_COMPROMISE' },
    ]),
  );
  const list = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ entries }));
  });
  const listPort = await listen(list);

  const port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && PASSED_THROUGH.has(key.toLowerCase())) env[key] = value;
  }
  Object.assign(env, {
    VERIFIER_ENVIRONMENT: 'local',
    VERIFIER_BIND_ADDRESS: '127.0.0.1',
    VERIFIER_PORT: String(port),
    VERIFIER_PACKAGE_NAME: settings.packageName,
    VERIFIER_SIGNING_DIGESTS: settings.signingDigests.join(','),
    VERIFIER_ACCEPTED_ROOTS_FILE: rootsFile,
    VERIFIER_REVOCATION_URL: `http://127.0.0.1:${String(listPort)}/status`,
    ...settings.extra,
  });

  const home = process.env.JAVA_HOME;
  const java =
    home !== undefined && home !== '' ? join(home, 'bin', WINDOWS ? 'java.exe' : 'java') : 'java';
  const child = spawn(
    java,
    [...jvmOptions(), '-classpath', join(INSTALL, 'lib', '*'), MAIN_CLASS],
    {
      cwd: directory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let printed = '';
  const keep = (chunk: Buffer): void => {
    printed = (printed + chunk.toString('utf8')).slice(-20_000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  // Read afresh each time: the process exits while the stop waits for it.
  const running = (): boolean => child.exitCode === null;
  const stop = async (): Promise<void> => {
    if (running()) {
      const ended = new Promise<void>((done) =>
        child.once('exit', () => {
          done();
        }),
      );
      child.kill();
      await Promise.race([ended, sleep(10_000)]);
      if (running()) child.kill('SIGKILL');
    }
    await new Promise<void>((done) =>
      list.close(() => {
        done();
      }),
    );
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    await ready(port, child, () => printed);
  } catch (failure) {
    await stop();
    throw failure;
  }
  return { url: `http://127.0.0.1:${String(port)}`, output: () => printed, stop };
}
