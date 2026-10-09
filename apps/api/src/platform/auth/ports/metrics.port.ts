import type { PortDescriptor } from './port-descriptor.js';

/** Label values are an outcome class from a closed set, never an identifier, an address or a token. */
export type MetricLabels = Readonly<Record<string, string>>;

/**
 * A metrics registry with bounded labels (OBSERVABILITY_AND_RECOVERY.md §3). A label whose value is not from a bounded set is
 * both a leak and a cardinality fault. `LABEL_UNBOUNDED` is the **development and test validation** of that: it is raised there,
 * so that a programming defect fails a test. It says nothing about production. **What production does with such a sample is an
 * explicit implementation obligation of S0.15** (plan section 5, S0.15; obligation OB-35): that task defines, implements and
 * tests it, and records the choice, so production behaviour is never left implicit.
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
        'nothing; an unbounded label raises LABEL_UNBOUNDED in development and test (production: OB-35)',
      outcomes: 'none',
      raises: ['LABEL_UNBOUNDED'],
      transaction: 'independent',
    },
    observe: {
      inputs: 'the metric name, a value and its bounded labels',
      outputs:
        'nothing; an unbounded label raises LABEL_UNBOUNDED in development and test (production: OB-35)',
      outcomes: 'none',
      raises: ['LABEL_UNBOUNDED'],
      transaction: 'independent',
    },
  },
};
