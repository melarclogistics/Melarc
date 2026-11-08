import { createContext, useCallback, useContext, useMemo } from 'react';
import { NavigationType, useLocation, useNavigationType } from 'react-router';

import type { ContinuityList, QueueContinuity, QueuePlace } from './queue-continuity';

/** What a scope gives the screens under it: the one store of places for each list, and whose they are (`bindingOf`). */
export interface ContinuityScope {
  readonly stores: Readonly<Record<ContinuityList, QueueContinuity>>;
  readonly binding: string;
}

/** Nothing while nobody is signed in: a screen outside a scope, or under one without a session, remembers nothing. */
export const ContinuityContext = createContext<ContinuityScope | null>(null);

/**
 * The state of the record's link back to its list. A visit to the list is a return only when it is the browser's Back (or Forward) or this
 * link; a link from the menu, a typed address or a booking asks for the list anew and is given the first page.
 */
export interface QueueReturnLink {
  /** The filters of the list the person left, as its address carries them. */
  readonly search: string;
  readonly state: { readonly queueReturn: true };
}

export interface QueueContinuityHandle {
  /**
   * The place this arrival brings the person back to, for the filters on the screen; nothing for an arrival that is not a return, for other
   * filters, for another session or scope, or when nothing was left. It changes nothing (a render may ask twice).
   */
  readonly returningTo: (signature: string) => QueuePlace | undefined;
  /** Remembers where the person is, as they open a record, in place of any place remembered before. */
  readonly leave: (place: QueuePlace) => void;
  /** Lets go of the place: the visit it was left for is over, or the person has chosen another start. */
  readonly discard: () => void;
  /** For the page of this record: the link back to the place that was left for it, or nothing if no place was. */
  readonly backTo: (requestId: string) => QueueReturnLink | undefined;
}

const isReturnMarker = (state: unknown): boolean =>
  typeof state === 'object' &&
  state !== null &&
  (state as { readonly queueReturn?: unknown }).queueReturn === true;

/**
 * The memory of where a list was left (`queue-continuity.ts`), as a screen under `QueueContinuityScope` meets it: the pickup queue's unless the
 * list is named. Each list has a memory of its own, so a place left in one is never offered to the other.
 */
export function useQueueContinuity(list: ContinuityList = 'pickup'): QueueContinuityHandle {
  const scope = useContext(ContinuityContext);
  const navigationType = useNavigationType();
  const location = useLocation();
  const comingBack = navigationType === NavigationType.Pop || isReturnMarker(location.state);

  // Each function changes only with the scope (or, for the one that depends on how the person arrived, with that), so that a screen may name
  // `discard` in an effect's dependencies without the effect running again for a navigation it has nothing to do with.
  const returningTo = useCallback(
    (signature: string): QueuePlace | undefined => {
      if (scope === null || !comingBack) return undefined;
      const held = scope.stores[list].peek(scope.binding);
      return held?.signature === signature ? held : undefined;
    },
    [scope, list, comingBack],
  );
  const leave = useCallback(
    (place: QueuePlace): void => {
      scope?.stores[list].leave(place, scope.binding);
    },
    [scope, list],
  );
  const discard = useCallback((): void => {
    scope?.stores[list].discard();
  }, [scope, list]);
  const backTo = useCallback(
    (requestId: string): QueueReturnLink | undefined => {
      const held = scope?.stores[list].peek(scope.binding);
      if (held?.requestId.toLowerCase() !== requestId.toLowerCase()) {
        return undefined;
      }
      return { search: held.search, state: { queueReturn: true } };
    },
    [scope, list],
  );

  return useMemo(
    () => ({ returningTo, leave, discard, backTo }),
    [returningTo, leave, discard, backTo],
  );
}
