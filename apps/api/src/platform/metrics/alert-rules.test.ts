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

describe('the alert rules of the business texts (S1.12e; the Product Owner’s thresholds of 30 October 2026)', () => {
  const TEXT_AGE = 'notification_oldest_due_age_seconds';
  const sends = (result: string) => `notification_sends_total{result="${result}"}`;
  const relay = (outcome: string) => `notification_relay_total{outcome="${outcome}"}`;
  /** Scrapes every five minutes up to `minutes`, the series growing linearly from `from` to `to`. */
  const growing = (minutes: number, series: Record<string, readonly [number, number]>): Scrape[] =>
    Array.from({ length: minutes / 5 + 1 }, (_, step) =>
      scrape(
        step * 5,
        Object.fromEntries(
          Object.entries(series).map(([name, [from, to]]) => [
            name,
            from + ((to - from) * step) / (minutes / 5),
          ]),
        ),
      ),
    );

  it('fire nothing on a quiet history', () => {
    expect(
      firing(
        growing(20, {
          [TEXT_AGE]: [0, 0],
          [sends('SENT')]: [10, 30],
          [relay('MATERIALISED')]: [5, 25],
        }),
      ),
    ).toEqual([]);
  });

  describe('the backlog of business texts', () => {
    // Break caught: a backlog alert that pages on one slow reading, or never pages on one that lasts.
    it('warns when work has been due for more than 5 minutes for 15 minutes, and not for less', () => {
      const old = Array.from({ length: 16 }, (_, minute) =>
        scrape(minute, { [TEXT_AGE]: 301 + minute * 60 }),
      );
      expect(firing(old)).toEqual(['text_messages_backlog_warning']);
      expect(firing(old.slice(0, 14))).toEqual([]);
      const brief = Array.from({ length: 16 }, (_, minute) =>
        scrape(minute, { [TEXT_AGE]: minute === 7 ? 0 : 400 }),
      );
      expect(firing(brief)).toEqual([]);
    });

    // Break caught: the boundary read as the other side, so that exactly five minutes pages.
    it('does not warn at exactly 5 minutes', () => {
      expect(
        firing(Array.from({ length: 16 }, (_, minute) => scrape(minute, { [TEXT_AGE]: 300 }))),
      ).toEqual([]);
    });

    // Break caught: a worker that predates the series read as one with a backlog of zero, or of everything.
    it('does not warn of a worker that serves no such gauge', () => {
      expect(
        firing(Array.from({ length: 16 }, (_, minute) => scrape(minute, { [AGE]: 0 }))),
      ).toEqual([]);
    });
  });

  describe('the dead letter', () => {
    // Break caught: an act whose messages were never made, going unnoticed because the message log cannot show it.
    it.each(['UNKNOWN_EVENT', 'SCHEDULE_EXHAUSTED'])(
      'raises a finding when an envelope goes to the dead letter as %s',
      (outcome) => {
        expect(
          firing([scrape(0, { [relay(outcome)]: 0 }), scrape(5, { [relay(outcome)]: 1 })]),
        ).toEqual(['text_messages_dead_letter']);
      },
    );

    // Break caught: the ordinary outcomes of a relay read as dead letters.
    it.each(['MATERIALISED', 'NOTHING_TO_SEND', 'RETRY'])(
      'does not for a relay that ends as %s',
      (outcome) => {
        expect(
          firing([scrape(0, { [relay(outcome)]: 0 }), scrape(5, { [relay(outcome)]: 40 })]),
        ).toEqual([]);
      },
    );

    // Break caught: a window shorter than a quarter of an hour, so that a dead letter ten minutes old is no longer a finding.
    it('is still a finding ten minutes later, within the quarter of an hour', () => {
      expect(
        firing([
          scrape(0, { [relay('UNKNOWN_EVENT')]: 0 }),
          scrape(10, { [relay('UNKNOWN_EVENT')]: 1 }),
          scrape(20, { [relay('UNKNOWN_EVENT')]: 1 }),
        ]),
      ).toEqual(['text_messages_dead_letter']);
    });

    it('does not for a dead letter that was already there, or one older than the window', () => {
      expect(
        firing([
          scrape(0, { [relay('UNKNOWN_EVENT')]: 2 }),
          scrape(5, { [relay('UNKNOWN_EVENT')]: 2 }),
        ]),
      ).toEqual([]);
      expect(
        firing([
          scrape(0, { [relay('UNKNOWN_EVENT')]: 0 }),
          scrape(5, { [relay('UNKNOWN_EVENT')]: 1 }),
          scrape(25, { [relay('UNKNOWN_EVENT')]: 1 }),
        ]),
      ).toEqual([]);
    });
  });

  describe('the scope mismatch', () => {
    // Break caught: the security signal of SECURITY_DESIGN.md §14.7 step 8 raised as an ordinary finding, or not at all.
    it('raises the security signal, as SEV-2, and not the dead-letter finding', () => {
      const history = [
        scrape(0, { [relay('SCOPE_MISMATCH')]: 0 }),
        scrape(5, { [relay('SCOPE_MISMATCH')]: 1 }),
      ];
      expect(firing(history)).toEqual(['text_messages_scope_mismatch']);
      expect(firingAlerts(history).map((rule) => rule.severity)).toEqual(['SEV-2']);
    });

    // Break caught: the same window shortened, so that a mismatch ten minutes old is no longer a signal.
    it('is still a signal ten minutes later, within the quarter of an hour', () => {
      expect(
        firing([
          scrape(0, { [relay('SCOPE_MISMATCH')]: 0 }),
          scrape(10, { [relay('SCOPE_MISMATCH')]: 1 }),
          scrape(20, { [relay('SCOPE_MISMATCH')]: 1 }),
        ]),
      ).toEqual(['text_messages_scope_mismatch']);
    });

    it('does not for the same count read again', () => {
      expect(
        firing([
          scrape(0, { [relay('SCOPE_MISMATCH')]: 3 }),
          scrape(5, { [relay('SCOPE_MISMATCH')]: 3 }),
        ]),
      ).toEqual([]);
    });

    // Break caught: the window lengthened, so that a mismatch from twenty minutes ago is still read as a new one.
    it('does not for a mismatch older than the quarter of an hour', () => {
      expect(
        firing([
          scrape(0, { [relay('SCOPE_MISMATCH')]: 0 }),
          scrape(5, { [relay('SCOPE_MISMATCH')]: 1 }),
          scrape(25, { [relay('SCOPE_MISMATCH')]: 1 }),
        ]),
      ).toEqual([]);
    });
  });

  describe('the provider’s refusals, silences and exhausted schedules (at least 20 texts, 15 minutes)', () => {
    // Break caught: a percentage read on too little traffic (section 3.2a), or the threshold read as at-or-above.
    it('flags more than 10% of at least 20 texts, and not 10% or fewer texts', () => {
      expect(
        firing(growing(15, { [sends('SENT')]: [0, 17], [sends('REJECTED')]: [0, 3] })),
      ).toEqual(['text_messages_provider_failure_rate']);
      expect(
        firing(growing(15, { [sends('SENT')]: [0, 18], [sends('REJECTED')]: [0, 2] })),
      ).toEqual([]);
      expect(
        firing(growing(15, { [sends('SENT')]: [0, 9], [sends('REJECTED')]: [0, 10] })),
      ).toEqual([]);
    });

    // Break caught: an unanswered attempt, the first sign of an outage, read as a success until its schedule ends hours later.
    it.each(['REJECTED', 'RETRY', 'SCHEDULE_EXHAUSTED'])('counts %s as a failure', (result) => {
      expect(firing(growing(15, { [sends('SENT')]: [0, 14], [sends(result)]: [0, 6] }))).toEqual([
        'text_messages_provider_failure_rate',
      ]);
    });

    // Break caught: a window shorter than a quarter of an hour, so that failures ten minutes old no longer count.
    it('still flags failures ten minutes old, within the quarter of an hour', () => {
      expect(
        firing([
          scrape(0, { [sends('SENT')]: 0, [sends('REJECTED')]: 0 }),
          scrape(10, { [sends('SENT')]: 14, [sends('REJECTED')]: 6 }),
          scrape(20, { [sends('SENT')]: 24, [sends('REJECTED')]: 6 }),
        ]),
      ).toEqual(['text_messages_provider_failure_rate']);
    });

    // Break caught: the failures of an hour ago paging now.
    it('judges the last 15 minutes and not the history', () => {
      const history = [
        scrape(0, { [sends('SENT')]: 0, [sends('REJECTED')]: 0 }),
        scrape(20, { [sends('SENT')]: 10, [sends('REJECTED')]: 30 }),
        scrape(30, { [sends('SENT')]: 40, [sends('REJECTED')]: 30 }),
        scrape(45, { [sends('SENT')]: 70, [sends('REJECTED')]: 30 }),
      ];
      expect(firing(history)).toEqual([]);
    });
  });
});

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
    // The business texts (decided by the Product Owner on 30 October 2026).
    expect(row('Business texts')).toContain(
      'the oldest due text or envelope **>5 minutes** for 15 minutes',
    );
    expect(row('Business texts')).toContain(
      '**>10%** of the sends in 15 minutes across **at least 20 attempts**',
    );
    expect(row('Business texts')).toContain('a relay ending in `SCOPE_MISMATCH`');
    expect(document).toContain('| **Text messages** *(30 October 2026)*|');
    expect(document).toContain('| **Provider percentage thresholds**| **20 provider attempts**|');
    expect(new Set(ALERT_RULES.map((rule) => rule.id)).size).toBe(ALERT_RULES.length);
    // The failure backstop (S1.28, D-A1; a reading recorded for the Product Owner): the document states the two conditions the rules judge.
    expect(row('Failure backstop')).toContain('missing or unusable');
    expect(row('Failure backstop')).toContain(
      '**no check has completed for 30 minutes** while some failed',
    );
    expect(document).toContain('| **Failure backstop** *(12 November 2026)*|');
    // The evidence scanner (Run A2, D-A6; SEV-2 is a reading recorded for the Product Owner): the document states the two conditions the rules judge.
    expect(row('Evidence scanner')).toContain('**no scanner is configured**');
    expect(row('Evidence scanner')).toContain(
      'scans unavailable for **15 minutes** with **none clean** in that time',
    );
    // Run B, D-B3: and the two the Product Owner added, any flagged scan and any flagged object that could not be removed.
    expect(row('Evidence scanner')).toContain('**any** scan that flagged a file');
    expect(row('Evidence scanner')).toContain('**any** flagged object that could not be removed');
    expect(document).toContain('| **Evidence scanner** *(12 November 2026)*|');
    expect(document).toContain(
      '### 4.3b The evidence scanner cannot be reached or is not configured',
    );
  });
});

describe('the alert rules of the evidence scanner (Run A2, D-A6)', () => {
  const scans = (outcome: string) => `evidence_scans_total{outcome="${outcome}"}`;
  const at = (minutes: number, counts: Partial<Record<string, number>>, instance = 'api-1') =>
    scrape(
      minutes,
      Object.fromEntries(
        ['CLEAN', 'FLAGGED', 'UNAVAILABLE', 'NOT_CONFIGURED'].map((outcome) => [
          scans(outcome),
          counts[outcome] ?? 0,
        ]),
      ),
      instance,
    );

  // Break caught: a production that has no scanner and stores nothing, with nobody told.
  it('fires at once when a rider tried to complete evidence and no scanner is configured', () => {
    expect(firing([at(0, {}), at(5, { NOT_CONFIGURED: 1 })])).toEqual([
      'evidence_scanner_not_configured',
    ]);
    // And stops when no more arrive for the window: the counter only grows, the rule looks at the last fifteen minutes.
    expect(
      firing([
        at(0, { NOT_CONFIGURED: 1 }),
        at(20, { NOT_CONFIGURED: 1 }),
        at(40, { NOT_CONFIGURED: 1 }),
      ]),
    ).toEqual([]);
  });

  // Break caught: a scanner that is down for a quarter of an hour, with nothing scanned clean, and nobody paged; and the reverse, a single failure that a retry cured, paging.
  it('fires when scans were unavailable for fifteen minutes and none was clean, and not for a blip a clean scan followed', () => {
    expect(firing([at(0, {}), at(10, { UNAVAILABLE: 1 }), at(15, { UNAVAILABLE: 3 })])).toEqual([
      'evidence_scanner_unavailable',
    ]);
    expect(
      firing([at(0, {}), at(10, { UNAVAILABLE: 1 }), at(15, { UNAVAILABLE: 1, CLEAN: 1 })]),
    ).toEqual([]);
    expect(firing([at(0, { CLEAN: 5 }), at(15, { CLEAN: 9 })])).toEqual([]);
  });

  // Break caught: a flagged file paging as an OUTAGE, which it is not (the scanner worked): the two outage rules stay quiet. Run B, D-B3 (13 November 2026): a flagged file is a security
  // fact all the same, so a rule of its own fires for it (this assertion was `[]` until then).
  it('does not read flagged files as an outage, and fires the rule of their own for them', () => {
    expect(firing([at(0, {}), at(15, { FLAGGED: 7, CLEAN: 3 })])).toEqual([
      'evidence_scan_flagged',
    ]);
  });

  // Break caught (D-B3; fails on 6547d90: there is no such rule): a flagged upload nobody is told of, a rule that needs more than one, or one that never stops.
  it('fires for any one flagged scan, and stops when none arrives for the window', () => {
    expect(firing([at(0, {}), at(5, { FLAGGED: 1 })])).toEqual(['evidence_scan_flagged']);
    // The scan was at minute 5: by minute 40 it is outside the last fifteen minutes (a counter only grows, so a window that never closed would fire for ever).
    expect(firing([at(0, {}), at(5, { FLAGGED: 1 }), at(40, { FLAGGED: 1 })])).toEqual([]);
    expect(firing([at(0, { CLEAN: 4 }), at(15, { CLEAN: 9 })])).toEqual([]);
  });

  // Break caught (D-B3): an object the scanner flagged that the platform could not take away, which may still sit in the bucket, left unsaid; and the reverse, a removal that worked paging.
  it('fires for any flagged object that could not be removed, and not for one that was', () => {
    const removals = (outcome: string) => `evidence_object_removals_total{outcome="${outcome}"}`;
    const afterwards = (minutes: number, failed: number, removed: number) =>
      scrape(minutes, { [removals('FAILED')]: failed, [removals('REMOVED')]: removed });
    expect(firing([afterwards(0, 0, 0), afterwards(10, 1, 0)])).toEqual([
      'evidence_flagged_object_not_removed',
    ]);
    expect(firing([afterwards(0, 0, 0), afterwards(10, 0, 3)])).toEqual([]);
    // The failure was at minute 5, and by minute 40 it is outside the last fifteen minutes.
    expect(firing([afterwards(0, 0, 0), afterwards(5, 1, 0), afterwards(40, 1, 0)])).toEqual([]);
  });

  it('reads every instance of the API and fires when any one has the fault', () => {
    expect(
      firing([
        at(0, {}, 'api-1'),
        at(0, {}, 'api-2'),
        at(15, { CLEAN: 4 }, 'api-1'),
        at(15, { UNAVAILABLE: 2 }, 'api-2'),
      ]),
    ).toEqual(['evidence_scanner_unavailable']);
  });

  it('names the runbook of the document and a severity of the Product Owner’s table', () => {
    const rules = ALERT_RULES.filter((rule) => rule.alert === 'Evidence scanner');
    expect(rules.map((rule) => rule.id).toSorted()).toEqual([
      'evidence_flagged_object_not_removed',
      'evidence_scan_flagged',
      'evidence_scanner_not_configured',
      'evidence_scanner_unavailable',
    ]);
    for (const rule of rules) {
      expect(rule.runbook).toBe('§4.3b');
      expect(rule.severity).toBe('SEV-2');
    }
  });
});

describe('the alert rules of the failure backstop (S1.28, D-A1)', () => {
  const UNUSABLE = 'pickup_backstop_unusable_hubs';
  const runs = (outcome: string) => `pickup_backstop_runs_total{outcome="${outcome}"}`;

  // Break caught: a lane that cannot judge a hub and says nothing, which is the one thing the Product Owner ruled out ("never silently").
  it('fires when the latest check could not judge a hub, and stops when a later check judges them all', () => {
    expect(firing([scrape(0, { [UNUSABLE]: 1 })])).toEqual(['failure_backstop_threshold_unusable']);
    expect(firing([scrape(0, { [UNUSABLE]: 2 }), scrape(15, { [UNUSABLE]: 1 })])).toEqual([
      'failure_backstop_threshold_unusable',
    ]);
    expect(firing([scrape(0, { [UNUSABLE]: 1 }), scrape(15, { [UNUSABLE]: 0 })])).toEqual([]);
  });

  // Break caught: a worker that does not serve the gauge yet (the lane has not completed a check), read as one with hubs it cannot judge, or as one with none.
  it('does not fire for a worker that serves no such gauge', () => {
    expect(firing([scrape(0, { [AGE]: 0 })])).toEqual([]);
    expect(firing([scrape(0, {}), scrape(15, {})])).toEqual([]);
  });

  // Break caught: a lane that raises on every check and is never noticed, or one that raised once on a blip and pages.
  it('fires when checks have failed for half an hour and none completed, and not for a blip a later check cured', () => {
    const history = (checked: number, failed: number): Scrape[] => [
      scrape(0, { [runs('CHECKED')]: 0, [runs('FAILED')]: 0 }),
      scrape(15, { [runs('CHECKED')]: 0, [runs('FAILED')]: 1 }),
      scrape(30, { [runs('CHECKED')]: checked, [runs('FAILED')]: failed }),
    ];
    expect(firing(history(0, 2))).toEqual(['failure_backstop_not_checking']);
    expect(firing(history(1, 1))).toEqual([]);
    expect(firing(history(2, 0))).toEqual([]);
  });

  // Break caught: a counter that only grows with successful checks read as a failure.
  it('does not fire for a lane that checks as it should', () => {
    expect(
      firing([
        scrape(0, { [runs('CHECKED')]: 0, [runs('FAILED')]: 0, [UNUSABLE]: 0 }),
        scrape(15, { [runs('CHECKED')]: 1, [runs('FAILED')]: 0, [UNUSABLE]: 0 }),
        scrape(30, { [runs('CHECKED')]: 2, [runs('FAILED')]: 0, [UNUSABLE]: 0 }),
      ]),
    ).toEqual([]);
  });
});
