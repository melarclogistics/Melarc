/**
 * The alerts of the credential path and the attestation trust data, as rules a machine can evaluate (S0.68; OBSERVABILITY_AND_RECOVERY.md
 * section 3, the table; section 3.1, severity; section 3.2, the thresholds; section 3.2a, the minimum of provider attempts). They read
 * what the private metrics endpoints serve, the API's, the delivery worker's and the attestation verifier's, as a history of scrapes,
 * and say which alerts fire. Which tool evaluates them in production, and where a page goes, is release gate G3's; these are the rules
 * that tool is given, and the rehearsal runs them on the real processes' readings.
 *
 * Every number is the document's, and `alert-rules.test.ts` holds the rules to the document's text. Every series is the catalogue's
 * (`metric-catalogue.ts`) or the verifier's (`Telemetry.kt`), and no rule reads a label that could identify anyone: there is none.
 */

/** One reading of every series a process serves, keyed by its name and labels as the exposition writes them (`name{a="x"}`). */
export interface Scrape {
  /** When it was read, in milliseconds. */
  readonly at: number;
  /** The process it was read from: the oldest verifier instance is what the trust-data rule judges. */
  readonly instance: string;
  readonly samples: ReadonlyMap<string, number>;
}

export type Severity = 'SEV-1' | 'SEV-2' | 'SEV-3';

export interface AlertRule {
  /** The rule's own name. */
  readonly id: string;
  /** The row of the alert table it implements. */
  readonly alert: 'Credential delivery' | 'Provider down' | 'Attestation trust data aging';
  readonly severity: Severity;
  /** What firing means, for the person who is paged. Never a value of a series. */
  readonly summary: string;
  /** The runbook section of OBSERVABILITY_AND_RECOVERY.md section 4 the response is. */
  readonly runbook: '§4.1' | '§4.3a';
  fires(history: readonly Scrape[]): boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Parses the Prometheus text exposition into its samples: comments and blank lines skipped, every value a number. */
export function parseExposition(text: string): Map<string, number> {
  const samples = new Map<string, number>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const space = trimmed.lastIndexOf(' ');
    const key = trimmed.slice(0, space);
    const value = Number(trimmed.slice(space + 1));
    if (space <= 0 || !Number.isFinite(value))
      throw new Error('a line of the exposition is not a sample');
    samples.set(key, value);
  }
  return samples;
}

/** The sum of every series of `name` whose labels include `match`, in one scrape. */
function total(scrape: Scrape, name: string, match: Readonly<Record<string, string>> = {}): number {
  let sum = 0;
  for (const [key, value] of scrape.samples) {
    const brace = key.indexOf('{');
    const series = brace < 0 ? key : key.slice(0, brace);
    if (series !== name) continue;
    const labels = brace < 0 ? '' : key.slice(brace);
    if (Object.entries(match).every(([label, wanted]) => labels.includes(`${label}="${wanted}"`)))
      sum += value;
  }
  return sum;
}

/** The scrapes of one instance, in time order. */
function byInstance(history: readonly Scrape[]): Map<string, Scrape[]> {
  const instances = new Map<string, Scrape[]>();
  for (const scrape of [...history].sort((a, b) => a.at - b.at)) {
    const list = instances.get(scrape.instance) ?? [];
    list.push(scrape);
    instances.set(scrape.instance, list);
  }
  return instances;
}

/**
 * How much a counter grew over the last `windowMs` of one instance's scrapes: the latest reading less the latest one at or before the
 * window's start (or the first reading, when the history is shorter). A fall is a restart, after which the counter grew from zero.
 */
function increase(
  scrapes: readonly Scrape[],
  read: (scrape: Scrape) => number,
  windowMs: number,
): number {
  const last = scrapes.at(-1);
  if (last === undefined) return 0;
  const start = last.at - windowMs;
  const base = scrapes.filter((scrape) => scrape.at <= start).at(-1) ?? scrapes[0];
  if (base === undefined || base === last) return 0;
  let grown = 0;
  let previous = read(base);
  for (const scrape of scrapes.filter((entry) => entry.at > base.at)) {
    const value = read(scrape);
    grown += value >= previous ? value - previous : value;
    previous = value;
  }
  return grown;
}

/** Whether `condition` held at every reading of the last `durationMs`, and the readings reach back that far. */
function sustained(
  scrapes: readonly Scrape[],
  condition: (scrape: Scrape) => boolean,
  durationMs: number,
): boolean {
  const last = scrapes.at(-1);
  if (last === undefined) return false;
  const start = last.at - durationMs;
  const first = scrapes[0];
  if (first === undefined || first.at > start) return false;
  return scrapes.filter((scrape) => scrape.at >= start).every(condition);
}

const anyInstance = (history: readonly Scrape[], test: (scrapes: Scrape[]) => boolean): boolean =>
  [...byInstance(history).values()].some(test);

const AGE = 'credential_delivery_oldest_due_age_seconds';
const age = (scrape: Scrape): number => total(scrape, AGE);
const hasAge = (scrape: Scrape): boolean => [...scrape.samples.keys()].some((key) => key === AGE);

/** Provider answers of one channel: what counts as an attempt and what counts as a failure (a rejection or a timeout). */
const PROVIDER_FAILURES = ['REJECTED', 'UNKNOWN'] as const;
const attemptsOf =
  (channel: string) =>
  (scrape: Scrape): number =>
    ['ACCEPTED', ...PROVIDER_FAILURES].reduce(
      (sum, result) =>
        sum + total(scrape, 'credential_delivery_attempts_total', { channel, result }),
      0,
    );
const failuresOf =
  (channel: string) =>
  (scrape: Scrape): number =>
    PROVIDER_FAILURES.reduce(
      (sum, result) =>
        sum + total(scrape, 'credential_delivery_attempts_total', { channel, result }),
      0,
    );
const successesOf =
  (channel: string) =>
  (scrape: Scrape): number =>
    total(scrape, 'credential_delivery_attempts_total', { channel, result: 'ACCEPTED' });

/**
 * The failures since the last success, read from counters: the failures counted after the last scrape in which a success was. A
 * scrape that saw both cannot say which came last, so its failures are not counted: the count is never more than the true run, and
 * the tripwire may fire one scrape late but never on a run that a success broke.
 */
function failuresSinceSuccess(scrapes: readonly Scrape[], channel: string): number {
  let run = 0;
  for (let index = 1; index < scrapes.length; index += 1) {
    const before = scrapes[index - 1];
    const now = scrapes[index];
    if (before === undefined || now === undefined) continue;
    const succeeded = successesOf(channel)(now) !== successesOf(channel)(before);
    const failed = Math.max(0, failuresOf(channel)(now) - failuresOf(channel)(before));
    run = succeeded ? 0 : run + failed;
  }
  return run;
}

/** Section 3.2a: below 20 attempts in its window a provider percentage is not evidence either way. */
const PROVIDER_MINIMUM_ATTEMPTS = 20;

function providerRules(channel: 'EMAIL' | 'SMS'): AlertRule[] {
  const name = channel === 'EMAIL' ? 'email' : 'SMS';
  return [
    {
      id: `provider_down_${channel.toLowerCase()}_failure_rate`,
      alert: 'Provider down',
      severity: 'SEV-3',
      summary: `The ${name} provider has failed more than 5% of at least 20 credential messages for 15 minutes.`,
      runbook: '§4.1',
      fires: (history) =>
        anyInstance(history, (scrapes) => {
          const attempts = increase(scrapes, attemptsOf(channel), 15 * MINUTE);
          const failures = increase(scrapes, failuresOf(channel), 15 * MINUTE);
          return attempts >= PROVIDER_MINIMUM_ATTEMPTS && failures / attempts > 0.05;
        }),
    },
    {
      id: `provider_down_${channel.toLowerCase()}_success_rate`,
      alert: 'Provider down',
      severity: 'SEV-2',
      summary: `The ${name} provider accepted fewer than 80% of at least 20 credential messages in 10 minutes.`,
      runbook: '§4.1',
      fires: (history) =>
        anyInstance(history, (scrapes) => {
          const attempts = increase(scrapes, attemptsOf(channel), 10 * MINUTE);
          const successes = increase(scrapes, successesOf(channel), 10 * MINUTE);
          return attempts >= PROVIDER_MINIMUM_ATTEMPTS && successes / attempts < 0.8;
        }),
    },
    {
      id: `provider_down_${channel.toLowerCase()}_consecutive_failures`,
      alert: 'Provider down',
      severity: 'SEV-2',
      summary: `The ${name} provider has failed five credential messages in a row.`,
      runbook: '§4.1',
      fires: (history) =>
        anyInstance(history, (scrapes) => failuresSinceSuccess(scrapes, channel) >= 5),
    },
  ];
}

const TRUST_AGE = 'attestation_trust_data_age_seconds';
/** The oldest verifier instance's age of its trust data, at each instance's latest reading. */
function oldestTrustAge(history: readonly Scrape[]): number | undefined {
  const ages = [...byInstance(history).values()]
    .map((scrapes) => scrapes.at(-1))
    .filter((scrape): scrape is Scrape => scrape?.samples.has(TRUST_AGE) === true)
    .map((scrape) => total(scrape, TRUST_AGE));
  return ages.length === 0 ? undefined : Math.max(...ages);
}

export const ALERT_RULES: readonly AlertRule[] = Object.freeze([
  {
    id: 'credential_delivery_backlog_warning',
    alert: 'Credential delivery',
    severity: 'SEV-3',
    summary: 'A credential message has been due for more than 2 minutes, for 15 minutes.',
    runbook: '§4.1',
    fires: (history) =>
      anyInstance(history, (scrapes) =>
        sustained(scrapes, (scrape) => hasAge(scrape) && age(scrape) > 2 * 60, 15 * MINUTE),
      ),
  },
  {
    id: 'credential_delivery_backlog_blocking',
    alert: 'Credential delivery',
    severity: 'SEV-2',
    summary:
      'A credential message has been due for more than 10 minutes: a principal is waiting for a link.',
    runbook: '§4.1',
    fires: (history) =>
      anyInstance(history, (scrapes) => {
        const last = scrapes.at(-1);
        return last !== undefined && hasAge(last) && age(last) > 10 * 60;
      }),
  },
  {
    id: 'credential_delivery_terminal_failure',
    alert: 'Credential delivery',
    severity: 'SEV-2',
    summary:
      'A credential message failed terminally: a security-sensitive dead letter, until triaged.',
    runbook: '§4.1',
    fires: (history) =>
      anyInstance(
        history,
        (scrapes) =>
          increase(
            scrapes,
            (scrape) => total(scrape, 'credential_delivery_jobs_failed_total'),
            15 * MINUTE,
          ) > 0,
      ),
  },
  {
    id: 'credential_delivery_lease_expired',
    alert: 'Credential delivery',
    // OBSERVABILITY_AND_RECOVERY.md names no severity for this condition of the row; SEV-3 ("a developing degradation") is this
    // task's reading, recorded for the Product Owner (plan section 7).
    severity: 'SEV-3',
    summary: 'A credential message lease expired with no outcome: a worker crashed or is too slow.',
    runbook: '§4.1',
    fires: (history) =>
      anyInstance(
        history,
        (scrapes) =>
          increase(
            scrapes,
            (scrape) => total(scrape, 'credential_delivery_leases_expired_total'),
            15 * MINUTE,
          ) > 0,
      ),
  },
  ...providerRules('EMAIL'),
  ...providerRules('SMS'),
  {
    id: 'attestation_trust_data_aging_warning',
    alert: 'Attestation trust data aging',
    severity: 'SEV-3',
    summary: 'The oldest verifier instance holds a revocation list older than 12 hours.',
    runbook: '§4.3a',
    fires: (history) => {
      const oldest = oldestTrustAge(history);
      return oldest !== undefined && oldest > (12 * HOUR) / 1000;
    },
  },
  {
    id: 'attestation_trust_data_aging_critical',
    alert: 'Attestation trust data aging',
    severity: 'SEV-2',
    summary:
      'The oldest verifier instance holds a revocation list older than 24 hours, or could not load the accepted roots: new rider enrolment and replacement fail closed.',
    runbook: '§4.3a',
    fires: (history) => {
      const oldest = oldestTrustAge(history);
      const rootsFailed = anyInstance(
        history,
        (scrapes) =>
          increase(
            scrapes,
            (scrape) => total(scrape, 'attestation_trust_roots_load_failures_total'),
            15 * MINUTE,
          ) > 0,
      );
      return rootsFailed || (oldest !== undefined && oldest > (24 * HOUR) / 1000);
    },
  },
] satisfies AlertRule[]);

/** The rules that fire on a history of scrapes. */
export function firingAlerts(
  history: readonly Scrape[],
  rules: readonly AlertRule[] = ALERT_RULES,
): AlertRule[] {
  return rules.filter((rule) => rule.fires(history));
}
