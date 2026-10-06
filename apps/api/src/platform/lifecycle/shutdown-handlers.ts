import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Logger } from 'pino';

import { gracefulShutdown, type ShutdownOutcome } from './graceful-shutdown.js';

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export type StopSignal = (typeof STOP_SIGNALS)[number];

/** The parts of the process the handlers use, so a test can stand in for it. */
export interface ShutdownTarget {
  on(signal: StopSignal, listener: () => void): unknown;
  setExitCode(code: number): void;
  /** Ends the process at once, whatever is still running or open. */
  exit(code: number): unknown;
}

export interface ShutdownHandlerOptions {
  readonly logger: Logger;
  readonly target: ShutdownTarget;
  /** Runs the shutdown. It settles within its own budget, so nothing here waits for it for ever. */
  readonly shutdown: () => Promise<ShutdownOutcome>;
}

/**
 * Turns a stop signal into one shutdown and an exit that matches how it went.
 *
 * A clean shutdown only sets the exit code and lets the event loop drain, so every buffer is flushed
 * and every handle closed by its owner. After a forced shutdown that cannot be relied on: an exit code
 * does not stop a handle that is still open, and a stalled resource may be holding one. So a forced
 * shutdown logs what it could not confirm, then ends the process at once with exit code 1.
 */
export function installShutdownHandlers({
  logger,
  target,
  shutdown,
}: ShutdownHandlerOptions): void {
  const endForced = (): void => {
    target.setExitCode(1);
    logger.error({ exit_code: 1 }, 'exiting now');
    target.exit(1);
  };

  let stopping = false;
  for (const signal of STOP_SIGNALS) {
    target.on(signal, () => {
      if (stopping) return;
      stopping = true;
      logger.info({ signal }, 'signal received');
      shutdown().then(
        (outcome) => {
          if (outcome === 'clean') target.setExitCode(0);
          else endForced();
        },
        (error: unknown) => {
          logger.fatal({ err: error }, 'shutdown crashed');
          endForced();
        },
      );
    });
  }
}

/**
 * The shutdown handlers of the real process. The entry point installs exactly this, and so do the
 * process tests, which is why it is here and not inline in main.ts.
 */
export function installProcessShutdown(
  app: NestExpressApplication,
  options: {
    readonly logger: Logger;
    readonly shutdown: { readonly timeoutMs: number; readonly drainDelayMs: number };
  },
): void {
  installShutdownHandlers({
    logger: options.logger,
    target: {
      on: (signal, listener) => process.on(signal, listener),
      setExitCode: (code) => {
        process.exitCode = code;
      },
      exit: (code) => process.exit(code),
    },
    shutdown: () => gracefulShutdown(app, { ...options.shutdown, logger: options.logger }),
  });
}
