import { Body, Controller, Header, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { ApiBody, ApiResponse } from '@nestjs/swagger';

import { OperationUnavailableError } from '../../authorization/operation-unavailable-error.js';
import { ContractOperation } from '../../contract/contract-operation.js';
import { ErrorCode } from '../../http/error-codes.js';
import { DescribeErrors } from '../../openapi/described-errors.js';
import { DescribeServers, RIDER_SERVERS } from '../../openapi/operation-statements.js';
import { Anonymous } from '../../routes/access-declaration.js';
import type { ClientRootSignal } from '../ports/session-store.port.js';
import { NO_STORE_HEADERS } from '../staff/staff-setup-schemas.js';
import { RIDER_CHALLENGE_SERVICE, RIDER_SIGN_IN_SERVICE } from './rider-sign-in-providers.js';
import { RIDER_NATIVE_CLIENT, RIDER_PHONE_LIMIT } from './rider-sign-in-limit.js';
import {
  RIDER_CHALLENGE_REQUEST_BODY,
  RIDER_CHALLENGE_SCHEMA,
  RIDER_SESSION_ISSUED_SCHEMA,
  RIDER_SIGN_IN_BODY,
} from './rider-sign-in-schemas.js';
import type { RiderChallengeService } from './rider-challenge.service.js';
import type { RiderSignInService } from './rider-sign-in.service.js';

interface RiderChallengeRequestBody {
  readonly phone: string;
}

interface RiderSignInBody {
  readonly phone: string;
  readonly pin: string;
  readonly challenge: string;
  readonly device_signature: string;
  readonly client_root_signal: ClientRootSignal;
}

/**
 * The rider's two pre-session operations (S0.59): `POST /auth/rider/sign-in/challenge` (`requestRiderSignInChallenge`) and
 * `POST /auth/rider/sign-in` (`riderSignIn`). Both are operations of the native Rider client, reachable at the Rider host as well as same-origin,
 * that carry no `Origin` and no cookie, and both draw on one bucket keyed on the canonical number they carry (`rate_limit_rider_challenge`),
 * so a number that belongs to nobody is limited exactly as a rider's.
 *
 * The sign-in answers the opaque bearer credential once (`RiderSessionIssued`, the one response of the contract that returns a raw session
 * credential), `no-store`, and sets no cookie: a Bearer credential is not attached by a browser, so a rider request carries no synchronizer
 * token. Composed without what a service needs (a database, local key material), an operation fails closed (`503`).
 */
@Controller('auth/rider/sign-in')
export class RiderSignInController {
  constructor(
    @Optional()
    @Inject(RIDER_CHALLENGE_SERVICE)
    private readonly challenges: RiderChallengeService | undefined,
    @Optional()
    @Inject(RIDER_SIGN_IN_SERVICE)
    private readonly signIns: RiderSignInService | undefined,
  ) {}

  @Post('challenge')
  @HttpCode(200)
  @ContractOperation('requestRiderSignInChallenge')
  @ApiBody({ schema: RIDER_CHALLENGE_REQUEST_BODY })
  @ApiResponse({ status: 200, schema: RIDER_CHALLENGE_SCHEMA })
  @DescribeErrors(ErrorCode.RateLimited, ErrorCode.ValidationFailed)
  @DescribeServers(RIDER_SERVERS)
  @Anonymous(RIDER_PHONE_LIMIT, RIDER_NATIVE_CLIENT)
  async requestChallenge(
    @Body() body: RiderChallengeRequestBody,
  ): Promise<{ challenge: string; expires_at: string }> {
    if (this.challenges === undefined) {
      throw new OperationUnavailableError('requestRiderSignInChallenge');
    }
    const issued = await this.challenges.request(body.phone);
    return { challenge: issued.challenge, expires_at: issued.expiresAt.toISOString() };
  }

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ContractOperation('riderSignIn')
  @ApiBody({ schema: RIDER_SIGN_IN_BODY })
  @ApiResponse({ status: 200, schema: RIDER_SESSION_ISSUED_SCHEMA, headers: NO_STORE_HEADERS })
  @DescribeErrors(
    ErrorCode.ChallengeExpired,
    ErrorCode.ChallengeUnusable,
    ErrorCode.CredentialLocked,
    ErrorCode.DeviceNotEnrolled,
    ErrorCode.DeviceProofInvalid,
    ErrorCode.InvalidCredentials,
    ErrorCode.RateLimited,
    ErrorCode.ValidationFailed,
  )
  @DescribeServers(RIDER_SERVERS)
  @Anonymous(RIDER_PHONE_LIMIT, RIDER_NATIVE_CLIENT)
  async signIn(@Body() body: RiderSignInBody): Promise<{
    session: unknown;
    access_token: string;
    token_type: 'Bearer';
  }> {
    if (this.signIns === undefined) throw new OperationUnavailableError('riderSignIn');
    const outcome = await this.signIns.signIn({
      phone: body.phone,
      pin: body.pin,
      challenge: body.challenge,
      deviceSignature: body.device_signature,
      clientRootSignal: body.client_root_signal,
    });
    return { session: outcome.view, access_token: outcome.session.token, token_type: 'Bearer' };
  }
}
