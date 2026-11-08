import { inspect } from 'node:util';

/**
 * A secret of a run held where a log, a failed assertion or a report cannot show it: a setup secret from a custody bundle, a link a
 * captured message carries. It prints as `[REDACTED]` however it is turned into text (template, `String`, JSON, `inspect`, an
 * assertion's diff), and only `reveal()` returns the value. The same idea as the API's `Secret` (`config/secret.ts`), kept here
 * because the harness depends on nothing inside the API.
 *
 * It protects against an accident, not against a spec that reveals the value and prints it. A secret spec never does
 * (`harness/evidence-policy.ts`), and a value put on a page goes through `page.goto`, `fill` or `evaluate`, which `reveal()` feeds.
 */
export class SecretText {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [inspect.custom](): string {
    return '[REDACTED]';
  }
}
