import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import { SETUP_GRANT_STORE } from '../platform/auth/setup-grants/setup-grant-providers.js';
import type { SetupGrantStore } from '../platform/auth/setup-grants/setup-grant-store.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import type { AppConfig } from '../platform/config/load-config.js';
import { renderLink } from '../platform/config/origins.js';
import { APP_CONFIG } from '../platform/platform.tokens.js';
import { ReasonValidator } from '../platform/settings/reason-validator.js';
import { ADMINISTRATOR_RECOVERIES } from '../platform/auth/recovery/recovery-providers.js';
import type { AdministratorRecoveries } from '../platform/auth/recovery/administrator-recovery.js';
import { VendorCredentialAdministration } from './vendor-credential-administration.service.js';

/** The injection token of the service of the administrative credential acts on a vendor account (S0.47b, S0.51). */
export const VENDOR_CREDENTIAL_ADMINISTRATION = Symbol('VENDOR_CREDENTIAL_ADMINISTRATION');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built on the runner, the store of grants (which queues the message) and the audit writer the platform provides, and
 * `undefined` where any is missing: an application composed without a database or without local key material has no store of grants and
 * no delivery queue, and the operation fails closed (`503`). The link is the Vendor origin's credential-setup route.
 */
export const vendorCredentialAdministrationProviders: readonly FactoryProvider[] = [
  {
    provide: VENDOR_CREDENTIAL_ADMINISTRATION,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      grants: SetupGrantStore | undefined,
      recoveries: AdministratorRecoveries | undefined,
      config: AppConfig,
    ): VendorCredentialAdministration | undefined =>
      runner === undefined ||
      audit === undefined ||
      grants === undefined ||
      recoveries === undefined
        ? undefined
        : new VendorCredentialAdministration({
            runner,
            audit,
            grants,
            recoveries,
            reasons: new ReasonValidator(),
            setupLink: (token) => renderLink(config.links.vendor.setupCredential, token),
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(SETUP_GRANT_STORE),
      optional(ADMINISTRATOR_RECOVERIES),
      APP_CONFIG,
    ],
  },
];
