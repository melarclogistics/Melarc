import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import { useSignedInSession } from '../session/use-permissions';
import { parseRecordLookup, type RecordLookupResultView } from './record-lookup-shape';

/** How long a text must stand still before it is asked of the server (`AC-LOOKUP-12`). */
export const LOOKUP_DEBOUNCE_MS = 200;
/** What the server accepts once the text is trimmed (`lookupRecords`, `q`). */
export const LOOKUP_MIN_CHARACTERS = 2;
export const LOOKUP_MAX_CHARACTERS = 64;

export type RecordLookupStatus =
  /** Nothing to ask: the text is too short (or too long) once trimmed, or nobody is signed in. */
  | 'idle'
  /** The text is long enough and has not stood still for the debounce yet: nothing is shown for it, and nothing was asked. */
  | 'waiting'
  /** The text stood still and the server is being asked. */
  | 'loading'
  /** The server answered; `results` may be empty, which is "nothing found" and not a failure. */
  | 'success'
  /** The read failed or its answer was not a page of results; `retry` asks again. */
  | 'error';

export interface RecordLookupState {
  readonly status: RecordLookupStatus;
  /** The trimmed text the state is about (`''` while idle). The results are those of this text and of no earlier one. */
  readonly query: string;
  readonly results: readonly RecordLookupResultView[];
  readonly error: unknown;
  readonly retry: () => void;
}

/** The text as the server reads it: trimmed, each run of white space one space, and 2 to 64 characters, or nothing. */
function searchableText(text: string): string | undefined {
  const folded = text.trim().replaceAll(/\s+/g, ' ');
  const length = Array.from(folded).length;
  return length >= LOOKUP_MIN_CHARACTERS && length <= LOOKUP_MAX_CHARACTERS ? folded : undefined;
}

/**
 * `lookupRecords` (`POST /ops/lookup`, a POST that changes nothing): finds a record by its code, a name or a phone number typed in full (task C2;
 * features/operations/global-lookup.md). The top bar's search and the palette of step R4 draw it; this reads, judges (`record-lookup-shape.ts`)
 * and hands the state on.
 *
 * **It asks late and asks little** (`AC-LOOKUP-12`): nothing for a text that is too short once trimmed or when nobody is signed in; for a longer
 * one, a single request once the text has stood still for {@link LOOKUP_DEBOUNCE_MS}, whatever was typed on the way. **It never offers an earlier
 * text's answer as a later text's**: from the moment the text changes, its state is `waiting` (then `loading`) with no results, and the results
 * that come are those of the text in `query`. A failed read is `error` and is not tried again by itself; the end of a session empties the cache
 * like any other, so one person's results are never the next person's. The server decides what the text is (a code, a number, a name), which
 * kinds the session may search and what it may open; the hook asks and judges.
 */
export function useRecordLookup(text: string): RecordLookupState {
  const client = useApiClient();
  const me = useSignedInSession();
  const wanted = searchableText(text);
  const [settled, setSettled] = useState<string | undefined>(undefined);
  // Every change of the searchable text starts the wait again, so that a text that had settled, left and returned to within the debounce, is not
  // asked at once because it equals the one that settled. The reset is made in the render that sees the change (React's "adjusting state when a
  // value changes"), not in an effect, so that no render between the two shows the earlier settled text as standing still.
  const [seen, setSeen] = useState(wanted);
  if (seen !== wanted) {
    setSeen(wanted);
    setSettled(undefined);
  }

  // The text settles once it has stood still. The timer belongs to the text it was set for, and is cleared by the next one.
  useEffect(() => {
    if (wanted === undefined || wanted === settled) return undefined;
    const timer = setTimeout(() => {
      setSettled(wanted);
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [wanted, settled]);

  const asking = me !== undefined && wanted !== undefined && wanted === settled;
  const read = useQuery({
    queryKey: ['record-lookup', wanted ?? ''],
    enabled: asking,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    // The signal ends the request of a text the person has typed past: a name search is a scan on the server, and a superseded one is no work worth finishing.
    // The text is sent in the body of a POST that changes nothing, never in the address: a phone number typed in full must not be in a URL (the
    // Product Owner's decision of 6 November 2026). The client adds the session's synchronizer token to any method that is not safe.
    queryFn: async ({ signal }) => {
      const answer = answerOf(
        await client.POST('/ops/lookup', { body: { q: wanted ?? '' }, signal }),
      );
      const page = parseRecordLookup(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
  const retry = () => {
    // Only a text that stood still and is being asked: a refetch ignores `enabled`, and would ask an empty text (a 400) or a text that has not
    // stood still.
    if (!asking) return;
    void read.refetch();
  };

  if (wanted === undefined || me === undefined) {
    return { status: 'idle', query: '', results: [], error: null, retry };
  }
  if (wanted !== settled) {
    return { status: 'waiting', query: wanted, results: [], error: null, retry };
  }
  if (read.isError) {
    return { status: 'error', query: wanted, results: [], error: read.error, retry };
  }
  if (read.isSuccess) {
    return { status: 'success', query: wanted, results: read.data.items, error: null, retry };
  }
  return { status: 'loading', query: wanted, results: [], error: null, retry };
}
