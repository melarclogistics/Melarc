import { connect, type Socket } from 'node:net';

/**
 * A client that writes the bytes it is told to, when it is told to, and reads back whatever the server sends. `fetch` cannot be
 * a slow sender, cannot stop in the middle of a head or a body, and sets the framing headers itself; the transport limits
 * (S0.20) are about exactly those requests, so the tests of them speak to the server over a bare socket.
 *
 * It parses one response: the status line, the headers and a body framed by `Content-Length` (or the rest of the connection).
 * That is all the tests need, and it is a test helper: nothing in the production tree imports it.
 */
export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  /** The body as JSON, or undefined when it is empty or is not JSON. */
  readonly json: Record<string, unknown> | undefined;
}

export class RawClient {
  private readonly chunks: Buffer[] = [];
  private response: Promise<RawResponse> | undefined;
  private ended = false;
  /** True once the server has closed its end or the connection has been reset. */
  closed = false;
  /** What the socket reported if it failed (a reset, a broken pipe). Writes after a server closes may fail with these. */
  failure: Error | undefined;
  private readonly waiters = new Set<() => void>();

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.wake();
    });
    socket.on('error', (error) => {
      this.failure = error;
      this.closed = true;
      this.wake();
    });
    socket.on('close', () => {
      this.closed = true;
      this.wake();
    });
    socket.on('end', () => {
      this.ended = true;
      this.wake();
    });
  }

  static async connect(baseUrl: string): Promise<RawClient> {
    const { hostname, port } = new URL(baseUrl);
    const socket = connect({ host: hostname, port: Number(port) });
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new RawClient(socket);
  }

  /** Writes bytes. Resolves when the socket has taken them; a write after the server closed is swallowed (see `failure`). */
  write(data: string | Buffer): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed || !this.socket.writable) {
        resolve();
        return;
      }
      this.socket.write(data, () => {
        resolve();
      });
    });
  }

  /** Ends the writing side, as a client that has finished its request does. */
  end(): void {
    if (!this.socket.destroyed) this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  /** Waits until `condition` holds, the connection closes, or `timeoutMs` passes; true when it held. */
  async until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.closed) return condition();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 25));
        this.waiters.add(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return true;
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
    this.waiters.clear();
  }

  /** What has arrived so far, as text. */
  received(): string {
    return Buffer.concat(this.chunks).toString('latin1');
  }

  /**
   * The server's response, parsed, once its head and the whole of its body have arrived (or the connection closed). Rejects when
   * nothing parseable arrives within `timeoutMs`.
   */
  read(timeoutMs = 5_000): Promise<RawResponse> {
    this.response ??= this.parse(timeoutMs);
    return this.response;
  }

  private async parse(timeoutMs: number): Promise<RawResponse> {
    const complete = (): boolean => {
      const text = this.received();
      const split = text.indexOf('\r\n\r\n');
      if (split < 0) return false;
      const head = text.slice(0, split);
      const length = /\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1];
      if (length === undefined) return this.closed || this.ended;
      return Buffer.byteLength(text.slice(split + 4), 'latin1') >= Number(length);
    };
    if (!(await this.until(complete, timeoutMs))) {
      throw new Error(
        `no complete response within ${String(timeoutMs)} ms: ${this.received().slice(0, 300)}`,
      );
    }
    const text = this.received();
    const split = text.indexOf('\r\n\r\n');
    if (split < 0)
      throw new Error(`the connection closed before a response head: ${JSON.stringify(text)}`);
    const [statusLine = '', ...lines] = text.slice(0, split).split('\r\n');
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const at = line.indexOf(':');
      if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    const body = Buffer.from(text.slice(split + 4), 'latin1').toString('utf8');
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    return { status, headers, text: body, json };
  }
}

/** A request head with the given lines, ended by a blank line unless `open` is set (a head the client never finishes). */
export function head(
  requestLine: string,
  headers: Readonly<Record<string, string>>,
  options: { readonly open?: boolean } = {},
): string {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `${[requestLine, ...lines].join('\r\n')}\r\n${options.open === true ? '' : '\r\n'}`;
}

/** One chunk of a chunked body. */
export function chunk(data: string | Buffer): Buffer {
  const body = Buffer.from(data);
  return Buffer.concat([Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n')]);
}
