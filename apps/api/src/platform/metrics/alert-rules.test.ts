import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ALERT_RULES, firingAlerts, parseExposition, type Scrape } from './alert-rules.js';
import { BoundedMetrics } from './bounded.metrics.adapter.js';
import { renderExposition } from './exposition.js';
import { METRIC_DEFINITIONS } from './metric-catalogue.js';

const MINUTE = 60_000;

/** A scrape of one instance at `minutes`, with the given series. */
const scrape = (
  minutes: number,
  samples: Record<string, number>,
  instance = 'worker-1',
): Scrape => ({
  at: minutes * MINUTE,
  instance,
  samples: new Map(Object.entries(samples)),
});

const firing = (history: readonly Scrape[]): string[] =>
  firingAlerts(history)
    .map((rule) => rule.id)
    .toSorted();

const AGE = 'credential_delivery_oldest_due_age_seconds';
const attempts = (channel: string, result: string) =>
  `credential_delivery_attempts_total{channel="${channel}",result="${result}"}`;

describe('the alert rules of the credential path and the trust data (S0.68)', () => {
  it('read what the exposition writes', () => {
    const metrics = new BoundedMetrics({
      policy: 'throw',
      clock: { monotonicMilliseconds: () => 0 },
    });
    metrics.increment('credential_delivery_attempts_total', {
      channel: 'EMAIL',
      result: 'REJECTED',
    });
    const samples = parseExposition(
      renderExposition(metrics.snapshot(), [{ name: AGE, value: 3 }]),
    );
    expect(samples.get(attempts('EMAIL', 'REJECTED'))).toBe(1);
    expect(samples.get(attempts('EMAIL', 'ACCEPTED'))).toBe(0);
    expect(samples.get(AGE)).toBe(3);
    expect(() => parseExposition('not a sample')).toThrow();
  });

  it('fire nothing on a quiet history', () => {
    expect(firing([scrape(0, { [AGE]: 0 }), scrape(20, { [AGE]: 0 })])).toEqual([]);
  });

  describe('the backlog of credential messages (Queue thresholds: a blocking queue)', () => {
    // Break caught: a backlog alert that pages on one slow reading, or never pages on one that lasts.
    it('warns when a message has been due for more than 2 minutes for 15 minutes, and not for less', () => {
      const old = Array.from({ length: 16 }, (_, minute) =>
        scrape(minute, { [AGE]: 121 + minute * 60 }),
      );
      expect(firing(old)).toContain('credential_delivery_backlog_warning');
      expect(firing(old.slice(2))).not.toContain('credential_delivery_backlog_warning');
      const broken = old.map((entry, index) => (index === 8 ? scrape(8, { [AGE]: 120 }) : entry));
      expect(firing(broken)).not.toContain('credential_delivery_backlog_warning');
    });

    it('is SEV-2 the moment a message has been due for more than 10 minutes', () => {
      expect(firing([scrape(0, { [AGE]: 601 })])).toContain('credential_delivery_backlog_blocking');
      expect(firing([scrape(0, { [AGE]: 600 })])).not.toContain(
        'credential_delivery_backlog_blocking',
      );
    });
  });

  describe('the dead letter and the expired lease (Credential delivery)', () => {
    it('fires on any terminal failure, and on any lease that expired with no outcome, and not on a counter that stood still', () => {
      const failed = 'credential_delivery_jobs_failed_total{outcome="REJECTED"}';
      const leases = 'credential_delivery_leases_expired_total';
      expect(
        firing([scrape(0, { [failed]: 0, [leases]: 0 }), scrape(1, { [failed]: 1, [leases]: 0 })]),
      ).toEqual(['credential_delivery_terminal_failure']);
      expect(
        firing([scrape(0, { [failed]: 2, [leases]: 0 }), scrape(1, { [failed]: 2, [leases]: 1 })]),
      ).toEqual(['credential_delivery_lease_expired']);
      expect(
        firing([scrape(0, { [failed]: 2, [leases]: 1 }), scrape(1, { [failed]: 2, [leases]: 1 })]),
      ).toEqual([]);
    });

    it('reads a counter that fell as a process that restarted and counted again', () => {
      const failed = 'credential_delivery_jobs_failed_total{outcome="SCHEDULE_EXHAUSTED"}';
      expect(firing([scrape(0, { [failed]: 5 }), scrape(1, { [failed]: 1 })])).toContain(
        'credential_delivery_terminal_failure',
      );
    });
  });

  describe('a provider that fails (Provider down)', () => {
    const history = (accepted: number, rejected: number, unknown = 0, span = 10): Scrape[] => [
      scrape(0, {
        [attempts('SMS', 'ACCEPTED')]: 0,
        [attempts('SMS', 'REJECTED')]: 0,
        [attempts('SMS', 'UNKNOWN')]: 0,
      }),
      scrape(span, {
        [attempts('SMS', 'ACCEPTED')]: accepted,
        [attempts('SMS', 'REJECTED')]: rejected,
        [attempts('SMS', 'UNKNOWN')]: unknown,
      }),
    ];

    // Break caught: a percentage judged on too few attempts (section 3.2a), which is noise reported as an outage.
    it('judges no percentage below 20 attempts', () => {
      expect(firing(history(10, 9))).not.toContain('provider_down_sms_success_rate');
      expect(firing(history(15, 4))).not.toContain('provider_down_sms_failure_rate');
    });

    it('warns above 5% failures and is SEV-2 below 80% success, counting a timeout as a failure', () => {
      expect(firing(history(19, 1, 0, 15))).toEqual([]);
      expect(firing(history(18, 1, 1, 15))).toEqual(['provider_down_sms_failure_rate']);
      expect(firing(history(15, 3, 2))).toEqual([
        'provider_down_sms_failure_rate',
        'provider_down_sms_success_rate',
      ]);
    });

    // Break caught: the volume-free tripwire missing a quiet outage, or firing on a run a success broke.
    it('is SEV-2 on five failures in a row at any volume, and not when a success broke the run', () => {
      const run = (counts: readonly [number, number][]) =>
        counts.map(([accepted, failed], minute) =>
          scrape(minute, {
            [attempts('EMAIL', 'ACCEPTED')]: accepted,
            [attempts('EMAIL', 'REJECTED')]: failed,
          }),
        );
      expect(
        firing(
          run([
            [1, 0],
            [1, 2],
            [1, 5],
          ]),
        ),
      ).toEqual(['provider_down_email_consecutive_failures']);
      expect(
        firing(
          run([
            [1, 0],
            [1, 2],
            [2, 4],
            [2, 6],
          ]),
        ),
      ).toEqual([]);
    });
  });

  describe('the attestation trust data (Attestation trust data aging)', () => {
    const TRUST = 'attestation_trust_data_age_seconds';
    const ROOTS = 'attestation_trust_roots_load_failures_total';

    it('warns past 12 hours and is SEV-2 past 24 hours, judged on the oldest instance', () => {
      const at = (hours: number, instance: string) =>
        scrape(0, { [TRUST]: hours * 3600, [ROOTS]: 0 }, instance);
      expect(firing([at(11, 'verifier-1'), at(12, 'verifier-2')])).toEqual([]);
      expect(firing([at(1, 'verifier-1'), at(12.01, 'verifier-2')])).toEqual([
        'attestation_trust_data_aging_warning',
      ]);
      expect(firing([at(24.01, 'verifier-1'), at(1, 'verifier-2')])).toEqual([
        'attestation_trust_data_aging_critical',
        'attestation_trust_data_aging_warning',
      ]);
    });

    it('is SEV-2 when the accepted roots could not be loaded', () => {
      expect(
        firing([
          scrape(0, { [TRUST]: 60, [ROOTS]: 0 }, 'v'),
          scrape(1, { [TRUST]: 120, [ROOTS]: 1 }, 'v'),
        ]),
      ).toEqual(['attestation_trust_data_aging_critical']);
    });
  });

  // Break caught: a series renamed in the catalogue, or a label value taken out of it, that the rules still read by the old name: they would
  // never fire again, and nothing would fail.
  it('read only series the catalogue defines or the verifier serves, and label values the catalogue allows', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'alert-rules.ts'), 'utf8');
    const verifier = new Set([
      'attestation_trust_data_age_seconds',
      'attestation_trust_roots_load_failures_total',
    ]);
    const named = [
      ...new Set(
        [...source.matchAll(/'([a-z]+(?:_[a-z]+)*_(?:total|seconds))'/g)].map((m) => m[1]),
      ),
    ];
    expect(named.length).toBeGreaterThanOrEqual(6);
    for (const name of named) {
      expect(
        name !== undefined && (name in METRIC_DEFINITIONS || verifier.has(name)),
        `${String(name)} is neither in the catalogue nor served by the verifier`,
      ).toBe(true);
    }
    const attempts = METRIC_DEFINITIONS.credential_delivery_attempts_total.labels;
    expect(attempts.channel).toEqual(expect.arrayContaining(['EMAIL', 'SMS']));
    expect(attempts.result).toEqual(expect.arrayContaining(['ACCEPTED', 'REJECTED', 'UNKNOWN']));
  });

  // Break caught: a threshold changed in the rules and not in the document that owns it, or the other way round.
  it('take every number from OBSERVABILITY_AND_RECOVERY.md section 3.2 and 3.2a, which still states them', () => {
    const document = readFileSync(
      resolve(import.meta.dirname, '../../../../../architecture/OBSERVABILITY_AND_RECOVERY.md'),
      'utf8',
    );
    const row = (domain: string): string =>
      document.split('\n').find((line) => line.startsWith(`| **${domain}**|`)) ?? '';
    expect(row('Queue')).toContain('oldest message **>2 minutes** for 15 minutes');
    expect(row('Queue')).toContain('blocking or operational oldest **>10 minutes**');
    expect(row('Provider')).toContain(
      'failure rate **>5%** for 15 minutes across **at least 20 attempts**',
    );
    expect(row('Provider')).toContain(
      'success rate **<80%** for 10 minutes across **at least 20 attempts**',
    );
    expect(row('Provider')).toContain('**five consecutive failures** regardless of volume');
    expect(row('Attestation trust data')).toContain('older than 12 hours');
    expect(row('Attestation trust data')).toContain(
      'older than 24 hours**, or the accepted roots cannot be loaded',
    );
    expect(row('Dead letters')).toContain('**any** financial or security-sensitive dead letter');
    expect(document).toContain('| **Provider percentage thresholds**| **20 provider attempts**|');
    expect(new Set(ALERT_RULES.map((rule) => rule.id)).size).toBe(ALERT_RULES.length);
  });
});
