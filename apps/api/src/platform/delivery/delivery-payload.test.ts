import { describe, expect, it } from 'vitest';

import {
  PayloadUnreadableError,
  decodeDeliveryPayload,
  deliveryPayloadContext,
  destinationProblem,
  encodeDeliveryPayload,
  linkProblem,
  type PayloadBinding,
} from './delivery-payload.js';

const JOB = '019a0000-0000-7000-8000-0000000000aa';
const PRINCIPAL = '11111111-1111-4111-8111-111111111111';
const REDEMPTION = '22222222-2222-4222-8222-222222222222';
const BINDING: PayloadBinding = {
  jobId: JOB,
  kind: 'SETUP_GRANT',
  principal: { type: 'STAFF', id: PRINCIPAL },
  redemption: { type: 'SETUP_GRANT', id: REDEMPTION },
};
const LINK =
  'https://ops.example.test/setup/credential#token=SENTINEL-TOKEN-0123456789abcdefghijklmnopq';
const CONTENT = { destination: 'ama@example.test', link: LINK };

const decode = (text: string) => decodeDeliveryPayload(new TextEncoder().encode(text));
const reasonOf = (text: string): unknown => {
  try {
    decode(text);
  } catch (error) {
    return error instanceof PayloadUnreadableError ? error.reason : error;
  }
  return undefined;
};

describe('the sealed payload of a delivery job', () => {
  // Break caught: a payload that does not give back what was queued, or one that holds more than the destination and the link
  // (the minimum a send needs; a message body, a name or a purpose would be more to protect and more to leak).
  it('holds the destination and the link and nothing else, and gives them back', () => {
    const bytes = encodeDeliveryPayload(CONTENT);

    expect(decodeDeliveryPayload(bytes)).toEqual(CONTENT);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ v: 1, ...CONTENT });
  });

  // Break caught: a payload read leniently, so that a record that is not the one the writer made (an extra field, another layout,
  // text that is not an object) is acted on instead of being refused.
  it.each([
    ['text that is not JSON', 'not json'],
    ['an array', '[]'],
    ['null', 'null'],
    [
      'a layout that is not the one written',
      '{"v":2,"destination":"a@b.test","link":"https://x.test/"}',
    ],
    ['no version', '{"destination":"a@b.test","link":"https://x.test/"}'],
    [
      'a field it does not write',
      '{"v":1,"destination":"a@b.test","link":"https://x.test/","body":"hello"}',
    ],
    ['no destination', '{"v":1,"link":"https://x.test/"}'],
    ['a destination that is not text', '{"v":1,"destination":7,"link":"https://x.test/"}'],
    ['an empty destination', '{"v":1,"destination":"","link":"https://x.test/"}'],
    ['a link that is not text', '{"v":1,"destination":"a@b.test","link":["https://x.test/"]}'],
    [
      'a link that is not http or https',
      '{"v":1,"destination":"a@b.test","link":"javascript:alert(1)"}',
    ],
    [
      'a link with white space in it',
      '{"v":1,"destination":"a@b.test","link":"https://x.test/a b"}',
    ],
  ])('refuses %s as unreadable', (_label, text) => {
    expect(() => decode(text)).toThrow(PayloadUnreadableError);
  });

  // Break caught: a payload written in a layout that only a newer writer makes being taken for garbage and destroyed. The reader says
  // by its reason that it does not support the layout, so that the worker keeps the payload for one that does.
  it.each([
    ['a newer layout', '{"v":2,"destination":"a@b.test","link":"https://x.test/"}'],
    [
      'a newer layout with a field of its own',
      '{"v":3,"destination":"a@b.test","link":"https://x.test/","body":"hi"}',
    ],
  ])('says that %s is one it does not support, not that it is garbage', (_label, text) => {
    expect(reasonOf(text)).toBe('VERSION_UNSUPPORTED');
  });

  // Break caught: garbage being kept for a worker that could read it: it never can, so the payload is a thing no retry will open.
  it.each([
    ['text that is not JSON', 'not json'],
    ['an array', '[]'],
    ['no version', '{"destination":"a@b.test","link":"https://x.test/"}'],
    ['an older layout', '{"v":0,"destination":"a@b.test","link":"https://x.test/"}'],
    [
      'a version that is not a whole number',
      '{"v":1.5,"destination":"a@b.test","link":"https://x.test/"}',
    ],
    [
      'a version that is not a number',
      '{"v":"2","destination":"a@b.test","link":"https://x.test/"}',
    ],
    [
      'a field it does not write',
      '{"v":1,"destination":"a@b.test","link":"https://x.test/","body":"hello"}',
    ],
    ['a link that is not http or https', '{"v":1,"destination":"a@b.test","link":"ftp://x.test/"}'],
  ])('says that %s is malformed', (_label, text) => {
    expect(reasonOf(text)).toBe('MALFORMED');
  });

  // Break caught: an error that repeats what was in the payload, which would put a token or an address in a log.
  it('says nothing of the payload when it refuses one', () => {
    for (const text of [
      `{"v":1,"destination":"ama@example.test","link":"${LINK}","extra":1}`,
      `{"v":2,"destination":"ama@example.test","link":"${LINK}"}`,
    ]) {
      let message = '';
      try {
        decode(text);
      } catch (error) {
        message = `${String(error)} ${JSON.stringify(error)}`;
      }
      expect(message).not.toContain('SENTINEL-TOKEN');
      expect(message).not.toContain('ama@example.test');
    }
  });

  // Break caught: bounds that let a payload grow without limit, in a table that every instance reads.
  it('bounds the destination and the link', () => {
    expect(() => encodeDeliveryPayload({ destination: 'a'.repeat(321), link: LINK })).toThrow(
      PayloadUnreadableError,
    );
    expect(() =>
      encodeDeliveryPayload({
        destination: 'a@b.test',
        link: `https://x.test/${'a'.repeat(2048)}`,
      }),
    ).toThrow(PayloadUnreadableError);
    expect(() =>
      encodeDeliveryPayload({ destination: 'a@b.test', link: 'https://x.test/a' }),
    ).not.toThrow();
  });
});

describe('what the sealed payload is bound to (SECURITY_DESIGN.md section 13.9a)', () => {
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

  // Break caught: associated data that changed in a later edit. It is a persisted format: a value sealed under one context does not
  // open under another, so changing it strands every queued message. The bytes of one binding are pinned.
  it('is the same bytes for the same binding, pinned', () => {
    expect(hex(deliveryPayloadContext(BINDING))).toBe(
      [
        '0000002a',
        Buffer.from(`STAFF:${PRINCIPAL}`).toString('hex'),
        '0000000b',
        Buffer.from('SETUP_GRANT').toString('hex'),
        '00000055',
        Buffer.from(`${JOB}/SETUP_GRANT/${REDEMPTION}`).toString('hex'),
      ].join(''),
    );
  });

  // Break caught: a ciphertext that opens after being moved to another job, another kind of message, another principal or another
  // redemption record: each of the four the document names changes the associated data.
  it.each([
    ['the job', { ...BINDING, jobId: '019a0000-0000-7000-8000-0000000000bb' }],
    ['the kind', { ...BINDING, kind: 'MFA_REENROLMENT' as const }],
    ['the principal', { ...BINDING, principal: { type: 'VENDOR' as const, id: PRINCIPAL } }],
    [
      'the principal’s identity',
      { ...BINDING, principal: { type: 'STAFF' as const, id: REDEMPTION } },
    ],
    [
      'the redemption record',
      { ...BINDING, redemption: { type: 'SETUP_GRANT' as const, id: JOB } },
    ],
    [
      'the kind of redemption record',
      { ...BINDING, redemption: { type: 'RECOVERY_REQUEST' as const, id: REDEMPTION } },
    ],
  ])('changes with %s', (_label, other) => {
    expect(hex(deliveryPayloadContext(other))).not.toBe(hex(deliveryPayloadContext(BINDING)));
  });

  // Break caught: an identifier written in capitals sealing under another context from the same identifier in lower case.
  it('reads an identifier in either case as the same one', () => {
    expect(
      hex(
        deliveryPayloadContext({
          ...BINDING,
          jobId: JOB.toUpperCase(),
          principal: { type: 'STAFF', id: PRINCIPAL.toUpperCase() },
          redemption: { type: 'SETUP_GRANT', id: REDEMPTION.toUpperCase() },
        }),
      ),
    ).toBe(hex(deliveryPayloadContext(BINDING)));
  });

  // Break caught: an identifier that is not one being sealed under, which would bind a payload to nothing a row could repeat.
  it('refuses a binding that names a thing that is not an identifier', () => {
    expect(() => deliveryPayloadContext({ ...BINDING, jobId: 'not-an-id' })).toThrow(TypeError);
    expect(() =>
      deliveryPayloadContext({ ...BINDING, principal: { type: 'STAFF', id: '' } }),
    ).toThrow(TypeError);
  });
});

describe('the destination and the link a message is queued with', () => {
  // Break caught: an address or number of the wrong shape for its channel being queued, so that a send is attempted to something
  // no one registered.
  it.each([
    ['EMAIL', 'ama@example.test', undefined],
    ['EMAIL', 'ama.mensah+ops@sub.example.test', undefined],
    ['SMS', '+233201234567', undefined],
    ['SMS', '+14155550123', undefined],
    ['EMAIL', '', 'EMPTY'],
    ['EMAIL', 'no-at-sign.example.test', 'SHAPE'],
    ['EMAIL', 'two@@example.test', 'SHAPE'],
    ['EMAIL', 'a b@example.test', 'SHAPE'],
    ['EMAIL', 'ama@example.test, kofi@example.test', 'SHAPE'],
    ['EMAIL', '+233201234567', 'SHAPE'],
    ['SMS', '0201234567', 'SHAPE'],
    ['SMS', '+233 20 123 4567', 'SHAPE'],
    ['SMS', 'ama@example.test', 'SHAPE'],
    ['SMS', '+0123456789', 'SHAPE'],
    ['EMAIL', 'a\nb@example.test', 'SHAPE'],
    // A control character that is not white space: no address pattern excludes it, so the rule for control characters does.
    ['EMAIL', 'a\u0000b@example.test', 'SHAPE'],
    ['EMAIL', 'ama@example.test\u0007', 'SHAPE'],
    ['EMAIL', 'ama\u007f@example.test', 'SHAPE'],
  ] as const)('judges %s destination %s', (channel, destination, problem) => {
    expect(destinationProblem(channel, destination)).toBe(problem);
  });

  // Break caught: a link that is not a web address, or that cannot be told from text with a second address in it.
  it.each([
    ['https://ops.example.test/setup/credential#token=abc', undefined],
    ['http://127.0.0.1:5173/recovery/complete#token=abc', undefined],
    ['', 'EMPTY'],
    ['ftp://ops.example.test/', 'SHAPE'],
    ['javascript:alert(1)', 'SHAPE'],
    ['https://ops.example.test/ a', 'SHAPE'],
    ['not a url', 'SHAPE'],
    ['https://user:password@ops.example.test/', 'SHAPE'],
  ] as const)('judges link %s', (link, problem) => {
    expect(linkProblem(link)).toBe(problem);
  });
});
