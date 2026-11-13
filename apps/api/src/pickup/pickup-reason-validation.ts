import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { guardReasonIn } from '../platform/database/database-failures.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import {
  ReasonRefusedError,
  type ReasonRequest,
  type ReasonValidator,
  type ValidatedReason,
} from '../platform/settings/reason-validator.js';

/** The one answer to a refused reason: the contract's `REASON_REQUIRED` or `REASON_NOT_ACTIVE` (errors-and-enums.md section 5). */
function answered(
  error: ReasonRefusedError,
  details?: Readonly<Record<string, unknown>>,
): ApiException {
  return ApiException.of(
    error.code === 'REASON_REQUIRED' ? ErrorCode.ReasonRequired : ErrorCode.ReasonNotActive,
    error.message,
    details,
  );
}

/**
 * A reason the catalogue refuses is the contract's `REASON_REQUIRED` or `REASON_NOT_ACTIVE` (errors-and-enums.md section 5); anything else
 * the validator throws is not this function's and goes on as it was. The message never repeats what the client sent, and `details` (the
 * place of the offending reason in the body, where there are several) is the caller's to give.
 *
 * Shared by the operations of the pickup domain that take a catalogue reason (the cancellation of a request, the carry-over of a request
 * onto a manifest), so that each answers a refused reason in one way.
 */
export async function validatedReason(
  reasons: Pick<ReasonValidator, 'validate'>,
  handle: TransactionHandle,
  request: ReasonRequest,
  details?: Readonly<Record<string, unknown>>,
): Promise<ValidatedReason> {
  try {
    return await reasons.validate(handle, request);
  } catch (error) {
    if (error instanceof ReasonRefusedError) throw answered(error, details);
    throw error;
  }
}

/**
 * The same answer for a reason the **database's guard** refused after the validator accepted it (`DETAIL reason=REASON_REQUIRED` or
 * `reason=REASON_NOT_ACTIVE` of a `23514`, read by `guardReasonIn`): a record that keeps a snapshot of a catalogue reason holds the snapshot
 * to the catalogue as it stands at the insert, so a catalogue that changed between the act's reading and its write is refused there and is
 * not a server error. The act is undone with the refusal, and a retry reads the catalogue again. `undefined` for every other failure, which
 * the caller rethrows.
 */
export function reasonRefusedByGuard(
  error: unknown,
  details?: Readonly<Record<string, unknown>>,
): ApiException | undefined {
  const reason = guardReasonIn(error);
  if (reason === 'REASON_CATEGORY_MISMATCH') return reasonOfAnotherCategory();
  return reason === 'REASON_REQUIRED' || reason === 'REASON_NOT_ACTIVE'
    ? answered(new ReasonRefusedError(reason), details)
    : undefined;
}

/**
 * The answer to a failure reported under a category its reason does not belong to (D-A4, `OB-S1-73`): `VALIDATION_FAILED`, the reason being the field at fault, with the rule
 * `category`. The catalogue binds each `PICKUP_FAILURE` reason to one of the four fixed categories (`reason_code.failure_category`); the service judges it before the evidence, the
 * photo and the door wait, and the stop's guard holds it for every writer (`reason=REASON_CATEGORY_MISMATCH`). The message repeats nothing the client sent.
 */
export function reasonOfAnotherCategory(): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer: '/reason_code', rule: 'category' }],
  });
}
