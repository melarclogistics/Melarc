/**
 * The asking for photo links, bounded. A page that draws sixty photos asks the platform for sixty retrieval authorizations (`createEvidenceRetrievalAuthorization`, one for each tile that comes near the
 * screen), and every request of an authenticated session counts toward the session's limit, so the asking is **bounded**: at most `limit` at once, in the order they were asked for, and **a request that is
 * abandoned while it waits gives its place up and never runs** (a tile that scrolled away, or a page that was left). The queue knows nothing of what it runs.
 */
export interface PhotoLinkQueue {
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

export function createPhotoLinkQueue(limit: number): PhotoLinkQueue {
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

/** The one queue of the page: four at a time is what a tablet's connection and the session's limit can carry, and a tile that is near the screen waits for no more than its turn. */
export const photoLinkQueue: PhotoLinkQueue = createPhotoLinkQueue(4);
