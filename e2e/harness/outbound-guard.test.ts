import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCaptured } from './capture.ts';

/** A file URL: on Windows `--import` does not accept an absolute path. */
const GUARD = pathToFileURL(resolve(import.meta.dirname, 'outbound-guard.mjs')).href;

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'melarc-guard-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Runs a script in a real Node process with the guard loaded the way the harness loads it into the API, and
 * returns what the script printed, and what the guard captured.
 */
function underGuard(body: string, capture = true) {
  const script = join(directory, 'script.mjs');
  const captureFile = join(directory, 'capture.jsonl');
  writeFileSync(script, body);
  const result = spawnSync(process.execPath, ['--import', GUARD, script], {
    encoding: 'utf8',
    env: {
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(capture ? { MELARC_E2E_CAPTURE_FILE: captureFile } : {}),
    },
    timeout: 20_000,
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    captured: capture ? readCaptured(captureFile) : [],
  };
}

const ATTEMPT = (host: string, port = 443) => `
import net from 'node:net';
const socket = net.connect(${String(port)}, '${host}');
socket.on('error', (error) => { console.log(error.code); process.exit(0); });
socket.on('connect', () => { console.log('CONNECTED'); process.exit(0); });
`;

describe('connections the guard allows', () => {
  // Break caught: a guard that knows only 127.0.0.1, so that the rest of the loopback range is refused.
  it('does not refuse any address in the 127.x.y.z loopback range', () => {
    // Nothing listens at 127.0.0.2, so the operating system refuses the connection. What is proved is that
    // the guard let it through: it neither blocked it nor recorded it.
    const result = underGuard(ATTEMPT('127.0.0.2', 9));

    expect(result.stdout).toBe('ECONNREFUSED');
    expect(result.captured).toEqual([]);
  });

  // Break caught: a guard so broad that the application cannot reach its own database or be reached by its
  // own proxy. Loopback is the whole of the machine's internal traffic and is never an external effect.
  it.each(['127.0.0.1', 'localhost'])('connects to %s', (host) => {
    const result = underGuard(`
import net from 'node:net';
const server = net.createServer((socket) => socket.end()).listen(0, '127.0.0.1', () => {
  const socket = net.connect(server.address().port, '${host}');
  socket.on('connect', () => { console.log('CONNECTED'); socket.end(); server.close(); });
  socket.on('error', (error) => { console.log(error.code); server.close(); });
});
`);

    expect(result.stdout).toBe('CONNECTED');
    expect(result.captured).toEqual([]);
  });

  // Break caught: the options form being read as something else, so that a loopback host named in an object
  // is refused or not seen at all.
  it('allows the options form of net.connect with a loopback host', () => {
    const result = underGuard(`
import net from 'node:net';
const server = net.createServer((socket) => socket.end()).listen(0, '127.0.0.1', () => {
  const socket = net.connect({ port: server.address().port, host: '127.0.0.1' });
  socket.on('connect', () => { console.log('CONNECTED'); socket.end(); server.close(); });
  socket.on('error', (error) => { console.log(error.code); server.close(); });
});
`);

    expect(result.stdout).toBe('CONNECTED');
    expect(result.captured).toEqual([]);
  });

  // Break caught: a connection that names no host being taken for an external one. Node connects such a
  // connection to localhost, so it is this machine, and a guard that refused it would stop the application
  // from reaching a server it started itself with `net.connect(port)`.
  it.each([
    ['a port only', 'net.connect(server.address().port)'],
    ['an options object with a port and no host', 'net.connect({ port: server.address().port })'],
  ])('allows a connection that names no host: %s', (_label, call) => {
    const result = underGuard(`
import net from 'node:net';
const server = net.createServer((socket) => socket.end()).listen(0, '127.0.0.1', () => {
  const socket = ${call};
  socket.on('connect', () => { console.log('CONNECTED'); socket.end(); server.close(); });
  socket.on('error', (error) => { console.log(error.code); server.close(); });
});
`);

    expect(result.stdout).toBe('CONNECTED');
    expect(result.captured).toEqual([]);
  });

  // Break caught: a pipe or socket path being treated as a host. A path is local by definition. The server here
  // listens on the path and nowhere else, so the connection can only succeed if it was made to the path, and the
  // test is not a TCP connection that merely happens to use the same call. On Windows it is a named pipe.
  it('allows a connection to a local pipe or socket path', () => {
    const path =
      process.platform === 'win32'
        ? String.raw`\\.\pipe\melarc-guard-${randomUUID()}`
        : join(directory, 'guard.sock');
    const result = underGuard(`
import net from 'node:net';
const path = ${JSON.stringify(path)};
const server = net.createServer((socket) => socket.end()).listen(path, () => {
  const socket = net.connect(path);
  socket.on('connect', () => { console.log('CONNECTED'); socket.end(); server.close(); });
  socket.on('error', (error) => { console.log(error.code); server.close(); });
});
`);

    expect(result.stdout).toBe('CONNECTED');
    expect(result.captured).toEqual([]);
  });
});

describe('connections the guard refuses', () => {
  // Break caught: an attempt to reach a host outside this machine going through. This is the sandbox: a
  // payment or messaging provider can never be contacted from a test, by any code path that opens a socket.
  it.each([
    ['a named host', 'payments.provider.example'],
    ['a public address', '203.0.113.5'],
    ['a look-alike of localhost', 'localhost.evil.example'],
    ['a private network address', '10.0.0.5'],
  ])('refuses %s, and records the attempt', (_label, host) => {
    const result = underGuard(ATTEMPT(host));

    expect(result.stdout).toBe('EHARNESSBLOCKED');
    expect(result.captured).toHaveLength(1);
    expect(result.captured[0]).toMatchObject({ kind: 'blocked-connection', host, port: 443 });
  });

  // Break caught: a host that merely begins with 127 being taken for the loopback range. It is not an address
  // (an octet over 255), so it would be looked up as a name, which is outside this machine.
  it('refuses a host that looks like a loopback address but is not one', () => {
    const result = underGuard(ATTEMPT('127.0.0.256'));

    expect(result.stdout).toBe('EHARNESSBLOCKED');
    expect(result.captured).toHaveLength(1);
  });

  // Break caught: a way of calling connect that the guard does not read, so that code written in that form
  // reaches a provider. Every form Node accepts names the host in one of these places.
  it.each([
    ['net.connect(port, host)', "net.connect(443, 'payments.provider.example')"],
    ['net.connect(options)', "net.connect({ port: 443, host: 'payments.provider.example' })"],
    [
      'net.createConnection(options, callback)',
      "net.createConnection({ port: 443, host: 'payments.provider.example' }, () => {})",
    ],
    ['a port given as a numeric string', "net.connect('443', 'payments.provider.example')"],
    ['Socket#connect(port, host)', "new net.Socket().connect(443, 'payments.provider.example')"],
    [
      'Socket#connect(options)',
      "new net.Socket().connect({ port: 443, host: 'payments.provider.example' })",
    ],
  ])('refuses %s to an external host, and records it', (_label, call) => {
    const result = underGuard(`
import net from 'node:net';
const socket = ${call};
socket.on('error', (error) => { console.log(error.code); process.exit(0); });
socket.on('connect', () => { console.log('CONNECTED'); process.exit(0); });
`);

    expect(result.stdout).toBe('EHARNESSBLOCKED');
    expect(result.captured).toHaveLength(1);
    expect(result.captured[0]).toMatchObject({ host: 'payments.provider.example', port: 443 });
  });

  // Documents what the guard does with a shape it does not recognise, which the comment in the guard says: it
  // does not refuse it, because it has no host to refuse, and it passes it to Node, which rejects it itself
  // before any connection is made. Break caught: that being changed without the comment being changed, or an
  // argument that Node would accept as a remote address being read as no host at all.
  it.each(['undefined', 'null', 'true', '{}'])(
    'passes the unrecognised argument %s to Node, which rejects it without connecting',
    (argument) => {
      const result = underGuard(`
import net from 'node:net';
try {
  new net.Socket().connect(${argument});
  console.log('NO ERROR');
} catch (error) {
  console.log(error.code);
}
process.exit(0);
`);

      expect(result.stdout).toMatch(/^ERR_(?:MISSING_ARGS|INVALID_ARG_TYPE)$/);
      expect(result.captured).toEqual([]);
    },
  );

  // Break caught: the guard covering raw sockets but not the HTTP client application code actually uses.
  it('refuses a request made with fetch, and records the host it was for', () => {
    const result = underGuard(`
try {
  await fetch('https://api.sms-provider.example/v1/send', { method: 'POST', body: '{}' });
  console.log('SENT');
} catch (error) {
  console.log('FAILED', error.cause?.code ?? error.code);
}
`);

    expect(result.stdout).toBe('FAILED EHARNESSBLOCKED');
    expect(result.captured.map((entry) => entry.host)).toEqual(['api.sms-provider.example']);
  });

  // Break caught: the guard being switched off by leaving out where to write. Nothing may get through
  // because a path was not set.
  it('still refuses when no capture file is configured, and records nothing', () => {
    const result = underGuard(ATTEMPT('payments.provider.example'), false);

    expect(result.stdout).toBe('EHARNESSBLOCKED');
  });

  // Break caught: a capture that cannot be told from nothing happening. Each attempt is a line with its time,
  // the kind, the host and the port, and several attempts are all kept.
  it('records every attempt, in order, with the host and port', () => {
    const result = underGuard(`
import net from 'node:net';
let pending = 2;
for (const [host, port] of [['first.example', 25], ['second.example', 587]]) {
  net.connect(port, host).on('error', () => { if (--pending === 0) console.log('DONE'); });
}
`);

    expect(result.stdout).toBe('DONE');
    expect(
      result.captured.map((entry) => `${entry.host}:${String(entry.port)}`).toSorted(),
    ).toEqual(['first.example:25', 'second.example:587']);
    expect(result.captured.every((entry) => !Number.isNaN(Date.parse(entry.at)))).toBe(true);
  });
});
