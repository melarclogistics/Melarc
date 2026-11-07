import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../auth/ports/audit-writer.port.js';
import { OPERATION_RUNNER } from '../authorization/authorization-providers.js';
import type { OperationRunner } from '../authorization/operation-runner.js';
import {
  RECORD_LOOKUP_SOURCES,
  type RecordLookupSource,
} from '../domain-ports/record-lookup.port.js';
import { limitStatements } from '../queue-summary/statement-limit.js';
import { hubNamesOf } from './hub-names.js';
import { primaryHubOfStaff } from './primary-hub.js';
import { RecordLookupService } from './record-lookup.service.js';

/** The injection token of the service of `lookupRecords`, which its controller asks for. */
export const RECORD_LOOKUP_SERVICE = Symbol('RECORD_LOOKUP_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service of `lookupRecords`, built from the runner of an operation, the audit writer and the sources the composition root bound (the
 * domains that own the records provide them, `domain-ports.module.ts`). It is `undefined` where any is missing, an application composed without
 * a database or without the domains' sources, so that the operation fails closed (`503`) and never answers with no records as though none
 * matched. The bound on a statement (`AC-LOOKUP-15`) is the one the queue summary's counts have (`queue-summary/statement-limit.ts`): the same
 * `SET LOCAL statement_timeout`, which only ever lowers the bound the configuration set.
 */
export const recordLookupProviders: readonly FactoryProvider[] = [
  {
    provide: RECORD_LOOKUP_SERVICE,
    useFactory: (
      runner: OperationRunner | undefined,
      sources: readonly RecordLookupSource[] | undefined,
      audit: AuditWriter | undefined,
    ): RecordLookupService | undefined =>
      runner === undefined || sources === undefined || audit === undefined
        ? undefined
        : new RecordLookupService({
            runner,
            sources,
            audit,
            primaryHubOf: primaryHubOfStaff,
            hubNamesOf,
            limitStatements,
          }),
    inject: [optional(OPERATION_RUNNER), optional(RECORD_LOOKUP_SOURCES), optional(AUDIT_WRITER)],
  },
];
