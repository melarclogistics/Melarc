import { noteRefusal } from '../platform/audit/audit-record.js';
import { AUDIT_LIMITS } from '../platform/audit/audit-vocabulary.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';

/** The bound of a note, the audit's own, so that the contract, the route schemas and the screening state one number. */
export const NOTE_MAX_LENGTH = AUDIT_LIMITS.maxNoteLength;

/**
 * The note of an administrative operation (`revokeSession`, `resetStaffMfa`, `approveStaffIdentity`, `reissueStaffCredentialSetup`), judged
 * before the operation begins, in the place a malformed body is judged: after the authority and scope refusals and before the version
 * and the state (openapi.yaml, the four operations). A note is one line of at most 1000 characters with no control character, address or
 * number in it: the bound and the screening of the audit event that keeps it (`noteRefusal`), so a note accepted here is a note the
 * ledger will take. A refusal names the field and never repeats the text. A note that is blank carries no explanation and is kept as none.
 */
export function checkedNote(note: string | undefined, field = 'note'): string | undefined {
  if (note === undefined) return undefined;
  const rule = noteRefusal(note);
  if (rule !== undefined) {
    throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
      violations: [{ in: 'body', pointer: `/${field}`, rule }],
    });
  }
  return note.trim() === '' ? undefined : note;
}

/**
 * The note an operation **requires** (`reregisterRiderDevice`'s `verification_note`: how Senior Ops verified the rider in person, which the
 * audit record must say): the rules of `checkedNote`, and a note that is blank is no note, so it is refused where an optional one is dropped.
 */
export function requiredNote(note: string, field: string): string {
  const checked = checkedNote(note, field);
  if (checked === undefined) {
    throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
      violations: [{ in: 'body', pointer: `/${field}`, rule: 'minLength' }],
    });
  }
  return checked;
}
