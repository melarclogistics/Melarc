import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in that speaks the HTTP contract `src/platform/notifications/hubtel-sms-client.ts` builds against (the header of that file
 * writes the contract down, and marks it UNVERIFIED), on a real socket: `POST {endpoint}/send` and `GET {endpoint}/{messageId}`, answering
 * as a test scripts it. Test support, excluded from the build.
 *
 * It behaves as the provider would where the contract says so, before any script is read: a request without the Basic credentials it was
 * started with is `401`, an unknown path `404`, the wrong method `405`, and a send whose body breaks the contract (a missing member, a
 * number with a leading plus) `400`. A script answers only a request the provider would have taken up.
 *
 * It records each request it received, the refused ones too: the method, the target, the body as JSON, whether the Basic credentials
 * matched, the two headers a client states about its body and whether the client dropped the connection before the answer was finished.
 * **It keeps no credential**: it holds a digest of the header the client must send, compares the digest of what arrived with it, and
 * records the verdict only.
 */

/** What the stand-in answers, built with the functions below. */
export type StandInReply =
  | {
      readonly kind: 'json';
      readonly status: number;
      readonly body: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'raw';
      readonly status: number;
      readonly text: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  /** The answer, after a wait: the client is expected to give up first. */
  | { readonly kind: 'slow'; readonly delayMs: number; readonly then: StandInReply }
  /** The head and the start of a body, then nothing: the connection stays open until the client or the stand-in closes it. */
  | { readonly kind: 'stall' }
  /** The connection is cut with no answer. */
  | { readonly kind: 'drop' };

/** The provider took the message: HTTP 201 (or the given status) and the members of the contract's success. */
export const accepted = (messageId = 'MSG-0001', status = 201): StandInReply => ({
  kind: 'json',
  status,
  body: { Status: 0, MessageId: messageId, Rate: 1, NetworkId: '62001' },
});

/** The provider refused with this HTTP status and this body. */
export const refused = (status: number, body: unknown = { Message: 'refused' }): StandInReply => ({
  kind: 'json',
  status,
  body,
});

/** An answer that is not JSON though its status is a success: the JSON stops half way. */
export const malformed = (status = 200): StandInReply => ({
  kind: 'raw',
  status,
  text: '{"Status":0,"MessageId":',
});

/** HTTP 429, with the given `Retry-After` value where there is one. */
export const rateLimited = (retryAfter?: string): StandInReply => ({
  kind: 'json',
  status: 429,
  body: { Message: 'slow down' },
  ...(retryAfter === undefined ? {} : { headers: { 'Retry-After': retryAfter } }),
});

/** The answer of `then`, after `delayMs`. */
export const slow = (delayMs: number, then: StandInReply = accepted()): StandInReply => ({
  kind: 'slow',
  delayMs,
  then,
});

export const stalled = (): StandInReply => ({ kind: 'stall' });

export const dropped = (): StandInReply => ({ kind: 'drop' });

/** A status query answered HTTP 200 with this body. */
export const answered = (body: unknown, status = 200): StandInReply => ({
  kind: 'json',
  status,
  body,
});

/** A status query answered with the word the contract gives in `Status`. */
export const statusIs = (word: unknown): StandInReply => answered({ Status: word });

export interface StandInRequest {
  readonly method: string;
  /** The request target as it arrived: the path and the query string, if any. */
  readonly path: string;
  /** The body as JSON; undefined when there was none or it was not JSON. */
  readonly body: unknown;
  /** Whether `Authorization` was exactly the Basic header of the credentials the stand-in was started with. */
  readonly credentialsMatched: boolean;
  readonly contentType: string | undefined;
  readonly accept: string | undefined;
  /** The client closed the connection before the stand-in had finished its answer. It is set when the close is seen: wait for it. */
  readonly aborted: boolean;
}

type Recorded = { -readonly [K in keyof StandInRequest]: StandInRequest[K] };

export interface HubtelStandIn {
  /** What the client is given as its `endpoint`: the messages resource, on 127.0.0.1 at a free port. */
  readonly endpoint: string;
  readonly requests: readonly StandInRequest[];
  /** The answers to the next sends, in order; once they are used each send is accepted with a message id of the stand-in's choosing. */
  queueSend(...replies: readonly StandInReply[]): void;
  /** The answers to the status queries of one message id, in order; the last one repeats. A message id nobody scripted is `404`. */
  scriptStatus(messageId: string, ...replies: readonly StandInReply[]): void;
  /** Stops the server and drops every connection and every answer still waiting. Closing twice is the same as closing once. */
  close(): Promise<void>;
}

export interface StandInCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

const RESOURCE = '/v1/messages';
const DESTINATION_DIGITS = /^[1-9][0-9]{7,14}$/;

const digestOf = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A send the contract describes: all four members, the number as digits and no plus. */
function keepsTheContract(body: unknown): boolean {
  return (
    isRecord(body) &&
    typeof body.From === 'string' &&
    body.From !== '' &&
    typeof body.To === 'string' &&
    DESTINATION_DIGITS.test(body.To) &&
    typeof body.Content === 'string' &&
    body.Content !== '' &&
    typeof body.RegisteredDelivery === 'boolean'
  );
}

function parsed(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function startHubtelStandIn(credentials: StandInCredentials): Promise<HubtelStandIn> {
  // Only a digest of the header the client must send is kept: the credentials are compared, and not held.
  const expected = digestOf(
    `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`, 'utf8').toString('base64')}`,
  );
  const requests: Recorded[] = [];
  const sends: StandInReply[] = [];
  const statuses = new Map<string, StandInReply[]>();
  const timers = new Set<NodeJS.Timeout>();
  let issued = 0;

  function respond(response: ServerResponse, reply: StandInReply): void {
    switch (reply.kind) {
      case 'json':
        response.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
        response.end(JSON.stringify(reply.body));
        return;
      case 'raw':
        response.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
        response.end(reply.text);
        return;
      case 'slow': {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!response.destroyed) respond(response, reply.then);
        }, reply.delayMs);
        timers.add(timer);
        return;
      }
      case 'stall':
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"Status":0,');
        return;
      case 'drop':
        response.destroy();
        return;
    }
  }

  function handle(request: IncomingMessage, response: ServerResponse, text: string): void {
    const received = request.headers.authorization;
    const credentialsMatched =
      received !== undefined && timingSafeEqual(digestOf(received), expected);
    const target = request.url ?? '';
    const record: Recorded = {
      method: request.method ?? '',
      path: target,
      body: parsed(text),
      credentialsMatched,
      contentType: request.headers['content-type'],
      accept: request.headers.accept,
      aborted: false,
    };
    requests.push(record);
    response.on('close', () => {
      if (!response.writableFinished) record.aborted = true;
    });

    if (!credentialsMatched) {
      respond(response, refused(401, { Message: 'Unauthorized' }));
      return;
    }
    const path = new URL(target, 'http://stand-in.invalid').pathname;
    if (!path.startsWith(`${RESOURCE}/`) || path.length === RESOURCE.length + 1) {
      respond(response, refused(404, { Message: 'Not found' }));
      return;
    }
    const rest = path.slice(RESOURCE.length + 1);
    if (rest.includes('/')) {
      respond(response, refused(404, { Message: 'Not found' }));
      return;
    }
    if (rest === 'send') {
      if (record.method !== 'POST') {
        respond(response, refused(405, { Message: 'Method not allowed' }));
      } else if (!keepsTheContract(record.body)) {
        respond(response, refused(400, { Message: 'Bad request' }));
      } else {
        issued += 1;
        respond(response, sends.shift() ?? accepted(`MSG-${String(issued).padStart(4, '0')}`));
      }
      return;
    }
    if (record.method !== 'GET') {
      respond(response, refused(405, { Message: 'Method not allowed' }));
      return;
    }
    let messageId: string;
    try {
      messageId = decodeURIComponent(rest);
    } catch {
      respond(response, refused(400, { Message: 'Bad request' }));
      return;
    }
    const script = statuses.get(messageId);
    const next = script === undefined ? undefined : script.length > 1 ? script.shift() : script[0];
    respond(response, next ?? refused(404, { Message: 'Not found' }));
  }

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      handle(request, response, Buffer.concat(chunks).toString('utf8'));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;

  let closing: Promise<void> | undefined;
  return {
    endpoint: `http://127.0.0.1:${String(port)}${RESOURCE}`,
    requests,
    queueSend: (...replies) => {
      sends.push(...replies);
    },
    scriptStatus: (messageId, ...replies) => {
      statuses.set(messageId, [...replies]);
    },
    close: () => {
      closing ??= new Promise<void>((done, fail) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        server.close((error) => {
          if (error === undefined) done();
          else fail(error);
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
