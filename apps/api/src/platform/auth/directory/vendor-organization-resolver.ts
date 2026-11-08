import type { VendorOrganizationResolver } from '../../authorization/operation-contexts.js';
import { VendorOrganizationUnavailableError } from '../../authorization/operation-contexts.js';
import type { IdentityDirectory } from '../ports/identity-directory.port.js';
import type { UnitOfWork } from '../ports/unit-of-work.port.js';
import { authenticationContext } from '../staff/authentication-context.js';

/**
 * The organisation of a vendor session's account, read from the account (S0.47): what the security context of the session's operation
 * names, so that the policies of the tables a vendor reads hold it to its own organisation's rows. It is asked of the directory in a short
 * transaction of its own, under the `authentication` capability (the only context that reads every account), **before** the operation's
 * transaction opens, and it never takes the organisation from the session or the request. An account that is not there has no
 * organisation to act for: the operation is not served (`VendorOrganizationUnavailableError`, the platform's operational failure).
 */
export function vendorOrganizationFromDirectory(
  unitOfWork: Pick<UnitOfWork, 'run'>,
  directory: Pick<IdentityDirectory, 'vendorOrganizationOf'>,
): VendorOrganizationResolver {
  return async (session) => {
    const organization = await unitOfWork.run(authenticationContext(), (transaction) =>
      directory.vendorOrganizationOf(transaction, { type: 'VENDOR', id: session.principalId }),
    );
    if (organization === null) throw new VendorOrganizationUnavailableError();
    return organization;
  };
}
