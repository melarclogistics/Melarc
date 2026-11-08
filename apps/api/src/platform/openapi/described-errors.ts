import { applyDecorators } from '@nestjs/common';
import { ApiExtension, ApiResponse } from '@nestjs/swagger';

import { ErrorCode, statusOf } from '../http/error-codes.js';

/**
 * The error envelope of the contract (`Error`), as the application's own description states it: the code is one of the catalogue's
 * codes (`ErrorCode`, which `error-codes.test.ts` holds to the contract's enumeration both ways), the message is diagnostic text, the
 * details are an open object, and the request id correlates the answer with the log.
 */
export const ERROR_BODY_SCHEMA = Object.freeze({
  type: 'object',
  required: ['code', 'message', 'request_id'],
  properties: {
    code: { type: 'string', enum: Object.values(ErrorCode).toSorted() },
    message: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
    request_id: { type: 'string' },
  },
} as const);

/**
 * States the errors an operation answers with, from the codes it raises: the `x-error-codes` extension, and one response for each
 * status those codes are answered with (`statusOf`, errors-and-enums.md §4: one rule for every operation), each carrying the error
 * envelope. The statuses are **derived from the code's own table and never typed beside the codes**, so an operation that raises a
 * `403` code and declares no `403` cannot be written, and the conformance check compares the result with the contract's own list.
 *
 * A code whose status no document decides (`SETTING_MISSING`, `SETTING_INVALID`) is refused here, as `statusOf` refuses it.
 */
export function DescribeErrors(...codes: readonly ErrorCode[]): MethodDecorator {
  if (codes.length === 0 || new Set(codes).size !== codes.length) {
    throw new TypeError('An operation states each of the error codes it raises once');
  }
  const statuses = [...new Set(codes.map((code) => statusOf(code)))].toSorted((a, b) => a - b);
  return applyDecorators(
    ApiExtension('x-error-codes', [...codes].toSorted()),
    ...statuses.map((status) =>
      ApiResponse({ status, schema: ERROR_BODY_SCHEMA as unknown as Record<string, unknown> }),
    ),
  );
}
