import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { PickupStopEvidence } from './pickup-stop-evidence.service.js';

/** The injection token of the service of the stop's evidence read (S1.30), which its controller asks for. */
export const PICKUP_STOP_EVIDENCE = Symbol('PICKUP_STOP_EVIDENCE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built on the operation runner and the audit writer the platform provides, and `undefined` where either is missing: an application composed without a
 * database has none, so it has no service, and the read fails closed (`503`).
 */
export const pickupStopEvidenceProviders: readonly FactoryProvider[] = [
  {
    provide: PICKUP_STOP_EVIDENCE,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
    ): PickupStopEvidence | undefined =>
      runner === undefined || audit === undefined
        ? undefined
        : new PickupStopEvidence({ runner, audit }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER)],
  },
];
