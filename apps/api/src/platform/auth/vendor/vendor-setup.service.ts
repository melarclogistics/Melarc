import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import { runAdmitted } from '../../limiter/run-admitted.js';
import { normaliseNewCredential, type CredentialCheck } from '../credentials/credential-rule.js';
import type { AuditWriter } from '../ports/audit-writer.port.js';
import type { HashAdmission } from '../ports/hash-admission.port.js';
import type { Hasher } from '../ports/hasher.port.js';
import type { IdentityDirectory, PrincipalRef } from '../ports/identity-directory.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import { SetupGrantExpiredError } from '../setup-grants/setup-grant-errors.js';
import type { SetupGrantStore, StoredGrant } from '../setup-grants/setup-grant-store.js';
import type { SetupGrantPurpose } from '../setup-grants/setup-grant-vocabulary.js';
import { authenticationContext } from '../staff/authentication-context.js';
import type { RegisteredDeviceRecord, RegisteredDeviceStore } from './registered-device-store.js';

/**
 * The refusals of the vendor's grant operations. One fixed text each: which way a grant was unusable (unknown, malformed, spent,
 * superseded, expired, another purpose's or another principal's, or for an account that cannot take it) is not for a caller to learn.
 */
export const invalidVendorGrant = (): ApiException =>
  ApiException.of(ErrorCode.SetupGrantInvalid, 'The setup link is not valid');
const limited = (): ApiException => ApiException.of(ErrorCode.RateLimited, 'Too many requests');

/** A refusal of a new secret, named as the schema's own rule of the same bound, at the field and never with its value. */
export function secretRefusal(
  check: Exclude<CredentialCheck, { ok: true }>,
  pointer = '/secret',
): ApiException {
  const rule =
    check.refusal === 'MALFORMED_UNICODE'
      ? 'format'
      : check.refusal === 'TOO_SHORT'
        ? 'minLength'
        : 'maxLength';
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });
}

/** A grant that a vendor's operation of `purpose` can use: `PENDING`, of that purpose, and a vendor account's. */
export function usableVendorGrant(
  grant: StoredGrant | null,
  purpose: SetupGrantPurpose,
): grant is StoredGrant {
  return (
    grant !== null &&
    grant.state === 'PENDING' &&
    grant.principalType === 'VENDOR' &&
    grant.purpose === purpose
  );
}

export interface VendorSetupOptions {
  readonly unitOfWork: UnitOfWork;
  readonly directory: IdentityDirectory;
  readonly grants: SetupGrantStore;
  readonly devices: RegisteredDeviceStore;
  readonly tokens: Pick<TokenService, 'hash'>;
  readonly hasher: Hasher;
  readonly hashAdmission: HashAdmission;
  readonly audit: AuditWriter;
}

export interface RegisteredBrowser {
  readonly device: RegisteredDeviceRecord;
  /** The browser's credential, for the `melarc_vendor_device` cookie of this response and for nothing else: shown once. */
  readonly credential: string;
}

/**
 * `completeVendorCredentialSetup` (S0.47b; vendor-authentication.md sections 4.1 and 4.2; `AC-SLICE-000-42`, `-97`): the vendor sets its
 * own shared secret and registers the browser it is using, with the `VENDOR_CREDENTIAL_SETUP` grant its registered channel received.
 * **The administrator never learns the secret**, and **no session is issued**: the vendor signs in afterwards with the account identifier,
 * the secret and this browser.
 *
 * - **The account comes from the grant and from nothing the request says**; every refusal of the grant is one answer
 *   (`SETUP_GRANT_INVALID`), and a token that was never going to work costs a lookup and no hash.
 * - **The secret is held to both bounds before anything else** (12 to 128 code points as sent, by the schema, and after NFKC, here):
 *   `VALIDATION_FAILED` at `/secret`, never with the value, whatever the grant.
 * - **The secret is hashed outside any transaction, after hash admission**, and only then does the one transaction of the act open: it
 *   locks the account's credential (the identity lock), re-reads the account (`ACTIVE`, no secret yet) and the grant under it, consumes
 *   the grant, writes the first secret (generation 0 to 1, the lockout cleared), registers the browser and writes the events, and commits
 *   all of it or none of it.
 * - **The events name the account as the actor** (a pre-session act of a `SYSTEM` transaction, which may name whom it served), never a
 *   person, and hold no secret, token or credential.
 */
export class VendorSetupService {
  readonly #options: VendorSetupOptions;

  constructor(options: VendorSetupOptions) {
    this.#options = options;
  }

  async completeCredentialSetup(request: {
    readonly setupToken: string;
    readonly secret: string;
  }): Promise<RegisteredBrowser> {
    const context = authenticationContext();
    const hash = this.#options.tokens.hash(request.setupToken);
    const checked = normaliseNewCredential(request.secret);
    if (!checked.ok) throw secretRefusal(checked);
    if (hash === null) throw invalidVendorGrant();

    const { unitOfWork, grants, directory } = this.#options;
    const eligible = await unitOfWork.run(context, async (transaction) => {
      const grant = await grants.findLiveByTokenHash(transaction, hash);
      if (!usableVendorGrant(grant, 'VENDOR_CREDENTIAL_SETUP')) return false;
      const account = await directory.readIdentity(transaction, {
        type: 'VENDOR',
        id: grant.principalId,
      });
      return account?.status === 'ACTIVE' && account.credentialGeneration === 0;
    });
    if (!eligible) throw invalidVendorGrant();

    const hashed = await runAdmitted(this.#options.hashAdmission, () =>
      this.#options.hasher.hash('VENDOR_SECRET', checked.credential),
    );
    if (!hashed.admitted) throw limited();
    const encodedHash = hashed.value;

    try {
      return await unitOfWork.run(context, (transaction) =>
        this.#establish(transaction, request.setupToken, hash, encodedHash),
      );
    } catch (error) {
      if (error instanceof SetupGrantExpiredError) throw invalidVendorGrant();
      throw error;
    }
  }

  /**
   * `completeAdditionalDeviceEnrolment` (S0.49; vendor-authentication.md section 5.5; `AC-SLICE-000-45`): the new browser consumes the
   * `VENDOR_DEVICE_ENROLMENT` grant the registered channel received and is registered **alongside** the account's other browsers. **It
   * issues no session and rotates no secret**: the vendor signs in on the new browser afterwards with the identifier and the secret, and that
   * sign-in displaces the earlier session as any does. The grant is the whole authority (it is principal-bound, so no account is taken);
   * every refusal of it is one answer, and the account must still be `ACTIVE` and hold a secret, judged under its lock.
   */
  async completeAdditionalDeviceEnrolment(request: {
    readonly setupToken: string;
  }): Promise<RegisteredBrowser> {
    const context = authenticationContext();
    const hash = this.#options.tokens.hash(request.setupToken);
    if (hash === null) throw invalidVendorGrant();
    const { unitOfWork, grants, directory, devices, audit } = this.#options;
    try {
      return await unitOfWork.run(context, async (transaction) => {
        const grant = await grants.findLiveByTokenHash(transaction, hash);
        if (!usableVendorGrant(grant, 'VENDOR_DEVICE_ENROLMENT')) throw invalidVendorGrant();
        const ref: PrincipalRef = { type: 'VENDOR', id: grant.principalId };
        const account = await directory.lockIdentity(transaction, ref);
        if (account?.status !== 'ACTIVE' || account.credentialGeneration === 0)
          throw invalidVendorGrant();
        const live = await grants.lockLive(transaction, hash);
        if (!usableVendorGrant(live, 'VENDOR_DEVICE_ENROLMENT') || live.principalId !== ref.id)
          throw invalidVendorGrant();
        const consumed = await grants.consume(transaction, {
          principal: ref,
          purpose: live.purpose,
          token: request.setupToken,
        });
        if (consumed === null) throw invalidVendorGrant();
        const registered = await devices.register(transaction, ref.id);

        const actor = { type: 'VENDOR_ACCOUNT', id: ref.id } as const;
        await audit.write(transaction, {
          code: 'auth.setup_grant.consumed',
          enhanced: false,
          outcome: 'SUCCEEDED',
          actor,
          object: { type: 'SetupGrant', id: consumed.id },
          previousState: 'PENDING',
          resultingState: 'CONSUMED',
          relatedIds: { principal_id: ref.id },
          detail: { purpose: consumed.purpose, principal_type: 'VENDOR' },
        });
        await audit.write(transaction, {
          code: 'auth.device.registered',
          enhanced: true,
          outcome: 'SUCCEEDED',
          actor,
          object: { type: 'RegisteredDevice', id: registered.device.id },
          resultingState: 'ACTIVE',
          beforeAfter: { status: { before: null, after: 'ACTIVE' } },
          relatedIds: { principal_id: ref.id, setup_grant_id: consumed.id },
          detail: { device_kind: 'VENDOR_BROWSER_CREDENTIAL', cause: 'ADDITIONAL_BROWSER' },
        });
        return registered;
      });
    } catch (error) {
      if (error instanceof SetupGrantExpiredError) throw invalidVendorGrant();
      throw error;
    }
  }

  async #establish(
    transaction: TransactionHandle,
    setupToken: string,
    hash: Uint8Array,
    encodedHash: string,
  ): Promise<RegisteredBrowser> {
    const { directory, grants, devices, audit } = this.#options;
    const grant = await grants.findLiveByTokenHash(transaction, hash);
    if (!usableVendorGrant(grant, 'VENDOR_CREDENTIAL_SETUP')) throw invalidVendorGrant();
    const ref: PrincipalRef = { type: 'VENDOR', id: grant.principalId };

    const account = await directory.lockIdentity(transaction, ref);
    if (account?.status !== 'ACTIVE' || account.credentialGeneration !== 0)
      throw invalidVendorGrant();
    // The grant is locked and judged again on the time after any wait for the account's lock.
    const live = await grants.lockLive(transaction, hash);
    if (!usableVendorGrant(live, 'VENDOR_CREDENTIAL_SETUP') || live.principalId !== ref.id)
      throw invalidVendorGrant();
    const consumed = await grants.consume(transaction, {
      principal: ref,
      purpose: live.purpose,
      token: setupToken,
    });
    if (consumed === null) throw invalidVendorGrant();
    const established = await directory.establishCredential(transaction, ref, encodedHash);
    if (established === null) throw invalidVendorGrant();
    const registered = await devices.register(transaction, ref.id);

    const actor = { type: 'VENDOR_ACCOUNT', id: ref.id } as const;
    await audit.write(transaction, {
      code: 'auth.setup_grant.consumed',
      enhanced: false,
      outcome: 'SUCCEEDED',
      actor,
      object: { type: 'SetupGrant', id: consumed.id },
      previousState: 'PENDING',
      resultingState: 'CONSUMED',
      relatedIds: { principal_id: ref.id },
      detail: { purpose: consumed.purpose, principal_type: 'VENDOR' },
    });
    await audit.write(transaction, {
      code: 'auth.credential.changed',
      enhanced: false,
      outcome: 'SUCCEEDED',
      actor,
      object: { type: 'VendorAccount', id: ref.id },
      beforeAfter: { credential_generation: { before: 0, after: established.generation } },
      relatedIds: { principal_id: ref.id, setup_grant_id: consumed.id },
      detail: { cause: 'SETUP', credential_kind: 'VENDOR_SECRET' },
    });
    await audit.write(transaction, {
      code: 'auth.device.registered',
      enhanced: true,
      outcome: 'SUCCEEDED',
      actor,
      object: { type: 'RegisteredDevice', id: registered.device.id },
      resultingState: 'ACTIVE',
      beforeAfter: { status: { before: null, after: 'ACTIVE' } },
      relatedIds: { principal_id: ref.id, setup_grant_id: consumed.id },
      detail: { device_kind: 'VENDOR_BROWSER_CREDENTIAL', cause: 'SETUP' },
    });
    return registered;
  }
}
