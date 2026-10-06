import pino, { type DestinationStream, type Logger } from 'pino';

import type { AppConfig } from '../config/load-config.js';
import { redactValue, scrubText } from './redaction.js';
import { currentRequestContext } from './request-context.js';

export interface CreateLoggerOptions {
  readonly config: AppConfig;
  /** Defaults to stdout. Tests pass an in-memory stream so they can search every byte logged. */
  readonly destination?: DestinationStream;
}

/** The one logger. Every field of every line passes through central redaction before it is written. */
export function createLogger({ config, destination }: CreateLoggerOptions): Logger {
  return pino(
    {
      level: config.logLevel,
      base: { service: 'melarc-api', env: config.appEnv },
      timestamp: pino.stdTimeFunctions.isoTime,
      // formatters.log has already reduced every error to its safe form; pino's own err serializer would
      // re-process that and overwrite its type.
      serializers: { err: (value: unknown) => value },
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => redactValue(object) as Record<string, unknown>,
      },
      mixin: () => {
        const context = currentRequestContext();
        return context ? { request_id: context.requestId } : {};
      },
      hooks: {
        logMethod(args, method) {
          const [first, ...rest] = args as unknown[];
          // An Error as the first argument would have its raw message copied into `msg`.
          const prepared =
            first instanceof Error ? [{ err: first }, first.message, ...rest] : [first, ...rest];
          const scrubbed = prepared.map((arg) => (typeof arg === 'string' ? scrubText(arg) : arg));
          method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
    },
    destination,
  );
}
