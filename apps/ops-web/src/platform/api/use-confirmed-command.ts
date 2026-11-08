import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { problemOf, type Problem } from '../problem/problem-copy';
import { useSessionStore } from '../session/session-context';
import { StaleSessionError } from '../session/session-boundary';
import {
  CommandCancelledError,
  CommandChangedError,
  UnresolvedCommandError,
  failureOf,
} from './idempotency';
import { useCommandKeySlot } from './use-command-key-slot';

/**
 * Where a confirmed command is:
 *
 * - `idle`: nothing is being done, or the earlier attempt was withdrawn or abandoned;
 * - `sending`: a request is on its way;
 * - `unknown`: a request was sent and **nothing authoritative came back** (no answer, an answer that is not the API's, a fault): it may have
 *   been done. The command is held, unchanged, until the person resolves it;
 * - `refused`: the API answered and declined. Nothing is in doubt, and the next submit is a new command;
 * - `conflict`: the record is not as the person saw it (`STATE_CONFLICT`): it changed, and has to be read again;
 * - `done`: the API said it was done.
 */
export type ConfirmedCommandPhase =
  'idle' | 'sending' | 'unknown' | 'refused' | 'conflict' | 'done';

export interface ConfirmedCommandOptions<Command extends object, Result> {
  /**
   * Sends the command, with the key to send it under, and answers with what the API answered. It throws what the call throws (read the call
   * with `answerOf`). The command is everything that makes the request what it is: the reason, the note, and the version the person saw
   * (the `If-Match` of the read), so that a retry is the same request.
   */
  readonly send: (command: Command, idempotencyKey: string) => Promise<Result>;
  /** The API said it was done. Not called for a screen that has gone, or for a session that has changed. A fault in it surfaces from `submit`; it does not undo the command. */
  readonly onDone?: (result: Result) => void;
  /** The person asks to see the record as it is now: after a conflict, or to find out whether an unknown outcome was done. */
  readonly onReload?: () => unknown;
  /**
   * Whether sending the same command again is safe: it takes an `Idempotency-Key` (a retry under the same key replays the first result), or
   * it is idempotent by its nature. When it is not, an unknown outcome offers only a look at the record (COMPONENT_PATTERNS section 33.2):
   * sent again after the first was done, it would meet a record that has moved, or be done twice. The default is that it is not.
   */
  readonly retryable?: boolean;
  /** The `operationId`, so that a failure is worded for it. */
  readonly operation?: string;
}

export interface ConfirmedCommand<Command extends object> {
  readonly phase: ConfirmedCommandPhase;
  /** What went wrong with the last attempt, in approved words. Present for `refused`, `conflict`, and for `unknown` when the last attempt was refused. */
  readonly problem: Problem | undefined;
  /** The form is not to be changed: a request is on its way, or its outcome is not known, and a changed command would be a different one. */
  readonly locked: boolean;
  /** An unknown outcome can be resolved by sending the same command again. */
  readonly canRetry: boolean;
  /** Sends a command. It does nothing while one is on its way or its outcome is unknown, and does not reject for the command's own failure (that is `phase`). */
  readonly submit: (command: Command) => Promise<void>;
  /** Sends the held command again, under the same key. Only after an unknown outcome, and only for a command that can be sent again. */
  readonly retry: () => Promise<void>;
  /** The person looks at the record: the held attempt is abandoned, so the next command is a new one, and the record is read again. */
  readonly checkRecord: () => void;
  /** Takes a refusal off the screen. */
  readonly dismiss: () => void;
}

interface State {
  readonly phase: ConfirmedCommandPhase;
  readonly problem: Problem | undefined;
}

const IDLE: State = { phase: 'idle', problem: undefined };

/** What a failed attempt leaves: depends on whether the command's earlier outcome is in doubt, which the key slot knows. */
function afterFailure(error: unknown, unresolved: boolean, operation: string | undefined): State {
  // Nothing was sent: there is nothing to say, unless an earlier attempt is still in doubt.
  if (error instanceof CommandCancelledError || error instanceof CommandChangedError) {
    return unresolved ? { phase: 'unknown', problem: undefined } : IDLE;
  }
  if (error instanceof UnresolvedCommandError) return { phase: 'unknown', problem: undefined };

  const problem = problemOf(error, operation === undefined ? {} : { operation });
  if (failureOf(error) !== 'unknown' && !unresolved) {
    return { phase: problem.kind === 'conflict' ? 'conflict' : 'refused', problem };
  }
  // The outcome of this attempt, or of an earlier one that this did not settle, is not known. A refusal of the retry is still shown.
  return { phase: 'unknown', problem: problem.kind === 'unavailable' ? undefined : problem };
}

/**
 * A command that asks for a reason and a confirmation, sent so that a lost answer never becomes a second act and a stale version never
 * becomes a silent overwrite (COMPONENT_PATTERNS section 33.2). It is `useCommandKeySlot` plus what a dialog needs of it:
 *
 * - **the command is held as it was sent**: a copy, so that the form's own object cannot change what a retry sends. The key and the
 *   version the person saw travel with it;
 * - **an unknown outcome keeps everything**: the dialog stays, the form is locked, and the person can send the same command again under
 *   the same key (if that is safe) or look at the record, which abandons the attempt and reads it again;
 * - **a refusal ends the attempt**: the key is released, the form is free, and the next submit is a new command;
 * - **a conflict says the record changed** and offers the same look at the record, from which a new command starts;
 * - **one at a time**: a second submit while one is on its way, or while an outcome is unknown, is ignored;
 * - **a session that changed** while it was on its way: nothing is shown, nothing is reported done, and nothing is sent into the new one.
 */
export function useConfirmedCommand<Command extends object, Result>(
  options: ConfirmedCommandOptions<Command, Result>,
): ConfirmedCommand<Command> {
  const slot = useCommandKeySlot();
  const session = useSessionStore();
  const [state, setState] = useState<State>(IDLE);
  const latest = useRef(options);
  const alive = useRef(true);
  const busy = useRef(false);
  const held = useRef<Command | undefined>(undefined);

  useLayoutEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const attempt = useCallback(
    async (command: Command): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      // Whose session the command is begun in. The session boundary refuses an answer to another one, but a `send` that does not go through
      // the boundary is judged here too: a command done for a person who has gone is not reported to the one who replaced them.
      const generation = session.generation;
      setState({ phase: 'sending', problem: undefined });
      let result: Result;
      try {
        result = await slot.run(command, (key) => latest.current.send(command, key));
        if (!alive.current) return;
        if (session.generation !== generation) throw new StaleSessionError();
      } catch (error) {
        if (!alive.current) return;
        if (error instanceof StaleSessionError || session.generation !== generation) {
          // The answer is for a session that has gone, and so is the key it was sent under: the idempotency record belongs to that person.
          slot.abandon();
          held.current = undefined;
          setState(IDLE);
          return;
        }
        setState(afterFailure(error, slot.describe().unresolved, latest.current.operation));
        return;
      } finally {
        busy.current = false;
      }
      // Done. What the screen does next is outside the attempt: a fault in it is the screen's, and must not read as the command's failure.
      held.current = undefined;
      setState({ phase: 'done', problem: undefined });
      latest.current.onDone?.(result);
    },
    [slot, session],
  );

  const submit = useCallback(
    async (command: Command): Promise<void> => {
      if (busy.current || slot.describe().unresolved) return;
      // A copy, taken now: what the form does to its object afterwards is not what a retry sends.
      const snapshot = structuredClone(command);
      held.current = snapshot;
      await attempt(snapshot);
    },
    [attempt, slot],
  );

  const retry = useCallback(async (): Promise<void> => {
    const command = held.current;
    if (command === undefined || !latest.current.retryable || !slot.describe().unresolved) return;
    await attempt(command);
  }, [attempt, slot]);

  const checkRecord = useCallback((): void => {
    slot.abandon();
    held.current = undefined;
    setState(IDLE);
    void latest.current.onReload?.();
  }, [slot]);

  const dismiss = useCallback((): void => {
    setState((current) => (current.phase === 'refused' ? IDLE : current));
  }, []);

  return {
    phase: state.phase,
    problem: state.problem,
    locked: state.phase === 'sending' || state.phase === 'unknown',
    canRetry: state.phase === 'unknown' && options.retryable === true,
    submit,
    retry,
    checkRecord,
    dismiss,
  };
}
