import { useEffect, useState } from 'react';

import { useSessionStore } from '../session/session-context';
import { createCommandKeySlot, newIdempotencyKey, type CommandKeySlot } from './idempotency';

/**
 * The `Idempotency-Key` slot of one form or dialog, in this session. It is `createCommandKeySlot` with the two things a screen would
 * otherwise have to remember to wire (U03 of 23 October 2026):
 *
 * - the slot's epoch is the session store's generation, so a key made while one person was signed in is never carried into another's
 *   session (the idempotency record belongs to a principal, and the earlier screen is gone with its session);
 * - when the form goes away its held key is forgotten: nobody is left to retry the attempt, and a form opened later is a new command.
 *
 * Use it as `slot.run(command, send)`, with `command` being everything that makes the request what it is.
 */
export function useCommandKeySlot(): CommandKeySlot {
  const store = useSessionStore();
  const [slot] = useState(() => createCommandKeySlot(newIdempotencyKey, () => store.generation));
  useEffect(
    () => () => {
      slot.abandon();
    },
    [slot],
  );
  return slot;
}
