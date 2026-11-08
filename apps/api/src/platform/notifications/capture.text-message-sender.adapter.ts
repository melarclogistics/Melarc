import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Clock } from '../auth/ports/clock.port.js';
import type { DeliveryOutcome } from '../auth/ports/delivery-queue.port.js';
import type {
  TextMessage,
  TextMessageSender,
  TextStatus,
} from '../auth/ports/text-message-sender.port.js';
import {
  assertOutsideCheckout,
  assertPrivateDirectory,
  type PrivacyProbe,
} from '../delivery/worker/outside-checkout.js';

/**
 * What the capture adapter keeps of a text message: all a developer needs to read it, and nothing a provider would add. **It holds the
 * destination and the text in clear, by design**, here and nowhere else: that is why the sink is a place outside the repository, private to
 * its owner, and why production refuses the capture adapter.
 */
export interface TextCaptureEntry {
  readonly dedupeId: string;
  readonly destination: string;
  readonly text: string;
  /** The instant the message was captured, in UTC (ISO 8601). */
  readonly at: string;
}

/** Where captured text messages go. A sink may keep one message for one deduplication identity. */
export interface TextCaptureSink {
  record(entry: TextCaptureEntry): Promise<void>;
}

export interface CaptureTextMessageSenderOptions {
  readonly sink: TextCaptureSink;
  readonly clock: Pick<Clock, 'now'>;
}

/** How many references the adapter remembers having issued: the most recent, so that a process that runs for months holds a bounded few. */
const REMEMBERED_REFERENCES = 10_000;

/**
 * The capture adapter of the text-message port: the `TextMessageSender` that reaches nobody, for a local run, CI and Staging by default
 * (`NOTIFICATION_SMS_ADAPTER=capture`; production refuses it, DEPLOYMENT_AND_ENVIRONMENTS.md §12.5). It records each message through its
 * sink and answers `ACCEPTED` with a reference that names the message and holds none of it (`capture:<deduplication identity>`).
 *
 * It behaves as a provider that took the message and delivered it at once: `status` answers `DELIVERED` for a reference this instance
 * issued (the most recent ten thousand) and `UNKNOWN` for any other, as a provider that does not know a reference would. A sink that
 * cannot be written is an `UNKNOWN` outcome, never a success and never a refusal: nothing is known about the message, and it is tried
 * again on its schedule. The failure is not carried: the sink's error may hold the folder, or the message.
 *
 * It does not judge the message: a destination or a text that Hubtel would refuse is captured all the same. It is an adapter, imported
 * only by the composition root.
 */
export class CaptureTextMessageSender implements TextMessageSender {
  readonly #sink: TextCaptureSink;
  readonly #clock: Pick<Clock, 'now'>;
  readonly #issued = new Set<string>();

  constructor(options: CaptureTextMessageSenderOptions) {
    this.#sink = options.sink;
    this.#clock = options.clock;
  }

  async send(message: TextMessage): Promise<DeliveryOutcome> {
    try {
      await this.#sink.record({
        dedupeId: message.dedupeId,
        destination: message.destination,
        text: message.text,
        at: this.#clock.now().toISOString(),
      });
    } catch {
      return { outcome: 'UNKNOWN' };
    }
    const reference = `capture:${message.dedupeId}`;
    this.#remember(reference);
    return { outcome: 'ACCEPTED', providerMessageRef: reference };
  }

  status(providerMessageRef: string): Promise<TextStatus> {
    return Promise.resolve<TextStatus>({
      state: this.#issued.has(providerMessageRef) ? 'DELIVERED' : 'UNKNOWN',
    });
  }

  #remember(reference: string): void {
    // Added last, so that a reference issued again is the newest and the oldest is the one that goes.
    this.#issued.delete(reference);
    this.#issued.add(reference);
    if (this.#issued.size > REMEMBERED_REFERENCES) {
      const oldest = this.#issued.values().next();
      if (oldest.done !== true) this.#issued.delete(oldest.value);
    }
  }
}

/** A deduplication identity is used as a file name, so it is nothing but letters, digits and hyphens. */
const SAFE_NAME = /^[A-Za-z0-9-]{16,128}$/;

export interface FileTextCaptureSinkOptions {
  /** Where to look for the checkout the folder must stay out of: the working directory and this application's own folder by default. */
  readonly startingPoints?: readonly string[];
  /** What the check that an existing folder is private reads of the file system: the real one by default. A test gives its own. */
  readonly privacyProbe?: PrivacyProbe;
}

/**
 * The sink of a local or staging run: one file per message, `<deduplication identity>.json`, in a folder the process owns alone. The
 * folder is judged by the rules of the credential capture (`outside-checkout.ts`) **when the sink is made**, before anything is written:
 * it must lie outside the checkout the process runs from, wherever the path leads, and a folder that already exists must be private to
 * its user where the file system has permission bits to say so. The folder is made private (mode 0700) and so is each file (0600) where
 * the file system has permission bits; on Windows Node applies none, and the folder belongs in the user's own profile. A file appears whole
 * or not at all (written under another name, then renamed), and a message captured again replaces the file with the same message.
 */
export class FileTextCaptureSink implements TextCaptureSink {
  readonly #directory: string;

  constructor(directory: string, options: FileTextCaptureSinkOptions = {}) {
    assertOutsideCheckout(
      directory,
      options.startingPoints ?? [process.cwd(), dirname(fileURLToPath(import.meta.url))],
    );
    assertPrivateDirectory(directory, options.privacyProbe);
    this.#directory = resolve(directory);
  }

  async record(entry: TextCaptureEntry): Promise<void> {
    if (!SAFE_NAME.test(entry.dedupeId)) {
      throw new TypeError('A captured text message is named by its deduplication identity.');
    }
    const file = join(this.#directory, `${entry.dedupeId}.json`);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
