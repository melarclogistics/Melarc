import type { AnonymousLimit } from '../../routes/access-declaration.js';
import type { LimitPartitioner } from '../../routes/limit-partitions.js';
import type { IdentityDirectory } from '../ports/identity-directory.port.js';
import type { UnitOfWork } from '../ports/unit-of-work.port.js';
import { authenticationContext } from '../staff/authentication-context.js';
import { canonicalAccountIdentifier } from './vendor-vocabulary.js';
import type { RegisteredDeviceStore } from './registered-device-store.js';
import { presentedVendorDevice } from './vendor-device-credential.js';

/** The longest account identifier the limiter takes a key from, in bytes: the contract's `maxLength` (64). */
export const MAX_IDENTIFIER_BYTES = 64;

/** The partition every request whose browser is not recognised for the account shares: inventing cookie values buys no bucket. */
export const INVALID_DEVICE = 'invalid-device';

/**
 * The limit of `vendorSignIn` (settings.md section 7.5, `rate_limit_vendor_signin`, 10 a minute; `AC-SLICE-000-19`): keyed on **the
 * submitted account together with the registered browser's identity, and only once the browser is recognised**. The account is the
 * identifier's canonical form (upper case, trimmed: `canonicalAccountIdentifier`); text that is not an identifier meets the coarse admission
 * limits only, as every other anonymous limit does, and is refused by the sign-in as any wrong identifier is.
 */
export const VENDOR_SIGN_IN_LIMIT: AnonymousLimit = {
  bucket: 'rate_limit_vendor_signin',
  identifier: { field: 'account_identifier', maxBytes: MAX_IDENTIFIER_BYTES },
  canonical: canonicalAccountIdentifier,
  partition: 'VENDOR_DEVICE',
};

/**
 * The partition of the vendor sign-in's key: the account and the browser the request's `melarc_vendor_device` names **when that browser is
 * an `ACTIVE` one registered to the account named**, and otherwise the account's one invalid-device partition (no cookie, a value that is
 * not a credential, an unknown one, a revoked one, another account's). It reads two rows by key, under the authentication capability, in a
 * short transaction of its own before anything is verified or counted, **both of them whatever the first found**, so the work does not say
 * whether a presented browser is still registered; the key holds the device's id and never its credential, and the limiter digests the key
 * again before it stores anything.
 */
export function vendorDevicePartition(
  unitOfWork: Pick<UnitOfWork, 'run'>,
  directory: Pick<IdentityDirectory, 'findVendorAccountByIdentifier'>,
  devices: Pick<RegisteredDeviceStore, 'findByCredential'>,
): LimitPartitioner {
  return async (request, account) => {
    const credential = presentedVendorDevice(request.headers);
    const device =
      credential === undefined
        ? null
        : await unitOfWork.run(authenticationContext(), async (transaction) => {
            // Both reads whatever the first found: a revoked or unknown browser sends what an active one does.
            const found = await devices.findByCredential(transaction, credential);
            const named = await directory.findVendorAccountByIdentifier(transaction, account);
            return found?.status === 'ACTIVE' && named?.ref.id === found.accountId
              ? found.deviceId
              : null;
          });
    return `${account}\u0000${device ?? INVALID_DEVICE}`;
  };
}
