/**
 * Says whether a PostgreSQL server answers where the database tools expect one, and when it does not, why that
 * may be and what to do. It changes nothing: it opens one connection to this machine, sends the protocol's own
 * first message (the SSL request: no user, no password, no database) and reads the one-byte answer.
 *
 *   exit 0   a PostgreSQL server answers at the address
 *   exit 1   nothing answers, something else answers, or a setting cannot be used
 *
 * The address is MELARC_PG_HOST (default 127.0.0.1) and MELARC_PG_PORT (default 5432) from the environment, or
 * from infrastructure/postgres/.env, as the database tools read them. Only this machine is ever probed, as with
 * the tools: a host that is not loopback is refused, and no advice here widens that.
 *
 * Inside WSL2 this machine's 127.0.0.1 is the WSL2 virtual machine, not Windows, unless WSL2 uses mirrored
 * networking. A server running on Windows may therefore not be where a WSL2 shell looks; DEVELOPMENT.md lists
 * the setups that are supported.
 *
 * Usage: node scripts/infra-check.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const PG_ENV = 'infrastructure/postgres/.env';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = '5432';
const DEFAULT_TIMEOUT_MS = 5_000;

/** The protocol's first message when a client asks for TLS: length 8, then the request code 80877103. */
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

/** What one probe found. */
export type Probe =
  | { kind: 'postgres' }
  | { kind: 'not-postgres'; detail: string }
  | { kind: 'unreachable'; code: string };

export type ProbeFunction = (host: string, port: number, timeoutMs: number) => Promise<Probe>;

/** A setting cannot be used. The message names the setting, never a value that could be a secret. */
export class InfraCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfraCheckError';
  }
}

/**
 * True only for this machine: `localhost`, a 127.x.y.z address or ::1, matched as a whole. This is the rule of
 * `isLoopbackHost` in apps/api/src/tools/database/safety.ts, which this script cannot import (it runs before an
 * install); `infra-check.test.ts` holds the two to the same answers.
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name === 'localhost' || name === '::1') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  return octets?.slice(1).every((octet) => Number(octet) <= 255) ?? false;
}

/** WSL sets WSL_DISTRO_NAME in its shells and puts "microsoft" in the kernel version it reports. */
export function isWsl(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
  procVersion: string | undefined,
): boolean {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME !== undefined && env.WSL_DISTRO_NAME !== '') return true;
  return procVersion !== undefined && /microsoft/i.test(procVersion);
}

/** The host and port the database tools use: the environment, then the settings file, then the defaults. */
export function readDatabaseAddress(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): { host: string; port: number } {
  const file = join(root, PG_ENV);
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const read = (key: string): string | undefined => {
    const value = env[key] === undefined || env[key] === '' ? fromFile[key] : env[key];
    return value === undefined || value === '' ? undefined : value;
  };

  const rawPort = read('MELARC_PG_PORT') ?? DEFAULT_PORT;
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new InfraCheckError('MELARC_PG_PORT must be an integer from 1 to 65535.');
  }
  return { host: read('MELARC_PG_HOST') ?? DEFAULT_HOST, port };
}

/** The code Node reports for a failed connection. A name that resolves to several addresses fails with an AggregateError that carries it too. */
function errorCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN';
}

/**
 * Connects, sends the SSL request and reads the answer. A PostgreSQL server answers one byte: S (it can) or N
 * (it cannot, and carries on). Anything else, a close without an answer, or no answer within the deadline means
 * something is listening that is not PostgreSQL. A failed or unfinished connection is reported as unreachable.
 */
export function probePostgres(
  host: string,
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Probe> {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    let connected = false;
    let settled = false;
    const finish = (probe: Probe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(probe);
    };

    const timer = setTimeout(() => {
      finish(
        connected
          ? {
              kind: 'not-postgres',
              detail: `it accepted the connection but did not answer within ${String(timeoutMs)} ms`,
            }
          : { kind: 'unreachable', code: 'ETIMEDOUT' },
      );
    }, timeoutMs);

    socket.once('connect', () => {
      connected = true;
      socket.write(SSL_REQUEST);
    });
    socket.once('data', (chunk: Buffer) => {
      const answer = chunk.subarray(0, 1).toString('latin1');
      finish(
        answer === 'S' || answer === 'N'
          ? { kind: 'postgres' }
          : {
              kind: 'not-postgres',
              detail: 'it answered with something that is not the PostgreSQL protocol',
            },
      );
    });
    socket.once('close', () => {
      finish({ kind: 'not-postgres', detail: 'it closed the connection without answering' });
    });
    socket.once('error', (error: Error) => {
      finish(
        connected
          ? {
              kind: 'not-postgres',
              detail: `the connection failed after it was made (${errorCode(error)})`,
            }
          : { kind: 'unreachable', code: errorCode(error) },
      );
    });
  });
}

const WSL_ADVICE = [
  'This shell is in WSL2. Inside WSL2, 127.0.0.1 is the WSL2 virtual machine, not Windows (unless WSL2 uses mirrored',
  'networking), so a database that is running on Windows may not be reachable here. Either:',
  '  1. Run the database inside WSL2: have Docker available in this distribution (Docker Desktop with WSL integration',
  '     enabled for it, or Docker Engine) and run `pnpm run infra:up` from this shell; or',
  '  2. Keep the database on Windows and turn on mirrored networking: add networkingMode=mirrored under [wsl2] in',
  '     %UserProfile%\\.wslconfig, run `wsl --shutdown` from Windows, then open WSL2 again.',
  'Either way the database stays bound to this machine only. See "Windows, WSL2 and Linux" in DEVELOPMENT.md.',
];

export interface InfraCheckOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Whether this is WSL2. Detected from the platform and the kernel version by default. */
  wsl?: boolean;
  probe?: ProbeFunction;
  timeoutMs?: number;
}

function detectWsl(env: Readonly<Record<string, string | undefined>>): boolean {
  let procVersion: string | undefined;
  try {
    procVersion = readFileSync('/proc/version', 'utf8');
  } catch {
    procVersion = undefined;
  }
  return isWsl(process.platform, env, procVersion);
}

/** Runs the check and returns the exit status. `out` receives each line of the report. */
export async function runInfraCheck(
  root: string,
  out: (line: string) => void,
  options: InfraCheckOptions = {},
): Promise<0 | 1> {
  const env = options.env ?? process.env;
  const probe = options.probe ?? probePostgres;

  let address: { host: string; port: number };
  try {
    address = readDatabaseAddress(root, env);
  } catch (error) {
    out(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const { host, port } = address;
  if (!isLoopbackHost(host)) {
    out(
      `Refusing to probe ${host}: the database tools act only on this machine, so this check does too. Use localhost or a 127.x.y.z address.`,
    );
    return 1;
  }

  const where = `${host}:${String(port)}`;
  const found = await probe(host, port, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (found.kind === 'postgres') {
    out(`PostgreSQL answers at ${where}.`);
    out(
      'This shows a server is there. It does not check passwords or the schema: `pnpm --filter @melarc/api run db:bootstrap` sets the roles and `db:migrate` the schema (DEVELOPMENT.md, step 4).',
    );
    return 0;
  }

  if (found.kind === 'not-postgres') {
    out(`Something is listening at ${where}, but it is not PostgreSQL: ${found.detail}.`);
    out(
      'Another program holds the port. Stop it, or set MELARC_PG_PORT in infrastructure/postgres/.env (and the port in DATABASE_URL in apps/api/.env) to a free port and run `pnpm run infra:up` again.',
    );
    return 1;
  }

  out(`Nothing is listening at ${where} (${found.code}).`);
  if (options.wsl ?? detectWsl(env)) {
    for (const line of WSL_ADVICE) out(line);
  } else {
    out(
      'Start the database with `pnpm run infra:up`, and see what it is doing with `pnpm run infra:status`. Docker must be running.',
    );
  }
  return 1;
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  process.exitCode = await runInfraCheck(root, (line) => {
    console.log(line);
  });
}
