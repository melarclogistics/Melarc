import type { Json } from '../../platform/contract/json.js';

/**
 * Every way the implementation can disagree with the contract that the conformance check reports. A
 * finding is a defect in the implementation, never in the contract: the contract is the authority
 * (SOLUTION_ARCHITECTURE.md section 3), so the code is what changes, or a reviewed contract change is made.
 */
export const FINDING_CODES = [
  // Which operations are implemented, and where.
  'UNDOCUMENTED_ROUTE',
  'ROUTE_OUTSIDE_SCOPE',
  'SCOPE_OPERATION_UNKNOWN',
  'OPERATION_NOT_LIVE',
  'OPERATION_NOT_DESCRIBED',
  'OPERATION_NOT_VALIDATED',
  'DESCRIBED_BUT_NOT_LIVE',
  'OPERATION_ROUTE_DRIFT',
  'OPERATION_DRIFT',
  // An operation's parts.
  'PARAMETER_DRIFT',
  'REQUEST_BODY_DRIFT',
  'RESPONSE_DRIFT',
  'ERROR_RESPONSE_DRIFT',
  'HEADER_DRIFT',
  'COOKIE_DRIFT',
  'SECURITY_DRIFT',
  'EXTENSION_DRIFT',
  // A fact of an operation, a parameter, a body or a response that the comparison does not model (a link, an
  // encoding, a callback). It is reported when only one side states it or the two differ, never dropped.
  'OPERATION_UNMODELLED',
  // A schema inside any of them.
  'SCHEMA_TYPE',
  'SCHEMA_NULLABLE',
  'SCHEMA_FORMAT',
  'SCHEMA_ENUM',
  'SCHEMA_REQUIRED',
  'SCHEMA_PROPERTY_MISSING',
  'SCHEMA_PROPERTY_EXTRA',
  'SCHEMA_ADDITIONAL_PROPERTIES',
  'SCHEMA_ITEMS',
  'SCHEMA_COMPOSITION',
  'SCHEMA_CONSTRAINT',
  'SCHEMA_DEFAULT',
  'SCHEMA_ACCESS',
  'SCHEMA_UNMODELLED',
  'SCHEMA_SHAPE',
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];

export interface Finding {
  readonly code: FindingCode;
  /** Where, in words a developer can follow: `GET /orders/{id} > response 200 > application/json > body`. */
  readonly at: string;
  readonly message: string;
  readonly expected?: Json;
  readonly actual?: Json;
}

export function formatFinding(finding: Finding): string {
  return `${finding.code}  ${finding.at}\n    ${finding.message}`;
}
