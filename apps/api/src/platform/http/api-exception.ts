import { HttpException } from '@nestjs/common';

import type { ErrorCode } from './error-codes.js';

/**
 * A refusal that carries a catalogue code. Its `message` and `details` are rendered to the client
 * as written, so they must be fixed text or values the platform computed, never request input.
 */
export class ApiException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    status: number,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super({ code, message }, status);
  }
}
