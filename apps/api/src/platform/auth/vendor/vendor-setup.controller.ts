import { Body, Controller, Header, HttpCode, Inject, Optional, Post, Res } from '@nestjs/common';
import { ApiBody, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { OperationUnavailableError } from '../../authorization/operation-unavailable-error.js';
import { ContractOperation } from '../../contract/contract-operation.js';
import { ErrorCode } from '../../http/error-codes.js';
import { DescribeErrors } from '../../openapi/described-errors.js';
import { DescribeCookies } from '../../openapi/operation-statements.js';
import { Anonymous, type AnonymousClient } from '../../routes/access-declaration.js';
import { issueVendorDeviceCookie } from '../cookies/cookie-writer.js';
import { setupTokenLimit } from '../staff/staff-setup-limit.js';
import type { RegisteredDeviceRecord } from './registered-device-store.js';
import { VENDOR_SETUP_SERVICE } from './vendor-setup-providers.js';
import {
  DEVICE_ISSUED_HEADERS,
  REGISTERED_DEVICE_SCHEMA,
  VENDOR_CREDENTIAL_SETUP_BODY,
} from './vendor-setup-schemas.js';
import type { VendorSetupService } from './vendor-setup.service.js';

/** A page of the Vendor PWA: the vendor's credential operations serve vendors, so only the Vendor origin may call them (`403` otherwise). */
export const VENDOR_BROWSER: AnonymousClient = { kind: 'browser', surfaces: ['VENDOR_PWA'] };

interface VendorCredentialSetupBody {
  readonly setup_token: string;
  readonly secret: string;
}

/**
 * `POST /auth/vendor/setup/credential` (S0.47b, `completeVendorCredentialSetup`): the vendor sets its shared secret and registers this
 * browser with its `VENDOR_CREDENTIAL_SETUP` grant. A browser pre-session mutation of the Vendor PWA (`Origin` held to the Vendor origin
 * before the token is examined), limited in the `rate_limit_recovery` bucket under the purpose-qualified digest of the token, answered
 * `no-store`. **The browser's credential travels in the `melarc_vendor_device` cookie, a real `Set-Cookie` field line, and never in the
 * body**; the body is the registered browser, which holds neither the credential nor its hash. No session is issued. Composed without
 * what the service needs, it fails closed (`503`).
 */
@Controller('auth/vendor/setup')
export class VendorSetupController {
  constructor(
    @Optional()
    @Inject(VENDOR_SETUP_SERVICE)
    private readonly service: VendorSetupService | undefined,
  ) {}

  @Post('credential')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ContractOperation('completeVendorCredentialSetup')
  @ApiBody({ schema: VENDOR_CREDENTIAL_SETUP_BODY })
  @ApiResponse({ status: 200, schema: REGISTERED_DEVICE_SCHEMA, headers: DEVICE_ISSUED_HEADERS })
  @DescribeCookies(200, ['melarc_vendor_device'])
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.RateLimited,
    ErrorCode.SetupGrantInvalid,
    ErrorCode.ValidationFailed,
  )
  @Anonymous(setupTokenLimit('VENDOR_CREDENTIAL_SETUP'), VENDOR_BROWSER)
  async completeCredentialSetup(
    @Body() body: VendorCredentialSetupBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RegisteredDeviceRecord> {
    if (this.service === undefined)
      throw new OperationUnavailableError('completeVendorCredentialSetup');
    const registered = await this.service.completeCredentialSetup({
      setupToken: body.setup_token,
      secret: body.secret,
    });
    issueVendorDeviceCookie(response, registered.credential);
    return registered.device;
  }
}
