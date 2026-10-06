import type { Logger } from 'pino';

/** The parts of the process the handlers use, so a test can stand in for it. */
export interface FaultTarget {
  on(event: string, listener: (value: unknown) => void): unknown;
  exit(code: number): unknown;
}

/**
 * Makes a crash go through the redacting logger instead of Node's default output, which prints the
 * error with every property attached to it (the request, headers, a connection string). The fatal
 * line is written first and the process then exits non-zero, because after an uncaught exception the
 * state of the process cannot be trusted.
 */
export function installFaultHandlers(logger: Logger, target: FaultTarget): void {
  target.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    target.exit(1);
  });
  target.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    target.exit(1);
  });
}
