import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { isJsonMediaType, promisesUtf8 } from '../utf8-json.js';
import { AdmissionRefusedError, type AdmissionGate, type AdmissionSlot } from './admission-gate.js';
import { refuseTransport, type TransportReason } from './transport-refusal.js';

/**
 * The exemption of the probes from the admission gate and the request budget (audit of 11 October 2026, F05): a request for the
 * **exact path** of a probe by a **method the probe answers** (`GET`, and `HEAD`, which Express answers from the `GET`) that carries
 * **no body**. A `POST` of a probe's path, or any request that brings a body, is a request like any other: it takes a slot and is
 * counted, and its body is limited, timed and parsed under the same rules.
 */
export function probeRequests(paths: ReadonlySet<string>): (request: Request) => boolean {
  return (request) =>
    (request.method === 'GET' || request.method === 'HEAD') &&
    paths.has(request.path) &&
    !declaresBody(request);
}

/** Whether the client asked to be told to go ahead before it sends the body (`Expect: 100-continue`). */
function expectsContinue(request: Request): boolean {
  return request.headers.expect?.toLowerCase() === '100-continue';
}

export interface TransportAdmissionOptions {
  /** The most bytes a body may have, counted as they are received (`HTTP_BODY_LIMIT_BYTES`). */
  readonly limitBytes: number;
  /** The most time the body may take to arrive once it is being read (`HTTP_BODY_TIMEOUT_MS`). */
  readonly bodyTimeoutMs: number;
  readonly gate: AdmissionGate;
  /** The probes, which are never queued behind the traffic they report on. */
  readonly isExempt: (request: Request) => boolean;
}

/**
 * Whether the request says it has a body: a `Transfer-Encoding` (a chunked body has no length), or a `Content-Length` above
 * nought. A `Content-Length` of nought is no body, whatever type the request names.
 */
export function declaresBody(request: Request): boolean {
  if (request.headers['transfer-encoding'] !== undefined) return true;
  const length = request.headers['content-length'];
  return length !== undefined && Number(length) > 0;
}

/** The `Content-Encoding`s of a request that are not `identity`. A body that names any is refused: nothing here inflates one. */
function isEncoded(request: Request): boolean {
  const encoding = request.headers['content-encoding'];
  if (encoding === undefined) return false;
  return encoding
    .split(',')
    .map((each) => each.trim().toLowerCase())
    .some((each) => each !== '' && each !== 'identity');
}

/**
 * What the head of a request with a body already says is wrong with it, before a byte of the body is read: it is encoded, it
 * is not JSON, it promises a charset other than UTF-8, or it declares more than the limit. The first reason that holds.
 */
function refusalFromHead(request: Request, limitBytes: number): TransportReason | undefined {
  if (isEncoded(request)) return 'compressed-body';
  const contentType = request.headers['content-type'];
  if (contentType === undefined || !isJsonMediaType(contentType)) return 'unsupported-media-type';
  if (!promisesUtf8(contentType)) return 'unsupported-charset';
  const length = request.headers['content-length'];
  if (length !== undefined && Number(length) > limitBytes) return 'body-too-large';
  return undefined;
}

/**
 * Transport admission (S0.20; permission-enforcement.md §5.1; SLICE-000-FINAL-DECISIONS.md §9), in front of the body parser and
 * of everything that routes or guards. It enforces, promptly and before the refusal order of the business starts:
 *
 * 1. **The head of a body** (encoding, media type, charset, declared size), from the head alone: a request refused here has
 *    not been read, and takes no slot. A body is JSON, in UTF-8, and not encoded; nothing in this API inflates a request.
 * 2. **A slot** at the admission gate, for at most the admission deadline, in a line of bounded length. The probes are not
 *    queued. A request whose client leaves while it waits is dropped from the line.
 * 3. **The body, counted as it is received** (`data` events), so a chunked body, which declares no length, is limited too, and
 *    the answer is made at the moment the limit is crossed: the server does not read an oversized body to the end to be able to
 *    say it is too large. A body that has not arrived within the body deadline of the moment it began to be read is answered
 *    `408`.
 *
 * Every refusal here is made by the transport and carries no `Error.code` (errors-and-enums.md §4). The slot is held until the
 * response is finished or the connection is gone. None of this bounds a handler: the request's execution budget does
 * (`request-budget.ts`), and it starts after this has admitted the request and received its body.
 */
export function createTransportAdmission(options: TransportAdmissionOptions): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const declared = declaresBody(request);
    if (declared) {
      const reason = refusalFromHead(request, options.limitBytes);
      if (reason !== undefined) {
        refuseTransport(response, reason);
        return;
      }
    }

    const receive = (): void => {
      if (declared) countAndTimeBody(request, response, options);
      // Only now is the client invited to send its body: the head has been judged and the request holds a slot. Node, left alone,
      // answers `Expect: 100-continue` the moment the head arrives (the server listens for `checkContinue` for this, `createApp`).
      if (expectsContinue(request) && !response.headersSent) response.writeContinue();
      next();
    };

    if (options.isExempt(request)) {
      receive();
      return;
    }

    // The wait is abandoned when the client goes away, and the slot, once held, is given back when the response is over.
    const waiting = new AbortController();
    let gone = false;
    const onClose = (): void => {
      gone = true;
      waiting.abort();
    };
    response.once('close', onClose);
    options.gate.acquire({ signal: waiting.signal }).then(
      (slot: AdmissionSlot) => {
        if (gone) {
          slot.release();
          return;
        }
        response.off('close', onClose);
        response.once('close', () => {
          slot.release();
        });
        // Nothing here may reject the promise this continues: an unhandled rejection ends the process. A failure to start reading
        // is the request's, and goes where any middleware's failure goes.
        try {
          receive();
        } catch (failure) {
          next(failure);
        }
      },
      (error: unknown) => {
        if (!(error instanceof AdmissionRefusedError)) {
          next(error);
          return;
        }
        if (error.reason === 'aborted') return;
        refuseTransport(response, `admission-${error.reason}`);
      },
    );
  };
}

/**
 * Limits one request's body while the body parser reads it: the bytes are counted as they arrive, and the time is the body
 * deadline. Both end the request with a refusal and stop being counted; neither is left behind once the body has arrived or the
 * request is over, so a connection kept alive is not cut by the deadline of a request that was answered.
 *
 * This listens to `data` beside the parser, in the same turn of the event loop that the parser starts reading in (the caller
 * calls `next()` straight after), so neither misses a chunk.
 */
function countAndTimeBody(
  request: Request,
  response: Response,
  options: TransportAdmissionOptions,
): void {
  let received = 0;
  let over = false;
  const stop = (): void => {
    over = true;
    clearTimeout(timer);
    request.off('data', onData);
  };
  const timer = setTimeout(() => {
    if (over) return;
    stop();
    refuseTransport(response, 'body-deadline');
  }, options.bodyTimeoutMs);
  timer.unref();
  const onData = (chunk: Buffer | string): void => {
    received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (over || received <= options.limitBytes) return;
    stop();
    refuseTransport(response, 'body-too-large');
  };
  request.on('data', onData);
  request.once('end', stop);
  request.once('close', stop);
  request.once('error', stop);
}
