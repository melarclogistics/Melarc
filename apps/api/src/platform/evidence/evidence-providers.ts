import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../auth/ports/audit-writer.port.js';
import { CLOCK, type Clock } from '../auth/ports/clock.port.js';
import { CONTENT_SCANNER, type ContentScanner } from '../auth/ports/content-scanner.port.js';
import { EVIDENCE_STORE, type EvidenceStore } from '../auth/ports/evidence-store.port.js';
import { IDEMPOTENCY_STORE, type IdempotencyStore } from '../auth/ports/idempotency-store.port.js';
import { METRICS, type Metrics } from '../auth/ports/metrics.port.js';
import { OPERATION_RUNNER } from '../authorization/authorization-providers.js';
import type { OperationRunner } from '../authorization/operation-runner.js';
import { SettingsReader } from '../settings/settings-reader.js';
import { EvidenceService } from './evidence.service.js';

/** The injection token of the service of the three evidence operations, which its controller asks for. */
export const EVIDENCE_SERVICE = Symbol('EVIDENCE_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service of the evidence operations (S1.11), built from the runner of an operation, the idempotency store, the object-store port and the content-scanner port the composition root
 * bound, the audit writer, the clock and the metrics registry. It is `undefined` where any is missing (an application composed without a database, without local key material, which the
 * idempotency store rests on, or without the store or the scanner), so that each operation fails closed (`503`) and never answers as though it had worked.
 */
export const evidenceProviders: readonly FactoryProvider[] = [
  {
    provide: EVIDENCE_SERVICE,
    useFactory: (
      runner: OperationRunner | undefined,
      idempotency: IdempotencyStore | undefined,
      store: EvidenceStore | undefined,
      scanner: ContentScanner | undefined,
      audit: AuditWriter | undefined,
      clock: Clock | undefined,
      metrics: Metrics | undefined,
    ): EvidenceService | undefined =>
      runner === undefined ||
      idempotency === undefined ||
      store === undefined ||
      scanner === undefined ||
      audit === undefined ||
      clock === undefined ||
      metrics === undefined
        ? undefined
        : new EvidenceService({
            runner,
            idempotency,
            store,
            scanner,
            audit,
            settings: new SettingsReader(),
            clock,
            metrics,
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(IDEMPOTENCY_STORE),
      optional(EVIDENCE_STORE),
      optional(CONTENT_SCANNER),
      optional(AUDIT_WRITER),
      optional(CLOCK),
      optional(METRICS),
    ],
  },
];
