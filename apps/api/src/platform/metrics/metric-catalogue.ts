import {
  ATTESTATION_INTEGRITY_CAUSES,
  ATTESTATION_UNAVAILABLE_CAUSES,
} from '../auth/ports/attestation-verifier.port.js';
import { RATE_LIMIT_COUNTERS } from '../auth/ports/rate-limiter.port.js';
import { DELIVERY_CHANNELS, TERMINAL_FAILURE_CLASSES } from '../delivery/delivery-vocabulary.js';
import { OUTBOX_OUTCOMES, SUPPRESSION_REASONS } from '../notifications/notification-vocabulary.js';

/*
 * The closed catalogue of metrics (S0.15; OBSERVABILITY_AND_RECOVERY.md §3). A metric exists only if it is defined here, with a
 * kind and, for each label, **the closed set of values the label can take**. That is what keeps a label bounded: a label value is
 * an outcome class, a bucket, a cause, never an identifier, an address, a destination or a token, and the registry refuses a
 * sample whose value is not in the set (`bounded.metrics.adapter.ts`). A metric that needs a new value, a new label or a new name
 * is added here in the same change as the code that records it, and `metric-catalogue.test.ts` holds the figures the documents
 * state to the documents.
 *
 * What serves them is the private metrics endpoint of each process (`metrics-listener.ts`, S0.68; off unless its port is configured),
 * and the thresholds and alerts that read them are `alert-rules.ts` (the alerting tool is release gate G3).
 */
/**
 * A counter and an observation are recorded by the code as things happen (`Metrics`); a **gauge** is read when the metrics are served
 * (S0.68), from the state it describes (the age of the oldest due delivery job), and the registry refuses to record one.
 */
export type MetricKind = 'counter' | 'observation' | 'gauge';

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
      bucket: RATE_LIMIT_COUNTERS,
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
   * Each answer of the private attestation verifier to the API (S0.56; SECURITY_DESIGN.md §15.2.3), by the outcome class of the port
   * (`INTERFACE_BROKEN` is an answer that is not in the interface and is thrown as a defect). The verdicts count what was decided, not who:
   * no key, chain, package or digest is a label.
   */
  attestation_verifier_calls_total: define({
    kind: 'counter',
    labels: {
      outcome: [
        'VERIFIED',
        'DEVICE_INTEGRITY_FAILED',
        'DEVICE_SECURITY_UNSUPPORTED',
        'TRUST_DATA_UNAVAILABLE',
        'INTERFACE_BROKEN',
      ],
    },
    description: 'Answers of the attestation verifier service, by outcome class.',
  }),
  /**
   * `TRUST_DATA_UNAVAILABLE` by its closed cause (SECURITY_DESIGN.md §15.2.3; OBSERVABILITY_AND_RECOVERY.md §4.3a): stale or missing data and
   * unloadable roots as the verifier says them, and an unreachable, late or overloaded verifier as the API sees them. The cause is in the
   * log and here, and never in a response.
   */
  attestation_verifier_unavailable_total: define({
    kind: 'counter',
    labels: { cause: ATTESTATION_UNAVAILABLE_CAUSES },
    description: 'Enrolments the attestation verifier could not evaluate, by closed cause.',
  }),
  /**
   * `DEVICE_INTEGRITY_FAILED` by the step of the policy that refused (SECURITY_DESIGN.md §15.2.1): a chain ending at an unknown root is visible
   * as a rate, and so is a rotation the configuration missed. The cause is also on the audit event, and never in a response.
   */
  attestation_integrity_failures_total: define({
    kind: 'counter',
    labels: { cause: ATTESTATION_INTEGRITY_CAUSES },
    description: 'Attestations the verifier refused, by the closed cause of the step that did.',
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
  /**
   * How long ago the oldest credential message that is due was queued, in seconds (retries included: the time the person it is for has
   * waited for the link): of the jobs whose next attempt is due, or whose lease ended with no outcome, and whose credential has not
   * expired, which are what the worker would claim next. Zero when none is due. Read by
   * the worker's metrics endpoint from the queue at each read (S0.68); the delivery-backlog alert of OBSERVABILITY_AND_RECOVERY.md
   * section 3 is on it. No label: the job's id is the worker log's, never a metric's.
   */
  credential_delivery_oldest_due_age_seconds: define({
    kind: 'gauge',
    labels: {},
    description:
      'Seconds since the oldest due credential message was queued; zero when none is due.',
  }),
  /**
   * How the notification lane ended or gave back each outbox envelope (S1.12; BACKGROUND_JOBS_AND_EVENTS.md §3.7), by outcome. A
   * `SCOPE_MISMATCH` is the security signal of SECURITY_DESIGN.md §14.7 step 8; an `UNKNOWN_EVENT` is an event no message answers; both wait
   * in the dead letter for a person. The labels carry no identifier: which envelope is in the worker's log and the outbox, never a metric.
   */
  notification_relay_total: define({
    kind: 'counter',
    labels: { outcome: OUTBOX_OUTCOMES },
    description:
      'Outbox envelopes the notification lane relayed, retried or dead-lettered, by outcome.',
  }),
  /** The result of each attempt to send a business text: the provider took it, will be asked again, refused it, or the schedule ended. */
  notification_sends_total: define({
    kind: 'counter',
    labels: { result: ['SENT', 'RETRY', 'REJECTED', 'SCHEDULE_EXHAUSTED'] },
    description: 'Attempts to send a business text message, by result.',
  }),
  /** A text held back and never sent, by the reason the message log shows: a switch, a limit, the window's guards, an overtaken message. */
  notification_suppressed_total: define({
    kind: 'counter',
    labels: { reason: SUPPRESSION_REASONS },
    description: 'Business text messages held back and never sent, by reason.',
  }),
  /** The network's word on a text the provider took: delivered, or failed in delivery. A message that never answers counts nowhere. */
  notification_receipts_total: define({
    kind: 'counter',
    labels: { result: ['DELIVERED', 'FAILED'] },
    description: 'The network’s word on business texts the provider accepted, by result.',
  }),
  /**
   * The age of the oldest notification work that is due and not done: an outbox envelope not yet relayed or a text not yet sent. Read by the
   * worker's metrics endpoint at each read (S1.12). Zero when nothing is due. A lane that has stopped, or a provider that is down, shows as
   * this growing while the queue depth looks the same; no label, because which message is in the log and never a metric.
   */
  notification_oldest_due_age_seconds: define({
    kind: 'gauge',
    labels: {},
    description:
      'Seconds since the oldest due notification work (an envelope or a text) became due; zero when none is due.',
  }),
  /**
   * How many outbox envelopes are in the dead letter, waiting for a person (BACKGROUND_JOBS_AND_EVENTS.md §3.3): an act whose messages were
   * never made, because the aggregate no longer had the scope the envelope names (a security signal), because no message answers its
   * event, or because the relay gave up. A dead envelope writes no notification, so the message log cannot show it; the counter of
   * `notification_relay_total` shows it only until the process restarts, and this shows it for as long as it waits. Read at each read of the
   * worker's metrics endpoint; no label, because which envelope is in the worker's log and the outbox, never a metric.
   */
  notification_dead_envelopes: define({
    kind: 'gauge',
    labels: {},
    description: 'Outbox envelopes in the dead letter, waiting for a person.',
  }),
  /**
   * What each check of the failure backstop came to (S1.28, D-A1; OBSERVABILITY_AND_RECOVERY.md §3): `CHECKED` is a check that ran to its end, whether or not it escalated anything, and
   * `FAILED` one that raised (the database was away, or the lane's grant is missing). A lane that fails and never checks is the *Failure backstop* row's second condition. Closed
   * outcomes, no identifier: which request, and in which hub, is the audit event's and the worker's log, never a metric.
   */
  pickup_backstop_runs_total: define({
    kind: 'counter',
    labels: { outcome: ['CHECKED', 'FAILED'] },
    description: 'Checks of the failure backstop, by outcome.',
  }),
  /** Requests the failure backstop escalated because their failure had sat undecided beyond the hub's threshold. No label: the request is in the audit event. */
  pickup_backstop_escalations_total: define({
    kind: 'counter',
    labels: {},
    description: 'Pickup requests escalated by the failure backstop.',
  }),
  /**
   * How many hubs the latest check of the failure backstop could not judge, because the hub's `stale_failure_backstop_hours` is missing or not a whole number of hours from 1 to 8760
   * while a failure waits there: nothing is escalated for such a hub and nothing is invented in its place. Read from the lane's memory when the worker's private metrics endpoint is
   * read, and absent until a check has run to its end (a lane that has not looked yet is not a lane that found nothing). The *Failure backstop* row's first condition is on it. No label:
   * which hub is in the worker's log.
   */
  pickup_backstop_unusable_hubs: define({
    kind: 'gauge',
    labels: {},
    description:
      'Hubs the failure backstop could not judge at its latest check (threshold missing or unusable); absent until a check has run.',
  }),
  /**
   * What the malicious-content check came to for each object it was asked about (Run A2, D-A6; SECURITY_DESIGN.md §14.18b): `CLEAN` (the scanner found nothing: the record may be stored),
   * `FLAGGED` (a signature matched: the file is refused and its object removed), `UNAVAILABLE` (the scanner did not answer, or answered what it should not: **the record stays unstored and
   * the call is retried; nothing is stored unscanned**) and `NOT_CONFIGURED` (no scanner is configured, so no evidence can be stored). Served by the API's metrics endpoint. Closed outcomes,
   * no identifier: which record, and which signature, is the process's log and never a metric.
   */
  evidence_scans_total: define({
    kind: 'counter',
    labels: { outcome: ['CLEAN', 'FLAGGED', 'UNAVAILABLE', 'NOT_CONFIGURED'] },
    description: 'Content scans of uploaded evidence, by outcome.',
  }),
  /**
   * What became of the removal of a file the scanner flagged (`REMOVED` or `FAILED`): a flagged object that could not be removed stays in the bucket until the owner's lifecycle rule takes it,
   * and the record is refused all the same. Served by the API's metrics endpoint. No identifier.
   */
  evidence_object_removals_total: define({
    kind: 'counter',
    labels: { outcome: ['REMOVED', 'FAILED'] },
    description: 'Removals of flagged evidence objects from the store, by outcome.',
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
