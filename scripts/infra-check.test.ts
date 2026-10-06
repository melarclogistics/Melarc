import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { isLoopbackHost as toolsIsLoopbackHost } from '../apps/api/src/tools/database/safety.ts';
import {
  isLoopbackHost,
  isWsl,
  probePostgres,
  readDatabaseAddress,
  runInfraCheck,
  type Probe,
} from './infra-check.ts';

const servers: Server[] = [];
const directories: string[] = [];

const closeServer = (server: Server): Promise<void> =>
  new Promise((done) => {
    server.close(() => {
      done();
    });
  });

after(async () => {
  for (const server of servers) await closeServer(server);
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/** A server on loopback that runs `onConnection` for each client. Returns its port and what the clients sent. */
async function serve(
  onConnection: (socket: Socket, received: Buffer[]) => void,
): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => received.push(chunk));
    onConnection(socket, received);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { port: address.port, received };
}

/** A port nothing listens on: bound and released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  await closeServer(server);
  return address.port;
}

/** The first byte PostgreSQL answers an SSLRequest with: S (it can) or N (it cannot, and carries on). */
const answerWith = (byte: string) => (socket: Socket) => {
  socket.once('data', () => socket.end(byte));
};

function checkout(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'melarc-infra-check-'));
  directories.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('probePostgres', () => {
  // Break caught: reachability being called a working database. Something else can hold the port (another
  // project's server does on this machine), and only the protocol's own answer says it is PostgreSQL.
  for (const byte of ['N', 'S']) {
    it(`recognizes a server that answers the SSL request with ${byte}`, async () => {
      const { port, received } = await serve(answerWith(byte));

      const probe = await probePostgres('127.0.0.1', port, 2_000);

      assert.deepEqual(probe, { kind: 'postgres' });
      // The probe is the protocol's own harmless first message: length 8, request code 80877103. No user, no password.
      assert.deepEqual(Buffer.concat(received), Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
    });
  }

  it('says a server that answers anything else is not PostgreSQL', async () => {
    const { port } = await serve((socket) => {
      socket.once('data', () => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    });
    const probe = await probePostgres('127.0.0.1', port, 2_000);
    assert.deepEqual(probe, {
      kind: 'not-postgres',
      detail: 'it answered with something that is not the PostgreSQL protocol',
    });
  });

  it('says a server that closes without answering is not PostgreSQL', async () => {
    const { port } = await serve((socket) => {
      socket.end();
    });
    const probe = await probePostgres('127.0.0.1', port, 2_000);
    assert.deepEqual(probe, {
      kind: 'not-postgres',
      detail: 'it closed the connection without answering',
    });
  });

  // Break caught: a probe that waits for ever on a server that accepts and says nothing.
  it('gives up on a server that accepts and never answers', async () => {
    const { port } = await serve(() => undefined);
    const started = Date.now();
    const probe = await probePostgres('127.0.0.1', port, 300);
    assert.deepEqual(probe, {
      kind: 'not-postgres',
      detail: 'it accepted the connection but did not answer within 300 ms',
    });
    assert.ok(Date.now() - started < 3_000, 'it must stop at its own deadline');
  });

  it('reports the error code when nothing is listening', async () => {
    const probe = await probePostgres('127.0.0.1', await closedPort(), 2_000);
    assert.deepEqual(probe, { kind: 'unreachable', code: 'ECONNREFUSED' });
  });

  // `localhost` can resolve to ::1 and 127.0.0.1; when both refuse, Node fails with an AggregateError.
  // Which address's code it carries depends on the host's IPv6, so a real code is what is asserted, not UNKNOWN.
  it('reports an error code when a name that resolves to several addresses refuses', async () => {
    const probe = await probePostgres('localhost', await closedPort(), 2_000);
    assert.equal(probe.kind, 'unreachable');
    assert.match(probe.code, /^E[A-Z]+$/);
  });
});

describe('readDatabaseAddress', () => {
  const FILE = 'infrastructure/postgres/.env';

  it('defaults to loopback and 5432 when nothing is set', () => {
    assert.deepEqual(readDatabaseAddress(checkout(), {}), { host: '127.0.0.1', port: 5432 });
  });

  it('reads the host and port from the settings file', () => {
    const root = checkout({
      [FILE]: 'MELARC_PG_HOST=localhost\nMELARC_PG_PORT=5433\nMELARC_PG_ADMIN_PASSWORD=secret\n',
    });
    assert.deepEqual(readDatabaseAddress(root, {}), { host: 'localhost', port: 5433 });
  });

  // Break caught: a developer's explicit setting for one run being overridden by the file, as the database tools
  // themselves let the environment win.
  it('lets the environment win over the file', () => {
    const root = checkout({ [FILE]: 'MELARC_PG_HOST=localhost\nMELARC_PG_PORT=5433\n' });
    const env = { MELARC_PG_HOST: '127.0.0.1', MELARC_PG_PORT: '6543' };
    assert.deepEqual(readDatabaseAddress(root, env), { host: '127.0.0.1', port: 6543 });
  });

  // Break caught: `MELARC_PG_PORT=` in a shell hiding the file's value, which the database tools do not do.
  it('treats an empty environment value as not set', () => {
    const root = checkout({ [FILE]: 'MELARC_PG_HOST=localhost\nMELARC_PG_PORT=5433\n' });
    const env = { MELARC_PG_HOST: '', MELARC_PG_PORT: '' };
    assert.deepEqual(readDatabaseAddress(root, env), { host: 'localhost', port: 5433 });
  });

  // Break caught: a value that Number() reads as a port but the tools refuse (1e3, 0x50, padded with spaces).
  for (const port of [
    '0',
    '65536',
    'abc',
    '54 32',
    '-1',
    '5432.5',
    '1e3',
    '0x50',
    ' 5432',
    '5432 ',
  ]) {
    it(`refuses the port ${JSON.stringify(port)}`, () => {
      assert.throws(
        () => readDatabaseAddress(checkout(), { MELARC_PG_PORT: port }),
        /MELARC_PG_PORT/,
      );
    });
  }
});

// Break caught: this script's copy of the loopback rule drifting from the one the database tools enforce. The
// script cannot import it at run time (it runs before an install), so a test holds the two to the same answers.
describe('isLoopbackHost', () => {
  const hosts = [
    '127.0.0.1',
    '127.1.2.3',
    '127.255.255.255',
    '127.0.0.256',
    '127.0.0',
    '127.0.0.1.5',
    'localhost',
    'LOCALHOST',
    'LocalHost',
    '::1',
    '::2',
    '::',
    '0.0.0.0',
    '10.0.0.5',
    '172.17.0.1',
    '192.168.1.1',
    'localhost.evil.example',
    'evil-localhost',
    'db.example.com',
    '',
    ' 127.0.0.1',
    '127.0.0.1 ',
    '[::1]',
    '0127.0.0.1',
    '128.0.0.1',
  ];

  for (const host of hosts) {
    it(`gives the database tools' answer for ${JSON.stringify(host)}`, () => {
      assert.equal(isLoopbackHost(host), toolsIsLoopbackHost(host));
    });
  }
});

describe('isWsl', () => {
  it('recognizes WSL by its distribution name or by a Microsoft kernel', () => {
    assert.equal(isWsl('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, ''), true);
    assert.equal(
      isWsl('linux', {}, 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@x)'),
      true,
    );
    assert.equal(
      isWsl('linux', {}, 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)'),
      true,
    );
  });

  it('does not take an empty distribution name for WSL', () => {
    assert.equal(isWsl('linux', { WSL_DISTRO_NAME: '' }, 'Linux version 6.8.0-generic'), false);
  });

  it('does not take other Linux, or any other platform, for WSL', () => {
    assert.equal(isWsl('linux', {}, 'Linux version 6.8.0-generic (buildd@lcy02)'), false);
    assert.equal(isWsl('linux', {}, undefined), false);
    assert.equal(isWsl('win32', { WSL_DISTRO_NAME: 'Ubuntu' }, 'microsoft'), false);
    assert.equal(isWsl('darwin', {}, 'microsoft'), false);
  });
});

describe('runInfraCheck', () => {
  const fixed = (probe: Probe) => () => Promise.resolve(probe);

  async function run(options: {
    probe?: Probe;
    env?: Record<string, string>;
    wsl?: boolean;
    files?: Record<string, string>;
  }): Promise<{ status: number; text: string; probed: [string, number][] }> {
    const lines: string[] = [];
    const probed: [string, number][] = [];
    const probe = options.probe ?? { kind: 'postgres' };
    const status = await runInfraCheck(checkout(options.files), (line) => lines.push(line), {
      env: options.env ?? {},
      wsl: options.wsl ?? false,
      probe: (host, port) => {
        probed.push([host, port]);
        return fixed(probe)();
      },
    });
    return { status, text: lines.join('\n'), probed };
  }

  it('exits 0 and names the address when PostgreSQL answers', async () => {
    const { status, text, probed } = await run({ env: { MELARC_PG_PORT: '5433' } });
    assert.equal(status, 0);
    assert.match(text, /PostgreSQL answers at 127\.0\.0\.1:5433/);
    assert.deepEqual(probed, [['127.0.0.1', 5433]]);
  });

  // Break caught: the check being used to probe a machine other than this one. The database tools act only on
  // this machine, and so does this.
  for (const host of ['10.0.0.5', 'db.example.com', '172.20.0.1', 'localhost.evil.example']) {
    it(`refuses to probe the host ${host}`, async () => {
      const { status, text, probed } = await run({ env: { MELARC_PG_HOST: host } });
      assert.equal(status, 1);
      assert.match(text, /this machine/);
      assert.deepEqual(probed, []);
    });
  }

  for (const host of ['127.0.0.1', 'localhost', '127.1.2.3', '::1']) {
    it(`probes the loopback host ${host}`, async () => {
      const { status, probed } = await run({ env: { MELARC_PG_HOST: host } });
      assert.equal(status, 0);
      assert.equal(probed.length, 1);
    });
  }

  it('says another program holds the port when something answers but is not PostgreSQL', async () => {
    const { status, text } = await run({ probe: { kind: 'not-postgres', detail: 'it sent HTTP' } });
    assert.equal(status, 1);
    assert.match(text, /not PostgreSQL/);
    assert.match(text, /another program/i);
    assert.match(text, /MELARC_PG_PORT/);
    // Changing the port also means changing the one the API connects to.
    assert.match(text, /DATABASE_URL/);
  });

  it('on a plain machine, tells the developer to start the database when nothing listens', async () => {
    const { status, text } = await run({ probe: { kind: 'unreachable', code: 'ECONNREFUSED' } });
    assert.equal(status, 1);
    assert.match(text, /Nothing is listening at 127\.0\.0\.1:5432 \(ECONNREFUSED\)/);
    assert.match(text, /pnpm run infra:up/);
    assert.match(text, /pnpm run infra:status/);
    assert.doesNotMatch(text, /WSL/);
  });

  // Break caught (audit B-03): a WSL2 developer told "start the database" when it is running, on Windows, at an
  // address their `localhost` is not. In the default NAT mode 127.0.0.1 inside WSL2 is the WSL2 VM, not Windows.
  it('in WSL2, explains that localhost may not be Windows, and the two ways forward', async () => {
    const { status, text } = await run({
      probe: { kind: 'unreachable', code: 'ECONNREFUSED' },
      wsl: true,
    });
    assert.equal(status, 1);
    assert.match(text, /WSL2/);
    assert.match(text, /not Windows/);
    assert.match(text, /pnpm run infra:up/);
    assert.match(text, /networkingMode=mirrored/);
    assert.match(text, /DEVELOPMENT\.md/);
  });

  it('never advises binding the database to every interface or pointing the tools at another host', async () => {
    const { text } = await run({ probe: { kind: 'unreachable', code: 'ECONNREFUSED' }, wsl: true });
    assert.doesNotMatch(text, /0\.0\.0\.0|all interfaces|MELARC_PG_HOST/);
  });

  it('says so when it gave up waiting', async () => {
    const { status, text } = await run({ probe: { kind: 'unreachable', code: 'ETIMEDOUT' } });
    assert.equal(status, 1);
    assert.match(text, /ETIMEDOUT/);
  });

  it('exits 1 with the reason for a setting that cannot be used', async () => {
    const { status, text } = await run({ env: { MELARC_PG_PORT: 'abc' } });
    assert.equal(status, 1);
    assert.match(text, /MELARC_PG_PORT/);
  });

  it('never prints a password from the settings file', async () => {
    const { text } = await run({
      files: { 'infrastructure/postgres/.env': 'MELARC_PG_ADMIN_PASSWORD=hunter2hunter2\n' },
      probe: { kind: 'unreachable', code: 'ECONNREFUSED' },
    });
    assert.doesNotMatch(text, /hunter2/);
  });
});

// The command a developer types, as a real process, against a real listener and against a closed port.
describe('the command line', () => {
  const script = resolve(import.meta.dirname, 'infra-check.ts');

  // Asynchronous on purpose: the listener these tests start lives in this process, and a synchronous spawn would
  // block the event loop that has to answer the child.
  function run(
    env: Record<string, string>,
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const outside = Object.entries(process.env).filter(([name]) => !name.startsWith('MELARC_PG_'));
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [script], {
        env: { ...Object.fromEntries(outside), ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.once('error', fail);
      child.once('close', (status) => {
        done({ status, stdout, stderr });
      });
    });
  }

  it('exits 0 against a PostgreSQL-speaking server', async () => {
    const { port } = await serve(answerWith('N'));
    const result = await run({ MELARC_PG_HOST: '127.0.0.1', MELARC_PG_PORT: String(port) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PostgreSQL answers/);
  });

  it('exits 1 against a closed port', async () => {
    const result = await run({
      MELARC_PG_HOST: '127.0.0.1',
      MELARC_PG_PORT: String(await closedPort()),
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Nothing is listening/);
  });

  it('exits 1, and probes nothing, for a host that is not this machine', async () => {
    const result = await run({ MELARC_PG_HOST: '10.255.255.1', MELARC_PG_PORT: '5432' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /this machine/);
  });
});
