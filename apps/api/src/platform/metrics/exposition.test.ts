import { describe, expect, it } from 'vitest';

import { BoundedMetrics } from './bounded.metrics.adapter.js';
import { renderExposition } from './exposition.js';
import { METRIC_DEFINITIONS, type MetricDefinition } from './metric-catalogue.js';

const clock = { monotonicMilliseconds: () => 0 };
const registry = () => new BoundedMetrics({ policy: 'throw', clock });

describe('the metrics exposition (S0.68)', () => {
  // Break caught: a counter that first appears at 1, so that an increase over a window misses the first terminal failure.
  it('serves every series of every counter, at zero until it moves', () => {
    const metrics = registry();
    metrics.increment('credential_delivery_jobs_failed_total', { outcome: 'REJECTED' });
    const text = renderExposition(metrics.snapshot(), []);

    expect(text).toContain('# TYPE credential_delivery_jobs_failed_total counter');
    expect(text).toContain('credential_delivery_jobs_failed_total{outcome="REJECTED"} 1');
    expect(text).toContain('credential_delivery_jobs_failed_total{outcome="SCHEDULE_EXHAUSTED"} 0');
    expect(text).toContain('credential_delivery_leases_expired_total 0');
    const attempts = METRIC_DEFINITIONS.credential_delivery_attempts_total.labels;
    const series = text
      .split('\n')
      .filter((line) => line.startsWith('credential_delivery_attempts_total{'));
    expect(series).toHaveLength((attempts.channel?.length ?? 0) * (attempts.result?.length ?? 0));
  });

  it('serves an observation as a summary of its sum and count, and only once it has been observed', () => {
    const definitions: Record<string, MetricDefinition> = {
      took_seconds: { kind: 'observation', labels: { step: ['a'] }, description: 'How long.' },
    };
    const metrics = new BoundedMetrics({ policy: 'throw', clock, definitions });
    expect(renderExposition(metrics.snapshot(), [], definitions)).toBe('\n');
    metrics.observe('took_seconds', 1.5, { step: 'a' });
    metrics.observe('took_seconds', 0.5, { step: 'a' });

    expect(renderExposition(metrics.snapshot(), [], definitions)).toBe(
      [
        '# HELP took_seconds How long.',
        '# TYPE took_seconds summary',
        'took_seconds_sum{step="a"} 2',
        'took_seconds_count{step="a"} 2',
        '',
      ].join('\n'),
    );
  });

  it('serves a gauge read at the time, and refuses one the catalogue does not hold as a gauge', () => {
    const text = renderExposition(registry().snapshot(), [
      { name: 'credential_delivery_oldest_due_age_seconds', value: 125.5 },
    ]);
    expect(text).toContain('# TYPE credential_delivery_oldest_due_age_seconds gauge');
    expect(text).toContain('credential_delivery_oldest_due_age_seconds 125.5');

    // Break caught: a gauge that could carry an identifier as a label, or a counter served as a gauge.
    expect(() =>
      renderExposition(registry().snapshot(), [
        { name: 'credential_delivery_leases_expired_total', value: 1 },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      renderExposition(registry().snapshot(), [
        {
          name: 'credential_delivery_oldest_due_age_seconds',
          value: 1,
          labels: { job: '0190d7c2' },
        },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      renderExposition(registry().snapshot(), [
        { name: 'credential_delivery_oldest_due_age_seconds', value: Number.NaN },
      ]),
    ).toThrow(RangeError);
  });

  it('writes each metric’s help and type once, in the order of the names, and nothing it was not given', () => {
    const text = renderExposition(registry().snapshot(), []);
    const types = text.split('\n').filter((line) => line.startsWith('# TYPE '));
    const names = types.map((line) => line.split(' ')[2] ?? '');
    expect(names).toEqual(names.toSorted());
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('credential_delivery_oldest_due_age_seconds');
    for (const line of text.split('\n').filter((entry) => entry !== '' && !entry.startsWith('#'))) {
      expect(line).toMatch(
        /^[a-z_]+(\{[a-z_]+="[A-Za-z0-9_.:-]+"(,[a-z_]+="[A-Za-z0-9_.:-]+")*\})? \d+(\.\d+)?$/,
      );
    }
  });
});
