import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SecretText } from './secret-text.ts';

/**
 * The messages the delivery worker captured (S0.45; the capture sink, `apps/api/src/platform/delivery/worker/capture-sink.ts`): the
 * run's stand-in for the e-mail and SMS providers, which nothing in a run may reach. The sink writes one file per message, named for
 * its deduplication identity, whole or not at all, and the file holds the destination and the link with its token **in clear, by
 * design**. A journey follows the link as the person it was for would; the link is a `SecretText`, so that it prints as nothing.
 *
 * The folder is made here, outside the checkout (the worker refuses a sink inside it), and removed when the run ends. The reader
 * knows the file's shape and not the worker's code: a change of the shape fails a journey at the first message.
 */

/** A new folder in the machine's temporary folder, outside the checkout, for the messages of one run. */
export function makeCaptureDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'melarc-e2e-capture-'));
}

export interface CapturedMessage {
  readonly capturedAt: string;
  readonly dedupeId: string;
  readonly kind: string;
  readonly channel: string;
  readonly destination: string;
  readonly link: SecretText;
  /** A vendor message's account identifier, which it carries beside the link (S0.47); absent from every other message. Not a secret. */
  readonly accountIdentifier?: string;
}

const MESSAGE_FILE = /^[A-Za-z0-9-]{16,128}\.json$/;

function messageOf(text: string): CapturedMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { capturedAt, dedupeId, kind, channel, destination, link, accountIdentifier } =
    parsed as Record<string, unknown>;
  if (
    typeof capturedAt !== 'string' ||
    typeof dedupeId !== 'string' ||
    typeof kind !== 'string' ||
    typeof channel !== 'string' ||
    typeof destination !== 'string' ||
    typeof link !== 'string' ||
    (accountIdentifier !== undefined && typeof accountIdentifier !== 'string')
  ) {
    return undefined;
  }
  return {
    capturedAt,
    dedupeId,
    kind,
    channel,
    destination,
    link: new SecretText(link),
    ...(accountIdentifier === undefined ? {} : { accountIdentifier }),
  };
}

/** Every finished message in the sink, oldest first. A folder that does not exist yet holds none; a temporary file is not a message. */
export function readMessages(directory: string): CapturedMessage[] {
  if (!existsSync(directory)) return [];
  const found: CapturedMessage[] = [];
  for (const name of readdirSync(directory)) {
    if (!MESSAGE_FILE.test(name)) continue;
    let text: string;
    try {
      text = readFileSync(join(directory, name), 'utf8');
    } catch {
      continue;
    }
    const message = messageOf(text);
    if (message !== undefined) found.push(message);
  }
  return found.toSorted(
    (a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.dedupeId.localeCompare(b.dedupeId),
  );
}

export interface InboxOptions {
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

export interface MessageWanted {
  /** The work email the message was sent to; compared in its canonical form (trimmed, lower case). */
  readonly to: string;
  readonly kind?: string;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The reader of one sink for one journey. Each message is handed over once: the next call for the same address and kind gets a later
 * message, never the one before, so that a journey cannot follow the link of an earlier act after a new one was sent.
 */
export class Inbox {
  readonly #directory: string;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #taken = new Set<string>();

  constructor(directory: string, options: InboxOptions = {}) {
    this.#directory = directory;
    this.#pollMs = options.pollMs ?? 100;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async next(wanted: MessageWanted): Promise<CapturedMessage> {
    const to = wanted.to.trim().toLowerCase();
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      const messages = readMessages(this.#directory);
      const match = messages.find(
        (message) =>
          !this.#taken.has(message.dedupeId) &&
          message.destination.trim().toLowerCase() === to &&
          (wanted.kind === undefined || message.kind === wanted.kind),
      );
      if (match !== undefined) {
        this.#taken.add(match.dedupeId);
        return match;
      }
      if (Date.now() >= deadline) {
        // How many there are, and nothing of them: not an address, a kind or a link.
        throw new Error(
          `There was no new message for that address within ${String(this.#timeoutMs)} ms (${String(messages.length)} message${messages.length === 1 ? '' : 's'} in the sink, ${String(this.#taken.size)} already taken).`,
        );
      }
      await sleep(this.#pollMs);
    }
  }
}
