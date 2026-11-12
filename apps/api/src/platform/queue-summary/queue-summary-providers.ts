import type { FactoryProvider } from '@nestjs/common';

import { OPERATION_RUNNER } from '../authorization/authorization-providers.js';
import type { OperationRunner } from '../authorization/operation-runner.js';
import { QUEUE_COUNTERS, type QueueCounter } from '../domain-ports/queue-counter.port.js';
import { QueueSummaryService } from './queue-summary.service.js';
import { limitStatements } from './statement-limit.js';

/** The injection token of the service of `getQueueSummary`, which its controller asks for. */
export const QUEUE_SUMMARY_SERVICE = Symbol('QUEUE_SUMMARY_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service of `getQueueSummary`, built from the runner of an operation and the counters the composition root bound (the domains that
 * own the queues provide them, `domain-ports.module.ts`). It is `undefined` where either is missing, an application composed without a
 * database or without the domains' counters, so that the operation fails closed (`503`) and never answers with no queues as though none
 * were the session's.
 */
export const queueSummaryProviders: readonly FactoryProvider[] = [
  {
    provide: QUEUE_SUMMARY_SERVICE,
    useFactory: (
      runner: OperationRunner | undefined,
      counters: readonly QueueCounter[] | undefined,
    ): QueueSummaryService | undefined =>
      runner === undefined || counters === undefined
        ? undefined
        : new QueueSummaryService({ runner, counters, limitStatements }),
    inject: [optional(OPERATION_RUNNER), optional(QUEUE_COUNTERS)],
  },
];
