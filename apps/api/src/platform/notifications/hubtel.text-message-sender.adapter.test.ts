import { afterEach, describe, expect, it } from 'vitest';

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
import type { DeliveryOutcome } from '../auth/ports/delivery-queue.port.js';
import {
  TEXT_MESSAGE_SENDER_DESCRIPTOR,
  type TextMessage,
  type TextMessageSender,
  type TextStatus,
} from '../auth/ports/text-message-sender.port.js';
import { Secret } from '../config/secret.js';
import {
  HUBTEL_EVENTS,
  HubtelSmsClient,
  type HubtelSendResult,
  type HubtelSmsClientOptions,
} from './hubtel-sms-client.js';
import { HubtelTextMessageSender } from './hubtel.text-message-sender.adapter.js';

const CLIENT_ID = 'SENTINEL_CLIENT_ID_91c4';
const CLIENT_SECRET = 'SENTINEL_CLIENT_SECRET_77ab';
const DESTINATION = '+233244000111';
const TEXT = 'SENTINEL_TEXT_5d2e';
const PROVIDER_BODY = 'SENTINEL_PROVIDER_BODY_c3e9';
const SENDER = 'MELARC';
const BASIC = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
const NOW = new Date('2026-10-29T12:00:00.000Z');

const message: TextMessage = {
  dedupeId: 'DEDUPE-0b7c2f6e-4d1a-4c35-9e08-6a1f3d2b7c90',
  destination: DESTINATION,
  text: TEXT,
};

const standIns: HubtelStandIn[] = [];

afterEach(async () => {
  await Promise.all(standIns.splice(0).map((standIn) => standIn.close()));
});

async function start(): Promise<HubtelStandIn> {
  const standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  standIns.push(standIn);
  return standIn;
}

function senderFor(standIn: HubtelStandIn, over: Partial<HubtelSmsClientOptions> = {}) {
  const events: string[] = [];
  const sender: TextMessageSender = new HubtelTextMessageSender(
    new HubtelSmsClient({
      endpoint: standIn.endpoint,
      clientId: new Secret(CLIENT_ID),
      clientSecret: new Secret(CLIENT_SECRET),
      senderId: SENDER,
      timeoutMs: 5_000,
      now: () => NOW,
      onEvent: (name) => events.push(name),
      ...over,
    }),
  );
  return { sender, events };
}

/** What a provider that writes the request back into its answer would write: all that must not come out again. */
const echo = {
  Message: `${PROVIDER_BODY} ${TEXT} ${DESTINATION}`,
  Authorization: `Basic ${BASIC}`,
  ClientId: CLIENT_ID,
  ClientSecret: CLIENT_SECRET,
};

const REQUEST_INVALID: DeliveryOutcome = { outcome: 'REJECTED', outcomeClass: 'REQUEST_INVALID' };
const AUTHENTICATION: DeliveryOutcome = {
  outcome: 'REJECTED',
  outcomeClass: 'PROVIDER_AUTHENTICATION',
};
const REFUSED: DeliveryOutcome = { outcome: 'REJECTED', outcomeClass: 'PROVIDER_REFUSED' };
const UNKNOWN: DeliveryOutcome = { outcome: 'UNKNOWN' };

describe('the Hubtel text-message sender: what a send comes to', () => {
  // Break caught: a status of the provider mapped to the wrong outcome: a refusal that is final taken for one to retry, or a fault of
  // the provider taken for the end of the message.
  it.each([
    [
      'HTTP 200 and a MessageId',
      accepted('MSG-200', 200),
      { outcome: 'ACCEPTED', providerMessageRef: 'MSG-200' },
    ],
    [
      'HTTP 201 and a MessageId',
      accepted('MSG-201', 201),
      { outcome: 'ACCEPTED', providerMessageRef: 'MSG-201' },
    ],
    ['HTTP 400', refused(400, echo), REQUEST_INVALID],
    ['HTTP 404', refused(404, echo), REQUEST_INVALID],
    ['HTTP 422', refused(422, echo), REQUEST_INVALID],
    ['HTTP 401', refused(401, echo), AUTHENTICATION],
    ['HTTP 403', refused(403, echo), AUTHENTICATION],
    [
      'HTTP 402, an account that may be funded later',
      refused(402, echo),
      { outcome: 'UNKNOWN', retryAfterMs: 300_000 },
    ],
    ['HTTP 429 with no Retry-After', rateLimited(), UNKNOWN],
    [
      'HTTP 429 with a wait in seconds',
      rateLimited('120'),
      { outcome: 'UNKNOWN', retryAfterMs: 120_000 },
    ],
    [
      'HTTP 429 with a wait as a date',
      rateLimited('Thu, 29 Oct 2026 12:00:45 GMT'),
      { outcome: 'UNKNOWN', retryAfterMs: 45_000 },
    ],
    [
      'HTTP 429 with exactly the longest wait',
      rateLimited('600'),
      { outcome: 'UNKNOWN', retryAfterMs: 600_000 },
    ],
    [
      'HTTP 429 with a wait beyond it',
      rateLimited('601'),
      { outcome: 'UNKNOWN', retryAfterMs: 600_000 },
    ],
    [
      'HTTP 429 with a wait of days',
      rateLimited('259200'),
      { outcome: 'UNKNOWN', retryAfterMs: 600_000 },
    ],
    [
      'HTTP 429 with a date years away',
      rateLimited('Fri, 29 Oct 2032 12:00:00 GMT'),
      { outcome: 'UNKNOWN', retryAfterMs: 600_000 },
    ],
    ['HTTP 429 with a wait that is none', rateLimited('0'), UNKNOWN],
    ['HTTP 429 with a date that has passed', rateLimited('Thu, 29 Oct 2026 11:00:00 GMT'), UNKNOWN],
    ['HTTP 429 with a wait that cannot be read', rateLimited('soon'), UNKNOWN],
    ['HTTP 500', refused(500, echo), UNKNOWN],
    ['HTTP 502', refused(502, echo), UNKNOWN],
    ['HTTP 503', refused(503, echo), UNKNOWN],
    [
      'HTTP 503 that asks for a wait',
      { kind: 'json', status: 503, body: echo, headers: { 'Retry-After': '30' } },
      UNKNOWN,
    ],
    ['HTTP 599', refused(599, echo), UNKNOWN],
    ['HTTP 405', refused(405, echo), REFUSED],
    ['HTTP 408', refused(408, echo), REFUSED],
    ['HTTP 409', refused(409, echo), REFUSED],
    ['HTTP 413', refused(413, echo), REFUSED],
    ['HTTP 418', refused(418, echo), REFUSED],
    ['HTTP 499', refused(499, echo), REFUSED],
    [
      'HTTP 301',
      { kind: 'json', status: 301, body: echo, headers: { Location: '/elsewhere' } },
      REFUSED,
    ],
    [
      'HTTP 307',
      { kind: 'json', status: 307, body: echo, headers: { Location: '/elsewhere' } },
      REFUSED,
    ],
    ['a success status with JSON that stops half way', malformed(200), UNKNOWN],
    ['a success status with no MessageId', answered({ ...echo, Status: 0 }), UNKNOWN],
    [
      'a success status with a Status that is not zero',
      answered({ ...echo, Status: 3, MessageId: 'MSG-1' }, 201),
      UNKNOWN,
    ],
    ['a success status with no body', { kind: 'raw', status: 204, text: '' }, UNKNOWN],
  ] satisfies [string, StandInReply, DeliveryOutcome][])(
    'answers %s',
    async (_label, reply, expected) => {
      const standIn = await start();
      standIn.queueSend(reply);
      const { sender } = senderFor(standIn);

      expect(await sender.send(message)).toStrictEqual(expected);
      expect(standIn.requests).toHaveLength(1);
    },
  );

  // Break caught: a call that gives up on the provider answered as anything but "unknown": the message may have been taken.
  it('answers unknown, promptly, to a provider that is too slow, that stalls, that cuts the line or that is not there', async () => {
    const standIn = await start();
    standIn.queueSend(slow(4_000), stalled(), dropped());
    const { sender, events } = senderFor(standIn, { timeoutMs: 150 });

    const started = performance.now();
    expect(await sender.send(message)).toStrictEqual(UNKNOWN);
    expect(await sender.send(message)).toStrictEqual(UNKNOWN);
    expect(await sender.send(message)).toStrictEqual(UNKNOWN);
    expect(performance.now() - started).toBeLessThan(3_000);
    await standIn.close();
    expect(await sender.send(message)).toStrictEqual(UNKNOWN);
    expect(events).toEqual([
      'hubtel_send_timeout',
      'hubtel_send_timeout',
      'hubtel_send_network_error',
      'hubtel_send_network_error',
    ]);
  });

  // Break caught: a send made for what Hubtel cannot take, or a refusal that is not the closed class of a request that was wrong.
  it.each([
    ['a number with no plus', { destination: '233244000111', text: TEXT }],
    ['a number with spaces', { destination: '+233 244 000 111', text: TEXT }],
    ['a number of seven digits', { destination: '+2332440', text: TEXT }],
    ['a number of sixteen digits', { destination: '+2332440001112345', text: TEXT }],
    ['no number', { destination: '', text: TEXT }],
    ['a text that is empty', { destination: DESTINATION, text: '' }],
    ['a text of 1001 characters', { destination: DESTINATION, text: 'x'.repeat(1_001) }],
  ])('rejects %s as a bad request and sends nothing', async (_label, over) => {
    const standIn = await start();
    const { sender, events } = senderFor(standIn);

    expect(await sender.send({ ...message, ...over })).toStrictEqual(REQUEST_INVALID);
    expect(standIn.requests).toHaveLength(0);
    expect(events).toEqual(['hubtel_send_invalid_request']);
  });

  it('sends a text of 1000 characters, and the shortest and the longest number', async () => {
    const standIn = await start();
    const { sender } = senderFor(standIn);

    for (const over of [
      { destination: '+12345678', text: 'x' },
      { destination: '+123456789012345', text: 'y'.repeat(1_000) },
    ]) {
      expect((await sender.send({ ...message, ...over })).outcome).toBe('ACCEPTED');
    }
    expect(standIn.requests).toHaveLength(2);
  });

  // Break caught: a field the contract has no place for sent, or the request not what the contract says it is.
  it('sends the contract’s four members and the identity of the message to nobody', async () => {
    const standIn = await start();
    standIn.queueSend(accepted('REF-1'));
    const { sender } = senderFor(standIn);

    expect(await sender.send(message)).toStrictEqual({
      outcome: 'ACCEPTED',
      providerMessageRef: 'REF-1',
    });
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
    expect(JSON.stringify(standIn.requests)).not.toContain(message.dedupeId);
  });

  it('is refused as unauthenticated, and says only that, when the provider does not know its credentials', async () => {
    const standIn = await start();
    const { sender } = senderFor(standIn, { clientSecret: new Secret('another-secret') });

    expect(await sender.send(message)).toStrictEqual(AUTHENTICATION);
    expect(standIn.requests[0]?.credentialsMatched).toBe(false);
  });
});

describe('the Hubtel text-message sender: the mapping, on its own', () => {
  const stub = (result: HubtelSendResult) => {
    const asked: unknown[] = [];
    const sender = new HubtelTextMessageSender({
      send: (given) => {
        asked.push(given);
        return Promise.resolve(result);
      },
      status: () => Promise.resolve({ state: 'UNKNOWN' }),
    });
    return { sender, asked };
  };

  // Break caught: more of the message given to the client than it needs: the identity of the message has no place in the contract.
  it('gives the client the destination and the text and nothing else', async () => {
    const { sender, asked } = stub({ kind: 'ACCEPTED', messageId: 'X-1' });

    await sender.send(message);

    expect(asked).toStrictEqual([{ destination: DESTINATION, text: TEXT }]);
  });

  it.each([
    [
      { kind: 'ACCEPTED', messageId: 'X-1' },
      { outcome: 'ACCEPTED', providerMessageRef: 'X-1' },
    ],
    [{ kind: 'INVALID_REQUEST' }, REQUEST_INVALID],
    [{ kind: 'UNUSABLE_ANSWER' }, UNKNOWN],
    [{ kind: 'NO_ANSWER', cause: 'TIMEOUT' }, UNKNOWN],
    [{ kind: 'NO_ANSWER', cause: 'NETWORK' }, UNKNOWN],
    [
      { kind: 'HTTP_REFUSED', status: 402, retryAfterMs: 5 },
      { outcome: 'UNKNOWN', retryAfterMs: 300_000 },
    ],
    [
      { kind: 'HTTP_REFUSED', status: 429, retryAfterMs: 1 },
      { outcome: 'UNKNOWN', retryAfterMs: 1 },
    ],
    [
      { kind: 'HTTP_REFUSED', status: 429, retryAfterMs: Number.MAX_SAFE_INTEGER },
      { outcome: 'UNKNOWN', retryAfterMs: 600_000 },
    ],
    [{ kind: 'HTTP_REFUSED', status: 429, retryAfterMs: 0 }, UNKNOWN],
    [{ kind: 'HTTP_REFUSED', status: 429, retryAfterMs: -5 }, UNKNOWN],
    [{ kind: 'HTTP_REFUSED', status: 429, retryAfterMs: Number.NaN }, UNKNOWN],
    [{ kind: 'HTTP_REFUSED', status: 500, retryAfterMs: 5_000 }, UNKNOWN],
    [{ kind: 'HTTP_REFUSED', status: 400, retryAfterMs: 5_000 }, REQUEST_INVALID],
  ] satisfies [HubtelSendResult, DeliveryOutcome][])('maps %j to %j', async (result, expected) => {
    expect(await stub(result).sender.send(message)).toStrictEqual(expected);
  });

  it('maps every status from 100 to 599 to one of the outcomes of the brief', async () => {
    const seen = new Map<string, number[]>();
    for (let status = 100; status <= 599; status += 1) {
      const outcome = await stub({ kind: 'HTTP_REFUSED', status }).sender.send(message);
      const key = JSON.stringify(outcome);
      seen.set(key, [...(seen.get(key) ?? []), status]);
    }

    expect([...seen.keys()].toSorted()).toEqual(
      [
        JSON.stringify(REQUEST_INVALID),
        JSON.stringify(AUTHENTICATION),
        JSON.stringify(REFUSED),
        JSON.stringify({ outcome: 'UNKNOWN', retryAfterMs: 300_000 }),
        JSON.stringify(UNKNOWN),
      ].toSorted(),
    );
    expect(seen.get(JSON.stringify(REQUEST_INVALID))).toEqual([400, 404, 422]);
    expect(seen.get(JSON.stringify(AUTHENTICATION))).toEqual([401, 403]);
    expect(seen.get(JSON.stringify({ outcome: 'UNKNOWN', retryAfterMs: 300_000 }))).toEqual([402]);
    expect(seen.get(JSON.stringify(UNKNOWN))).toEqual([
      429,
      ...Array.from({ length: 100 }, (_, index) => 500 + index),
    ]);
  });
});

describe('the Hubtel text-message sender: the status of a message', () => {
  it('reads Sent as pending and Delivered as delivered, in the order the provider says them', async () => {
    const standIn = await start();
    standIn.scriptStatus('MSG-1', statusIs('Sent'), statusIs('Delivered'));
    const { sender } = senderFor(standIn);

    const answers: TextStatus[] = [
      await sender.status('MSG-1'),
      await sender.status('MSG-1'),
      await sender.status('MSG-1'),
    ];

    expect(answers).toStrictEqual([
      { state: 'PENDING' },
      { state: 'DELIVERED' },
      { state: 'DELIVERED' },
    ]);
  });

  // Break caught: a word of the provider mapped to a state it is not, or a class that is the provider's own text.
  it.each([
    ['Delivered', { state: 'DELIVERED' }],
    ['Sent', { state: 'PENDING' }],
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
    ['Unroutable', { state: 'FAILED', outcomeClass: 'UNROUTABLE' }],
    ['Error', { state: 'FAILED', outcomeClass: 'ERROR' }],
    ['Expired', { state: 'FAILED', outcomeClass: 'EXPIRED' }],
    ['Something else', { state: 'UNKNOWN' }],
  ])('reads %s as %j', async (word, expected) => {
    const standIn = await start();
    standIn.scriptStatus('MSG-1', statusIs(word));

    expect(await senderFor(standIn).sender.status('MSG-1')).toStrictEqual(expected);
  });

  it('is unknown where the provider does not answer, refuses, or says nothing that can be read', async () => {
    const standIn = await start();
    standIn.scriptStatus('REFUSED', refused(500, { Status: 'Delivered' }));
    standIn.scriptStatus('RUBBISH', malformed(200));
    standIn.scriptStatus('SLOW', slow(4_000, statusIs('Delivered')));
    const { sender } = senderFor(standIn, { timeoutMs: 150 });

    for (const reference of ['REFUSED', 'RUBBISH', 'SLOW', 'NEVER-SCRIPTED', '../etc']) {
      expect(await sender.status(reference), reference).toStrictEqual({ state: 'UNKNOWN' });
    }
  });
});

describe('the Hubtel text-message sender: what must never come out', () => {
  const FORBIDDEN = [
    CLIENT_ID,
    CLIENT_SECRET,
    TEXT,
    PROVIDER_BODY,
    BASIC,
    `Basic ${BASIC}`,
    Buffer.from(CLIENT_ID).toString('base64'),
    Buffer.from(CLIENT_SECRET).toString('base64'),
    DESTINATION,
    DESTINATION.slice(1),
    message.dedupeId,
  ];

  const transportFailure: typeof fetch = () =>
    Promise.reject(
      new Error(
        `connect ECONNREFUSED Basic ${BASIC} ${CLIENT_ID} ${CLIENT_SECRET} ${DESTINATION} ${TEXT}`,
        {
          cause: new TypeError(`${CLIENT_SECRET} ${TEXT}`),
        },
      ),
    );

  interface Case {
    readonly label: string;
    readonly reply?: StandInReply;
    readonly close?: boolean;
    readonly over?: Partial<HubtelSmsClientOptions>;
    readonly sending?: Partial<TextMessage>;
  }

  const SENDS: readonly Case[] = [
    { label: 'accepted', reply: accepted('MSG-ACCEPTED') },
    ...[400, 401, 402, 403, 404, 408, 418, 422, 429, 500, 502, 503].map((status) => ({
      label: `refused with HTTP ${String(status)} and a body that echoes the request`,
      reply: refused(status, echo),
    })),
    {
      label: 'refused with HTTP 302',
      reply: { kind: 'json', status: 302, body: echo, headers: { Location: `/${PROVIDER_BODY}` } },
    },
    { label: 'rate limited, with a wait', reply: rateLimited('30') },
    {
      label: 'accepted with a Status that is not zero and a body that echoes the request',
      reply: answered({ ...echo, Status: 9, MessageId: 'MSG-X' }, 201),
    },
    { label: 'answered with JSON that stops half way', reply: malformed(200) },
    {
      label: 'answered with a body that is not JSON and holds the request',
      reply: {
        kind: 'raw',
        status: 200,
        text: `<html>${PROVIDER_BODY} ${TEXT} ${DESTINATION} ${BASIC}</html>`,
      },
    },
    { label: 'answered with nothing', reply: { kind: 'raw', status: 204, text: '' } },
    { label: 'too slow', reply: slow(4_000), over: { timeoutMs: 150 } },
    { label: 'stalled in the body', reply: stalled(), over: { timeoutMs: 150 } },
    { label: 'cut off', reply: dropped() },
    { label: 'not there', close: true },
    {
      label: 'unreachable, with a transport that tells everything',
      over: { fetch: transportFailure },
    },
    { label: 'given a number that is wrong', sending: { destination: `${DESTINATION}x` } },
    { label: 'given a text that is too long', sending: { text: `${TEXT}${'x'.repeat(1_000)}` } },
  ];

  // Break caught: a secret, a number, a text, a header, an address or a word of the provider in an outcome, an error or an event: the
  // rule that makes a log line safe to keep.
  it.each(SENDS.map((one) => [one.label, one] as const))(
    'says none of it when a send is %s',
    async (_label, one) => {
      const standIn = await start();
      if (one.reply !== undefined) standIn.queueSend(one.reply);
      const { sender, events } = senderFor(standIn, one.over);
      if (one.close === true) await standIn.close();

      let outcome: DeliveryOutcome | undefined;
      let thrown: unknown;
      try {
        outcome = await sender.send({ ...message, ...one.sending });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(outcome).toBeDefined();
      const seen = [
        JSON.stringify(outcome),
        events.join('|'),
        standIn.endpoint,
        new URL(standIn.endpoint).host,
      ];
      expect(seen[0]).not.toContain('http');
      for (const forbidden of FORBIDDEN) {
        expect(seen[0], forbidden).not.toContain(forbidden);
        expect(seen[1], forbidden).not.toContain(forbidden);
      }
      for (const address of [standIn.endpoint, new URL(standIn.endpoint).host, '/v1/messages']) {
        expect(seen[0], address).not.toContain(address);
        expect(seen[1], address).not.toContain(address);
      }
      for (const name of events) expect(HUBTEL_EVENTS as readonly string[]).toContain(name);
    },
  );

  it('says none of it when it reads the status of a message', async () => {
    const standIn = await start();
    standIn.scriptStatus('S-OK', statusIs('Delivered'));
    standIn.scriptStatus('S-ODD', statusIs(`${PROVIDER_BODY} ${TEXT} ${DESTINATION} ${BASIC}`));
    standIn.scriptStatus(
      'S-OBJ',
      answered({ ...echo, Status: { Name: `${PROVIDER_BODY} ${TEXT}` } }),
    );
    standIn.scriptStatus('S-404', refused(404, echo));
    standIn.scriptStatus('S-500', refused(500, echo));
    standIn.scriptStatus('S-JSON', malformed(200));
    standIn.scriptStatus('S-SLOW', slow(4_000));
    standIn.scriptStatus('S-CUT', dropped());
    const { sender, events } = senderFor(standIn, { timeoutMs: 150 });
    const failing = senderFor(standIn, { fetch: transportFailure });

    const answers: unknown[] = [];
    for (const reference of [
      'S-OK',
      'S-ODD',
      'S-OBJ',
      'S-404',
      'S-500',
      'S-JSON',
      'S-SLOW',
      'S-CUT',
      '../x',
    ]) {
      answers.push(await sender.status(reference));
    }
    answers.push(await failing.sender.status('S-OK'));

    const text = `${JSON.stringify(answers)}|${events.join('|')}|${failing.events.join('|')}`;
    for (const forbidden of [...FORBIDDEN, standIn.endpoint, '/v1/messages']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(answers[0]).toStrictEqual({ state: 'DELIVERED' });
    expect(answers.slice(1)).toStrictEqual(Array.from({ length: 9 }, () => ({ state: 'UNKNOWN' })));
  });
});

describe('the Hubtel text-message sender as a port', () => {
  it('describes the two operations it has, outside any transaction, and raises nothing', () => {
    expect(Object.keys(TEXT_MESSAGE_SENDER_DESCRIPTOR.operations).toSorted()).toEqual([
      'send',
      'status',
    ]);
    for (const operation of Object.values(TEXT_MESSAGE_SENDER_DESCRIPTOR.operations)) {
      expect(operation.transaction).toBe('outside-any-transaction');
      expect(operation.raises).toBe('none');
    }
  });
});
