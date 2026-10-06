/**
 * Codes from the catalogue (contracts/errors-and-enums.md) that the platform itself emits. The
 * contract's Error.code enumeration is closed, so a code absent from it must never be emitted; a test
 * checks every value here against contracts/openapi.yaml.
 */
export const ErrorCode = {
  NotFound: 'NOT_FOUND',
  ValidationFailed: 'VALIDATION_FAILED',
  PermissionDenied: 'PERMISSION_DENIED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
