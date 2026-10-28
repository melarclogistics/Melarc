/**
 * What a metrics registry holds at one moment: each counter series with its count, and each observed series with its count, sum and
 * range. The bounded registry (`bounded.metrics.adapter.ts`) makes it; the private endpoint serves it (S0.68).
 */
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

/** A registry whose snapshot can be read: what the composition root binds to the `Metrics` port in a running process. */
export interface SnapshotSource {
  snapshot(): MetricsSnapshot;
}

/**
 * The registry bound to the `Metrics` port, read as one that serves a snapshot, or undefined for one that does not (a test's double).
 * The process entry asks this instead of importing the adapter class, which only the composition root may name.
 */
export function snapshotSourceOf(metrics: unknown): SnapshotSource | undefined {
  const candidate = metrics as Partial<SnapshotSource> | null | undefined;
  return typeof candidate?.snapshot === 'function' ? (candidate as SnapshotSource) : undefined;
}
