import { described } from '../openapi/described-schema.js';
import { QUEUE_IDS } from '../domain-ports/queue-counter.port.js';

/**
 * The shape of the answer of `getQueueSummary` as the application describes it (`QueueId`, `QueueSummaryEntry` and `QueueSummary` of the
 * contract). The contract's schema is what an answer is validated against outside production; this is what the application says it
 * gives, and the conformance check compares the two (`pnpm run contract:check`). An entry is the queue, its count and, when the count is
 * not `0`, the moment its oldest record entered it, **and nothing else**: closed against any other property.
 */
export const QUEUE_ID_SCHEMA = described({ type: 'string', enum: [...QUEUE_IDS] });

export const QUEUE_SUMMARY_ENTRY_SCHEMA = described({
  type: 'object',
  required: ['queue', 'count'],
  additionalProperties: false,
  properties: {
    queue: QUEUE_ID_SCHEMA,
    count: { type: 'integer', minimum: 0 },
    oldest_at: { type: 'string', format: 'date-time' },
  },
});

export const QUEUE_SUMMARY_SCHEMA = described({
  type: 'object',
  required: ['queues'],
  additionalProperties: false,
  properties: { queues: { type: 'array', items: QUEUE_SUMMARY_ENTRY_SCHEMA } },
});
