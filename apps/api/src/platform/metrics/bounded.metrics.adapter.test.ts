import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../test-support/manual-clock.js';
import {
  BoundedMetrics,
  DIAGNOSTIC_INTERVAL_MS,
  MetricsLabelError,
  MetricsSampleError,
  type MetricDiagnostic,
} from './bounded.metrics.adapter.js';

const make = (policy: 'throw' | 'drop') => {
  const clock = new ManualClock();
  const diagnostics: MetricDiagnostic[] = [];
  const metrics = new BoundedMetrics({
    policy,
    clock,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { clock, diagnostics, metrics };
};

const counter = (
  metrics: BoundedMetrics,
  name: string,
  labels: Record<string, string> = {},
): number =>
  metrics
    .snapshot()
    .counters.find(
      (entry) => entry.name === name && JSON.stringify(entry.labels) === JSON.stringify(labels),
    )?.value ?? 0;

describe('counting', () => {
  // Break caught: a sample lost or counted twice, or labels that make a counter a different series by their order.
  it('counts each series on its own, whatever order its labels are given in', () => {
    const { metrics } = make('throw');

    metrics.increment('rate_limited_total', {
      bucket: 'rate_limit_staff_signin',
      cause: 'BUCKET_CEILING',
    });
    metrics.increment('rate_limited_total', {
      cause: 'BUCKET_CEILING',
      bucket: 'rate_limit_staff_signin',
    });
    metrics.increment('rate_limited_total', {
      bucket: 'rate_limit_recovery',
      cause: 'BUCKET_CEILING',
    });
    metrics.increment('audit_enhanced_write_failed_total');

    expect(
      counter(metrics, 'rate_limited_total', {
        bucket: 'rate_limit_staff_signin',
        cause: 'BUCKET_CEILING',
      }),
    ).toBe(2);
    expect(
      counter(metrics, 'rate_limited_total', {
        bucket: 'rate_limit_recovery',
        cause: 'BUCKET_CEILING',
      }),
    ).toBe(1);
    expect(counter(metrics, 'audit_enhanced_write_failed_total')).toBe(1);
  });

  // Break caught: a snapshot that is not deterministic, which a scraper and a test both depend on.
  it('lists the series in a fixed order', () => {
    const { metrics } = make('throw');
    metrics.increment('credential_recovery_requests_excluded_total', { outcome: 'REJECTED' });
    metrics.increment('credential_recovery_requests_excluded_total', { outcome: 'RATE_LIMITED' });
    metrics.increment('audit_enhanced_write_failed_total');

    const names = metrics
      .snapshot()
      .counters.map((entry) => `${entry.name}:${JSON.stringify(entry.labels)}`);
    expect(names).toEqual([...names].sort());
  });
});

describe('an unbounded label in development and test (LABEL_UNBOUNDED)', () => {
  const attempts: [string, () => void][] = [
    [
      'a value outside the closed set',
      () => {
        make('throw').metrics.increment('credential_recovery_requests_excluded_total', {
          outcome: 'ama@example.test',
        });
      },
    ],
    [
      'a label the metric does not have',
      () => {
        make('throw').metrics.increment('credential_recovery_requests_excluded_total', {
          outcome: 'REJECTED',
          user: 'x',
        });
      },
    ],
    [
      'a label missing',
      () => {
        make('throw').metrics.increment('rate_limited_total', { bucket: 'rate_limit_recovery' });
      },
    ],
    [
      'labels given to a metric that has none',
      () => {
        make('throw').metrics.increment('audit_enhanced_write_failed_total', { who: 'x' });
      },
    ],
    [
      'a value that is not text',
      () => {
        make('throw').metrics.increment('credential_recovery_requests_excluded_total', {
          outcome: 7 as never,
        });
      },
    ],
    [
      'a bucket that is not one of the six',
      () => {
        make('throw').metrics.increment('rate_limited_total', {
          bucket: 'rate_limit_seventh',
          cause: 'BUCKET_CEILING',
        });
      },
    ],
    [
      'a metric that is not in the catalogue',
      () => {
        make('throw').metrics.increment('invented_total');
      },
    ],
  ];

  // Break caught: a defect that would leak or explode cardinality passing in a test.
  it.each(attempts)('raises LABEL_UNBOUNDED for %s', (_name, attempt) => {
    expect(attempt).toThrow(MetricsLabelError);
    try {
      attempt();
    } catch (error) {
      expect((error as MetricsLabelError).code).toBe('LABEL_UNBOUNDED');
    }
  });

  // Break caught: the offending value (an identifier, an address) echoed into an error, a log or a stored series.
  it('names the metric and the label and never the value', () => {
    const { metrics } = make('throw');

    try {
      metrics.increment('credential_recovery_requests_excluded_total', {
        outcome: 'ama@example.test',
      });
      expect.unreachable('the sample must be refused');
    } catch (error) {
      expect((error as Error).message).toContain('credential_recovery_requests_excluded_total');
      expect((error as Error).message).toContain('outcome');
      expect((error as Error).message).not.toContain('ama@example.test');
    }
    expect(JSON.stringify(metrics.snapshot())).not.toContain('ama@example.test');
    expect(metrics.snapshot().counters).toEqual([]);
  });
});

describe('what production does with an unbounded label (OB-35)', () => {
  // Break caught: a business operation failing because a metric had a bad label, or the bad sample being counted under a made-up series.
  it('drops the sample and goes on: nothing is raised and nothing is recorded under it', () => {
    const { metrics } = make('drop');

    expect(() => {
      metrics.increment('credential_recovery_requests_excluded_total', {
        outcome: 'ama@example.test',
      });
      metrics.increment('invented_total');
      metrics.increment('rate_limited_total', { bucket: 'rate_limit_recovery' });
    }).not.toThrow();

    expect(
      counter(metrics, 'credential_recovery_requests_excluded_total', {
        outcome: 'ama@example.test',
      }),
    ).toBe(0);
    // Only the registry's own account of the drops is recorded: one series for each of the three reasons, and no series for the sample.
    expect(metrics.snapshot().counters.map((entry) => entry.name)).toEqual([
      'metrics_samples_dropped_total',
      'metrics_samples_dropped_total',
      'metrics_samples_dropped_total',
    ]);
  });

  // Break caught (review of 10 October 2026, finding 7): a diagnostic sink that fails (a full log, a closed stream) failing the
  // operation that was counting, which the production policy exists to prevent.
  it('goes on when the diagnostic sink itself fails, and still counts the drop', () => {
    const metrics = new BoundedMetrics({
      policy: 'drop',
      clock: new ManualClock(),
      onDiagnostic: () => {
        throw new Error('the log is closed');
      },
    });

    expect(() => {
      metrics.increment('invented_total');
      metrics.increment('rate_limited_total', { bucket: 'rate_limit_recovery' });
    }).not.toThrow();

    expect(counter(metrics, 'metrics_samples_dropped_total', { reason: 'UNKNOWN_METRIC' })).toBe(1);
    expect(
      counter(metrics, 'metrics_samples_dropped_total', { reason: 'LABEL_SET_MISMATCH' }),
    ).toBe(1);
  });

  // Break caught: a dropped sample leaving no trace, so that a defect in the code that makes it is never found.
  it('counts what it drops, by reason, in a counter of its own', () => {
    const { metrics } = make('drop');
    metrics.increment('credential_recovery_requests_excluded_total', { outcome: 'bad-1' });
    metrics.increment('credential_recovery_requests_excluded_total', { outcome: 'bad-2' });
    metrics.increment('invented_total');
    metrics.increment('audit_enhanced_write_failed_total', { extra: 'x' });

    expect(
      counter(metrics, 'metrics_samples_dropped_total', { reason: 'LABEL_VALUE_OUT_OF_SET' }),
    ).toBe(2);
    expect(counter(metrics, 'metrics_samples_dropped_total', { reason: 'UNKNOWN_METRIC' })).toBe(1);
    expect(
      counter(metrics, 'metrics_samples_dropped_total', { reason: 'LABEL_SET_MISMATCH' }),
    ).toBe(1);
  });

  // Break caught: a diagnostic carrying the value (an identifier would reach a log), or a name made up by the caller.
  it('gives a bounded, redacted diagnostic: the metric and label names from the catalogue, the reason, never a value', () => {
    const { diagnostics, metrics } = make('drop');

    metrics.increment('credential_recovery_requests_excluded_total', {
      outcome: 'ama@example.test',
    });
    metrics.increment('ama@example.test_total');

    expect(diagnostics).toEqual([
      {
        metric: 'credential_recovery_requests_excluded_total',
        reason: 'LABEL_VALUE_OUT_OF_SET',
        label: 'outcome',
        suppressed: 0,
      },
      { metric: '(unknown)', reason: 'UNKNOWN_METRIC', suppressed: 0 },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('ama@example.test');
  });

  // Break caught: a defect in a hot path flooding the log, one line per request.
  it('says it once per metric and reason, then at most once an interval, with the count it held back', () => {
    const { clock, diagnostics, metrics } = make('drop');
    const bad = () => {
      metrics.increment('credential_recovery_requests_excluded_total', { outcome: 'bad' });
    };

    for (let attempt = 0; attempt < 500; attempt += 1) bad();
    expect(diagnostics).toHaveLength(1);

    clock.advance(DIAGNOSTIC_INTERVAL_MS - 1);
    bad();
    expect(diagnostics).toHaveLength(1);

    clock.advance(1);
    bad();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[1]?.suppressed).toBe(500);
  });

  // Break caught: memory growing with the number of distinct bad names or values (the sample itself is an attack surface).
  it('holds nothing per bad value: a thousand distinct bad samples leave the state as it was', () => {
    const { metrics } = make('drop');
    const before = JSON.stringify(metrics.snapshot());
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      metrics.increment('credential_recovery_requests_excluded_total', {
        outcome: `bad-${String(attempt)}`,
      });
      metrics.increment(`made_up_${String(attempt)}_total`);
    }

    const after = metrics.snapshot();
    expect(after.counters.map((entry) => entry.name)).toEqual([
      'metrics_samples_dropped_total',
      'metrics_samples_dropped_total',
    ]);
    expect(JSON.stringify(after)).not.toContain('bad-');
    expect(JSON.stringify(after)).not.toContain('made_up');
    expect(before).toBe(JSON.stringify({ counters: [], observations: [] }));
  });

  // Break caught: valid samples lost because invalid ones were seen.
  it('keeps counting the valid samples', () => {
    const { metrics } = make('drop');
    metrics.increment('credential_recovery_requests_excluded_total', { outcome: 'bad' });
    metrics.increment('credential_recovery_requests_excluded_total', { outcome: 'REJECTED' });

    expect(
      counter(metrics, 'credential_recovery_requests_excluded_total', { outcome: 'REJECTED' }),
    ).toBe(1);
  });
});

/**
 * G2-08. The supported boundary of the labels argument is **a record**: an object that is not null and not an array, whose own
 * enumerable properties are the labels, plain data in the application's own code. Anything else is refused before it is enumerated
 * (`Object.keys(null)` threw, with production's drop behaviour selected). Defence against arbitrary hostile JavaScript is not
 * claimed: a Proxy or a getter that throws is the caller running code in the process, which no argument check can contain.
 */
describe('a labels argument that is not a record (G2-08)', () => {
  const containers: [string, unknown][] = [
    ['null', null],
    ['an empty array', []],
    ['an array with an element', ['REJECTED']],
    ['text', 'REJECTED'],
    ['a number', 7],
    ['a boolean', true],
    ['a function', () => ({ outcome: 'REJECTED' })],
    ['a symbol', Symbol('labels')],
    ['a bigint', 10n],
  ];
  const withAndWithoutLabels = (metrics: BoundedMetrics, container: unknown) => {
    metrics.increment('credential_recovery_requests_excluded_total', container as never);
    metrics.increment('audit_enhanced_write_failed_total', container as never);
  };

  // Break caught: a malformed container reaching Object.keys, so that counting fails the operation it was counting, in production,
  // where a sample that cannot be counted is dropped and nothing is raised; or an array being taken for a record of no labels.
  it.each(containers)(
    'drops %s in production, counts the drop and raises nothing',
    (_name, container) => {
      const { metrics, diagnostics } = make('drop');

      expect(() => {
        withAndWithoutLabels(metrics, container);
      }).not.toThrow();

      expect(
        counter(metrics, 'metrics_samples_dropped_total', { reason: 'LABEL_SET_MISMATCH' }),
      ).toBe(2);
      expect(counter(metrics, 'audit_enhanced_write_failed_total')).toBe(0);
      // one diagnostic for each metric, naming the metric and the reason, and nothing of the container
      expect(diagnostics.map((diagnostic) => diagnostic.metric).toSorted()).toEqual([
        'audit_enhanced_write_failed_total',
        'credential_recovery_requests_excluded_total',
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain('REJECTED');
    },
  );

  // Break caught: the same for an observation, whose labels are checked by the same code.
  it.each(containers)('drops %s given to an observation in production', (_name, container) => {
    const metrics = new BoundedMetrics({
      policy: 'drop',
      clock: new ManualClock(),
      definitions: {
        request_seconds: {
          kind: 'observation',
          labels: { outcome: ['OK', 'FAILED'] },
          description: 'x',
        },
      },
    });

    expect(() => {
      metrics.observe('request_seconds', 1, container as never);
    }).not.toThrow();

    expect(metrics.snapshot().observations).toEqual([]);
    expect(
      counter(metrics, 'metrics_samples_dropped_total', { reason: 'LABEL_SET_MISMATCH' }),
    ).toBe(1);
  });

  // Break caught: the refusal in development and test being a crash of another kind (a TypeError from Object.keys), or no refusal.
  it.each(containers)(
    'raises LABEL_UNBOUNDED for %s in development and test',
    (_name, container) => {
      expect(() => {
        make('throw').metrics.increment(
          'credential_recovery_requests_excluded_total',
          container as never,
        );
      }).toThrow(MetricsLabelError);
      expect(() => {
        make('throw').metrics.increment('audit_enhanced_write_failed_total', container as never);
      }).toThrow(MetricsLabelError);
    },
  );

  // Break caught: the default being lost: a call with no labels argument at all is a call with no labels, for a metric that has none,
  // and a missing label for one that has some.
  it('treats no labels argument as no labels', () => {
    const { metrics } = make('drop');

    metrics.increment('audit_enhanced_write_failed_total');
    metrics.increment('audit_enhanced_write_failed_total', undefined);
    metrics.increment('credential_recovery_requests_excluded_total');

    expect(counter(metrics, 'audit_enhanced_write_failed_total')).toBe(2);
    expect(
      counter(metrics, 'metrics_samples_dropped_total', { reason: 'LABEL_SET_MISMATCH' }),
    ).toBe(1);
    expect(() => {
      make('throw').metrics.increment('credential_recovery_requests_excluded_total');
    }).toThrow(MetricsLabelError);
  });

  // Break caught: a record with no prototype (what a parser may hand back) being refused as a malformed container.
  it('accepts a record with no prototype and a class instance, which are records', () => {
    const { metrics } = make('throw');
    const bare = Object.assign(Object.create(null) as Record<string, string>, {
      outcome: 'REJECTED',
    });
    class Labels {
      readonly outcome = 'UNKNOWN_OR_INELIGIBLE';
    }

    metrics.increment('credential_recovery_requests_excluded_total', bare);
    metrics.increment('credential_recovery_requests_excluded_total', new Labels() as never);

    expect(
      counter(metrics, 'credential_recovery_requests_excluded_total', { outcome: 'REJECTED' }),
    ).toBe(1);
    expect(
      counter(metrics, 'credential_recovery_requests_excluded_total', {
        outcome: 'UNKNOWN_OR_INELIGIBLE',
      }),
    ).toBe(1);
  });
});

describe('observing a value', () => {
  const definitions = {
    request_seconds: {
      kind: 'observation',
      labels: { outcome: ['OK', 'FAILED'] },
      description: 'A catalogue of the test: a duration, by outcome.',
    },
    events_total: { kind: 'counter', labels: {}, description: 'A counter of the test.' },
  } as const;
  const observer = (policy: 'throw' | 'drop') =>
    new BoundedMetrics({ policy, clock: new ManualClock(), definitions });

  // Break caught: an observation not summarised (count, sum, extremes), or one series’ values mixed into another’s.
  it('summarises the observations of each series by their count, sum, least and greatest', () => {
    const metrics = observer('throw');
    metrics.observe('request_seconds', 0.5, { outcome: 'OK' });
    metrics.observe('request_seconds', 1.5, { outcome: 'OK' });
    metrics.observe('request_seconds', 0, { outcome: 'OK' });
    metrics.observe('request_seconds', 9, { outcome: 'FAILED' });

    expect(metrics.snapshot().observations).toEqual([
      { name: 'request_seconds', labels: { outcome: 'FAILED' }, count: 1, sum: 9, min: 9, max: 9 },
      { name: 'request_seconds', labels: { outcome: 'OK' }, count: 3, sum: 2, min: 0, max: 1.5 },
    ]);
  });

  // Break caught: a value that is not a measurement (negative, not finite, not a number) being summed in.
  it('refuses a value that is not a finite number of at least zero, and the wrong kind of call', () => {
    const metrics = observer('throw');

    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1' as never]) {
      expect(() => {
        metrics.observe('request_seconds', value, { outcome: 'OK' });
      }).toThrow(MetricsSampleError);
    }
    expect(() => {
      metrics.increment('request_seconds', { outcome: 'OK' });
    }).toThrow(MetricsSampleError);
    expect(() => {
      metrics.observe('events_total', 1);
    }).toThrow(MetricsSampleError);
    expect(metrics.snapshot().observations).toEqual([]);
  });

  // Break caught: a bad value in production failing the operation, or being summed in.
  it('drops a bad value in production, counted under its reason', () => {
    const metrics = observer('drop');

    expect(() => {
      metrics.observe('request_seconds', -1, { outcome: 'OK' });
      metrics.observe('request_seconds', 2, { outcome: 'bad' });
      metrics.increment('request_seconds', { outcome: 'OK' });
    }).not.toThrow();

    expect(metrics.snapshot().observations).toEqual([]);
    expect(counter(metrics, 'metrics_samples_dropped_total', { reason: 'VALUE_INVALID' })).toBe(1);
    expect(
      counter(metrics, 'metrics_samples_dropped_total', { reason: 'LABEL_VALUE_OUT_OF_SET' }),
    ).toBe(1);
    expect(counter(metrics, 'metrics_samples_dropped_total', { reason: 'KIND_MISMATCH' })).toBe(1);
  });
});
