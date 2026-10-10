/**
 * The capture reader (S0.10). A delivery adapter in `capture` mode keeps what it would have sent in memory and sends nothing to
 * anyone (DEPLOYMENT_AND_ENVIRONMENTS.md section 4); a test reads it through a `CaptureReader`. The adapter arrives with S0.17 and
 * writes to the `CaptureSink` it is given; until then nothing writes, so the reader is empty, and it is empty by default for every
 * test: a test that expects that nothing was sent can say so, and a store never carries one test's messages into the next.
 *
 * The reader can only read, so code under test that is handed it cannot change what was captured; the sink alone can add and clear.
 * Test support, excluded from the build.
 */

export interface CaptureReader<T> {
  /** A copy of everything captured so far, in order. */
  all(): readonly T[];
  readonly size: number;
  /** The latest entry, or the latest that matches `predicate`; `undefined` when there is none. */
  last(predicate?: (entry: T) => boolean): T | undefined;
  /** Every entry that matches, in order. */
  where(predicate: (entry: T) => boolean): readonly T[];
}

export interface CaptureSink<T> {
  push(entry: T): void;
  clear(): void;
}

export function createCapture<T>(): { reader: CaptureReader<T>; sink: CaptureSink<T> } {
  const entries: T[] = [];
  const reader: CaptureReader<T> = {
    all: () => [...entries],
    get size() {
      return entries.length;
    },
    last: (predicate) =>
      predicate === undefined ? entries.at(-1) : entries.toReversed().find(predicate),
    where: (predicate) => entries.filter(predicate),
  };
  const sink: CaptureSink<T> = {
    push: (entry) => {
      entries.push(entry);
    },
    clear: () => {
      entries.length = 0;
    },
  };
  return { reader, sink };
}
