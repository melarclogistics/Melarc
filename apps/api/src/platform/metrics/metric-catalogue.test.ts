import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RATE_LIMIT_BUCKETS } from '../auth/ports/rate-limiter.port.js';
import { DELIVERY_CHANNELS, TERMINAL_FAILURE_CLASSES } from '../delivery/delivery-vocabulary.js';
import { METRIC_DEFINITIONS, labelPolicyFor, metricNames } from './metric-catalogue.js';

const OBSERVABILITY = readFileSync(
  resolve(import.meta.dirname, '../../../../../architecture/OBSERVABILITY_AND_RECOVERY.md'),
  'utf8',
).replaceAll('\r', '');

describe('the metric catalogue', () => {
  // Break caught: the counter the specification names missing, or its outcomes drifting from the document that owns them.
  it('holds credential_recovery_requests_excluded_total with exactly the outcomes the document states', () => {
    const sentence =
      /`credential_recovery_requests_excluded_total`, whose single label is the outcome \(([^)]*)\)/.exec(
        OBSERVABILITY,
      );
    const outcomes = [...(sentence?.[1] ?? '').matchAll(/`([A-Z_]+)`/g)].map((match) => match[1]);

    expect(outcomes).toEqual(['UNKNOWN_OR_INELIGIBLE', 'RATE_LIMITED', 'REJECTED']);
    expect(METRIC_DEFINITIONS.credential_recovery_requests_excluded_total).toMatchObject({
      kind: 'counter',
      labels: { outcome: outcomes },
    });
    expect(
      Object.keys(METRIC_DEFINITIONS.credential_recovery_requests_excluded_total.labels),
    ).toEqual(['outcome']);
  });

  // Break caught: the rate-limited counter carrying a seventh bucket, or an unlisted cause (the document counts per bucket and per cause).
  it('counts RATE_LIMITED per bucket and per cause, over the six buckets and no other', () => {
    const definition = METRIC_DEFINITIONS.rate_limited_total;

    expect(definition.kind).toBe('counter');
    expect(Object.keys(definition.labels)).toEqual(['bucket', 'cause']);
    expect(definition.labels.bucket).toEqual([...RATE_LIMIT_BUCKETS]);
    expect(definition.labels.cause).toEqual([
      'BUCKET_CEILING',
      'STORE_CAPACITY',
      'KEY_TOO_LONG',
      'HASH_ADMISSION_FULL',
    ]);
    expect(OBSERVABILITY).toContain('RATE_LIMITED` refusals are counted per bucket and per cause');
  });

  // Break caught (S0.18): the delivery worker's counters missing, carrying a label that is not a closed set, or drifting from the
  // vocabulary of the jobs they count or from the document that names them.
  it('counts the delivery worker’s attempts, terminal failures and expired leases, by closed sets', () => {
    const attempts = METRIC_DEFINITIONS.credential_delivery_attempts_total;
    const failed = METRIC_DEFINITIONS.credential_delivery_jobs_failed_total;
    const expired = METRIC_DEFINITIONS.credential_delivery_leases_expired_total;

    expect(attempts.kind).toBe('counter');
    expect(Object.keys(attempts.labels)).toEqual(['channel', 'result']);
    expect(attempts.labels.channel).toEqual([...DELIVERY_CHANNELS]);
    expect(attempts.labels.result).toEqual([
      'ACCEPTED',
      'UNKNOWN',
      'REJECTED',
      'DESTINATION_NOT_ALLOWED',
    ]);
    expect(failed.kind).toBe('counter');
    expect(Object.keys(failed.labels)).toEqual(['outcome']);
    expect(failed.labels.outcome).toEqual([...TERMINAL_FAILURE_CLASSES]);
    expect(expired.kind).toBe('counter');
    expect(expired.labels).toEqual({});
    expect(METRIC_DEFINITIONS.rate_limiter_key_incompatible_total.labels).toEqual({});
    const deferred = METRIC_DEFINITIONS.credential_delivery_jobs_deferred_total;
    expect(deferred.kind).toBe('counter');
    expect(Object.keys(deferred.labels)).toEqual(['reason']);
    expect(deferred.labels.reason).toEqual(['PAYLOAD_NOT_HELD', 'REDEMPTION_UNCONFIRMED']);
    for (const name of [
      'credential_delivery_attempts_total',
      'credential_delivery_jobs_failed_total',
      'credential_delivery_jobs_deferred_total',
      'credential_delivery_leases_expired_total',
      'rate_limiter_key_incompatible_total',
    ]) {
      expect(OBSERVABILITY, name).toContain(`\`${name}\``);
    }
  });

  // Break caught: a label whose values are not a fixed small set (an identifier, an address, a token) entering the catalogue.
  it('has only labels with a closed, small set of upper-case values, and no label named for an identifier', () => {
    for (const [name, definition] of Object.entries(METRIC_DEFINITIONS)) {
      expect(name, name).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const [label, values] of Object.entries(definition.labels)) {
        expect(label, `${name}.${label}`).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(label, `${name}.${label}`).not.toMatch(
          /id|email|phone|address|token|session|key|destination/,
        );
        expect(values.length, `${name}.${label}`).toBeGreaterThan(0);
        expect(values.length, `${name}.${label}`).toBeLessThanOrEqual(10);
        for (const value of values)
          expect(value, `${name}.${label}`).toMatch(/^[a-z][a-z0-9_]*$|^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  // Break caught: a counter not named as a counter, which a scraper would read as a gauge.
  it('names every counter with the _total suffix', () => {
    for (const name of metricNames()) {
      const definition = METRIC_DEFINITIONS[name];
      if (definition.kind === 'counter') expect(name).toMatch(/_total$/);
    }
  });

  // Break caught: the catalogue changeable at run time, which would let code add an unbounded metric.
  it('is frozen, down to the value sets', () => {
    expect(Object.isFrozen(METRIC_DEFINITIONS)).toBe(true);
    for (const definition of Object.values(METRIC_DEFINITIONS)) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.labels)).toBe(true);
      for (const values of Object.values(definition.labels))
        expect(Object.isFrozen(values)).toBe(true);
    }
  });

  // Break caught: production behaving like development (a request failing on a metric), or development like production (a defect hidden).
  it('throws on an unbounded label in development and test, and drops with a diagnostic in production (OB-35)', () => {
    expect(labelPolicyFor('development')).toBe('throw');
    expect(labelPolicyFor('test')).toBe('throw');
    expect(labelPolicyFor('production')).toBe('drop');
  });
});
