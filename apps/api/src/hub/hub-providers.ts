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
import { HubBlindCounts } from './blind-count.service.js';
import { HubHandovers } from './hub-handover.service.js';
import { HubCheckIns } from './check-in.service.js';
import { HubIntakes } from './hub-intakes.service.js';
import { HubIntakeFindings } from './intake-findings.service.js';
import { ReceivingReads } from './receiving-reads.service.js';

/** The injection token of the service of the hub handover (S1.31), which its controller asks for. */
export const HUB_HANDOVERS = Symbol('HUB_HANDOVERS');

/** The injection token of the service of the receiving side's reads and lock (S1.32), which its controller asks for. */
export const HUB_INTAKES = Symbol('HUB_INTAKES');

/** The injection token of the service of the blind count (S1.33), which its controller asks for. */
export const HUB_BLIND_COUNTS = Symbol('HUB_BLIND_COUNTS');

/** The injection token of the service of the condition and the adjudication (S1.34), which its controller asks for. */
export const HUB_INTAKE_FINDINGS = Symbol('HUB_INTAKE_FINDINGS');

/** The injection token of the service of the receiving side's reads by run (Run D, S1.35b), which its controller asks for. */
export const HUB_RECEIVING_READS = Symbol('HUB_RECEIVING_READS');

/** The injection token of the service of the acts of the check-in (Run D, S1.35b), which its controller asks for. */
export const HUB_CHECK_INS = Symbol('HUB_CHECK_INS');

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
  {
    provide: HUB_INTAKES,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
    ): HubIntakes | undefined =>
      runner === undefined || audit === undefined ? undefined : new HubIntakes({ runner, audit }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER)],
  },
  {
    provide: HUB_BLIND_COUNTS,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
    ): HubBlindCounts | undefined =>
      runner === undefined || audit === undefined || idempotency === undefined
        ? undefined
        : new HubBlindCounts({ runner, audit, idempotency }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER), optional(IDEMPOTENCY_STORE)],
  },
  {
    provide: HUB_INTAKE_FINDINGS,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
    ): HubIntakeFindings | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined
        ? undefined
        : new HubIntakeFindings({ runner, audit, idempotency, clock }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
    ],
  },
  {
    provide: HUB_RECEIVING_READS,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
    ): ReceivingReads | undefined =>
      runner === undefined || audit === undefined ? undefined : new ReceivingReads({ runner, audit }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER)],
  },
  {
    provide: HUB_CHECK_INS,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
    ): HubCheckIns | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined
        ? undefined
        : new HubCheckIns({ runner, audit, idempotency, clock }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
    ],
  },
];
