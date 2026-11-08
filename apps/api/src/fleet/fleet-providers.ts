import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import { CLOCK, type Clock } from '../platform/auth/ports/clock.port.js';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStore,
} from '../platform/auth/ports/idempotency-store.port.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { RUN_ACCESS, type RunAccess } from '../platform/domain-ports/run-access.port.js';
import { RunCustodyHandovers } from './run-custody-handover.service.js';

/** The injection token of the service of the run custody handover (S1.24), which its controllers ask for. */
export const RUN_CUSTODY_HANDOVERS = Symbol('RUN_CUSTODY_HANDOVERS');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service of the custody handover, `undefined` where what it needs is missing: an application composed without a database has none, so it
 * has no service, and the operations fail closed (`503`). It needs the runner, the audit, the idempotency store of the retry of an acceptance
 * or a failure, the clock for the identifiers of the handovers, and the run port (the `pickup` domain's answer to what a run is and to its
 * completion: `platform/domain-ports/run-access.port.ts`).
 */
export const fleetProviders: readonly FactoryProvider[] = [
  {
    provide: RUN_CUSTODY_HANDOVERS,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
      runs: RunAccess | undefined,
    ): RunCustodyHandovers | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined ||
      runs === undefined
        ? undefined
        : new RunCustodyHandovers({ runner, audit, idempotency, clock, runs }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
      optional(RUN_ACCESS),
    ],
  },
];
