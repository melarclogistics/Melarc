import type { Request, Response } from 'express';

/**
 * What a refusal that leaves the connection open costs (the audit of 11 October 2026, F05). Most transport refusals are about what
 * the request says, and answer without closing: a client that is still writing its body would be reset under the answer (on some
 * platforms a reset discards what the client had not yet read), so the rest of the body is read off and discarded, as an HTTP
 * server does (a "lingering close"). Left to Node that reading is bounded by the request deadline alone, and a refusal that never
 * held a slot at the admission gate (a head refusal) is not counted against the process at all.
 *
 * This bounds it three ways: **bytes** (more than `maxBytes` read off after the refusal and the connection is closed), **time**
 * (`maxMs` from the refusal) and **connections** (at most `maxConcurrent` are being read off at once; a refusal beyond that closes
 * its connection with the answer, `Connection: close`, and reads nothing). The connection is closed only after the answer has been
 * written to the socket, so the client is told why before it is cut.
 *
 * The figures are derived from the receipt limits and the admission concurrency (`createApp`: sixteen times the body limit, the body
 * deadline, the admission concurrency), and add no setting. The bytes are generous on purpose: a connection cut while the client is
 * still writing is reset, and on some platforms a reset discards the answer the client had not yet read.
 */
export interface RefusedBodyLimits {
  readonly maxBytes: number;
  readonly maxMs: number;
  readonly maxConcurrent: number;
}

/** The Express setting the policy is kept under, so that a refusal made anywhere in the pipeline finds it from its response. */
export const REFUSED_BODY_SETTING = 'melarc refused body drain';

/** True while the request says it has a body that has not all arrived. */
export function bodyIsStillComing(request: Request): boolean {
  return !request.complete;
}

export class RefusedBodyDrain {
  #active = 0;

  constructor(private readonly limits: RefusedBodyLimits) {
    if (!Number.isInteger(limits.maxBytes) || limits.maxBytes < 0) {
      throw new RangeError('The bytes read off after a refusal are a whole number, none or more');
    }
    if (!Number.isFinite(limits.maxMs) || limits.maxMs <= 0) {
      throw new RangeError('The time to read off a refused body is a finite, positive number');
    }
    if (!Number.isInteger(limits.maxConcurrent) || limits.maxConcurrent < 1) {
      throw new RangeError('The connections read off at once are a positive whole number');
    }
  }

  /** How many connections are being read off now. */
  get active(): number {
    return this.#active;
  }

  /**
   * Asks for room to read off the body of a request that is being refused, before the refusal is written. Returns what to do once
   * it has been written (`begin`), or undefined when there is no room and the refusal must close the connection instead.
   */
  admit(request: Request, response: Response): (() => void) | undefined {
    if (this.#active >= this.limits.maxConcurrent) return undefined;
    this.#active += 1;
    return () => {
      this.#begin(request, response);
    };
  }

  #begin(request: Request, response: Response): void {
    let over = false;
    let drained = 0;
    const finish = (): void => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', finish);
      request.off('close', finish);
      request.off('error', finish);
      request.socket.off('close', finish);
      this.#active -= 1;
    };
    // The answer first, then the cut: destroying the socket with the refusal still in its buffer would lose it.
    const cut = (): void => {
      finish();
      const socket = request.socket;
      const destroy = (): void => {
        socket.destroy();
      };
      if (response.writableFinished) {
        destroy();
        return;
      }
      response.once('finish', destroy);
      setTimeout(destroy, 1_000).unref();
    };
    const onData = (chunk: Buffer | string): void => {
      drained += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (drained > this.limits.maxBytes) cut();
    };
    const timer = setTimeout(cut, this.limits.maxMs);
    timer.unref();
    request.on('data', onData);
    request.once('end', finish);
    request.once('close', finish);
    request.once('error', finish);
    // A request that was refused before its body arrived is no longer one the server tracks once it has been answered, so when the
    // client goes away it hears nothing: the socket is what says the connection is over.
    request.socket.once('close', finish);
  }
}
