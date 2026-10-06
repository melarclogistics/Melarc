import type { LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Sends Nest's own framework logs through the same redacting logger as everything else. */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  private write(level: Level, message: unknown, params: unknown[]): void {
    // Nest appends its context name last and, for errors, a stack trace before it.
    const strings = params.filter((param): param is string => typeof param === 'string');
    const detail: Record<string, unknown> = {};
    const context = strings.at(-1);
    if (context !== undefined) detail.context = context;
    if (level === 'error' && strings.length > 1) detail.trace = strings[0];

    if (message instanceof Error) {
      this.logger[level]({ ...detail, err: message }, message.message);
    } else if (typeof message === 'string') {
      this.logger[level](detail, message);
    } else {
      this.logger[level]({ ...detail, detail: message }, 'framework log');
    }
  }
}
