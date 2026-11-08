import { ApiError, BrowserTransportError } from '@melarc/api-client/browser';

/**
 * The `Idempotency-Key` of a command (contracts/openapi.yaml, the `IdempotencyKey` parameter: client-generated, at most
 * 128 characters; the same key with the same payload replays the original result, the same key with another payload is
 * `409 IDEMPOTENCY_KEY_CONFLICT`).
 *
 * The generated client sends no key of its own, and a primitive like `Button` knows nothing of keys: they belong to
 * the feature that sends the command (COMPONENT_PATTERNS 33.2). This is what that feature uses, so each of them keeps
 * the same rules:
 *
 * - a key is **new for each command**;
 * - an attempt whose outcome is **not known** (no answer, an answer that is not the API's, an abort, a `5xx`) leaves the command
 *   **unresolved**, and the key is kept: the retry is a replay of the same command and not a second one;
 * - **only an authoritative outcome ends an unresolved command**: a success (the replay of the original result, or the execution the
 *   first attempt never got). A later *refusal* does not: a rate limit, a CSRF refusal, a refused permission, a malformed request, a
 *   version that moved, a request the transport refused to send and the server's `IDEMPOTENCY_KEY_CONFLICT` are all decided before
 *   the idempotency lookup, or after it, and from the client it cannot be told which; none of them says whether the earlier attempt
 *   committed, so none releases the key;
 * - the first attempt of a command that is *refused* is finished: it was answered, and nothing about it is in doubt;
 * - a **changed** command is not sent while an earlier one is unresolved: sent with the old key it would be `IDEMPOTENCY_KEY_CONFLICT`,
 *   and with a new one it might be done twice. The person checks the record and **abandons** the earlier attempt (`abandon`), which is
 *   the only other way out, or sends the same command again;
 * - nothing retries by itself, and nothing mints a new key after a conflict: a retry is the person's action.
 *
 * The slot keeps a digest of the command, never the command, because a command can hold a secret.
 */

/** A fresh key. A random UUID is 36 characters, far inside the contract's 128, and unguessable. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * What a failed attempt says about *that attempt*:
 *
 * - `not-sent`: nothing left the browser: the transport refused the request, or the command was withdrawn or changed while it was being
 *   prepared (`CommandCancelledError`, `CommandChangedError`);
 * - `refused`: the API answered with a `4xx`. It declined this attempt and said nothing about an earlier one;
 * - `unknown`: anything else (no answer, an answer that is not the API's, an abort, a `5xx`, which the API also uses for a commit whose
 *   outcome it does not know: apps/api/CLAUDE.md). The command may have been done.
 */
export type AttemptFailure = 'not-sent' | 'refused' | 'unknown';

export function failureOf(error: unknown): AttemptFailure {
  if (
    error instanceof BrowserTransportError ||
    error instanceof CommandCancelledError ||
    error instanceof CommandChangedError
  ) {
    return 'not-sent';
  }
  if (
    error instanceof ApiError &&
    error.kind === 'http' &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return 'refused';
  }
  return 'unknown';
}

/** A different command was offered while an earlier one is unresolved. Nothing was sent. */
export class UnresolvedCommandError extends Error {
  override name = 'UnresolvedCommandError';
  constructor() {
    super(
      'An earlier attempt of a different command was not answered, so whether it was done is not known: check the record, then abandon it or send it again.',
    );
  }
}

/**
 * The command was withdrawn while it was being prepared: the person abandoned it, the form went away, or the session changed (the
 * lifecycle review of 24 October 2026). Nothing was sent and no key was made. A command begun for one person must never be sent into the
 * session that replaced theirs, and the session boundary cannot stop it: it first sees a request dispatched in the new session.
 */
export class CommandCancelledError extends Error {
  override name = 'CommandCancelledError';
  constructor() {
    super(
      'The command was withdrawn before it was sent: the form went away, it was abandoned or the session changed.',
    );
  }
}

/**
 * The command changed while it was being prepared, so the fingerprint described other data than the request would carry. Nothing was sent.
 */
export class CommandChangedError extends Error {
  override name = 'CommandChangedError';
  constructor() {
    super('The command changed while it was being prepared, so it was not sent: offer it again.');
  }
}

const fingerprintRefused = (what: string): TypeError =>
  new TypeError(`Cannot fingerprint the command: ${what}.`);

/**
 * The command as a string that is the same for the same command **as it is sent** (its `JSON.stringify` form) whatever order its
 * properties were written in. The accepted domain is narrow on purpose: `null`, booleans, finite numbers, strings, arrays, and plain
 * objects (or objects with no prototype) of those. An `undefined` property is left out and an `undefined` array element is `null`, as
 * `JSON.stringify` does. Anything whose wire form cannot be vouched for is refused:
 *
 * - a **sparse array** (a hole is sent as `null`, and joined as nothing it would be one command with `[]`);
 * - an accessor property (a getter answers when it is asked, and again when the request is built);
 * - an object with `toJSON`, a class instance, a `Date`, a `Map`, a typed array;
 * - a non-finite number, a `bigint`, a symbol, a function;
 * - a cycle.
 */
export function canonicalCommand(value: unknown): string {
  return canonical(value, new Set<object>());
}

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw fingerprintRefused('it holds a number that is not finite');
      return JSON.stringify(value);
    case 'object':
      return canonicalObject(value, ancestors);
    default:
      throw fingerprintRefused(
        `it holds a value of type ${typeof value} that JSON cannot represent`,
      );
  }
}

function canonicalObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw fingerprintRefused('it refers to itself');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw fingerprintRefused('it holds a sparse array');
        const item: unknown = value[index];
        items.push(item === undefined ? 'null' : canonical(item, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw fingerprintRefused('it holds an object that is not a plain one');
    }
    const record = value as Record<string, unknown>;
    if (typeof record.toJSON === 'function') {
      throw fingerprintRefused('it holds an object that chooses its own serialisation');
    }
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || 'get' in descriptor || 'set' in descriptor) {
        throw fingerprintRefused('it holds an accessor property');
      }
      const member: unknown = descriptor.value;
      if (member === undefined) continue;
      members.push(`${JSON.stringify(key)}:${canonical(member, ancestors)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** The digest of a command that has already been put in its canonical form (the only asynchronous step of preparing it). */
async function digestOf(canonicalForm: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalForm);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface CommandKeySlot {
  /**
   * Sends a command with its key. `command` is everything that makes the request what it is: the operation, the path and query values,
   * the body and the `If-Match` version. The slot sends with the key it holds when the command is the one held, and with a new key when
   * nothing is held. It rethrows what `send` throws, and throws {@link UnresolvedCommandError}, sending nothing, for a different
   * command while an earlier one is unresolved. Preparing the command is asynchronous (its digest), so the session and the slot are noted
   * before it and judged again just before the send: a session that changed, an `abandon()` or the form going away is
   * {@link CommandCancelledError}, and a command that was edited in the meantime is {@link CommandChangedError}. Neither sends anything.
   */
  run<T>(command: unknown, send: (idempotencyKey: string) => Promise<T>): Promise<T>;
  /**
   * The explicit act of a person who has looked at the record (or accepts that the earlier attempt may have been done): the held key and
   * its uncertainty are forgotten, and the next command is a new one. Also what leaving the form does. A command that is still being
   * prepared when this is called is withdrawn, not merely left without a key.
   */
  abandon(): void;
  /** Whether a key is being held and whether the command it belongs to is unresolved, and nothing else about it. */
  describe(): { readonly held: boolean; readonly unresolved: boolean };
}

interface Held {
  readonly key: string;
  readonly fingerprint: string;
  /** The session (or flow) the key was made in: another one does not inherit it. */
  readonly epoch: number;
  /** Whether an attempt of this command ended without an answer that tells what became of it. */
  unresolved: boolean;
  /** Attempts under way with this key. One command at a time is the screen's rule; this only keeps an overlap from freeing the key. */
  inFlight: number;
}

/**
 * One slot for each place a command can be sent from (a form, a dialog). It holds at most one key, with a digest of the command it belongs
 * to. `epoch` says which session or flow the slot is in; a key made in another one is not carried into this one (the idempotency record
 * belongs to a principal, and the screen of the earlier session is gone).
 */
export function createCommandKeySlot(
  generate: () => string = newIdempotencyKey,
  epoch: () => number = () => 0,
): CommandKeySlot {
  let held: Held | undefined;
  /** How many times the slot has been abandoned: a command prepared before one of them is not the one the person means to send. */
  let abandonments = 0;

  return {
    async run(command, send) {
      // Everything that says which command this is, and for whom, is taken before the first asynchronous step: the data (as the canonical
      // string that is fingerprinted), the session, and the slot's own count of abandonments.
      const canonicalForm = canonicalCommand(command);
      const now = epoch();
      const abandonedBefore = abandonments;

      const fingerprint = await digestOf(canonicalForm);

      // And judged again, in the same synchronous stretch as the send (no await lies between here and it): a session that changed, an
      // abandon, the form's disposal (which abandons) and a command that was edited meanwhile all withdraw this call, so that nothing is
      // sent, and no key is made, for a command whose person or data is no longer the one it was begun for.
      if (epoch() !== now || abandonments !== abandonedBefore) throw new CommandCancelledError();
      if (canonicalCommand(command) !== canonicalForm) throw new CommandChangedError();

      if (held !== undefined && held.epoch !== now) held = undefined;

      let current: Held;
      if (held === undefined) {
        current = { key: generate(), fingerprint, epoch: now, unresolved: false, inFlight: 0 };
        held = current;
      } else if (held.fingerprint === fingerprint) {
        current = held;
      } else if (held.unresolved || held.inFlight > 0) {
        throw new UnresolvedCommandError();
      } else {
        current = { key: generate(), fingerprint, epoch: now, unresolved: false, inFlight: 0 };
        held = current;
      }

      const retry = current.unresolved;
      current.inFlight += 1;
      try {
        const result = await send(current.key);
        // A success is the one authoritative outcome: the first execution, or the replay of the original result.
        if (held === current) held = undefined;
        return result;
      } catch (error) {
        if (failureOf(error) === 'unknown') current.unresolved = true;
        // The first attempt of a command that was refused, or never sent, is finished. A later refusal reconciles nothing.
        else if (!retry && !current.unresolved && current.inFlight === 1 && held === current) {
          held = undefined;
        }
        throw error;
      } finally {
        current.inFlight -= 1;
      }
    },
    abandon() {
      abandonments += 1;
      held = undefined;
    },
    describe() {
      return { held: held !== undefined, unresolved: held?.unresolved === true };
    },
  };
}
