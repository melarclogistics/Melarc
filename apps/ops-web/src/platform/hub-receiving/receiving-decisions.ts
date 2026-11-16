import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import type { components } from '@melarc/api-client';

import { parseIntake } from '../hub-intake/hub-intake-shape';
import { parseCheckIn } from './receiving-shape';

type Outcome = components['schemas']['DiscrepancyAdjudication']['outcome'];

/** What a senior officer decides about a case: the outcome, the reason in words (mandatory) and the photos that go with it. */
export interface CaseDecision {
  readonly outcome: Outcome;
  readonly note: string;
  /** Stored photos of the case, taken for the decision (purpose `OSD`). */
  readonly evidenceIds?: readonly string[];
}

/** The version a decision leaves: the record as it now is has a new `ETag`, which the page reads again for itself. */
export interface Decided {
  readonly version: string;
}

function phaseOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null
    ? (body as { readonly count_phase?: unknown }).count_phase
    : undefined;
}

/**
 * `adjudicateDiscrepancy` (`hub.osd.adjudicate`: a senior officer, never Ops Staff; `If-Match` of the record read, and no `Idempotency-Key`): *Still searching* (`ESCALATED`) leaves the case open, *Accept*
 * and *Write off* close it, and *Vendor told* (`VENDOR_NOTIFIED`) records, after a write-off, that someone told the vendor: nothing is sent. The reason is mandatory. **The answer is the record in the shape of
 * its mode** (a vendor's check-in, or a counted blind intake), and either is judged and must be this vendor's; the page reads the record again for what the decision changed.
 */
export async function decideCase(
  client: ApiClient,
  intakeId: string,
  decision: CaseDecision,
  version: string,
): Promise<Decided> {
  const answer = answerOf(
    await client.POST('/hub-intakes/{id}/discrepancy', {
      params: { path: { id: intakeId }, header: { 'If-Match': version } },
      body: {
        outcome: decision.outcome,
        note: decision.note,
        ...(decision.evidenceIds === undefined || decision.evidenceIds.length === 0
          ? {}
          : { evidence_ids: [...decision.evidenceIds] }),
      },
    }),
  );
  if (answer.etag === undefined) throw unexpectedResponse(answer.status);
  const id =
    phaseOf(answer.data) === 'CHECK_IN'
      ? parseCheckIn(answer.data)?.id
      : parseIntake(answer.data)?.id;
  if (id?.toLowerCase() !== intakeId.toLowerCase()) throw unexpectedResponse(answer.status);
  return { version: answer.etag };
}
