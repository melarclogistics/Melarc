import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Authorized } from '../../../authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../../../authorization/authorized-request.js';
import { OperationUnavailableError } from '../../../authorization/operation-unavailable-error.js';
import { ContractOperation } from '../../../contract/contract-operation.js';
import { ErrorCode } from '../../../http/error-codes.js';
import { fingerprintOfRequest } from '../../../http/request-fingerprint-input.js';
import { currentRequestContext } from '../../../logging/request-context.js';
import { DescribeErrors } from '../../../openapi/described-errors.js';
import { DescribeCookies, DescribeSecurity } from '../../../openapi/operation-statements.js';
import { Anonymous, Self } from '../../../routes/access-declaration.js';
import { issueVendorDeviceCookie } from '../../cookies/cookie-writer.js';
import { setupTokenLimit } from '../../staff/staff-setup-limit.js';
import type { RegisteredDeviceRecord } from '../registered-device-store.js';
import { VENDOR_SETUP_SERVICE } from '../vendor-setup-providers.js';
import {
  ADDITIONAL_DEVICE_ENROLMENT_BODY,
  DEVICE_ISSUED_HEADERS,
  REGISTERED_DEVICE_SCHEMA,
} from '../vendor-setup-schemas.js';
import { VENDOR_BROWSER } from '../vendor-setup.controller.js';
import type { VendorSetupService } from '../vendor-setup.service.js';
import { VENDOR_DEVICES_SERVICE } from './vendor-devices-providers.js';
import type { VendorDevicesService } from './vendor-devices.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** The one header of a read of the device set and of a revocation: the version `revokeVendorDevice` takes back as `If-Match`. */
const ETAG_HEADERS = {
  ETag: {
    description: 'Opaque version of the device set. Send back as `If-Match`.',
    schema: { type: 'string' },
  },
} as unknown as Record<string, never>;

const VENDOR_SELF = { surfaces: ['VENDOR_PWA'], activity: 'qualifying' } as const;

/**
 * The vendor's own browsers (S0.49): the grant that registers another one, its completion from the new browser, the list, and the
 * revocation of one. The three of a live session are `self` operations of the Vendor PWA (a vendor acting on its own account); the
 * completion is a browser pre-session mutation of the Vendor PWA whose grant is its whole authority, and sets the new browser's
 * credential in a real `Set-Cookie`, with no session. Composed without what they need, they fail closed (`503`).
 */
@Controller('auth/vendor')
export class VendorDevicesController {
  constructor(
    @Optional()
    @Inject(VENDOR_DEVICES_SERVICE)
    private readonly devices: VendorDevicesService | undefined,
    @Optional()
    @Inject(VENDOR_SETUP_SERVICE)
    private readonly setup: VendorSetupService | undefined,
  ) {}

  @Post('device/grant')
  @HttpCode(202)
  @ContractOperation('requestAdditionalDeviceGrant')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', maxLength: 128 },
  })
  @ApiResponse({
    status: 202,
    description:
      'Accepted. The grant was issued and its message queued; no grant material is returned.',
  })
  @DescribeSecurity(['browserSession', 'csrfToken'])
  @DescribeErrors(
    ErrorCode.CredentialDeliveryFailed,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.RateLimited,
    ErrorCode.SessionInvalid,
  )
  @Self(VENDOR_SELF)
  async requestGrant(
    @Authorized() authorized: AuthorizedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<void> {
    if (this.devices === undefined)
      throw new OperationUnavailableError('requestAdditionalDeviceGrant');
    await this.devices.requestGrant(authorized, {
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'requestAdditionalDeviceGrant'),
    });
  }

  @Post('device/enrol')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ContractOperation('completeAdditionalDeviceEnrolment')
  @ApiBody({ schema: ADDITIONAL_DEVICE_ENROLMENT_BODY })
  @ApiResponse({ status: 200, schema: REGISTERED_DEVICE_SCHEMA, headers: DEVICE_ISSUED_HEADERS })
  @DescribeCookies(200, ['melarc_vendor_device'])
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.RateLimited,
    ErrorCode.SetupGrantInvalid,
    ErrorCode.ValidationFailed,
  )
  @Anonymous(setupTokenLimit('VENDOR_DEVICE_ENROLMENT'), VENDOR_BROWSER)
  async enrol(
    @Body() body: { readonly setup_token: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<RegisteredDeviceRecord> {
    if (this.setup === undefined)
      throw new OperationUnavailableError('completeAdditionalDeviceEnrolment');
    const registered = await this.setup.completeAdditionalDeviceEnrolment({
      setupToken: body.setup_token,
    });
    issueVendorDeviceCookie(response, registered.credential);
    return registered.device;
  }

  @Get('devices')
  @ContractOperation('listVendorDevices')
  @ApiResponse({
    status: 200,
    schema: { type: 'array', items: REGISTERED_DEVICE_SCHEMA },
    headers: ETAG_HEADERS,
  })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid)
  @Self(VENDOR_SELF)
  async list(
    @Authorized() authorized: AuthorizedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<readonly RegisteredDeviceRecord[]> {
    if (this.devices === undefined) throw new OperationUnavailableError('listVendorDevices');
    const set = await this.devices.list(authorized, correlation());
    response.setHeader('ETag', set.etag);
    return set.devices;
  }

  @Post('devices/:id/revoke')
  @HttpCode(200)
  @ContractOperation('revokeVendorDevice')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: REGISTERED_DEVICE_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
  )
  @Self({ ...VENDOR_SELF, record: { entity: 'registered_device', param: 'id' } })
  async revoke(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RegisteredDeviceRecord> {
    if (this.devices === undefined) throw new OperationUnavailableError('revokeVendorDevice');
    const revoked = await this.devices.revoke(authorized, id, ifMatch);
    response.setHeader('ETag', revoked.etag);
    return revoked.device;
  }
}
