import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Optional,
  Post,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ApiBody, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { OperationUnavailableError } from '../../authorization/operation-unavailable-error.js';
import type { AppConfig } from '../../config/load-config.js';
import { declareAnswerPrincipal } from '../../contract/answer-context.js';
import { ContractOperation } from '../../contract/contract-operation.js';
import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import { DescribeErrors } from '../../openapi/described-errors.js';
import { DescribeCookies } from '../../openapi/operation-statements.js';
import { APP_CONFIG } from '../../platform.tokens.js';
import { Anonymous, BROWSER_ON_BOTH_SURFACES } from '../../routes/access-declaration.js';
import { issueVendorDeviceCookie } from '../cookies/cookie-writer.js';
import type { RecoveryCompletionService } from './recovery-completion.service.js';
import { RECOVERY_COMPLETION_LIMIT, RECOVERY_REQUEST_LIMIT } from './recovery-request-limit.js';
import { RecoveryRequestRefusals } from './recovery-request-refusals.filter.js';
import type { RecoveryRequestService } from './recovery-request.service.js';
import { RECOVERY_COMPLETION_SERVICE, RECOVERY_REQUEST_SERVICE } from './recovery-providers.js';
import {
  RECOVERY_COMPLETE_BODY,
  RECOVERY_COMPLETED_HEADERS,
  RECOVERY_REQUEST_BODY,
} from './recovery-schemas.js';
import type { RecoveryPrincipalType } from './recovery-vocabulary.js';

interface RecoveryRequestBody {
  readonly principal_type: RecoveryPrincipalType;
  readonly identifier: string;
}

interface RecoveryCompleteBody {
  readonly token: string;
  readonly new_credential: string;
}

/**
 * The self-service recovery operations (S0.50, S0.51), one route of each surface's pages: a staff member's from the Ops Portal, a vendor's
 * from the Vendor PWA (`BROWSER_ON_BOTH_SURFACES`, the `Origin` held to one of the two configured origins before the body is examined).
 *
 * **The origin is the requesting surface's** (openapi.yaml: "the `Origin` must exactly match a configured allowlisted origin of the
 * requesting surface"): a staff recovery is asked from the Ops origin and a vendor's from the Vendor origin, and the other pairing is the
 * same `403 CSRF_VALIDATION_FAILED` as any origin refusal. That a principal type and an origin disagree says nothing about any principal.
 */
@Controller('auth/recovery')
export class CredentialRecoveryController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional()
    @Inject(RECOVERY_REQUEST_SERVICE)
    private readonly requests: RecoveryRequestService | undefined,
    @Optional()
    @Inject(RECOVERY_COMPLETION_SERVICE)
    private readonly completions: RecoveryCompletionService | undefined,
  ) {}

  @Post('request')
  @HttpCode(202)
  @ContractOperation('requestCredentialRecovery')
  @ApiBody({ schema: RECOVERY_REQUEST_BODY })
  @ApiResponse({
    status: 202,
    description:
      'Accepted. Identical for known and unknown identifiers; no recovery material is returned.',
  })
  @DescribeErrors(ErrorCode.CsrfValidationFailed, ErrorCode.RateLimited, ErrorCode.ValidationFailed)
  @Anonymous(RECOVERY_REQUEST_LIMIT, BROWSER_ON_BOTH_SURFACES)
  @UseFilters(RecoveryRequestRefusals)
  async request(@Body() body: RecoveryRequestBody, @Req() request: Request): Promise<void> {
    if (this.requests === undefined)
      throw new OperationUnavailableError('requestCredentialRecovery');
    this.#holdToSurface(request, body.principal_type);
    await this.requests.request({
      principalType: body.principal_type,
      identifier: body.identifier,
    });
  }

  /**
   * `POST /auth/recovery/complete` (S0.51a). The page of the link's surface posts the token it read from the fragment, with the new
   * credential; the answer is `204` with no body, no session cookie, and for a vendor the browser's new device credential. Every unusable
   * link is the one `422 RECOVERY_TOKEN_INVALID`.
   */
  @Post('complete')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @ContractOperation('completeCredentialRecovery')
  @ApiBody({ schema: RECOVERY_COMPLETE_BODY })
  @ApiResponse({
    status: 204,
    description: 'Credential set; all sessions terminated.',
    headers: RECOVERY_COMPLETED_HEADERS,
  })
  @DescribeCookies(204, ['melarc_vendor_device'], { when: { principalType: 'VENDOR' } })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.RateLimited,
    ErrorCode.RecoveryTokenInvalid,
    ErrorCode.ValidationFailed,
  )
  @Anonymous(RECOVERY_COMPLETION_LIMIT, BROWSER_ON_BOTH_SURFACES)
  async complete(
    @Body() body: RecoveryCompleteBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    if (this.completions === undefined)
      throw new OperationUnavailableError('completeCredentialRecovery');
    const completed = await this.completions.complete({
      token: body.token,
      newCredential: body.new_credential,
      surfaceOf: request.headers.origin === this.config.origins.vendor ? 'VENDOR' : 'STAFF',
    });
    declareAnswerPrincipal(request, completed.principalType);
    if (completed.principalType === 'VENDOR')
      issueVendorDeviceCookie(response, completed.deviceCredential);
  }

  /** The origin of the surface whose principal asks: Ops for staff, Vendor for vendors. The guard has already admitted one of the two. */
  #holdToSurface(request: Request, type: RecoveryPrincipalType): void {
    const expected = type === 'STAFF' ? this.config.origins.ops : this.config.origins.vendor;
    if (request.headers.origin !== expected) {
      throw new ApiException(ErrorCode.CsrfValidationFailed, 403, 'CSRF validation failed');
    }
  }
}
