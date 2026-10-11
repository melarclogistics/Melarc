import type { Clock } from '../auth/ports/clock.port.js';
import type { MetricLabels, Metrics } from '../auth/ports/metrics.port.js';
import { METRIC_DEFINITIONS, type LabelPolicy, type MetricDefinition } from './metric-catalogue.js';

/** A sample refused for an unbounded name, label or value: `LABEL_UNBOUNDED`. The message names the metric and the label, never a value. */
export class MetricsLabelError extends Error {
  readonly code = 'LABEL_UNBOUNDED';
  constructor(message: string) {
    super(message);
    this.name = 'MetricsLabelError';
  }
}

/** A sample refused for a defect that is not a label: the wrong kind of call for the metric, or a value that is not a number. */
export class MetricsSampleError extends Error {
  readonly code = 'METRIC_SAMPLE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'MetricsSampleError';
  }
}

export type DropReason =
  | 'UNKNOWN_METRIC'
  | 'LABEL_SET_MISMATCH'
  | 'LABEL_VALUE_OUT_OF_SET'
  | 'KIND_MISMATCH'
  | 'VALUE_INVALID';

/**
 * What production says when it drops a sample: the metric (from the catalogue, or `(unknown)`), the reason, the label name where
 * one is at fault, and how many like it were held back since the last diagnostic. It holds no value from the sample.
 */
export interface MetricDiagnostic {
  readonly metric: string;
  readonly reason: DropReason;
  readonly label?: string;
  readonly suppressed: number;
}

/** The least time between two diagnostics for one metric and reason, on the monotonic clock. A defect in a hot path is one line a minute. */
export const DIAGNOSTIC_INTERVAL_MS = 60_000;

export interface BoundedMetricsOptions {
  readonly policy: LabelPolicy;
  readonly clock: Pick<Clock, 'monotonicMilliseconds'>;
  /** Where a production diagnostic goes (the logger, in the composition). Never given a value from a sample. */
  readonly onDiagnostic?: (diagnostic: MetricDiagnostic) => void;
  /** The catalogue. The application's own; a test may give a smaller or different one. */
  readonly definitions?: Readonly<Record<string, MetricDefinition>>;
}

interface Series {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

interface CounterEntry extends Series {
  value: number;
}
interface ObservationEntry extends Series {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface MetricsSnapshot {
  readonly counters: readonly { name: string; labels: Record<string, string>; value: number }[];
  readonly observations: readonly {
    name: string;
    labels: Record<string, string>;
    count: number;
    sum: number;
    min: number;
    max: number;
  }[];
}

/**
 * The supported boundary of a labels argument (G2-08): **a record**, an object that is not `null` and not an array, whose own
 * enumerable string properties are the labels. A record without a prototype and an instance of a class are records. Anything else
 * (`null`, an array, text, a number, a function, a symbol) is refused as a label-set mismatch before any property is read.
 * Protection against arbitrary hostile JavaScript is **not** claimed: a `Proxy` whose traps throw, or a getter that throws, is the
 * caller running code inside the process, and no check of the argument can contain it.
 */
function isRecord(labels: unknown): labels is Record<string, unknown> {
  return typeof labels === 'object' && labels !== null && !Array.isArray(labels);
}

interface Refusal {
  readonly reason: DropReason;
  readonly metric: string | undefined;
  readonly label: string | undefined;
}

/**
 * The metrics registry (S0.15) with **bounded labels** (OBSERVABILITY_AND_RECOVERY.md §3). A metric is one defined in the catalogue,
 * a sample names every label of its metric and no other, and every value is one of the label's closed set: the number of series a
 * metric can have is the product of its sets, which is small and fixed, so cardinality is bounded by construction and no identifier,
 * address, destination or token can become a label.
 *
 * **What happens to a sample that is not in the catalogue is chosen by `policy`, and recorded (OB-35).** In development and test it
 * throws, `LABEL_UNBOUNDED` (`MetricsLabelError`), so that a programming defect fails a test. In production it **drops the sample and
 * goes on**: counting is never allowed to fail the operation it is counting, a request that has just committed a credential change
 * must not turn into a failure because a label was wrong. The drop is not silent: it is counted in `metrics_samples_dropped_total`
 * by reason, and a diagnostic goes to `onDiagnostic` once per metric and reason, then at most once per `DIAGNOSTIC_INTERVAL_MS`
 * with the number held back. The diagnostic and the error carry the metric's name and the label's name, taken from the catalogue,
 * and **never a value** (a value is what might be an identifier); a metric name the catalogue does not hold is reported as
 * `(unknown)`. Nothing is stored per bad sample, so a flood of distinct bad names or values uses no more memory than one.
 *
 * **The labels argument is a record** (`isRecord`): a `null`, an array or any other non-record is a refused sample like any other, in
 * production as in development, and is never enumerated. That is the whole boundary: an argument that runs hostile code when it is
 * read (a throwing getter, a `Proxy`) is not guarded against.
 *
 * It aggregates in this process and keeps no identifier. `snapshot()` is what the private endpoint of S0.68 will serve; no
 * endpoint is here, and the registry opens no listener, file or connection.
 */
export class BoundedMetrics implements Metrics {
  readonly #policy: LabelPolicy;
  readonly #clock: Pick<Clock, 'monotonicMilliseconds'>;
  readonly #onDiagnostic: ((diagnostic: MetricDiagnostic) => void) | undefined;
  readonly #definitions: Readonly<Record<string, MetricDefinition>>;
  readonly #counters = new Map<string, CounterEntry>();
  readonly #observations = new Map<string, ObservationEntry>();
  /** When a diagnostic for a metric and reason was last given, and how many have been held back since. At most one entry per pair. */
  readonly #diagnosed = new Map<string, { at: number; suppressed: number }>();

  constructor(options: BoundedMetricsOptions) {
    this.#policy = options.policy;
    this.#clock = options.clock;
    this.#onDiagnostic = options.onDiagnostic;
    this.#definitions = options.definitions ?? METRIC_DEFINITIONS;
  }

  increment(name: string, labels: MetricLabels = {}): void {
    const checked = this.#check(name, 'counter', labels);
    if (checked === undefined) return;
    const entry = this.#counters.get(checked.key) ?? { name, labels: checked.labels, value: 0 };
    entry.value += 1;
    this.#counters.set(checked.key, entry);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const checked = this.#check(name, 'observation', labels);
    if (checked === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      this.#refuse({ reason: 'VALUE_INVALID', metric: name, label: undefined });
      return;
    }
    const entry = this.#observations.get(checked.key) ?? {
      name,
      labels: checked.labels,
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    };
    entry.count += 1;
    entry.sum += value;
    entry.min = Math.min(entry.min, value);
    entry.max = Math.max(entry.max, value);
    this.#observations.set(checked.key, entry);
  }

  snapshot(): MetricsSnapshot {
    const inOrder = <T>(entries: Map<string, T>): T[] =>
      [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry);
    return {
      counters: inOrder(this.#counters).map((entry) => ({
        name: entry.name,
        labels: { ...entry.labels },
        value: entry.value,
      })),
      observations: inOrder(this.#observations).map((entry) => ({
        name: entry.name,
        labels: { ...entry.labels },
        count: entry.count,
        sum: entry.sum,
        min: entry.min,
        max: entry.max,
      })),
    };
  }

  /** The series key and the labels as stored, or `undefined` when the sample was refused (thrown, or dropped and counted). */
  #check(
    name: string,
    kind: MetricDefinition['kind'],
    labels: MetricLabels,
  ): { key: string; labels: Record<string, string> } | undefined {
    const definition = Object.hasOwn(this.#definitions, name) ? this.#definitions[name] : undefined;
    if (definition === undefined) {
      this.#refuse({ reason: 'UNKNOWN_METRIC', metric: undefined, label: undefined });
      return undefined;
    }
    if (definition.kind !== kind) {
      this.#refuse({ reason: 'KIND_MISMATCH', metric: name, label: undefined });
      return undefined;
    }
    const expected = Object.keys(definition.labels).sort();
    // The container is judged before it is enumerated: `null` and an array are objects to `typeof`, and `Object.keys(null)` throws,
    // which in production would fail the operation being counted. The supported boundary is a record (see `isRecord`).
    const isContainer = isRecord(labels);
    const given = isContainer ? Object.keys(labels) : [];
    const matches =
      isContainer &&
      expected.length === given.length &&
      expected.every((label) => given.includes(label));
    if (!matches) {
      // The label at fault is one the catalogue names: the first expected label that is absent, else none.
      this.#refuse({
        reason: 'LABEL_SET_MISMATCH',
        metric: name,
        label: isContainer ? expected.find((label) => !given.includes(label)) : undefined,
      });
      return undefined;
    }
    const stored: Record<string, string> = {};
    for (const label of expected) {
      const value: unknown = labels[label];
      const allowed = definition.labels[label];
      if (typeof value !== 'string' || allowed?.includes(value) !== true) {
        this.#refuse({ reason: 'LABEL_VALUE_OUT_OF_SET', metric: name, label });
        return undefined;
      }
      stored[label] = value;
    }
    return {
      key: `${name}\u0000${expected.map((label) => `${label}=${stored[label] ?? ''}`).join('\u0000')}`,
      labels: stored,
    };
  }

  #refuse(refusal: Refusal): void {
    const metric = refusal.metric ?? '(unknown)';
    const labelPart = refusal.label === undefined ? '' : `, label ${refusal.label}`;
    if (this.#policy === 'throw') {
      const text =
        refusal.reason === 'UNKNOWN_METRIC'
          ? 'a metric that is not in the catalogue'
          : `metric ${metric}${labelPart}`;
      if (refusal.reason === 'KIND_MISMATCH' || refusal.reason === 'VALUE_INVALID') {
        throw new MetricsSampleError(`Metric sample refused (${refusal.reason}): ${text}`);
      }
      throw new MetricsLabelError(
        `Metric sample refused (LABEL_UNBOUNDED, ${refusal.reason}): ${text}`,
      );
    }

    // Production: drop, count, and say so within bounds. The counter is recorded directly: it is the registry's own.
    const dropKey = `metrics_samples_dropped_total\u0000reason=${refusal.reason}`;
    const dropped = this.#counters.get(dropKey) ?? {
      name: 'metrics_samples_dropped_total',
      labels: { reason: refusal.reason },
      value: 0,
    };
    dropped.value += 1;
    this.#counters.set(dropKey, dropped);

    const known = refusal.metric !== undefined && Object.hasOwn(this.#definitions, refusal.metric);
    const named = known ? refusal.metric : undefined;
    const pair = `${named ?? '(unknown)'}\u0000${refusal.reason}`;
    const now = this.#clock.monotonicMilliseconds();
    const last = this.#diagnosed.get(pair);
    if (last !== undefined && now - last.at < DIAGNOSTIC_INTERVAL_MS) {
      last.suppressed += 1;
      return;
    }
    this.#diagnosed.set(pair, { at: now, suppressed: 0 });
    try {
      this.#onDiagnostic?.({
        metric: named ?? '(unknown)',
        reason: refusal.reason,
        ...(refusal.label === undefined ? {} : { label: refusal.label }),
        suppressed: last?.suppressed ?? 0,
      });
    } catch {
      // A sink that fails (a full log, a closed stream) must not fail the operation that was counting: the drop is already counted.
    }
  }
}
