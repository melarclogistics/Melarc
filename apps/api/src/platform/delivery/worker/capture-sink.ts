import { randomBytes } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DeliveryChannel } from '../../auth/ports/delivery-queue.port.js';

/**
 * What the capture adapter keeps of a message: everything a developer needs to follow the link and nothing the provider would
 * add. **It holds the destination and the link, which carries the raw token, in clear, by design** (SECURITY_DESIGN.md §13.9a:
 * "in non-production only, the capture adapter's restricted sink"). That is why the sink is a place outside the repository, private
 * to its owner, and why production refuses the capture adapter altogether.
 */
export interface CapturedMessage {
  readonly capturedAt: string;
  readonly dedupeId: string;
  readonly kind: string;
  readonly channel: DeliveryChannel;
  readonly destination: string;
  readonly link: string;
}

/** Where captured messages go. One message per deduplication identity: the same identity stored again leaves one message. */
export interface CaptureSink {
  write(message: CapturedMessage): Promise<void>;
  has(dedupeId: string): Promise<boolean>;
}

/** A deduplication identity is used as a file name, so it is nothing but letters, digits and hyphens. */
const SAFE_NAME = /^[A-Za-z0-9-]{16,128}$/;

/** The sink of the tests that do not need a disk: the messages in a map, in the order they were first captured. */
export class MemoryCaptureSink implements CaptureSink {
  readonly messages = new Map<string, CapturedMessage>();

  write(message: CapturedMessage): Promise<void> {
    this.messages.set(message.dedupeId, message);
    return Promise.resolve();
  }

  has(dedupeId: string): Promise<boolean> {
    return Promise.resolve(this.messages.has(dedupeId));
  }
}

/**
 * The sink of a local or staging run: one file per message, `<dedupe id>.json`, in a directory the process owns alone. The
 * directory is made private (mode 0700) and so is each file (0600) where the file system has permission bits; on Windows Node
 * applies none, so the directory belongs in the user's own profile, as the settings files do (`scripts/setup-env.ts`). A file
 * appears whole or not at all (written under another name, then renamed), so a reader never sees half a message, and a retried
 * send replaces the file with the same message.
 *
 * It is never inside the repository: the worker refuses to start with a directory in the checkout (`outside-checkout.ts`), so the
 * source package, which is built from the checkout, cannot hold a captured message.
 */
export class FileCaptureSink implements CaptureSink {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async write(message: CapturedMessage): Promise<void> {
    const file = this.#fileFor(message.dedupeId);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(temporary, `${JSON.stringify(message, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async has(dedupeId: string): Promise<boolean> {
    try {
      await access(this.#fileFor(dedupeId));
      return true;
    } catch (error) {
      if (error instanceof TypeError) throw error;
      return false;
    }
  }

  #fileFor(dedupeId: string): string {
    if (!SAFE_NAME.test(dedupeId)) {
      throw new TypeError('A captured message is named by its deduplication identity.');
    }
    return join(this.#directory, `${dedupeId}.json`);
  }
}
