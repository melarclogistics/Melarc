import { noteRefusal } from './audit-record.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';

/**
 * The note an operation of the pickup domain requires of Ops (S1.15 `resolveCutoffException`: why a late booking is approved or
 * rescheduled; S1.16 `requestOnePackageException`: why a single package should go), judged before the operation begins, where a malformed
 * body is judged.
 *
 * - **A note that is blank explains nothing, and that is `REASON_REQUIRED`** (the contract: "blank is REASON_REQUIRED"), not a malformed
 *   body, so it is judged first, even when what is blank is made of a tab or a line break.
 * - **Then the audit's own screening** (`noteRefusal`: one line of at most 1000 characters with no control character, address or
 *   international number in it), so that a note accepted here is a note the ledger will keep, and the refusal names the field and never
 *   repeats the text.
 *
 * Returned as it was given: the ledger keeps the note, and the operation does not trim what a person wrote.
 */
export function requiredNote(note: string, pointer = '/note'): string {
  if (note.trim() === '') {
    throw ApiException.of(ErrorCode.ReasonRequired, 'A note saying why is required');
  }
  const rule = noteRefusal(note);
  if (rule !== undefined) {
    throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
      violations: [{ in: 'body', pointer, rule }],
    });
  }
  return note;
}
