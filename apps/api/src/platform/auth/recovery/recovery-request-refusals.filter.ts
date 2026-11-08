import {
  Catch,
  HttpException,
  Inject,
  Optional,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';

import { ApiException } from '../../http/api-exception.js';
import { sendFailure } from '../../http/all-exceptions.filter.js';
import { ErrorCode } from '../../http/error-codes.js';
import { LOGGER } from '../../platform.tokens.js';
import { METRICS, type Metrics } from '../ports/metrics.port.js';

/** The outcome a refused recovery request is counted under, or none for a failure that is not the caller's (an outage is not a refusal). */
function excludedOutcome(exception: unknown): 'RATE_LIMITED' | 'REJECTED' | undefined {
  if (exception instanceof ApiException && exception.code === ErrorCode.RateLimited)
    return 'RATE_LIMITED';
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return status >= 400 && status < 500 ? 'REJECTED' : undefined;
  }
  return undefined;
}

/**
 * The refusals of `requestCredentialRecovery` that write no audit event (audit.md section 5.4, `auth.recovery.requested`, cases 2 and 3):
 * one refused by the rate limit, and one refused before the operation runs (validation, the `Origin`). They are visible only as the
 * bounded counter `credential_recovery_requests_excluded_total`, labelled with the outcome alone. This filter is the route's: it counts the
 * refusal and hands the exception to the platform's one answer for a failure (`sendFailure`), so the answer is the one any route gives.
 *
 * A refusal of the transport, before any route is chosen (an oversized or unparsable body), never reaches a route's filter: it is counted in
 * the request's completion line, as every transport refusal is, and not here.
 */
@Catch()
export class RecoveryRequestRefusals implements ExceptionFilter {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    @Optional() @Inject(METRICS) private readonly metrics: Metrics | undefined,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const outcome = excludedOutcome(exception);
    if (outcome !== undefined) {
      this.metrics?.increment('credential_recovery_requests_excluded_total', { outcome });
    }
    sendFailure(host.switchToHttp().getResponse<Response>(), exception, this.logger);
  }
}
