import { RATE_LIMIT_BUCKETS } from '../auth/ports/rate-limiter.port.js';
import { DELIVERY_CHANNELS, TERMINAL_FAILURE_CLASSES } from '../delivery/delivery-vocabulary.js';

/**
 * The closed catalogue of metrics (S0.15; OBSERVABILITY_AND_RECOVERY.md §3). A metric exists only if it is defined here, with a
 * kind and, for each label, **the closed set of values the label can take**. That is what keeps a label bounded: a label value is
 * an outcome class, a bucket, a cause, never an identifier, an address, a destination or a token, and the registry refuses a
 * sample whose value is not in the set (`bounded.metrics.adapter.ts`). A metric that needs a new value, a new label or a new name
 * is added here in the same change as the code that records it, and `metric-catalogue.test.ts` holds the figures the documents
 * state to the documents.
 *
 * Nothing here is served: the private endpoint that serves them, the thresholds and the alerts are S0.68's.
 */
export type MetricKind = 'counter' | 'observation';

export interface MetricDefinition {
  readonly kind: MetricKind;
  /** Each label, and the values it can take. A sample names every label and no other. */
  readonly labels: Readonly<Record<string, readonly string[]>>;
  readonly description: string;
}

const define = (definition: MetricDefinition): MetricDefinition =>
  Object.freeze({
    ...definition,
    labels: Object.freeze(
      Object.fromEntries(
        Object.entries(definition.labels).map(([label, values]) => [
          label,
          Object.freeze([...values]),
        ]),
      ),
    ),
  });

export const METRIC_DEFINITIONS = Object.freeze({
  /**
   * The recovery requests that write no audit event (audit.md §5.4, `auth.recovery.requested`): counted here, and only here. The
   * single label is the outcome; it never carries what was typed, a token or a destination.
   */
  credential_recovery_requests_excluded_total: define({
    kind: 'counter',
    labels: { outcome: ['UNKNOWN_OR_INELIGIBLE', 'RATE_LIMITED', 'REJECTED'] },
    description: 'Recovery requests excluded from the audit ledger, by outcome.',
  }),
  /**
   * `RATE_LIMITED` refusals, per bucket and per cause: the bucket's ceiling, the limiter's table being full, a key too long to
   * digest (answered as any other refusal), or hash admission being full (OBSERVABILITY_AND_RECOVERY.md §3, "Counters that carry no alert yet"). The labels carry no identifier, email, phone
   * number, token or resource id. The benchmark task (S0.65) proposes an alert on the hash-admission series.
   */
  rate_limited_total: define({
    kind: 'counter',
    labels: {
      bucket: RATE_LIMIT_BUCKETS,
      cause: ['BUCKET_CEILING', 'STORE_CAPACITY', 'KEY_TOO_LONG', 'HASH_ADMISSION_FULL'],
    },
    description: 'RATE_LIMITED refusals, by bucket and cause.',
  }),
  /**
   * An admission the limiter refused to decide because live rows exist under a key version this instance does not hold (G2-04): a
   * rotation whose new key was not given to every instance before one began to write under it, or a version retired while rows
   * under it still count. The caller is answered as for any unavailable limiter (generic operational failure, fail closed); this
   * counter is how an operator finds that the deployment is in that state. It has no label: which versions are in the log of the
   * instance, by number, and never in a metric.
   */
  rate_limiter_key_incompatible_total: define({
    kind: 'counter',
    labels: {},
    description:
      'Admissions refused because live rows are under a limiter key version this instance does not hold.',
  }),
  /**
   * An enhanced-audit action refused because its audit record could not be durably written (audit.md §6): the action did not
   * happen, which is an operational block and not a logging fault (OBSERVABILITY_AND_RECOVERY.md §3). It has no label: which act,
   * and whose, is in the request log by correlation id and never in a metric.
   */
  audit_enhanced_write_failed_total: define({
    kind: 'counter',
    labels: {},
    description: 'Enhanced-audit writes that failed closed.',
  }),
  /**
   * Each answer of a provider to a credential message, by channel and result (S0.18; OBSERVABILITY_AND_RECOVERY.md §3, "Provider down":
   * every provider rejection or timeout recorded by a credential delivery job counts toward the SMS and email rates). `UNKNOWN` is a
   * timeout, a lost acknowledgement or a temporary refusal. The labels carry no identifier, destination or token.
   */
  credential_delivery_attempts_total: define({
    kind: 'counter',
    labels: {
      channel: DELIVERY_CHANNELS,
      result: ['ACCEPTED', 'UNKNOWN', 'REJECTED', 'DESTINATION_NOT_ALLOWED'],
    },
    description: 'Provider answers to credential messages, by channel and result.',
  }),
  /**
   * A credential message that fails terminally, by its non-secret outcome class: "a credential message that will not be sent is a
   * security-sensitive dead letter" (OBSERVABILITY_AND_RECOVERY.md §3). The alert on it is S0.68's.
   */
  credential_delivery_jobs_failed_total: define({
    kind: 'counter',
    labels: { outcome: TERMINAL_FAILURE_CLASSES },
    description: 'Credential messages that failed terminally, by outcome class.',
  }),
  /**
   * A claim that ended before any provider was asked, because the worker could not do what a send needs (G2-03): it does not hold the
   * key, envelope or layout version the payload was sealed in (`PAYLOAD_NOT_HELD`), or could not confirm the redemption record. The
   * message is live and waits; a rate of these is an operator's signal that a worker is incompatible with the queue, which no
   * provider rate shows. Closed reasons, no identifier.
   */
  credential_delivery_jobs_deferred_total: define({
    kind: 'counter',
    labels: { reason: ['PAYLOAD_NOT_HELD', 'REDEMPTION_UNCONFIRMED'] },
    description: 'Credential messages deferred before any provider was asked, by reason.',
  }),
  /**
   * A lease taken over because its holder left no outcome (a worker crashed, or was too slow): "leases expire without an outcome"
   * (OBSERVABILITY_AND_RECOVERY.md §3). It has no label; which job is in the worker's log by job id and never in a metric.
   */
  credential_delivery_leases_expired_total: define({
    kind: 'counter',
    labels: {},
    description: 'Delivery leases taken over after their holder left no outcome.',
  }),
  /**
   * The registry's own account of the samples it dropped in production (OB-35), by the reason. The reason is a closed set; the
   * dropped sample's name and values are never kept.
   */
  metrics_samples_dropped_total: define({
    kind: 'counter',
    labels: {
      reason: [
        'UNKNOWN_METRIC',
        'LABEL_SET_MISMATCH',
        'LABEL_VALUE_OUT_OF_SET',
        'KIND_MISMATCH',
        'VALUE_INVALID',
      ],
    },
    description: 'Metric samples dropped for having an unbounded name, label or value.',
  }),
}) satisfies Readonly<Record<string, MetricDefinition>>;

export type MetricName = keyof typeof METRIC_DEFINITIONS;

export const metricNames = (): MetricName[] => Object.keys(METRIC_DEFINITIONS) as MetricName[];

/**
 * What the registry does with a sample whose name, label or value is outside the catalogue. In development and test it **throws**
 * (`LABEL_UNBOUNDED`), so that a programming defect fails a test. In production it **drops the sample**, counts it, and says so once
 * per metric and reason per interval in a bounded, redacted diagnostic, so that a defect in code that merely counts something never
 * disrupts the business operation it runs inside (obligation OB-35; the choice is recorded in the plan, section 7.13).
 */
export type LabelPolicy = 'throw' | 'drop';

export function labelPolicyFor(nodeEnv: 'development' | 'test' | 'production'): LabelPolicy {
  return nodeEnv === 'production' ? 'drop' : 'throw';
}
