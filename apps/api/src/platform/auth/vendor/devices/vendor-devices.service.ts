import type { AuthorizedRequest } from '../../../authorization/authorized-request.js';
import type { OperationRunner } from '../../../authorization/operation-runner.js';
import { DeliveryNotQueueableError } from '../../../delivery/delivery-errors.js';
import { ApiException } from '../../../http/api-exception.js';
import { ErrorCode } from '../../../http/error-codes.js';
import { isIdempotencyKey } from '../../../idempotency/idempotency-scope.js';
import { LimiterUnavailableError } from '../../../limiter/limiter-errors.js';
import type { AuditWriter } from '../../ports/audit-writer.port.js';
import type { IdempotencyStore } from '../../ports/idempotency-store.port.js';
import type { IdentityDirectory, PrincipalRef } from '../../ports/identity-directory.port.js';
import type { RateLimiter } from '../../ports/rate-limiter.port.js';
import type { SessionStore } from '../../ports/session-store.port.js';
import type { TransactionHandle } from '../../ports/unit-of-work.port.js';
import type { IssuedGrant, SetupGrantStore } from '../../setup-grants/setup-grant-store.js';
import { authenticationContext } from '../../staff/authentication-context.js';
import type { RegisteredDeviceRecord, RegisteredDeviceStore } from '../registered-device-store.js';
import { deviceSetEtagMatches, deviceSetEtagOf } from './device-set-etag.js';

const OPERATION_GRANT = 'requestAdditionalDeviceGrant';
/** The namespace of the recovery bucket's key for this operation: the authenticated account, never a value the request presents. */
const GRANT_LIMIT_NAMESPACE = 'melarc.vendor-device-grant.v1';

const deliveryFailed = (): ApiException =>
  ApiException.of(
    ErrorCode.CredentialDeliveryFailed,
    'The browser grant could not be queued for delivery',
  );
const noSession = (): ApiException =>
  ApiException.of(ErrorCode.SessionInvalid, 'No usable session');
const stateConflict = (message: string): ApiException =>
  ApiException.of(ErrorCode.StateConflict, message);

export interface VendorDevicesOptions {
  readonly runner: Pick<OperationRunner, 'read' | 'actAsAuthentication'>;
  readonly directory: Pick<IdentityDirectory, 'lockIdentity' | 'registeredChannel'>;
  readonly grants: Pick<SetupGrantStore, 'issue'>;
  readonly devices: Pick<RegisteredDeviceStore, 'listFor' | 'revoke'>;
  readonly sessions: Pick<SessionStore, 'terminate'>;
  readonly idempotency: IdempotencyStore;
  /** The authoritative limiter; none composed fails the grant closed, as a route that names a bucket does. */
  readonly limiter: Pick<RateLimiter, 'admit'> | undefined;
  readonly audit: AuditWriter;
  /** The Vendor origin's link for an additional browser, with the token in the fragment (`linkTemplates`). */
  readonly deviceLink: (token: string) => string;
}

export interface DeviceSet {
  readonly devices: readonly RegisteredDeviceRecord[];
  readonly etag: string;
}

/**
 * The vendor's own browsers (S0.49; vendor-authentication.md sections 5.5 and 12; `AC-SLICE-000-45`, `-100`), from a live session.
 *
 * - **`requestAdditionalDeviceGrant`** issues a single-use `VENDOR_DEVICE_ENROLMENT` grant at the ordinary lifetime and queues its message to
 *   the credential's delivery channel, with the account identifier, **resolved from the account and never from the request**. It rotates no
 *   secret and ends no session. It is limited in `rate_limit_recovery` **keyed on the authenticated account** (never on a grant that does
 *   not exist yet), asked with no transaction open, and it takes an `Idempotency-Key`: a retry with the same key and request is answered as
 *   the first was and issues nothing; another request under the key is `IDEMPOTENCY_KEY_CONFLICT`.
 * - **`listVendorDevices`** reads every browser the account has held, `REVOKED` and `REPLACED` included, in the vendor's own context, with
 *   the version of the set as its `ETag`.
 * - **`revokeVendorDevice`** ends one browser as `REVOKED`, with the version the vendor read: a stale one, the browser the session is using
 *   (signing out is what `signOut` is for) and a browser already ended are `STATE_CONFLICT`; another vendor's is `NOT_FOUND` (the guard,
 *   before this runs). Any live session bound to it ends with `DEVICE_REVOKED`; the secret and every other browser are untouched.
 *
 * The two acts that change something run under the authentication capability holding the session's policy locks (`actAsAuthentication`:
 * the registry gives a Vendor no write on the grant, the message or the browser) and lock the account first, the lock the sign-in and the
 * recovery take; their events name the account as the actor, never a person.
 */
export class VendorDevicesService {
  readonly #options: VendorDevicesOptions;

  constructor(options: VendorDevicesOptions) {
    this.#options = options;
  }

  async requestGrant(
    authorized: AuthorizedRequest,
    request: { readonly idempotencyKey: string | undefined; readonly fingerprint: string },
  ): Promise<void> {
    const { runner, limiter } = this.#options;
    const key = request.idempotencyKey;
    if (!isIdempotencyKey(key)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const ref: PrincipalRef = { type: 'VENDOR', id: authorized.session.principalId };
    // The limit first, with no transaction open, keyed on the account the session authenticated: every request counts, a replay included.
    if (limiter === undefined) throw new LimiterUnavailableError();
    const decision = await limiter.admit(
      'rate_limit_recovery',
      `${GRANT_LIMIT_NAMESPACE}\u0000${ref.id}`,
    );
    if (!decision.allowed) throw ApiException.of(ErrorCode.RateLimited, 'Too many requests');

    await runner.actAsAuthentication(authorized, authenticationContext(), async (handle) => {
      const { idempotency, directory } = this.#options;
      const scope = {
        principalType: 'VENDOR',
        principalId: ref.id,
        operationId: OPERATION_GRANT,
        key,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') return;
      if (begun.outcome === 'CONFLICT') {
        throw ApiException.of(
          ErrorCode.IdempotencyKeyConflict,
          'That Idempotency-Key was used with a different request',
        );
      }
      if (begun.outcome !== 'NEW')
        throw new Error('An idempotency record of this command is stranded');

      // The account under its lock: a session stands only for an account that can sign in.
      const account = await directory.lockIdentity(handle, ref);
      if (account?.status !== 'ACTIVE' || account.credentialGeneration === 0) throw noSession();
      const channel = await directory.registeredChannel(handle, ref);
      if (channel === null) throw deliveryFailed();
      await this.#issue(handle, ref, channel);
      await idempotency.complete(handle, scope, { status: 202, body: new Uint8Array() });
    });
  }

  async list(authorized: AuthorizedRequest, correlationId: string): Promise<DeviceSet> {
    return this.#options.runner.read(authorized, correlationId, async (handle) => {
      const devices = await this.#options.devices.listFor(handle, authorized.session.principalId);
      return { devices, etag: deviceSetEtagOf(devices) };
    });
  }

  async revoke(
    authorized: AuthorizedRequest,
    id: string,
    ifMatch: string | undefined,
  ): Promise<{ readonly device: RegisteredDeviceRecord; readonly etag: string }> {
    const { runner, directory, devices, sessions, audit } = this.#options;
    const ref: PrincipalRef = { type: 'VENDOR', id: authorized.session.principalId };
    return runner.actAsAuthentication(authorized, authenticationContext(), async (handle) => {
      const account = await directory.lockIdentity(handle, ref);
      if (account?.status !== 'ACTIVE') throw noSession();
      const before = await devices.listFor(handle, ref.id);
      if (!deviceSetEtagMatches(ifMatch, deviceSetEtagOf(before))) {
        throw stateConflict('The browsers of the account have changed since they were read');
      }
      const target = before.find((device) => device.id === id.toLowerCase());
      if (target === undefined) throw ApiException.of(ErrorCode.NotFound, 'Resource not found');
      if (target.id === authorized.session.registeredDeviceId) {
        throw stateConflict('This is the browser in use: signing out is what ends its session');
      }
      if (target.status !== 'ACTIVE') throw stateConflict('The browser has already ended');
      const revoked = await devices.revoke(handle, target.id, ref.id);
      if (revoked === null) throw stateConflict('The browser has already ended');

      const actor = { type: 'VENDOR_ACCOUNT', id: ref.id } as const;
      await audit.write(handle, {
        code: 'auth.device.revoked',
        enhanced: true,
        outcome: 'SUCCEEDED',
        actor,
        object: { type: 'RegisteredDevice', id: revoked.id },
        previousState: 'ACTIVE',
        resultingState: 'REVOKED',
        beforeAfter: { status: { before: 'ACTIVE', after: 'REVOKED' } },
        relatedIds: { principal_id: ref.id },
        detail: { device_kind: 'VENDOR_BROWSER_CREDENTIAL', cause: 'VENDOR' },
      });
      for (const sessionId of await sessions.terminate(
        handle,
        { by: 'device', registeredDeviceId: revoked.id },
        'DEVICE_REVOKED',
      )) {
        await audit.write(handle, {
          code: 'auth.session.terminated',
          enhanced: false,
          enhancedBasis: 'ROUTINE_TERMINATION',
          outcome: 'SUCCEEDED',
          actor,
          object: { type: 'Session', id: sessionId },
          reason: { code: 'DEVICE_REVOKED', label: 'The browser was revoked' },
          relatedIds: { registered_device_id: revoked.id },
        });
      }
      const after = await devices.listFor(handle, ref.id);
      return { device: revoked, etag: deviceSetEtagOf(after) };
    });
  }

  /** The grant and its message, the earlier pending grant superseded and its message cancelled, and the events of both. */
  async #issue(
    handle: TransactionHandle,
    ref: PrincipalRef,
    channel: {
      readonly channel: 'EMAIL' | 'SMS';
      readonly destination: string;
      readonly accountIdentifier?: string;
    },
  ): Promise<void> {
    const { grants, audit, deviceLink } = this.#options;
    let issued: IssuedGrant;
    try {
      issued = await grants.issue(handle, {
        principal: ref,
        purpose: 'VENDOR_DEVICE_ENROLMENT',
        issuedBy: null,
        delivery: {
          kind: 'DEVICE_GRANT',
          channel: channel.channel,
          destination: channel.destination,
          link: deviceLink,
          ...(channel.accountIdentifier === undefined
            ? {}
            : { accountIdentifier: channel.accountIdentifier }),
        },
      });
    } catch (error) {
      if (error instanceof DeliveryNotQueueableError) throw deliveryFailed();
      throw error;
    }
    const actor = { type: 'VENDOR_ACCOUNT', id: ref.id } as const;
    if (issued.supersededGrantId !== null) {
      await audit.write(handle, {
        code: 'auth.setup_grant.superseded',
        enhanced: false,
        outcome: 'SUCCEEDED',
        actor,
        object: { type: 'SetupGrant', id: issued.supersededGrantId },
        previousState: 'PENDING',
        resultingState: 'SUPERSEDED',
        relatedIds: { principal_id: ref.id, superseded_by: issued.grant.id },
        detail: { purpose: 'VENDOR_DEVICE_ENROLMENT', principal_type: 'VENDOR' },
      });
    }
    await audit.write(handle, {
      code: 'auth.setup_grant.issued',
      enhanced: false,
      outcome: 'SUCCEEDED',
      actor,
      object: { type: 'SetupGrant', id: issued.grant.id },
      relatedIds: { principal_id: ref.id },
      detail: {
        purpose: 'VENDOR_DEVICE_ENROLMENT',
        channel: channel.channel,
        principal_type: 'VENDOR',
      },
    });
  }
}
