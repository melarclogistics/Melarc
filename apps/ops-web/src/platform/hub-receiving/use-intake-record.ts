import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import { parseIntake, type IntakeView } from '../hub-intake/hub-intake-shape';
import { parseCheckIn, type CheckInView } from './receiving-shape';

/**
 * A vendor's record as `getHubIntake` gave it, **told by the mode of the vendor**: a vendor with door photos is a check-in (`HubIntakeCheckIn`: parcels, names, the rider's number shown, the findings), a vendor
 * counted blind is the intake as the blind-count screens judge it (before its count it has no declaration, count, comparison, condition, finding or photo, and an answer that carries any of them is refused
 * whole). The `ETag` is the version every act on the record takes, exactly as it was sent; it does not move with the lock.
 */
export type IntakeRecordView =
  | { readonly kind: 'check-in'; readonly view: CheckInView; readonly etag: string }
  | { readonly kind: 'blind'; readonly intake: IntakeView; readonly etag: string };

/** The key of the one read of a vendor's record, so that an act that changes it can ask for it to be read again. */
export const intakeRecordKey = (id: string) =>
  ['hub-receiving', 'intake', id.toLowerCase()] as const;

/** The idle read of a record (see `useReceivingRun`): nothing is read again on focus or reconnection, nothing is kept once the screen lets go, and a failure is retried by the person. */
const NOT_KEPT = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  gcTime: 0,
} as const;

function phaseOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null
    ? (body as { readonly count_phase?: unknown }).count_phase
    : undefined;
}

/**
 * `getHubIntake` (`hub.read`): one vendor's record, **as a check-in or as a blind-count intake** by what the API says it is, judged before it is believed, with its `ETag`. An answer that is neither, or is
 * another vendor's, is refused as an unexpected response and never drawn.
 */
export function useIntakeRecord(id: string, enabled = true): UseQueryResult<IntakeRecordView> {
  const client = useApiClient();
  return useQuery({
    queryKey: intakeRecordKey(id),
    enabled,
    ...NOT_KEPT,
    queryFn: async (): Promise<IntakeRecordView> => {
      const answer = answerOf(await client.GET('/hub-intakes/{id}', { params: { path: { id } } }));
      if (answer.etag === undefined) throw unexpectedResponse(answer.status);
      if (phaseOf(answer.data) === 'CHECK_IN') {
        const view = parseCheckIn(answer.data);
        if (view?.id.toLowerCase() !== id.toLowerCase()) throw unexpectedResponse(answer.status);
        return { kind: 'check-in', view, etag: answer.etag };
      }
      const intake = parseIntake(answer.data);
      if (intake?.id.toLowerCase() !== id.toLowerCase()) throw unexpectedResponse(answer.status);
      return { kind: 'blind', intake, etag: answer.etag };
    },
  });
}
