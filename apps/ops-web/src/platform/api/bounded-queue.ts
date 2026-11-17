/**
 * A queue that runs at most `limit` tasks at once, in the order they were asked for, and **gives up the place of a task that is abandoned while it waits**, which then never runs. It knows nothing of
 * what it runs. It is the one queue of the portal: the photo links (`platform/evidence/photo-link-queue.ts`) and the uploads of evidence (`platform/evidence/upload-evidence.ts`) each have one of their
 * own, because every request of a signed-in session counts toward the session's limit and a page that asks for a hundred things at once spends it in a second.
 */
export interface BoundedQueue {
  /** Runs `task` when a place is free. `signal` abandons it while it waits: the answer is then an `AbortError` and the task never runs. */
  run<Result>(task: () => Promise<Result>, signal?: AbortSignal): Promise<Result>;
}

interface Waiting {
  readonly start: () => void;
  readonly cancel: (reason: unknown) => void;
}

function abortError(): DOMException {
  return new DOMException('The request was abandoned before its turn.', 'AbortError');
}

export function createBoundedQueue(limit: number): BoundedQueue {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('The limit of a queue is a whole number of at least one.');
  }
  const waiting: Waiting[] = [];
  let inFlight = 0;

  function next(): void {
    while (inFlight < limit) {
      const one = waiting.shift();
      if (one === undefined) return;
      one.start();
    }
  }

  return {
    run<Result>(task: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
      return new Promise<Result>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(abortError());
          return;
        }
        const entry: Waiting = {
          start: () => {
            signal?.removeEventListener('abort', abandon);
            inFlight += 1;
            // A task that throws before it returns a promise is a failure of the task, and its place is given up like any other's.
            let running: Promise<Result>;
            try {
              running = task();
            } catch (error) {
              running = Promise.reject(
                error instanceof Error ? error : new Error('The request failed.'),
              );
            }
            running.then(resolve, reject).finally(() => {
              inFlight -= 1;
              next();
            });
          },
          cancel: reject,
        };
        function abandon(): void {
          const at = waiting.indexOf(entry);
          if (at >= 0) waiting.splice(at, 1);
          entry.cancel(abortError());
        }
        signal?.addEventListener('abort', abandon, { once: true });
        waiting.push(entry);
        next();
      });
    },
  };
}
