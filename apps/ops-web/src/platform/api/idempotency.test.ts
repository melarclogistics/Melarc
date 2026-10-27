import { ApiError, BrowserTransportError } from '@melarc/api-client/browser';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalCommand,
  CommandCancelledError,
  CommandChangedError,
  createCommandKeySlot,
  failureOf,
  newIdempotencyKey,
  UnresolvedCommandError,
} from './idempotency';

/** A generator that is easy to read in an assertion: key-1, key-2, ... */
function counting(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `key-${String(count)}`;
  };
}

const lost = () => new ApiError({ kind: 'network' });
const refused = (status: number, code?: string) =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });
const notSent = () => new BrowserTransportError('Refusing to send');

const COMMAND = { operation: 'createStaffIdentity', body: { full_name: 'A' } };

/** Runs the command through the slot with a send that settles as told, and reports the key it was sent with. */
async function attempt(
  slot: ReturnType<typeof createCommandKeySlot>,
  command: unknown,
  outcome: 'ok' | Error,
): Promise<{ key: string; result: 'ok' | Error }> {
  let sentWith = '';
  const result = await slot
    .run(command, (key) => {
      sentWith = key;
      return outcome === 'ok' ? Promise.resolve('ok' as const) : Promise.reject(outcome);
    })
    .catch((error: unknown) => error as Error);
  return { key: sentWith, result: result === 'ok' ? 'ok' : result };
}

describe('newIdempotencyKey', () => {
  // Break caught: a key the contract refuses (`maxLength: 128`), or one that two commands can share.
  it('is a fresh value within the contract’s length each time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));

    expect(keys.size).toBe(50);
    for (const key of keys) {
      expect(key.length).toBeGreaterThan(0);
      expect(key.length).toBeLessThanOrEqual(128);
      expect(key).toMatch(/^[0-9a-f-]+$/);
    }
  });
});

describe('failureOf: what a failure says about the attempt that failed', () => {
  // Break caught: an answer taken for the outcome of the command. The server's refusal of *this* attempt (a rate limit, a CSRF refusal,
  // a version that moved, a malformed request) is decided before the idempotency lookup, or after it, and from the client it is not
  // told which; it says nothing about whether an earlier attempt of the same command committed.
  it.each([
    ['an answer of 400', refused(400, 'VALIDATION_FAILED'), 'refused'],
    ['an answer of 403, the CSRF check', refused(403, 'CSRF_VALIDATION_FAILED'), 'refused'],
    ['an answer of 409, a moved version', refused(409, 'STATE_CONFLICT'), 'refused'],
    [
      'an answer of 409, the key recorded with another command',
      refused(409, 'IDEMPOTENCY_KEY_CONFLICT'),
      'refused',
    ],
    ['an answer of 422', refused(422, 'REASON_REQUIRED'), 'refused'],
    ['an answer of 429, which did nothing', refused(429, 'RATE_LIMITED'), 'refused'],
    ['an answer of 500, which may have committed', refused(500), 'unknown'],
    ['an answer of 503', refused(503), 'unknown'],
    ['no answer', lost(), 'unknown'],
    [
      'an answer that is not the API’s',
      new ApiError({ kind: 'unexpected-response', status: 200 }),
      'unknown',
    ],
    ['a request the transport refused to send, which left nothing', notSent(), 'not-sent'],
    ['an abort, which may have arrived', new DOMException('aborted', 'AbortError'), 'unknown'],
    ['an error that is not any of those', new Error('boom'), 'unknown'],
  ] as const)('judges %s', (_label, error, expected) => {
    expect(failureOf(error)).toBe(expected);
  });
});

describe('a command key slot: while an attempt is unresolved (U01 of 23 October 2026)', () => {
  // Break caught: a retry of a command whose outcome is not known getting a new key. The server could not tell it from a second
  // command, and would do it twice (COMPONENT_PATTERNS 33.2).
  it('reuses the key after a lost response, for the same command', async () => {
    const slot = createCommandKeySlot(counting());

    const first = await attempt(slot, COMMAND, lost());
    const second = await attempt(slot, COMMAND, lost());

    expect([first.key, second.key]).toEqual(['key-1', 'key-1']);
    expect(slot.describe()).toEqual({ held: true, unresolved: true });
  });

  // Break caught (the reproduction of the finding): the replay of a lost response is answered 429 before the idempotency lookup, the
  // helper takes that for the outcome, releases the key, and the next retry is a second command although the first may have committed.
  it('keeps the key when the replay of a lost response is rate-limited', async () => {
    const slot = createCommandKeySlot(counting());
    await attempt(slot, COMMAND, lost());

    const limited = await attempt(slot, COMMAND, refused(429, 'RATE_LIMITED'));
    const next = await attempt(slot, COMMAND, lost());

    expect(limited.key).toBe('key-1');
    expect(next.key).toBe('key-1');
    expect(slot.describe().unresolved).toBe(true);
  });

  it('keeps the key when the replay is refused before it is sent', async () => {
    const slot = createCommandKeySlot(counting());
    await attempt(slot, COMMAND, lost());

    await attempt(slot, COMMAND, notSent());
    const next = await attempt(slot, COMMAND, lost());

    expect(next.key).toBe('key-1');
  });

  it.each([
    ['a CSRF refusal', refused(403, 'CSRF_VALIDATION_FAILED')],
    ['a permission refusal', refused(403, 'PERMISSION_DENIED')],
    ['a validation refusal', refused(400, 'VALIDATION_FAILED')],
    ['a version that moved', refused(409, 'STATE_CONFLICT')],
    ['a reason that is not accepted', refused(422, 'REASON_NOT_ACTIVE')],
  ])(
    'keeps the key when the replay is answered with %s: that is not the outcome of the first attempt',
    async (_label, error) => {
      const slot = createCommandKeySlot(counting());
      await attempt(slot, COMMAND, lost());

      await attempt(slot, COMMAND, error);
      const next = await attempt(slot, COMMAND, lost());

      expect(next.key).toBe('key-1');
    },
  );

  // Break caught: a minted key and a resend after the server said the key is recorded with another command. That answer means the earlier
  // attempt may well have committed; a new key would do it again.
  it('does not mint a new key, or send again by itself, after an idempotency conflict', async () => {
    const slot = createCommandKeySlot(counting());
    const send = vi.fn(() => Promise.reject(refused(409, 'IDEMPOTENCY_KEY_CONFLICT')));
    await attempt(slot, COMMAND, lost());

    await slot.run(COMMAND, send).catch(() => undefined);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('key-1');
    expect(slot.describe()).toEqual({ held: true, unresolved: true });
  });

  // Break caught: the one answer that reconciles the command being ignored: the replay of the original result, or the first execution,
  // both a success, ends the uncertainty, and the next command is a new one.
  it('ends the uncertainty with a success: the replay, or the execution the first attempt never got', async () => {
    const slot = createCommandKeySlot(counting());
    await attempt(slot, COMMAND, lost());
    await attempt(slot, COMMAND, refused(429, 'RATE_LIMITED'));

    const replay = await attempt(slot, COMMAND, 'ok');
    const after = await attempt(slot, COMMAND, 'ok');

    expect(replay).toEqual({ key: 'key-1', result: 'ok' });
    expect(after.key).toBe('key-2');
    expect(slot.describe()).toEqual({ held: false, unresolved: false });
  });

  // Break caught: a different command sent with the key of one that may have committed (the server answers IDEMPOTENCY_KEY_CONFLICT and the
  // person is told their command conflicts with itself), or sent with a new key (it may be done twice). Neither is chosen for them.
  it('refuses a changed command while the earlier one is unresolved, and sends nothing', async () => {
    const slot = createCommandKeySlot(counting());
    await attempt(slot, COMMAND, lost());
    const send = vi.fn(() => Promise.resolve('ok'));

    await expect(slot.run({ ...COMMAND, body: { full_name: 'B' } }, send)).rejects.toBeInstanceOf(
      UnresolvedCommandError,
    );

    expect(send).not.toHaveBeenCalled();
    expect(slot.describe()).toEqual({ held: true, unresolved: true });
  });

  it('serves the earlier command again after a refused change', async () => {
    const slot = createCommandKeySlot(counting());
    await attempt(slot, COMMAND, lost());
    await slot
      .run({ ...COMMAND, body: { full_name: 'B' } }, () => Promise.resolve('ok'))
      .catch(() => undefined);

    const again = await attempt(slot, COMMAND, 'ok');

    expect(again).toEqual({ key: 'key-1', result: 'ok' });
  });

  // Break caught: no way out of an unresolved command, so that a person who has looked at the record and found the earlier attempt did not
  // happen can never send again. Abandoning is their explicit act and the only other thing that ends it.
  it('lets the person abandon the unresolved command, and the next command is new', async () => {
    const slot = createCommandKeySlot(counting());
    await attempt(slot, COMMAND, lost());

    slot.abandon();
    const changed = await attempt(slot, { ...COMMAND, body: { full_name: 'B' } }, lost());
    const same = await attempt(slot, COMMAND, lost());

    expect(changed.key).toBe('key-2');
    // The changed command is itself unresolved now, so this one is refused until that is dealt with.
    expect(same.result).toBeInstanceOf(UnresolvedCommandError);
  });

  it('abandons nothing when nothing is held', () => {
    const slot = createCommandKeySlot(counting());

    slot.abandon();

    expect(slot.describe()).toEqual({ held: false, unresolved: false });
  });

  // Break caught: a held key carried into another session. The idempotency record belongs to a principal, so the key means nothing to
  // another person's session, and what the first session left unresolved is no longer this flow's to settle: the screen is rebuilt.
  it('does not carry a key into another session', async () => {
    let session = 1;
    const slot = createCommandKeySlot(counting(), () => session);
    await attempt(slot, COMMAND, lost());

    session = 2;
    const next = await attempt(slot, COMMAND, lost());

    expect(next.key).toBe('key-2');
  });
});

describe('a command key slot: the first attempt of a command', () => {
  // Break caught: a rejection read as an unknown outcome. The first attempt was answered, and nothing about it is in doubt: the next
  // command is a new one, and an edit of this one is not held up.
  it.each([
    ['400', refused(400, 'VALIDATION_FAILED')],
    ['403', refused(403, 'PERMISSION_DENIED')],
    ['409', refused(409, 'STATE_CONFLICT')],
    ['422', refused(422, 'REASON_REQUIRED')],
    ['429', refused(429, 'RATE_LIMITED')],
  ])('is finished by an answer of %s: the next command gets a new key', async (_label, error) => {
    const slot = createCommandKeySlot(counting());

    const first = await attempt(slot, COMMAND, error);
    const edited = await attempt(slot, { ...COMMAND, body: { full_name: 'B' } }, 'ok');

    expect(first.key).toBe('key-1');
    expect(edited.key).toBe('key-2');
    expect(slot.describe()).toEqual({ held: false, unresolved: false });
  });

  it('is finished by a request the transport refused to send, which left nothing to doubt', async () => {
    const slot = createCommandKeySlot(counting());

    await attempt(slot, COMMAND, notSent());
    const next = await attempt(slot, COMMAND, 'ok');

    expect(next.key).toBe('key-2');
  });

  it('uses a new key after a success', async () => {
    const slot = createCommandKeySlot(counting());

    const first = await attempt(slot, COMMAND, 'ok');
    const second = await attempt(slot, COMMAND, 'ok');

    expect([first.key, second.key]).toEqual(['key-1', 'key-2']);
  });

  it.each([
    ['500', refused(500)],
    ['503', refused(503)],
    ['an abort', new DOMException('aborted', 'AbortError')],
  ])('is unresolved after %s, which may have committed', async (_label, error) => {
    const slot = createCommandKeySlot(counting());

    await attempt(slot, COMMAND, error);

    expect(slot.describe()).toEqual({ held: true, unresolved: true });
  });

  it('returns what the send returned, and rethrows what it threw', async () => {
    const slot = createCommandKeySlot(counting());
    const error = refused(400);

    await expect(slot.run({ operation: 'a' }, () => Promise.resolve(42))).resolves.toBe(42);
    await expect(slot.run({ operation: 'a' }, () => Promise.reject(error))).rejects.toBe(error);
  });

  // Break caught: the slot keeping the command itself. A command can hold a password or a note; only what is needed to tell two commands
  // apart may stay in memory, and that is a digest.
  it('keeps no copy of the command while it waits', async () => {
    const slot = createCommandKeySlot(counting());
    const sentinel = 'sentinel-secret-5e1c';

    await attempt(slot, { operation: 'op', body: { password: sentinel } }, lost());

    expect(JSON.stringify(slot)).not.toContain(sentinel);
    expect(JSON.stringify(Object.getOwnPropertyNames(slot))).not.toContain(sentinel);
    expect(JSON.stringify(slot.describe())).not.toContain(sentinel);
  });

  // Break caught: a command that cannot be fingerprinted sending with a key the slot cannot tell apart from the next one.
  it('refuses a command it cannot tell apart, and sends nothing', async () => {
    const slot = createCommandKeySlot(counting());
    const send = vi.fn(() => Promise.resolve(null));
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(slot.run(circular, send)).rejects.toThrow(/fingerprint/i);
    await expect(slot.run({ n: 1n }, send)).rejects.toThrow(/fingerprint/i);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the fingerprint of a command (U04 of 23 October 2026)', () => {
  /** The wire form of a value with its object keys in order: what two equal commands must agree on, whatever order they were written in. */
  const sortedWire = (value: unknown): string =>
    JSON.stringify(value, (_key, inner: unknown) =>
      inner !== null && typeof inner === 'object' && !Array.isArray(inner)
        ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
        : inner,
    );

  // Break caught: a sparse array fingerprinted differently from the way it is sent. `Array(1)` is sent as `[null]` and `[]` as `[]`;
  // a canonicaliser that joins holes as empty text gave both the same fingerprint, so two different commands shared a key.
  it('rejects a sparse array, however deep, rather than guess what it is sent as', () => {
    expect(() => canonicalCommand(new Array(1))).toThrow(/fingerprint/i);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalCommand({ a: [1, , 3] })).toThrow(/fingerprint/i);
    expect(() => canonicalCommand({ a: { b: [[new Array(2)]] } })).toThrow(/fingerprint/i);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalCommand([, 1])).toThrow(/fingerprint/i);
  });

  it('tells an empty array, an array holding null and an array holding undefined apart as the wire does', () => {
    expect(canonicalCommand([])).toBe('[]');
    expect(canonicalCommand([null])).toBe('[null]');
    // JSON.stringify sends an undefined element as null, so the two are one command.
    expect(canonicalCommand([undefined])).toBe(canonicalCommand([null]));
    expect(canonicalCommand([])).not.toBe(canonicalCommand([null]));
    expect(canonicalCommand([[], [null]])).toBe('[[],[null]]');
  });

  it('agrees with the wire serialisation for every value it accepts', () => {
    const samples: unknown[] = [
      null,
      true,
      0,
      -0,
      1.5,
      'text',
      'é « »  ',
      [],
      [null],
      [undefined, 1],
      {},
      { b: 1, a: [2, { d: null, c: undefined }] },
      { a: undefined },
      { nested: { z: [], y: {}, x: [[], [[]]] } },
    ];
    for (const sample of samples) {
      expect(JSON.parse(canonicalCommand(sample))).toEqual(JSON.parse(JSON.stringify(sample)));
      expect(canonicalCommand(sample)).toBe(sortedWire(sample));
    }
  });

  it('is the same for the same command written in another property order, and not otherwise', () => {
    expect(canonicalCommand({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      canonicalCommand({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
    expect(canonicalCommand({ a: [1, 2] })).not.toBe(canonicalCommand({ a: [2, 1] }));
    expect(canonicalCommand({ a: 1 })).not.toBe(canonicalCommand({ a: '1' }));
    expect(canonicalCommand({ a: null })).not.toBe(canonicalCommand({}));
    expect(canonicalCommand({ a: undefined })).toBe(canonicalCommand({}));
  });

  // Break caught: values whose wire form the helper cannot vouch for: a getter that answers differently each time, an object that
  // chooses its own serialisation, a class instance, a non-finite number, a function, a symbol, a bigint.
  it.each([
    [
      'a getter',
      {
        get a() {
          return 1;
        },
      },
    ],
    ['an object with toJSON', { toJSON: () => 1 }],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    [
      'a class instance',
      new (class Thing {
        x = 1;
      })(),
    ],
    ['NaN', { a: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['a function', { a: () => 1 }],
    ['a symbol', { a: Symbol('x') }],
    ['a bigint', { a: 1n }],
    ['a typed array', new Uint8Array(2)],
  ])('refuses %s', (_label, value) => {
    expect(() => canonicalCommand(value)).toThrow(/fingerprint/i);
  });

  it('refuses a cycle at any depth', () => {
    const inner: Record<string, unknown> = {};
    const outer = { a: [{ b: inner }] };
    inner.back = outer;

    expect(() => canonicalCommand(outer)).toThrow(/fingerprint/i);
  });

  it('accepts the same object twice when it is not a cycle', () => {
    const shared = { x: 1 };

    expect(canonicalCommand({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  // The fingerprint of a command is what the slot compares, so the slot treats two spellings of one wire command as one command.
  it('makes the slot treat an undefined element and a null element as one command', async () => {
    const slot = createCommandKeySlot(counting());
    await attempt(slot, { items: [undefined] }, lost());

    const again = await attempt(slot, { items: [null] }, lost());

    expect(again.key).toBe('key-1');
  });
});

describe('a command key slot: a command still being prepared when its world changes (review of 24 October 2026)', () => {
  /** A slot whose session the test can replace, and a send that records the session it was called in. */
  function world(generate: () => string = counting()) {
    let session = 1;
    const slot = createCommandKeySlot(generate, () => session);
    const sent: { key: string; session: number }[] = [];
    const send = (key: string) => {
      sent.push({ key, session });
      return Promise.resolve('ok' as const);
    };
    return {
      slot,
      sent,
      send,
      replaceSession: () => {
        session += 1;
      },
    };
  }

  // Break caught: the session read after the fingerprint's asynchronous digest, so that a command begun for one person is sent, with a
  // new key, into the session that replaced it. The boundary cannot catch it: it sees a request first dispatched in the new session.
  it('sends nothing when the session is replaced while the command is being fingerprinted', async () => {
    const { slot, sent, send, replaceSession } = world();

    const pending = slot.run(COMMAND, send);
    replaceSession();

    await expect(pending).rejects.toMatchObject({ name: 'CommandCancelledError' });
    expect(sent).toEqual([]);
    expect(slot.describe()).toEqual({ held: false, unresolved: false });
  });

  // Break caught: `abandon()` forgetting a key that exists and nothing else, so that a command still being prepared goes on to be sent.
  it('sends nothing when the person abandons the command while it is being fingerprinted', async () => {
    const { slot, sent, send } = world();

    const pending = slot.run(COMMAND, send);
    slot.abandon();

    await expect(pending).rejects.toMatchObject({ name: 'CommandCancelledError' });
    expect(sent).toEqual([]);
  });

  // The exact sequence of the review: the old command under session 1, the session replaced and the key abandoned, and the old command
  // still reached send() under session 2.
  it('does not let the old command reach the new session after both the replacement and the abandon', async () => {
    const { slot, sent, send, replaceSession } = world();

    const pending = slot.run(COMMAND, send);
    replaceSession();
    slot.abandon();

    await expect(pending).rejects.toMatchObject({ name: 'CommandCancelledError' });
    expect(sent).toEqual([]);
  });

  // Break caught: a key made for a command that is then thrown away, which leaves a key in the slot for a command nobody sent.
  it('mints no key for a command that was cancelled', async () => {
    const generate = vi.fn(counting());
    const { slot, send, replaceSession } = world(generate);

    const pending = slot.run(COMMAND, send);
    replaceSession();
    await pending.catch(() => undefined);

    expect(generate).not.toHaveBeenCalled();
  });

  // Break caught: the fingerprint taken of the command at one moment and the request built from it at another, so that the key and the
  // digest describe data the request no longer holds.
  it('sends nothing when the command changes while it is being fingerprinted', async () => {
    const { slot, sent, send } = world();
    const command = {
      operation: 'resetStaffMfa',
      body: { reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE' },
    };

    const pending = slot.run(command, send);
    command.body.reason_code = 'MFA_AUTHENTICATOR_LOST';

    await expect(pending).rejects.toMatchObject({ name: 'CommandChangedError' });
    expect(sent).toEqual([]);
    expect(slot.describe()).toEqual({ held: false, unresolved: false });
  });

  it('judges the data it was offered: a command changed and changed back is the same command and is sent', async () => {
    const { slot, sent, send } = world();
    const command = { operation: 'resetStaffMfa', body: { reason_code: 'A' } };

    const pending = slot.run(command, send);
    command.body.reason_code = 'B';
    command.body.reason_code = 'A';

    await expect(pending).resolves.toBe('ok');
    expect(sent).toEqual([{ key: 'key-1', session: 1 }]);
  });

  // Break caught: the checks refusing a command nothing happened to.
  it('still sends a command nothing happened to, once, with a key of its own', async () => {
    const { slot, sent, send } = world();

    await expect(slot.run(COMMAND, send)).resolves.toBe('ok');

    expect(sent).toEqual([{ key: 'key-1', session: 1 }]);
  });

  // Break caught: a withdrawal that also withdraws a key the person is entitled to keep: the command already sent and unresolved keeps its
  // key for the retry, whatever happens to a different command that is still being prepared.
  it('does not disturb the key of an earlier, unresolved command when a later one is withdrawn', async () => {
    const { slot, sent, send } = world();
    await slot.run(COMMAND, () => Promise.reject(lost())).catch(() => undefined);
    expect(slot.describe()).toEqual({ held: true, unresolved: true });

    const pending = slot.run(COMMAND, send);
    // Nothing is withdrawn here: the same command is a retry and is sent with the held key.
    await expect(pending).resolves.toBe('ok');

    expect(sent).toEqual([{ key: 'key-1', session: 1 }]);
  });
});

describe('failureOf for a command that was withdrawn or changed while it was being prepared', () => {
  // Break caught: a withdrawn command reported as one whose outcome is unknown, which would tell a screen it may have been done.
  it.each([new CommandCancelledError(), new CommandChangedError()])(
    'says nothing was sent for %s',
    (error) => {
      expect(failureOf(error)).toBe('not-sent');
    },
  );
});
