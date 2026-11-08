import type { operations } from '@melarc/api-client';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';

type ListQuery = NonNullable<operations['listReasonDefinitions']['parameters']['query']>;

/** The operations whose reasons the catalogue can be asked for: the identity operations (the contract's `operation` filter). */
export type ReasonOperation = NonNullable<ListQuery['operation']>;

/** The branch of an operation that narrows its reasons (the contract's `branch` filter). */
export type ReasonBranch = NonNullable<ListQuery['branch']>;

/** A reason as a screen needs it to offer it: which one, in what words, and whether the note it asks for is mandatory. */
export interface ReasonChoice {
  readonly code: string;
  readonly label: string;
  readonly requiresNote: boolean;
}

const MAX_REASONS = 500;
const MAX_CODE_LENGTH = 64;
const MAX_LABEL_LENGTH = 200;
const CODE_SHAPE = /^[A-Za-z0-9_.-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A control character does not belong in a code or a label, and would not survive being drawn or logged. */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/**
 * The reasons a screen may offer, from an answer of `listReasonDefinitions`, or nothing when the answer is not the catalogue. The send
 * boundary guarantees JSON, not that it is this list, and a reason picker offers what it is given to a person who is about to act on
 * it: so the answer is judged before it is believed, for the fields the picker uses, and a single entry that is not a reason makes the
 * whole answer unusable. A reason that is not active is left out (the server would refuse it as `REASON_NOT_ACTIVE`), and the order
 * is the server's. The result holds what was judged and nothing else of the entry.
 */
export function parseReasons(body: unknown): ReasonChoice[] | undefined {
  if (!Array.isArray(body) || body.length > MAX_REASONS) return undefined;
  const reasons: ReasonChoice[] = [];
  const seen = new Set<string>();
  for (const entry of body as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const { code, label, active, requiresNote } = entry;
    if (
      typeof code !== 'string' ||
      code.length === 0 ||
      code.length > MAX_CODE_LENGTH ||
      !CODE_SHAPE.test(code) ||
      typeof label !== 'string' ||
      label.trim() === '' ||
      label.length > MAX_LABEL_LENGTH ||
      hasControlCharacter(label) ||
      typeof active !== 'boolean' ||
      !(requiresNote === undefined || typeof requiresNote === 'boolean')
    ) {
      return undefined;
    }
    if (seen.has(code)) return undefined;
    seen.add(code);
    if (active) reasons.push({ code, label, requiresNote: requiresNote === true });
  }
  return reasons;
}

/**
 * The reasons of one action, asked of the server with the filters that make it offer only reasons the action will not refuse
 * (`operation`, and the `branch` the action is on, which comes from the record's reset state and never from `mfa_enrolled`). The server
 * revalidates at use. The catalogue is not read again when the window is focused or the connection returns (every request the API
 * accepts counts as activity), and a failed read is retried by the person and not by the page.
 */
export function useReasonDefinitions(
  operation: ReasonOperation,
  branch?: ReasonBranch,
): UseQueryResult<ReasonChoice[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['reason-definitions', operation, branch ?? null],
    // The request is not tied to the query's abort signal: the answer is a few lines, and a dialog opened twice in quick succession (or
    // twice by the development build's strict mode) should share one request and not cancel and repeat it.
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/reason-definitions', {
          params: { query: { operation, ...(branch === undefined ? {} : { branch }) } },
        }),
      );
      const reasons = parseReasons(answer.data);
      if (reasons === undefined) throw unexpectedResponse(answer.status);
      return reasons;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
