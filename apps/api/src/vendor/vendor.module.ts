import { Module } from '@nestjs/common';

import { vendorAccountsProviders } from './vendor-accounts-providers.js';
import { VendorAccountsController } from './vendor-accounts.controller.js';
import { vendorCredentialAdministrationProviders } from './vendor-credential-administration-providers.js';
import { VendorCredentialAdministrationController } from './vendor-credential-administration.controller.js';

/**
 * The `vendor` permission domain (S0.47: the reads of vendor accounts and the re-issue of a setup grant; the vendor's identity directory of the authentication ports, which
 * the composition root binds and which is not a Nest module). It depends on the platform, and on two pieces of the staff domain that are
 * not about staff: the reserved system actor a fixture organisation records, and the paging helpers of the reads. Nothing depends on it.
 * Creating, approving and suspending a vendor are SLICE-008's.
 */
@Module({
  controllers: [VendorAccountsController, VendorCredentialAdministrationController],
  providers: [...vendorAccountsProviders, ...vendorCredentialAdministrationProviders],
})
export class VendorModule {}
