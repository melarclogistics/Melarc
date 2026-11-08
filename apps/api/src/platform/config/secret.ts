import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';

/**
 * A value that must never reach a log line, a serialised configuration or a debugger dump: key material, a caller secret for
 * a private service. It prints as `[REDACTED]` through every ordinary route (`String`, `JSON.stringify`, `util.inspect`,
 * `util.format`, a spread, `structuredClone`), and holds the value in a private field, so there is no own property to list.
 * The only way out is `reveal()`, which a reader of a secret calls on purpose and which a review can search for.
 *
 * This is the structural half of redaction. The logger's key-name rules are the second half (`logging/redaction.ts`).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}
