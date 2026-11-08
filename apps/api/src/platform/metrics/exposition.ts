import type { MetricsSnapshot } from './metrics-snapshot.js';
import { METRIC_DEFINITIONS, type MetricDefinition } from './metric-catalogue.js';

/**
 * The text the private metrics endpoint serves (S0.68): the Prometheus text exposition format, version 0.0.4, which the attestation
 * verifier's own endpoint already speaks, so one scraper reads all three processes.
 *
 * - **Every series of a counter is present**, at zero until it moves. The label sets are closed (`metric-catalogue.ts`), so the
 *   product of them is small and fixed, and a counter that appears for the first time at 1 would hide its first increment from a
 *   rate or an increase: an alert on the first terminal failure needs the zero before it.
 * - **An observation is a summary with no quantiles**: its `_sum` and `_count`, for the series that have been observed.
 * - **A gauge is read when the metrics are served** and given here; a reading the catalogue does not hold is refused, as the
 *   registry refuses an unknown sample, so a gauge cannot carry an identifier either.
 *
 * Nothing here comes from a request: names, descriptions and label values are the catalogue's, and the numbers are counts, sums and
 * the gauges' readings.
 */
export interface GaugeReading {
  readonly name: string;
  readonly value: number;
  readonly labels?: Readonly<Record<string, string>>;
}

export const EXPOSITION_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const escapeHelp = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
const escapeValue = (text: string): string =>
  text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');

function labelText(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0
    ? ''
    : `{${entries.map(([name, value]) => `${name}="${escapeValue(value)}"`).join(',')}}`;
}

const keyOf = (labels: Readonly<Record<string, string>>): string => labelText(labels);

function number(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

/** Every combination of a definition's label values: one entry, the empty set, for a metric with no label. */
function combinations(definition: MetricDefinition): Record<string, string>[] {
  let all: Record<string, string>[] = [{}];
  for (const [label, values] of Object.entries(definition.labels)) {
    all = all.flatMap((partial) => values.map((value) => ({ ...partial, [label]: value })));
  }
  return all;
}

function assertReading(
  reading: GaugeReading,
  definitions: Readonly<Record<string, MetricDefinition>>,
): void {
  const definition = Object.hasOwn(definitions, reading.name)
    ? definitions[reading.name]
    : undefined;
  if (definition?.kind !== 'gauge') {
    throw new RangeError('A gauge reading names a metric the catalogue does not hold as a gauge');
  }
  const labels = reading.labels ?? {};
  const names = Object.keys(labels).toSorted();
  const allowed = Object.keys(definition.labels).toSorted();
  const fits =
    names.length === allowed.length &&
    names.every(
      (name, index) =>
        name === allowed[index] && (definition.labels[name] ?? []).includes(labels[name] ?? ''),
    );
  if (!fits || !Number.isFinite(reading.value)) {
    throw new RangeError(`A reading of ${reading.name} is outside its catalogue entry`);
  }
}

export function renderExposition(
  snapshot: MetricsSnapshot,
  gauges: readonly GaugeReading[],
  definitions: Readonly<Record<string, MetricDefinition>> = METRIC_DEFINITIONS,
): string {
  for (const reading of gauges) assertReading(reading, definitions);
  const lines: string[] = [];
  for (const name of Object.keys(definitions).toSorted()) {
    const definition = definitions[name];
    if (definition === undefined) continue;
    if (definition.kind === 'counter') {
      const seen = new Map(
        snapshot.counters
          .filter((counter) => counter.name === name)
          .map((counter) => [keyOf(counter.labels), counter.value]),
      );
      lines.push(`# HELP ${name} ${escapeHelp(definition.description)}`, `# TYPE ${name} counter`);
      for (const labels of combinations(definition).toSorted((a, b) =>
        keyOf(a) < keyOf(b) ? -1 : 1,
      )) {
        lines.push(`${name}${labelText(labels)} ${number(seen.get(keyOf(labels)) ?? 0)}`);
      }
    } else if (definition.kind === 'observation') {
      const observed = snapshot.observations.filter((observation) => observation.name === name);
      if (observed.length === 0) continue;
      lines.push(`# HELP ${name} ${escapeHelp(definition.description)}`, `# TYPE ${name} summary`);
      for (const observation of observed) {
        lines.push(`${name}_sum${labelText(observation.labels)} ${number(observation.sum)}`);
        lines.push(`${name}_count${labelText(observation.labels)} ${number(observation.count)}`);
      }
    } else {
      const read = gauges.filter((reading) => reading.name === name);
      if (read.length === 0) continue;
      lines.push(`# HELP ${name} ${escapeHelp(definition.description)}`, `# TYPE ${name} gauge`);
      for (const reading of read)
        lines.push(`${name}${labelText(reading.labels ?? {})} ${number(reading.value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
