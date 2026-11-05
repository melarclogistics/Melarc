import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accepted,
  answered,
  dropped,
  malformed,
  rateLimited,
  refused,
  slow,
  stalled,
  startHubtelStandIn,
  statusIs,
  type HubtelStandIn,
  type StandInReply,
} from '../../test-support/hubtel-stand-in.js';
import { Secret } from '../config/secret.js';
import {
  HUBTEL_EVENTS,
  HubtelSmsClient,
  HubtelSmsClientConfigurationError,
  parseRetryAfter,
  textStatusOf,
  type HubtelSmsClientOptions,
} from './hubtel-sms-client.js';

const CLIENT_ID = 'SENTINEL_CLIENT_ID_91c4';
const CLIENT_SECRET = 'SENTINEL_CLIENT_SECRET_77ab';
const DESTINATION = '+233244000111';
const TEXT = 'SENTINEL_TEXT_5d2e';
const SENDER = 'MELARC';
const BASIC = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

const standIns: HubtelStandIn[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(standIns.splice(0).map((standIn) => standIn.close()));
});

async function start(): Promise<HubtelStandIn> {
  const standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  standIns.push(standIn);
  return standIn;
}

function clientFor(standIn: HubtelStandIn, over: Partial<HubtelSmsClientOptions> = {}) {
  const events: string[] = [];
  const client = new HubtelSmsClient({
    endpoint: standIn.endpoint,
    clientId: new Secret(CLIENT_ID),
    clientSecret: new Secret(CLIENT_SECRET),
    senderId: SENDER,
    timeoutMs: 5_000,
    onEvent: (name) => events.push(name),
    ...over,
  });
  return { client, events };
}

/** A client over an endpoint that is only ever built, never called. */
const offline = (endpoint: string, over: Partial<HubtelSmsClientOptions> = {}) =>
  new HubtelSmsClient({
    endpoint,
    clientId: new Secret(CLIENT_ID),
    clientSecret: new Secret(CLIENT_SECRET),
    senderId: SENDER,
    timeoutMs: 1_000,
    ...over,
  });

const message = { destination: DESTINATION, text: TEXT };

describe('what the Hubtel client sends', () => {
  // Break caught: a request that breaks the contract the header of the client writes down, in any of its parts.
  it('posts the message to {endpoint}/send as the four members of the contract, with the Basic credentials', async () => {
    const standIn = await start();
    const { client } = clientFor(standIn);

    const result = await client.send(message);

    expect(result).toStrictEqual({ kind: 'ACCEPTED', messageId: 'MSG-0001' });
    expect(standIn.requests).toHaveLength(1);
    const [seen] = standIn.requests;
    expect(seen).toMatchObject({
      method: 'POST',
      path: '/v1/messages/send',
      credentialsMatched: true,
      contentType: 'application/json',
      accept: 'application/json',
    });
    expect(seen?.body).toStrictEqual({
      From: SENDER,
      To: '233244000111',
      Content: TEXT,
      RegisteredDelivery: true,
    });
  });

  // Break caught: a credential in the URL (the older form of the API took them in the query), where proxies and logs keep it.
  it('puts nothing of the credentials, the number or the text in the address', async () => {
    const standIn = await start();

    await clientFor(standIn).client.send(message);

    const path = standIn.requests[0]?.path ?? '';
    expect(path).toBe('/v1/messages/send');
    for (const secret of [CLIENT_ID, CLIENT_SECRET, BASIC, '233244000111', TEXT]) {
      expect(path).not.toContain(secret);
    }
  });

  // Break caught: a client that sends other credentials than it holds, or none: the stand-in refuses what does not match.
  it('is refused as unauthenticated when its credentials are not the stand-in’s, and says what the status was', async () => {
    const standIn = await start();
    const { client, events } = clientFor(standIn, { clientSecret: new Secret('another-secret') });

    expect(await client.send(message)).toStrictEqual({ kind: 'HTTP_REFUSED', status: 401 });
    expect(standIn.requests[0]?.credentialsMatched).toBe(false);
    expect(events).toEqual(['hubtel_send_refused']);
  });

  // Break caught: the header built once and kept (a secret that outlives the call in a field), or built from a stale copy. The secrets
  // are read when a call is made, once each per call, and not before.
  it('reads the two secrets when a call is made and not before, and keeps no header', async () => {
    const standIn = await start();
    class Counting extends Secret {
      reads = 0;
      override reveal(): string {
        this.reads += 1;
        return super.reveal();
      }
    }
    const id = new Counting(CLIENT_ID);
    const secret = new Counting(CLIENT_SECRET);
    const { client } = clientFor(standIn, { clientId: id, clientSecret: secret });
    expect([id.reads, secret.reads]).toEqual([0, 0]);

    await client.send(message);
    expect([id.reads, secret.reads]).toEqual([1, 1]);
    await client.send(message);
    expect([id.reads, secret.reads]).toEqual([2, 2]);
    await client.status('MSG-0001');
    expect([id.reads, secret.reads]).toEqual([3, 3]);
    expect(standIn.requests.map((request) => request.credentialsMatched)).toEqual([
      true,
      true,
      true,
    ]);
  });

  // Break caught: state shared between calls (a header or a body built once and reused), which calls made together would mix up.
  it('serves calls made together, each with its own message and its own credentials', async () => {
    const standIn = await start();
    const { client } = clientFor(standIn);
    const texts = Array.from({ length: 12 }, (_, index) => `${TEXT} ${String(index)}`);

    const results = await Promise.all(
      texts.map((text) => client.send({ destination: DESTINATION, text })),
    );

    const ids = results.map((result) => (result.kind === 'ACCEPTED' ? result.messageId : ''));
    expect(ids.every((id) => id !== '')).toBe(true);
    expect(new Set(ids).size).toBe(12);
    const sent = standIn.requests.map((request) => (request.body as { Content: string }).Content);
    expect(sent.toSorted()).toEqual(texts.toSorted());
    expect(standIn.requests.every((request) => request.credentialsMatched)).toBe(true);
  });

  // Break caught: a request made for an input the provider cannot take (a number it will refuse, a text that is empty or too long), which
  // costs a call and a message to a real number.
  it.each([
    ['empty', ''],
    ['no plus', '233244000111'],
    ['a zero after the plus', '+0244000111'],
    ['seven digits', '+1234567'],
    ['sixteen digits', '+1234567890123456'],
    ['spaces', '+233 244 000 111'],
    ['hyphens', '+233-244-000-111'],
    ['a leading space', ' +233244000111'],
    ['a trailing space', '+233244000111 '],
    ['a trailing line feed', '+233244000111\n'],
    ['two plus signs', '++233244000111'],
    ['international prefix', '00233244000111'],
    ['a scheme', 'tel:+233244000111'],
    ['a letter', '+23324400011a'],
  ])('makes no request for a destination with %s', async (_label, destination) => {
    const standIn = await start();
    const { client, events } = clientFor(standIn);

    expect(await client.send({ destination, text: TEXT })).toStrictEqual({
      kind: 'INVALID_REQUEST',
    });
    expect(standIn.requests).toHaveLength(0);
    expect(events).toEqual(['hubtel_send_invalid_request']);
  });

  it.each([
    ['empty', ''],
    ['one character too long', 'a'.repeat(1_001)],
  ])('makes no request for a text that is %s', async (_label, text) => {
    const standIn = await start();
    const { client, events } = clientFor(standIn);

    expect(await client.send({ destination: DESTINATION, text })).toStrictEqual({
      kind: 'INVALID_REQUEST',
    });
    expect(standIn.requests).toHaveLength(0);
    expect(events).toEqual(['hubtel_send_invalid_request']);
  });

  // Break caught: a range written one short at either end.
  it.each([
    ['the shortest number', '+12345678', 'a'],
    ['the longest number', '+123456789012345', 'a'.repeat(1_000)],
  ])('takes %s and the limit of the text', async (_label, destination, text) => {
    const standIn = await start();

    const result = await clientFor(standIn).client.send({ destination, text });

    expect(result.kind).toBe('ACCEPTED');
    expect(standIn.requests[0]?.body).toMatchObject({
      To: destination.slice(1),
      Content: text,
    });
  });

  // Break caught: a redirect followed with the Authorization header on it, to wherever the answer pointed.
  it('does not follow a redirect', async () => {
    const standIn = await start();
    standIn.queueSend({
      kind: 'raw',
      status: 302,
      text: '',
      headers: { Location: '/v1/messages/elsewhere' },
    });

    expect(await clientFor(standIn).client.send(message)).toStrictEqual({
      kind: 'HTTP_REFUSED',
      status: 302,
    });
    expect(standIn.requests).toHaveLength(1);
  });
});

describe('what the Hubtel client takes from the answer to a send', () => {
  const acceptedBy = async (reply: StandInReply) => {
    const standIn = await start();
    standIn.queueSend(reply);
    return clientFor(standIn).client.send(message);
  };

  it('takes HTTP 200 and 201 as an acceptance and returns the MessageId', async () => {
    expect(await acceptedBy(accepted('ABC-1', 200))).toStrictEqual({
      kind: 'ACCEPTED',
      messageId: 'ABC-1',
    });
    expect(await acceptedBy(accepted('ABC-2', 201))).toStrictEqual({
      kind: 'ACCEPTED',
      messageId: 'ABC-2',
    });
    expect(await acceptedBy(accepted('ABC-3', 202))).toStrictEqual({
      kind: 'ACCEPTED',
      messageId: 'ABC-3',
    });
  });

  // Break caught: the contract is unverified. A provider that writes its members in another case must not have every send taken for
  // lost, which would repeat a message to a real number.
  it('reads the members whatever their case, and a zero Status written as text', async () => {
    expect(await acceptedBy(answered({ status: 0, messageId: 'LOW-1' }))).toStrictEqual({
      kind: 'ACCEPTED',
      messageId: 'LOW-1',
    });
    expect(await acceptedBy(answered({ STATUS: '0', MESSAGEID: 'UP-1' }))).toStrictEqual({
      kind: 'ACCEPTED',
      messageId: 'UP-1',
    });
    expect(await acceptedBy(answered({ MessageId: 'NOSTATUS-1' }))).toStrictEqual({
      kind: 'ACCEPTED',
      messageId: 'NOSTATUS-1',
    });
  });

  // Break caught: a 2xx taken for an acceptance though it names no message, says it is not one, or cannot be read.
  it.each([
    ['JSON that stops half way', malformed(200)],
    ['a body that is not JSON', { kind: 'raw', status: 200, text: '<html>ok</html>' } as const],
    ['an empty body', { kind: 'raw', status: 204, text: '' } as const],
    // Both of these would be an acceptance if the body were read to its end, so the cap is what makes them unusable. The first reaches
    // the client in pieces of no declared length; the second declares a length it never delivers, so a client that read on would wait.
    [
      'a body far too large to be read',
      {
        kind: 'raw',
        status: 200,
        text: `{"Status":0,"MessageId":"BIG-1"}${' '.repeat(40_000)}`,
      } as const,
    ],
    [
      'a body whose declared length is far too large to wait for',
      {
        kind: 'raw',
        status: 200,
        text: '{"Status":0,"MessageId":"BIG-2"}',
        headers: { 'Content-Length': '40000' },
      } as const,
    ],
    ['an array', answered([{ MessageId: 'A-1' }])],
    ['null', answered(null)],
    ['a string', answered('MSG-1')],
    ['no members', answered({})],
    ['no MessageId', answered({ Status: 0, Rate: 1 })],
    ['an empty MessageId', answered({ Status: 0, MessageId: '' })],
    ['a MessageId that is a number', answered({ Status: 0, MessageId: 12_345 })],
    ['a MessageId with a space', answered({ Status: 0, MessageId: 'has space' })],
    ['a MessageId with a slash', answered({ Status: 0, MessageId: 'a/b' })],
    ['a MessageId that is a path', answered({ Status: 0, MessageId: '../x' })],
    ['a MessageId that is a dot', answered({ Status: 0, MessageId: '.' })],
    ['a MessageId that starts with a dot', answered({ Status: 0, MessageId: '.hidden' })],
    ['a MessageId of 129 characters', answered({ Status: 0, MessageId: 'x'.repeat(129) })],
    ['a Status that is not zero', answered({ Status: 1, MessageId: 'MSG-1' })],
    ['a Status that is not zero, as text', answered({ Status: '2', MessageId: 'MSG-1' })],
    ['a negative Status', answered({ Status: -1, MessageId: 'MSG-1' })],
  ] satisfies [string, StandInReply][])(
    'does not take %s for an acceptance',
    async (_label, reply) => {
      expect(await acceptedBy(reply)).toStrictEqual({ kind: 'UNUSABLE_ANSWER' });
    },
  );

  it('takes a MessageId of 128 characters', async () => {
    const id = `a${'b'.repeat(127)}`;
    expect(await acceptedBy(accepted(id))).toStrictEqual({ kind: 'ACCEPTED', messageId: id });
  });

  // Break caught: the status of a refusal lost, or the body of the provider read into the result.
  it.each([300, 301, 302, 400, 401, 402, 403, 404, 408, 409, 418, 422, 429, 500, 502, 503, 504])(
    'returns HTTP %i as a refusal with its status and nothing of its body',
    async (status) => {
      const result = await acceptedBy(
        refused(status, { Message: `SENTINEL_PROVIDER_BODY ${DESTINATION} ${TEXT}` }),
      );

      expect(result).toStrictEqual({ kind: 'HTTP_REFUSED', status });
    },
  );

  describe('Retry-After', () => {
    const now = new Date('2026-10-29T12:00:00.000Z');

    // Break caught: the wait read as the wrong unit, a date read as seconds, or a value that is no wait taken for one.
    it.each([
      ['120', 120_000],
      [' 30 ', 30_000],
      ['1', 1_000],
      ['0', undefined],
      ['', undefined],
      ['soon', undefined],
      ['1.5', undefined],
      ['-5', undefined],
      ['+5', undefined],
      ['5 seconds', undefined],
      ['Thu, 29 Oct 2026 12:02:00 GMT', 120_000],
      ['Thu, 29 Oct 2026 12:00:00 GMT', undefined],
      ['Thu, 29 Oct 2026 11:00:00 GMT', undefined],
      ['Thu, 29 Oct 2026 12:02:00', undefined],
      ['29 Oct 2026 12:02:00 GMT', undefined],
      ['9'.repeat(40), Number.MAX_SAFE_INTEGER],
    ])('reads %j as %s', (value, milliseconds) => {
      expect(parseRetryAfter(value, now)).toBe(milliseconds);
    });

    it('reads nothing where there is no header', () => {
      expect(parseRetryAfter(null, now)).toBeUndefined();
      expect(parseRetryAfter(undefined, now)).toBeUndefined();
    });

    it('carries the wait of a refusal in seconds, as a date and not at all', async () => {
      const standIn = await start();
      standIn.queueSend(
        rateLimited('120'),
        rateLimited('Thu, 29 Oct 2026 12:00:45 GMT'),
        rateLimited(),
        rateLimited('later'),
      );
      const { client } = clientFor(standIn, { now: () => now });

      expect(await client.send(message)).toStrictEqual({
        kind: 'HTTP_REFUSED',
        status: 429,
        retryAfterMs: 120_000,
      });
      expect(await client.send(message)).toStrictEqual({
        kind: 'HTTP_REFUSED',
        status: 429,
        retryAfterMs: 45_000,
      });
      expect(await client.send(message)).toStrictEqual({ kind: 'HTTP_REFUSED', status: 429 });
      expect(await client.send(message)).toStrictEqual({ kind: 'HTTP_REFUSED', status: 429 });
    });
  });
});

describe('time and the network', () => {
  // Break caught: a timeout that is not enforced: the call waits for the provider as long as the provider likes, and a lane holds its
  // lease for it. The abort must reach the wire, and the answer is "may or may not have been accepted", never a refusal.
  it('gives up on a provider that is slower than its time-out, promptly, and aborts the request', async () => {
    const standIn = await start();
    standIn.queueSend(slow(4_000));
    const { client, events } = clientFor(standIn, { timeoutMs: 150 });

    const started = performance.now();
    const result = await client.send(message);
    const elapsed = performance.now() - started;

    expect(result).toStrictEqual({ kind: 'NO_ANSWER', cause: 'TIMEOUT' });
    expect(elapsed).toBeLessThan(2_000);
    expect(events).toEqual(['hubtel_send_timeout']);
    await vi.waitFor(() => {
      expect(standIn.requests[0]?.aborted).toBe(true);
    }, 3_000);
  });

  // Break caught: a time-out that covers the head of the answer and not its body, so a provider that starts and never finishes holds the call.
  it('gives up on a provider that starts its answer and never finishes it', async () => {
    const standIn = await start();
    standIn.queueSend(stalled());
    const { client } = clientFor(standIn, { timeoutMs: 150 });

    const started = performance.now();
    const result = await client.send(message);

    expect(result).toStrictEqual({ kind: 'NO_ANSWER', cause: 'TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('takes a connection that is refused, and one that is cut, for no answer', async () => {
    const closed = await start();
    const { client: toClosed, events } = clientFor(closed);
    await closed.close();
    expect(await toClosed.send(message)).toStrictEqual({ kind: 'NO_ANSWER', cause: 'NETWORK' });
    expect(events).toEqual(['hubtel_send_network_error']);

    const cutting = await start();
    cutting.queueSend(dropped());
    expect(await clientFor(cutting).client.send(message)).toStrictEqual({
      kind: 'NO_ANSWER',
      cause: 'NETWORK',
    });
  });

  // Break caught: the text of a failure of the transport (which can hold the address, the request, the headers) leaving the client.
  it('says nothing of what a failing transport said, whether it rejects or throws', async () => {
    const rejecting: typeof fetch = () =>
      Promise.reject(
        new Error(`connect ECONNREFUSED ${CLIENT_SECRET} Basic ${BASIC} ${DESTINATION} ${TEXT}`, {
          cause: new Error(CLIENT_ID),
        }),
      );
    const throwing: typeof fetch = () => {
      throw new TypeError(`${CLIENT_SECRET} ${TEXT}`);
    };

    for (const transport of [rejecting, throwing]) {
      const events: string[] = [];
      const client = offline('https://sms.example.test/v1/messages', {
        fetch: transport,
        onEvent: (name) => events.push(name),
      });

      const result = await client.send(message);
      const status = await client.status('MSG-1');

      expect(result).toStrictEqual({ kind: 'NO_ANSWER', cause: 'NETWORK' });
      expect(status).toStrictEqual({ state: 'UNKNOWN' });
      expect(events).toEqual(['hubtel_send_network_error', 'hubtel_status_network_error']);
    }
  });

  // Break caught: the time-out timer left running after the answer: a timer per call kept alive in a long-running worker.
  it('leaves no timer behind once it has an answer, or has given up', async () => {
    vi.useFakeTimers();
    const answering: typeof fetch = () =>
      Promise.resolve(Response.json({ Status: 0, MessageId: 'TIMER-1' }, { status: 201 }));
    const failing: typeof fetch = () => Promise.reject(new Error('no'));
    const refusing: typeof fetch = () => Promise.resolve(new Response('no', { status: 500 }));

    for (const transport of [answering, failing, refusing]) {
      await offline('https://sms.example.test/v1/messages', { fetch: transport }).send(message);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

describe('the status of a message', () => {
  describe('the words of the provider', () => {
    // Break caught: a word taken for another: the mobile network's final word is the only final one, and `Sent` is not it.
    it.each([
      ['Delivered', { state: 'DELIVERED' }],
      ['delivered', { state: 'DELIVERED' }],
      ['  DELIVERED  ', { state: 'DELIVERED' }],
      ['Sent', { state: 'PENDING' }],
      ['SENT', { state: 'PENDING' }],
      ['Submitted', { state: 'PENDING' }],
      ['Queued', { state: 'PENDING' }],
      ['Pending', { state: 'PENDING' }],
      ['Accepted', { state: 'PENDING' }],
      ['Buffered', { state: 'PENDING' }],
      ['Failed', { state: 'FAILED', outcomeClass: 'FAILED' }],
      ['Undeliverable', { state: 'FAILED', outcomeClass: 'UNDELIVERABLE' }],
      ['Rejected', { state: 'FAILED', outcomeClass: 'REJECTED' }],
      ['Blacklisted', { state: 'FAILED', outcomeClass: 'BLACKLISTED' }],
      ['Unrouteable', { state: 'FAILED', outcomeClass: 'UNROUTEABLE' }],
      ['unroutable', { state: 'FAILED', outcomeClass: 'UNROUTABLE' }],
      ['Error', { state: 'FAILED', outcomeClass: 'ERROR' }],
      [' expired ', { state: 'FAILED', outcomeClass: 'EXPIRED' }],
      ['Delivered to handset', { state: 'UNKNOWN' }],
      ['Delivrd', { state: 'UNKNOWN' }],
      ['Unknown', { state: 'UNKNOWN' }],
      ['', { state: 'UNKNOWN' }],
      ['   ', { state: 'UNKNOWN' }],
    ])('reads the word %j as %j', (word, expected) => {
      expect(textStatusOf({ Status: word })).toStrictEqual(expected);
    });

    // Break caught: a status looked for in one place only, or a number taken for a word.
    it.each([
      ['Status', { Status: 'Sent' }],
      ['status', { status: 'Sent' }],
      ['MessageStatus', { MessageStatus: 'Sent' }],
      ['DeliveryStatus', { DeliveryStatus: 'Sent' }],
      ['a Name', { Status: { Name: 'Sent' } }],
      ['a Description', { Status: { Description: 'Sent' } }],
      ['a name', { status: { name: 'Sent' } }],
      ['a description', { status: { description: 'Sent' } }],
      ['a number beside the word', { Status: 0, MessageStatus: 'Sent' }],
      ['an object with no word beside the word', { Status: {}, DeliveryStatus: 'Sent' }],
      ['a Name that is not text', { Status: { Name: 5, Description: 'Sent' } }],
      ['another case', { sTaTuS: 'Sent' }],
    ])('finds the word in %s', (_label, body) => {
      expect(textStatusOf(body)).toStrictEqual({ state: 'PENDING' });
    });

    it('takes the first place the contract lists when two disagree', () => {
      expect(textStatusOf({ Status: 'Sent', DeliveryStatus: 'Delivered' })).toStrictEqual({
        state: 'PENDING',
      });
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a string', 'Delivered'],
      ['a number', 7],
      ['an array', [{ Status: 'Delivered' }]],
      ['no members', {}],
      ['a null status', { Status: null }],
      ['a numeric status', { Status: 5 }],
      ['an object with no word', { Status: { Code: 3 } }],
      ['a list', { Status: ['Delivered'] }],
      ['a first word that is not on the table', { Status: 'Weird', DeliveryStatus: 'Delivered' }],
    ])('cannot read %s', (_label, body) => {
      expect(textStatusOf(body)).toStrictEqual({ state: 'UNKNOWN' });
    });
  });

  it('reads the words of the provider over the wire, a sequence of answers at a time', async () => {
    const standIn = await start();
    standIn.scriptStatus('MSG-A', statusIs('Sent'), statusIs('Delivered'));
    standIn.scriptStatus('MSG-B', statusIs('Undeliverable'));
    const { client, events } = clientFor(standIn);

    expect(await client.status('MSG-A')).toStrictEqual({ state: 'PENDING' });
    expect(await client.status('MSG-A')).toStrictEqual({ state: 'DELIVERED' });
    expect(await client.status('MSG-A')).toStrictEqual({ state: 'DELIVERED' });
    expect(await client.status('MSG-B')).toStrictEqual({
      state: 'FAILED',
      outcomeClass: 'UNDELIVERABLE',
    });
    expect(standIn.requests.map((request) => [request.method, request.path])).toEqual([
      ['GET', '/v1/messages/MSG-A'],
      ['GET', '/v1/messages/MSG-A'],
      ['GET', '/v1/messages/MSG-A'],
      ['GET', '/v1/messages/MSG-B'],
    ]);
    expect(standIn.requests.every((request) => request.credentialsMatched)).toBe(true);
    expect(standIn.requests[0]?.accept).toBe('application/json');
    expect(events).toEqual([
      'hubtel_status_answered',
      'hubtel_status_answered',
      'hubtel_status_answered',
      'hubtel_status_answered',
    ]);
  });

  // Break caught: an answer that is no answer (a refusal, rubbish, silence) read as a state of the message.
  it('is unknown when the provider refuses, answers rubbish or cannot be reached', async () => {
    const standIn = await start();
    standIn.scriptStatus('NOT-FOUND', refused(404));
    standIn.scriptStatus('SERVER', refused(500, { Status: 'Delivered' }));
    standIn.scriptStatus('LIMIT', rateLimited('5'));
    standIn.scriptStatus('RUBBISH', malformed(200));
    standIn.scriptStatus('EMPTY', { kind: 'raw', status: 200, text: '' });
    standIn.scriptStatus('ODD', statusIs('delivered?'));
    standIn.scriptStatus('SLOW', slow(4_000, statusIs('Delivered')));
    standIn.scriptStatus('DROP', dropped());
    const { client, events } = clientFor(standIn, { timeoutMs: 300 });

    for (const id of ['NOT-FOUND', 'SERVER', 'LIMIT', 'RUBBISH', 'EMPTY', 'ODD', 'SLOW', 'DROP']) {
      expect(await client.status(id), id).toStrictEqual({ state: 'UNKNOWN' });
    }
    expect(events).toEqual([
      'hubtel_status_refused',
      'hubtel_status_refused',
      'hubtel_status_refused',
      'hubtel_status_unusable_answer',
      'hubtel_status_unusable_answer',
      'hubtel_status_unusable_answer',
      'hubtel_status_timeout',
      'hubtel_status_network_error',
    ]);
  });

  // Break caught: a reference from the outside becoming a part of the address (a path that climbs out of the resource, a query, another
  // host's path), or a request made for a reference that cannot name a message.
  it.each([
    ['empty', ''],
    ['a dot', '.'],
    ['two dots', '..'],
    ['an encoded dot', '%2e%2e'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a question mark', 'a?b'],
    ['a hash', 'a#b'],
    ['a space', 'a b'],
    ['a line feed', 'a\nb'],
    ['a percent', 'a%2Fb'],
    ['a first character that is not a letter or digit', '-abc'],
    ['129 characters', 'x'.repeat(129)],
  ])('makes no request for a reference with %s', async (_label, reference) => {
    const standIn = await start();
    const { client, events } = clientFor(standIn);

    expect(await client.status(reference)).toStrictEqual({ state: 'UNKNOWN' });
    expect(standIn.requests).toHaveLength(0);
    expect(events).toEqual(['hubtel_status_invalid_reference']);
  });

  it('writes the characters of a reference that are not plain into the address encoded', async () => {
    const standIn = await start();
    standIn.scriptStatus('MSG:1+2=', statusIs('Sent'));

    expect(await clientFor(standIn).client.status('MSG:1+2=')).toStrictEqual({ state: 'PENDING' });
    expect(standIn.requests[0]?.path).toBe('/v1/messages/MSG%3A1%2B2%3D');
  });
});

describe('the endpoint and the options of the Hubtel client', () => {
  it('builds the addresses from the endpoint whatever its slashes, query and fragment', async () => {
    const standIn = await start();
    standIn.scriptStatus('MSG-1', statusIs('Sent'));
    const { client } = clientFor(standIn, { endpoint: `${standIn.endpoint}///?x=1#fragment` });

    await client.send(message);
    await client.status('MSG-1');

    expect(standIn.requests.map((request) => request.path)).toEqual([
      '/v1/messages/send',
      '/v1/messages/MSG-1',
    ]);
  });

  it.each([
    ['https://sms.example.test/v1/messages'],
    ['https://sms.example.test:8443/v1/messages/'],
    ['http://127.0.0.1:8080/v1/messages'],
    ['http://localhost:8080/v1/messages'],
    ['http://[::1]:8080/v1/messages'],
  ])('takes the endpoint %s', (endpoint) => {
    expect(() => offline(endpoint)).not.toThrow();
  });

  // Break caught: the Basic credentials sent in clear over the open network, or an endpoint that carries credentials of its own.
  it.each([
    ['plain http to a host that is not this machine', 'http://sms.example.test/v1/messages'],
    ['plain http to an address that is not loopback', 'http://10.0.0.5/v1/messages'],
    ['a host that only starts like localhost', 'http://localhost.example.test/v1/messages'],
    ['another scheme', 'ftp://sms.example.test/v1/messages'],
    ['credentials in the address', 'https://user:password@sms.example.test/v1/messages'],
    ['a user in the address', 'https://user@sms.example.test/v1/messages'],
    ['no address at all', 'not an address'],
    ['an empty address', ''],
  ])('refuses %s, and the error names none of it', (_label, endpoint) => {
    let thrown: unknown;
    try {
      offline(endpoint);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HubtelSmsClientConfigurationError);
    const { message: text, cause } = thrown as Error;
    for (const part of ['sms.example.test', 'password', 'user', '10.0.0.5', 'not an address']) {
      expect(text).not.toContain(part);
    }
    expect(text).not.toContain(CLIENT_SECRET);
    expect(cause).toBeUndefined();
  });

  it.each([
    ['a sender that is empty', { senderId: '' }],
    ['a sender that is blank', { senderId: '   ' }],
    ['a time-out of zero', { timeoutMs: 0 }],
    ['a negative time-out', { timeoutMs: -1 }],
    ['a time-out that is not whole', { timeoutMs: 1.5 }],
    ['a time-out that is not a number', { timeoutMs: Number.NaN }],
    ['a time-out that is infinite', { timeoutMs: Number.POSITIVE_INFINITY }],
    ['a time-out that a timer cannot hold', { timeoutMs: 2 ** 31 }],
  ])('refuses %s', (_label, over) => {
    expect(() => offline('https://sms.example.test/v1/messages', over)).toThrow(
      HubtelSmsClientConfigurationError,
    );
  });
});

describe('what the Hubtel client gives away', () => {
  // Break caught: a secret, or the header made of them, shown by an inspector, a serialiser or the string of the object.
  it('shows neither a secret nor the header to anything that prints it', async () => {
    const standIn = await start();
    const { client } = clientFor(standIn);
    await client.send(message);

    for (const printed of [
      inspect(client, { depth: 8, showHidden: true }),
      JSON.stringify(client),
      Object.prototype.toString.call(client),
    ]) {
      for (const secret of [CLIENT_ID, CLIENT_SECRET, BASIC]) {
        expect(printed).not.toContain(secret);
      }
    }
  });

  // Break caught: a callback that fails taking the send down with it, or giving its error to the caller.
  it('does not let a callback that throws change the result', async () => {
    const standIn = await start();
    const { client } = clientFor(standIn, {
      onEvent: () => {
        throw new Error(`${CLIENT_SECRET} ${TEXT}`);
      },
    });

    expect(await client.send(message)).toStrictEqual({ kind: 'ACCEPTED', messageId: 'MSG-0001' });
    expect(await client.status('MSG-0001')).toStrictEqual({ state: 'UNKNOWN' });
  });

  // Break caught: an event named after the provider's words, the number or the text: only the closed names are ever given.
  it('gives its callback only names of the closed list, and nothing a message holds', async () => {
    const standIn = await start();
    standIn.queueSend(
      accepted('E-1'),
      refused(400, { Message: `${DESTINATION} ${TEXT}` }),
      malformed(),
      slow(2_000),
      dropped(),
    );
    standIn.scriptStatus('E-1', statusIs(`${TEXT} Delivered`));
    const { client, events } = clientFor(standIn, { timeoutMs: 150 });

    await client.send(message);
    await client.send(message);
    await client.send(message);
    await client.send(message);
    await client.send(message);
    await client.send({ destination: 'no', text: TEXT });
    await client.status('E-1');
    await client.status('../E-1');

    expect(events.length).toBeGreaterThanOrEqual(8);
    for (const name of events) expect(HUBTEL_EVENTS as readonly string[]).toContain(name);
    for (const sentinel of [CLIENT_ID, CLIENT_SECRET, BASIC, DESTINATION, '233244000111', TEXT]) {
      expect(events.join('|')).not.toContain(sentinel);
    }
  });

  it('gives no more than twelve names', () => {
    expect(new Set(HUBTEL_EVENTS).size).toBe(HUBTEL_EVENTS.length);
    expect(HUBTEL_EVENTS).toHaveLength(12);
    for (const name of HUBTEL_EVENTS) expect(name).toMatch(/^hubtel_(send|status)_[a-z_]+$/);
  });
});

describe('the stand-in the tests of the Hubtel client rest on', () => {
  const send = (standIn: HubtelStandIn, init: RequestInit & { headers?: Record<string, string> }) =>
    fetch(`${standIn.endpoint}/send`, { method: 'POST', ...init });
  const valid = JSON.stringify({
    From: SENDER,
    To: '233244000111',
    Content: 'hello',
    RegisteredDelivery: true,
  });
  const authorized = { Authorization: `Basic ${BASIC}` };

  // Break caught: a stand-in that accepts what the provider would refuse, so that a client that breaks the contract passes against it.
  it.each([
    ['no credentials', {}, valid, 401],
    ['another scheme', { Authorization: `Bearer ${BASIC}` }, valid, 401],
    [
      'other credentials',
      { Authorization: `Basic ${Buffer.from('a:b').toString('base64')}` },
      valid,
      401,
    ],
    ['a body that is not JSON', authorized, 'To=233244000111', 400],
    [
      'no RegisteredDelivery',
      authorized,
      JSON.stringify({ From: 'A', To: '233244000111', Content: 'x' }),
      400,
    ],
    ['a number with a plus', authorized, valid.replace('233244000111', '+233244000111'), 400],
    [
      'a number of text',
      authorized,
      JSON.stringify({ From: 'A', To: 233244000111, Content: 'x', RegisteredDelivery: true }),
      400,
    ],
    ['an empty text', authorized, valid.replace('hello', ''), 400],
  ])('refuses a send with %s', async (_label, headers, body, status) => {
    const standIn = await start();
    standIn.queueSend(accepted('SCRIPT-1'));

    const response = await send(standIn, { headers, body });

    expect(response.status).toBe(status);
    // A refused request does not use up the script: the next valid send gets its answer.
    const next = await send(standIn, { headers: authorized, body: valid });
    expect(((await next.json()) as { MessageId: string }).MessageId).toBe('SCRIPT-1');
  });

  it('answers the wrong method and the wrong path as the provider would, and an unscripted message as not found', async () => {
    const standIn = await start();

    const get = await fetch(`${standIn.endpoint}/send`, { headers: authorized });
    const post = await fetch(`${standIn.endpoint}/MSG-1`, {
      method: 'POST',
      headers: authorized,
      body: valid,
    });
    const elsewhere = await fetch(`${standIn.endpoint.replace('/messages', '/other')}/send`, {
      method: 'POST',
      headers: authorized,
      body: valid,
    });
    const unknown = await fetch(`${standIn.endpoint}/MSG-404`, { headers: authorized });

    expect([get.status, post.status, elsewhere.status, unknown.status]).toEqual([
      405, 405, 404, 404,
    ]);
  });

  // Break caught: a stand-in that keeps the credentials it compares, which a test could then leak by printing its record.
  it('records the verdict on the credentials and never the credentials', async () => {
    const standIn = await start();

    await send(standIn, { headers: authorized, body: valid });
    await send(standIn, { headers: { Authorization: 'Basic other' }, body: valid });

    expect(standIn.requests.map((request) => request.credentialsMatched)).toEqual([true, false]);
    const everything = `${JSON.stringify(standIn.requests)} ${inspect(standIn, { depth: 8, showHidden: true })}`;
    for (const secret of [CLIENT_ID, CLIENT_SECRET, BASIC]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('closes twice as it closes once, and drops an answer that is still waiting', async () => {
    const standIn = await start();
    standIn.queueSend(slow(60_000));
    const pending = send(standIn, { headers: authorized, body: valid }).catch(() => 'dropped');
    await vi.waitFor(() => {
      expect(standIn.requests).toHaveLength(1);
    });

    await standIn.close();
    await standIn.close();

    expect(await pending).toBe('dropped');
  });
});
