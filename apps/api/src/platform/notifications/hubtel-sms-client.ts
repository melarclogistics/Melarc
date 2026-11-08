import type { ReadableStreamReadResult } from 'node:stream/web';

import type { TextMessage, TextStatus } from '../auth/ports/text-message-sender.port.js';
import type { Secret } from '../config/secret.js';

/**
 * The HTTP client of Hubtel's business SMS API: the exchange, the contract and nothing of what a result means to the platform
 * (`hubtel.text-message-sender.adapter.ts` maps a result to the port's outcomes). Not an adapter.
 *
 * **THE CONTRACT THIS CLIENT BUILDS AGAINST. UNVERIFIED.** The official reference pages could not be read when this was written, so what
 * follows is the best known form of it, and the owner's first real send confirms or corrects it.
 *
 * - **Send**: `POST {endpoint}/send`, with `Authorization: Basic base64(clientId:clientSecret)`, `Content-Type: application/json` and
 *   `Accept: application/json`. The JSON body is `{ "From": <the sender id>, "To": <the E.164 number without its leading plus, such as
 *   "233244000111">, "Content": <the text>, "RegisteredDelivery": true }`. Success is HTTP 200 or 201 with JSON `{ "Status": 0,
 *   "MessageId": "<string>", "Rate": <number>, "NetworkId": "<string>" }`. A 2xx whose `Status` is a non-zero number, or whose body has
 *   no usable `MessageId`, is not an acceptance.
 * - **Status**: `GET {endpoint}/{messageId}`, with the same `Authorization`. The body carries the status in `Status` (or `status`,
 *   `MessageStatus`, `DeliveryStatus`), as text or as an object with a `Name`, `Description`, `name` or `description` text. Compared
 *   without case and without the space around it: `delivered` is delivered; `sent`, `submitted`, `queued`, `pending`, `accepted` and
 *   `buffered` are pending (only the mobile network's final status is final, and `Sent` is not); `failed`, `undeliverable`, `rejected`,
 *   `blacklisted`, `unrouteable`, `unroutable`, `error` and `expired` are failed, with the upper-cased word as the outcome class; any
 *   other word, a body that cannot be read and a status that is not 2xx are unknown.
 *
 * What this client adds, because the contract is unverified and a send taken for lost is sent again to a real number: it reads the
 * members whatever their case (`MessageId` or `messageId`), and a `Status` written as text. A `MessageId` is usable when it is 1 to 128
 * letters, digits and `._~:=+-`, beginning with a letter or digit, so that it can name an address without changing it. The members the
 * contract has no place for are not sent: the deduplication identity of a message is not forwarded.
 *
 * **What it keeps from leaving.** The two secrets are revealed only when a call is made, to build the `Authorization` header for that
 * call, which is never stored. A result, an error and a callback name carry no destination, no text, no credential, no header, no address
 * and nothing the provider wrote: a result is built from the status code, a closed word and a number; an error thrown at construction
 * has a fixed text; a name given to `onEvent` is one of `HUBTEL_EVENTS`. What a failing transport said is never read.
 *
 * The endpoint is `https`, or `http` on this machine for a stand-in (the credentials are never sent in clear over a network), carries no
 * sign-in details of its own, and is stripped of its query and fragment. No redirect is followed. Every call is bounded by `timeoutMs`,
 * which covers the answer's body as well as its head, and is aborted when it ends: the answer to a call that gave up is "may or may not
 * have been accepted".
 */

/** The closed list of names the client gives to `onEvent`: what happened to a call, and nothing about the message. */
export const HUBTEL_EVENTS = [
  'hubtel_send_accepted',
  'hubtel_send_refused',
  'hubtel_send_unusable_answer',
  'hubtel_send_invalid_request',
  'hubtel_send_timeout',
  'hubtel_send_network_error',
  'hubtel_status_answered',
  'hubtel_status_refused',
  'hubtel_status_unusable_answer',
  'hubtel_status_invalid_reference',
  'hubtel_status_timeout',
  'hubtel_status_network_error',
] as const;
export type HubtelEvent = (typeof HUBTEL_EVENTS)[number];

export interface HubtelSmsClientOptions {
  /** The messages resource: the send is `POST {endpoint}/send`, the status `GET {endpoint}/{messageId}`. */
  readonly endpoint: string;
  readonly clientId: Secret;
  readonly clientSecret: Secret;
  /** What the message shows as its sender (`From`). */
  readonly senderId: string;
  /** The longest one call may take, head and body, in whole milliseconds. */
  readonly timeoutMs: number;
  /** The transport, for tests; the platform's `fetch` by default. */
  readonly fetch?: typeof fetch;
  /** The time `Retry-After` given as a date is measured from; now by default. */
  readonly now?: () => Date;
  /** Told, by closed name, what happened to each call. A callback that throws changes nothing. */
  readonly onEvent?: (name: HubtelEvent) => void;
}

/** What a send came to, in the terms of the exchange. The platform's outcome is the adapter's to decide. */
export type HubtelSendResult =
  /** Hubtel took the message and named it. */
  | { readonly kind: 'ACCEPTED'; readonly messageId: string }
  /** The answer was not a success: its HTTP status, and the wait it asked for where it asked for one. */
  | { readonly kind: 'HTTP_REFUSED'; readonly status: number; readonly retryAfterMs?: number }
  /** A success status whose body is not an acceptance: it cannot be read, names no usable message, or says the message was not taken. */
  | { readonly kind: 'UNUSABLE_ANSWER' }
  /** The destination or the text is one Hubtel cannot take. Nothing was sent. */
  | { readonly kind: 'INVALID_REQUEST' }
  /** No answer: the call ran out of time, or the transport failed. The message may or may not have been taken. */
  | { readonly kind: 'NO_ANSWER'; readonly cause: 'TIMEOUT' | 'NETWORK' };

/** The options of the client are wrong. The text is fixed: it names no value, so that a secret or an address cannot be in it. */
export class HubtelSmsClientConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubtelSmsClientConfigurationError';
  }
}

const ENDPOINT_RULE =
  'The Hubtel SMS endpoint must be an https address, or an http address on this machine, and must carry no sign-in details.';
const SENDER_RULE = 'The Hubtel SMS sender id must not be empty.';
const TIMEOUT_RULE =
  'The Hubtel SMS time-out must be a whole number of milliseconds, from 1 to 2147483647.';

const DESTINATION = /^\+[1-9][0-9]{7,14}$/;
/** The longest text, in UTF-16 code units. */
const TEXT_MAX_LENGTH = 1_000;
/** A message id that can be written into an address as one segment and cannot be a dot segment. */
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._~:=+-]{0,127}$/;
/** What of an answer is read: the answers of the contract are a few dozen bytes. */
const MAX_ANSWER_BYTES = 16 * 1024;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

const SECONDS = /^[0-9]+$/;
const HTTP_DATE = /^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;
const NON_ZERO_NUMBER_TEXT = /^\s*-?[0-9]+\s*$/;

const PENDING_WORDS: ReadonlySet<string> = new Set([
  'sent',
  'submitted',
  'queued',
  'pending',
  'accepted',
  'buffered',
]);
const FAILED_WORDS: ReadonlySet<string> = new Set([
  'failed',
  'undeliverable',
  'rejected',
  'blacklisted',
  'unrouteable',
  'unroutable',
  'error',
  'expired',
]);
/** Where the status is looked for, in this order; a member is found whatever its case. */
const STATUS_MEMBERS = ['Status', 'MessageStatus', 'DeliveryStatus'] as const;
/** Where the word is looked for when the status is an object. */
const WORD_MEMBERS = ['Name', 'Description'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The member of a JSON object called `name`, whatever the case of its key; undefined where the value is no object or has none. */
function member(value: unknown, name: string): unknown {
  if (!isRecord(value)) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(value)) {
    if (key.toLowerCase() === wanted) return value[key];
  }
  return undefined;
}

/**
 * The wait a `Retry-After` header asks for, in milliseconds: whole seconds, or an HTTP date (`Thu, 29 Oct 2026 12:02:00 GMT`) measured
 * from `now`. Undefined where there is no header, it cannot be read, or the wait is none (zero seconds, a date that has passed). A very
 * long wait is returned as the longest whole number, for whoever decides how much of it to heed.
 */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  let milliseconds: number;
  if (SECONDS.test(text)) {
    milliseconds = Number(text) * 1_000;
  } else if (HTTP_DATE.test(text)) {
    milliseconds = Date.parse(text) - now.getTime();
  } else {
    return undefined;
  }
  return milliseconds > 0 ? Math.min(milliseconds, Number.MAX_SAFE_INTEGER) : undefined;
}

/** The word a status body states, without case or the space around it; undefined where it states none. */
function statusWordOf(body: unknown): string | undefined {
  for (const place of STATUS_MEMBERS) {
    const stated = member(body, place);
    if (typeof stated === 'string') return stated.trim().toLowerCase();
    for (const name of WORD_MEMBERS) {
      const word = member(stated, name);
      if (typeof word === 'string') return word.trim().toLowerCase();
    }
  }
  return undefined;
}

/**
 * What a status body says of the message, by the table in the header of this file. The outcome class of a failure is the upper-cased
 * word of the table, never text of the provider's.
 */
export function textStatusOf(body: unknown): TextStatus {
  const word = statusWordOf(body);
  if (word === 'delivered') return { state: 'DELIVERED' };
  if (word !== undefined && PENDING_WORDS.has(word)) return { state: 'PENDING' };
  if (word !== undefined && FAILED_WORDS.has(word)) {
    return { state: 'FAILED', outcomeClass: word.toUpperCase() };
  }
  return { state: 'UNKNOWN' };
}

type JsonBody = { readonly parsed: true; readonly value: unknown } | { readonly parsed: false };
const UNREAD: JsonBody = { parsed: false };

type Exchange =
  | {
      readonly kind: 'RESPONSE';
      readonly status: number;
      readonly retryAfterMs: number | undefined;
      readonly body: JsonBody;
    }
  | { readonly kind: 'NO_ANSWER'; readonly cause: 'TIMEOUT' | 'NETWORK' };

/** Whether a `Status` says the message was not taken: a number, or text written as one, that is not zero. */
function isNonZeroStatus(code: unknown): boolean {
  if (typeof code === 'number') return code !== 0;
  return typeof code === 'string' && NON_ZERO_NUMBER_TEXT.test(code) && Number(code) !== 0;
}

/** The id of the message a success body names, where it is a success and names a usable one. */
function acceptedMessageId(body: JsonBody): string | undefined {
  if (!body.parsed || isNonZeroStatus(member(body.value, 'Status'))) return undefined;
  const id = member(body.value, 'MessageId');
  return typeof id === 'string' && MESSAGE_ID.test(id) ? id : undefined;
}

/** The body, read up to the cap and no further, as JSON; unread where it is empty, too large or not JSON. */
async function readJson(response: Response): Promise<JsonBody> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_ANSWER_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return UNREAD;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return UNREAD;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // The platform types the chunks of a response body as `any`: they are bytes.
    const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      return UNREAD;
    }
    chunks.push(value);
  }
  try {
    return { parsed: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
  } catch {
    return UNREAD;
  }
}

/** The address calls are made to: the endpoint without its query, its fragment and its trailing slashes. */
function resourceOf(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // What the parser said holds the address it was given: it is not carried.
    throw new HubtelSmsClientConfigurationError(ENDPOINT_RULE);
  }
  const secure = url.protocol === 'https:';
  const onThisMachine = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if ((!secure && !onThisMachine) || url.username !== '' || url.password !== '') {
    throw new HubtelSmsClientConfigurationError(ENDPOINT_RULE);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export class HubtelSmsClient {
  readonly #resource: string;
  readonly #clientId: Secret;
  readonly #clientSecret: Secret;
  readonly #senderId: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #onEvent: ((name: HubtelEvent) => void) | undefined;

  constructor(options: HubtelSmsClientOptions) {
    this.#resource = resourceOf(options.endpoint);
    if (options.senderId.trim() === '') throw new HubtelSmsClientConfigurationError(SENDER_RULE);
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > MAX_TIMER_MILLISECONDS
    ) {
      throw new HubtelSmsClientConfigurationError(TIMEOUT_RULE);
    }
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#senderId = options.senderId;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#onEvent = options.onEvent;
  }

  /** Sends one message. Nothing is sent for a destination or a text Hubtel cannot take. It does not throw for anything a provider can do. */
  async send(message: Pick<TextMessage, 'destination' | 'text'>): Promise<HubtelSendResult> {
    const { destination, text } = message;
    if (!DESTINATION.test(destination) || text.length < 1 || text.length > TEXT_MAX_LENGTH) {
      this.#emit('hubtel_send_invalid_request');
      return { kind: 'INVALID_REQUEST' };
    }
    const exchange = await this.#exchange(
      'POST',
      `${this.#resource}/send`,
      JSON.stringify({
        From: this.#senderId,
        To: destination.slice(1),
        Content: text,
        RegisteredDelivery: true,
      }),
    );
    if (exchange.kind === 'NO_ANSWER') {
      this.#emit(
        exchange.cause === 'TIMEOUT' ? 'hubtel_send_timeout' : 'hubtel_send_network_error',
      );
      return exchange;
    }
    if (exchange.status < 200 || exchange.status > 299) {
      this.#emit('hubtel_send_refused');
      return {
        kind: 'HTTP_REFUSED',
        status: exchange.status,
        ...(exchange.retryAfterMs === undefined ? {} : { retryAfterMs: exchange.retryAfterMs }),
      };
    }
    const messageId = acceptedMessageId(exchange.body);
    if (messageId === undefined) {
      this.#emit('hubtel_send_unusable_answer');
      return { kind: 'UNUSABLE_ANSWER' };
    }
    this.#emit('hubtel_send_accepted');
    return { kind: 'ACCEPTED', messageId };
  }

  /** What the provider says of an accepted message. Unknown for anything that cannot be read, and for a reference that cannot name one. */
  async status(messageId: string): Promise<TextStatus> {
    if (!MESSAGE_ID.test(messageId)) {
      this.#emit('hubtel_status_invalid_reference');
      return { state: 'UNKNOWN' };
    }
    const exchange = await this.#exchange(
      'GET',
      `${this.#resource}/${encodeURIComponent(messageId)}`,
      undefined,
    );
    if (exchange.kind === 'NO_ANSWER') {
      this.#emit(
        exchange.cause === 'TIMEOUT' ? 'hubtel_status_timeout' : 'hubtel_status_network_error',
      );
      return { state: 'UNKNOWN' };
    }
    if (exchange.status < 200 || exchange.status > 299) {
      this.#emit('hubtel_status_refused');
      return { state: 'UNKNOWN' };
    }
    const status: TextStatus = exchange.body.parsed
      ? textStatusOf(exchange.body.value)
      : { state: 'UNKNOWN' };
    this.#emit(
      status.state === 'UNKNOWN' ? 'hubtel_status_unusable_answer' : 'hubtel_status_answered',
    );
    return status;
  }

  /** The header of one call, made of the two secrets for that call and handed to nothing but the request. */
  #authorization(): string {
    const credentials = `${this.#clientId.reveal()}:${this.#clientSecret.reveal()}`;
    return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
  }

  /**
   * One call under the time-out. A refusal is not read past its head; a success is read up to the cap. Whatever the transport throws is
   * only classified (time-out or not), never read.
   */
  async #exchange(
    method: 'GET' | 'POST',
    address: string,
    body: string | undefined,
  ): Promise<Exchange> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: this.#authorization(),
        Accept: 'application/json',
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const transport = this.#fetch;
      const response = await transport(address, {
        method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
        ...(body === undefined ? {} : { body }),
      });
      const { status } = response;
      if (status < 200 || status > 299) {
        const asked = response.headers.get('retry-after');
        const retryAfterMs = asked === null ? undefined : parseRetryAfter(asked, this.#now());
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'RESPONSE', status, retryAfterMs, body: UNREAD };
      }
      return { kind: 'RESPONSE', status, retryAfterMs: undefined, body: await readJson(response) };
    } catch {
      return { kind: 'NO_ANSWER', cause: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
    } finally {
      clearTimeout(timer);
    }
  }

  #emit(name: HubtelEvent): void {
    try {
      this.#onEvent?.(name);
    } catch {
      // A callback that fails must not change what was sent or what the caller is told.
    }
  }
}
