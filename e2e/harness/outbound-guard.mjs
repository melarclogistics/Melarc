// The sandbox for external effects. It is loaded into the API process under test with `node --import` and
// is never part of the application: nothing in apps/ refers to it.
//
// Local and test environments must not contact production payment, messaging or security providers
// (delivery/DEVELOPMENT_EXECUTION_PLAN.md section 12). The rule is enforced here by the one thing every
// outbound call has in common: it opens a TCP socket. A connection to anything but this machine is refused
// before it is made, and each refusal is appended to MELARC_E2E_CAPTURE_FILE, one JSON line, so a test can
// assert on what the code tried to do. fetch, http and https all connect through net.Socket, so they are
// covered; a pipe or a socket file is local by definition and is left alone.
import { appendFileSync } from 'node:fs';
import net from 'node:net';
import process from 'node:process';

const captureFile = process.env.MELARC_E2E_CAPTURE_FILE;

/** Exactly this machine: localhost, 127.x.y.z and ::1, matched as a whole so that "localhost.evil.example" is not. */
function isLoopback(host) {
  // No host at all (`net.connect(port)`, `{ port }`, a path) is the local machine: Node connects to localhost.
  if (host === undefined || host === null || host === '') return true;
  const name = String(host).toLowerCase();
  if (name === 'localhost' || name === '::1' || name === '[::1]') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * The target of the many shapes net.Socket#connect accepts: (options), (port, host), (path), and the already
 * normalized `[options, callback]` array that net.connect hands to it. They are read as Node itself reads
 * them: a number or a numeric string is a port, and only a string second argument is a host; any other string
 * is a pipe or socket path.
 *
 * A shape that is none of these (undefined, null, a boolean, an object with no path and no port) is not
 * refused here. It has no host, and a missing host is the local machine, so it is passed on, and Node's own
 * argument check rejects it (ERR_MISSING_ARGS, ERR_INVALID_ARG_TYPE) before any connection is made.
 */
function targetOf(args) {
  const [raw, second] = args;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first !== null && typeof first === 'object') {
    return first.path === undefined
      ? { host: first.host, port: Number(first.port) }
      : { path: first.path };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { host: typeof second === 'string' ? second : undefined, port: Number(first) };
  }
  return { path: first };
}

function record(target) {
  if (captureFile === undefined || captureFile === '') return;
  const entry = {
    at: new Date().toISOString(),
    kind: 'blocked-connection',
    host: String(target.host),
    port: target.port,
  };
  // Synchronously, so the line is there even if the process is killed straight after.
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = targetOf(args);
  if (target.path !== undefined || isLoopback(target.host)) return connect.apply(this, args);

  record(target);
  const error = Object.assign(
    new Error(
      `Outbound connection to ${String(target.host)}:${String(target.port)} is refused by the test sandbox`,
    ),
    { code: 'EHARNESSBLOCKED' },
  );
  process.nextTick(() => {
    this.destroy(error);
  });
  return this;
};
