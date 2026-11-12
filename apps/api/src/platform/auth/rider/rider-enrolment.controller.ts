import { Body, Controller, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { ApiBody, ApiResponse } from '@nestjs/swagger';

import { ContractOperation } from '../../contract/contract-operation.js';
import { ErrorCode } from '../../http/error-codes.js';
import { DescribeErrors, RETRY_AFTER_HEADERS } from '../../openapi/described-errors.js';
import { DescribeServers, RIDER_SERVERS } from '../../openapi/operation-statements.js';
import { Anonymous } from '../../routes/access-declaration.js';
import { StaffSetupUnavailableError } from '../staff/staff-setup-errors.js';
import { setupTokenLimit } from '../staff/staff-setup-limit.js';
import { REGISTERED_DEVICE_SCHEMA } from '../vendor/vendor-setup-schemas.js';
import type { RiderDeviceRecord } from './rider-device-store.js';
import { RIDER_ENROLMENT_SERVICE } from './rider-enrolment-providers.js';
import { RIDER_NATIVE_CLIENT } from './rider-sign-in-limit.js';
import { RIDER_ENROLMENT_BODY } from './rider-enrolment-schemas.js';
import type { RiderEnrolmentService } from './rider-enrolment.service.js';

interface RiderEnrolmentBody {
  readonly setup_token: string;
  readonly public_key: string;
  readonly pin: string;
  readonly key_attestation: { readonly certificate_chain: readonly string[] };
}

/**
 * `completeRiderDeviceEnrolment` (S0.57): the rider's handset completes the binding the officer started, with the grant of the QR code, the
 * public half of the key it made, the PIN its rider chose and the attestation of the key. It is a pre-session operation of the native Rider
 * client (`POST /auth/rider/device/enrol`, reachable at the Rider host as well as same-origin), limited in the `rate_limit_recovery` bucket under
 * the purpose-qualified digest of the token it presents, and it **issues no session and sets no cookie**.
 *
 * The body is validated against the contract before the handler runs, so what arrives has the contract's shape; the service judges the rest.
 * Where the application is composed without what the service needs (a database, local key material, the verifier), the operation fails closed
 * (`503`), and nothing answers as if a device had been registered.
 */
@Controller('auth/rider/device')
export class RiderEnrolmentController {
  constructor(
    @Optional()
    @Inject(RIDER_ENROLMENT_SERVICE)
    private readonly service: RiderEnrolmentService | undefined,
  ) {}

  @Post('enrol')
  @HttpCode(200)
  @ContractOperation('completeRiderDeviceEnrolment')
  @ApiBody({ schema: RIDER_ENROLMENT_BODY })
  @ApiResponse({ status: 200, schema: REGISTERED_DEVICE_SCHEMA })
  // The error response with a header of its own here: the wait before the handset tries again (the grant is still good).
  @ApiResponse({ status: 503, headers: RETRY_AFTER_HEADERS })
  @DescribeErrors(
    ErrorCode.DeviceIntegrityFailed,
    ErrorCode.DeviceSecurityUnsupported,
    ErrorCode.RateLimited,
    ErrorCode.SetupGrantInvalid,
    ErrorCode.TrustDataUnavailable,
    ErrorCode.ValidationFailed,
  )
  @DescribeServers(RIDER_SERVERS)
  @Anonymous(setupTokenLimit('RIDER_DEVICE_ENROLMENT'), RIDER_NATIVE_CLIENT)
  async completeRiderDeviceEnrolment(@Body() body: RiderEnrolmentBody): Promise<RiderDeviceRecord> {
    if (this.service === undefined) throw new StaffSetupUnavailableError();
    return this.service.complete({
      setupToken: body.setup_token,
      publicKey: body.public_key,
      pin: body.pin,
      certificateChain: body.key_attestation.certificate_chain,
    });
  }
}
