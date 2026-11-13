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
import { RUN_CUSTODY, type RunCustody } from '../platform/domain-ports/run-custody.port.js';
import { HubHandovers } from './hub-handover.service.js';

/** The injection token of the service of the hub handover (S1.31), which its controller asks for. */
export const HUB_HANDOVERS = Symbol('HUB_HANDOVERS');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service of the hub handover, `undefined` where what it needs is missing: an application composed without a database has none, so it has no service, and the operation fails closed
 * (`503`). It needs the runner, the audit, the idempotency store of the retry, the clock for the identifiers of the intakes, and the two ports through which the `hub` domain reaches the
 * run (the `pickup` domain's answer: its stops, its version, its completion) and the custody of its parcels (the `fleet` domain's answer): `platform/domain-ports/`. **The `hub` domain
 * imports nothing of either.**
 */
export const hubProviders: readonly FactoryProvider[] = [
  {
    provide: HUB_HANDOVERS,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
      runs: RunAccess | undefined,
      custody: RunCustody,
    ): HubHandovers | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined ||
      runs === undefined
        ? undefined
        : new HubHandovers({ runner, audit, idempotency, clock, runs, custody }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
      optional(RUN_ACCESS),
      RUN_CUSTODY,
    ],
  },
];
