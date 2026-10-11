import type { PortDescriptor } from './port-descriptor.js';

/** Label values are an outcome class from a closed set, never an identifier, an address or a token. */
export type MetricLabels = Readonly<Record<string, string>>;

/**
 * A metrics registry with bounded labels (OBSERVABILITY_AND_RECOVERY.md §3). A label whose value is not from a bounded set is
 * both a leak and a cardinality fault. `LABEL_UNBOUNDED` is the **development and test validation** of that: it is raised there,
 * so that a programming defect fails a test. **In production the sample is dropped** and counted, and a bounded, redacted
 * diagnostic is given once per metric and reason per interval, so that counting never disrupts the operation it runs inside
 * (obligation OB-35, resolved in S0.15: `platform/metrics/bounded.metrics.adapter.ts` and plan section 7.13).
 */
export interface Metrics {
  increment(name: string, labels?: MetricLabels): void;
  observe(name: string, value: number, labels?: MetricLabels): void;
}

export const METRICS = Symbol('METRICS');

export const METRICS_DESCRIPTOR: PortDescriptor<Metrics> = {
  port: 'Metrics',
  owner: { kind: 'platform', area: 'metrics' },
  operations: {
    increment: {
      inputs: 'the metric name and its bounded labels',
      outputs:
        'nothing; an unbounded label raises LABEL_UNBOUNDED in development and test and is dropped, counted and diagnosed in production',
      outcomes: 'none',
      raises: ['LABEL_UNBOUNDED', 'METRIC_SAMPLE_INVALID'],
      transaction: 'independent',
    },
    observe: {
      inputs: 'the metric name, a value and its bounded labels',
      outputs:
        'nothing; an unbounded label raises LABEL_UNBOUNDED in development and test and is dropped, counted and diagnosed in production',
      outcomes: 'none',
      raises: ['LABEL_UNBOUNDED', 'METRIC_SAMPLE_INVALID'],
      transaction: 'independent',
    },
  },
};
