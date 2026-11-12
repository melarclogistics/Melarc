import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { PickupOpsWorkLists } from './ops-work-lists.service.js';

/** The injection token of the service of the Ops work lists of the collection and the failure (D-A3), which their controller asks for. */
export const PICKUP_OPS_WORK_LISTS = Symbol('PICKUP_OPS_WORK_LISTS');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built on the operation runner and the audit writer the platform provides, and `undefined` where either is missing: an application composed
 * without a database has none, so it has no service, and the reads fail closed (`503`).
 */
export const pickupOpsWorkListsProviders: readonly FactoryProvider[] = [
  {
    provide: PICKUP_OPS_WORK_LISTS,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
    ): PickupOpsWorkLists | undefined =>
      runner === undefined || audit === undefined
        ? undefined
        : new PickupOpsWorkLists({ runner, audit }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER)],
  },
];
