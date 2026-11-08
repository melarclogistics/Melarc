import { STATUS_CODES } from 'node:http';

import type { Request, Response } from 'express';

import { OPERATIONAL_FAILURE, writeFailure, type Rendered } from '../all-exceptions.filter.js';
import { bodyIsStillComing, REFUSED_BODY_SETTING, type RefusedBodyDrain } from './refused-body.js';
import { TRANSPORT_REFUSAL_KEY } from './response-keys.js';

/**
 * Why the transport layer refused a request. A reason is for the log and the tests, never for the client: a transport refusal
 * carries no `Error.code` (errors-and-enums.md §4, Product decision of 8 October 2026) and its text is fixed.
 */
export type TransportReason =
  | 'body-too-large'
  | 'compressed-body'
  | 'unsupported-media-type'
  | 'unsupported-charset'
  | 'body-deadline'
  | 'invalid-framing'
  | 'admission-full'
  | 'admission-timeout'
  | 'admission-closed';

const STATUS_OF: Readonly<Record<TransportReason, 400 | 408 | 413 | 415 | 503>> = {
  'body-too-large': 413,
  'compressed-body': 415,
  'unsupported-media-type': 415,
  'unsupported-charset': 415,
  'body-deadline': 408,
  'invalid-framing': 400,
  'admission-full': 503,
  'admission-timeout': 503,
  'admission-closed': 503,
};

function renderedFor(reason: TransportReason): Rendered {
  const status = STATUS_OF[reason];
  // A full gate is an outage of the service and is answered as every outage is. The others are the caller's: the reason phrase
  // of the status and no code, since the catalogue has none for them.
  if (status === 503) return OPERATIONAL_FAILURE;
  return { status, body: { message: STATUS_CODES[status] ?? 'Bad Request' } };
}

/**
 * The refusals after which the connection is closed: a sender too slow to be worth waiting for, and a request whose framing
 * cannot be trusted to find where the next one begins. Every other refusal is about what the request says, not about how it
 * arrives, and **leaves the connection open**: the rest of the body, which the client may already be sending, is read and
 * discarded (Node discards the body of a request nobody read; the body parser reads off a request it refused), within the bounds
 * of `refused-body.ts` (bytes, time, and connections being read off at once; beyond them the connection is closed after the
 * answer, or at once when there is no room). Closing at once would reset the connection under a client that is still writing, and
 * on some platforms a reset discards the answer the client had not yet read, so a client with an oversized body would learn
 * nothing of why it was refused.
 */
const CLOSES_THE_CONNECTION: ReadonlySet<TransportReason> = new Set([
  'body-deadline',
  'invalid-framing',
]);

/**
 * Refuses a request at transport admission, before any step of the refusal order: a code-less answer with the request id.
 *
 * The reason is kept on the response for the completion line (`request-middleware.ts`), which is the one line a refused
 * request writes: a refusal is cheap to provoke, and a log line for each is a way to fill the log. Nothing of the request is
 * recorded here.
 */
export function refuseTransport(response: Response, reason: TransportReason): void {
  if (response.headersSent) return;
  response.locals[TRANSPORT_REFUSAL_KEY] = reason;
  // A body that is still coming is read off within bounds if there is room to; otherwise the connection closes with the answer.
  const drain = (response.app as { get?: (name: string) => unknown } | undefined)?.get?.(
    REFUSED_BODY_SETTING,
  ) as RefusedBodyDrain | undefined;
  const request = response.req as Request | undefined;
  let begin: (() => void) | undefined;
  if (CLOSES_THE_CONNECTION.has(reason)) {
    response.setHeader('Connection', 'close');
  } else if (drain !== undefined && request !== undefined && bodyIsStillComing(request)) {
    begin = drain.admit(request, response);
    if (begin === undefined) response.setHeader('Connection', 'close');
  }
  writeFailure(response, renderedFor(reason));
  begin?.();
}
