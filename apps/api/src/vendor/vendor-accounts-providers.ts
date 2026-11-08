import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { VendorAccountsService } from './vendor-accounts.service.js';

/** The injection token of the service of the vendor reads (S0.47a), which its controller asks for. */
export const VENDOR_ACCOUNTS_SERVICE = Symbol('VENDOR_ACCOUNTS_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built on the operation runner and the audit writer the platform provides, and `undefined` where either is missing: an
 * application composed without a database has none, and the reads fail closed (`503`). The credential facts are read inside the
 * operation's own transaction (`melarc.vendor_credential_facts`), so no reader of them is injected.
 */
export const vendorAccountsProviders: readonly FactoryProvider[] = [
  {
    provide: VENDOR_ACCOUNTS_SERVICE,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
    ): VendorAccountsService | undefined =>
      runner === undefined || audit === undefined
        ? undefined
        : new VendorAccountsService({ runner, audit }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER)],
  },
];
