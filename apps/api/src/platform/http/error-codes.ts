/**
 * The contract's `Error.code` enumeration (contracts/openapi.yaml, `components.schemas.Error`; owned by
 * contracts/errors-and-enums.md), every code of it and no other. The enumeration is closed, so a code absent from it must never be
 * emitted, and a code the contract has must be reachable by name: `error-codes.test.ts` compares this object with the contract's
 * enumeration both ways, so adding a code to one and not the other fails.
 *
 * What the platform itself emits is a subset (`NOT_FOUND`, `VALIDATION_FAILED`, `PERMISSION_DENIED`, and from S0.22 on the
 * authentication, CSRF, limiter and authorization refusals); a domain raises its own codes through `ApiException` with the
 * status `statusOf` gives.
 */
export const ErrorCode = {
  AccountOverdue: 'ACCOUNT_OVERDUE',
  AllowanceDisabled: 'ALLOWANCE_DISABLED',
  AttemptsExhausted: 'ATTEMPTS_EXHAUSTED',
  BlindCountViolated: 'BLIND_COUNT_VIOLATED',
  CarrierCostRequired: 'CARRIER_COST_REQUIRED',
  CarrierNotApproved: 'CARRIER_NOT_APPROVED',
  CashHandoverVariance: 'CASH_HANDOVER_VARIANCE',
  ChallengeExpired: 'CHALLENGE_EXPIRED',
  ChallengeUnusable: 'CHALLENGE_UNUSABLE',
  CodeExpired: 'CODE_EXPIRED',
  CodeInvalid: 'CODE_INVALID',
  CollectionNotRecorded: 'COLLECTION_NOT_RECORDED',
  CommitmentReasonRequired: 'COMMITMENT_REASON_REQUIRED',
  CommitmentSourceUnresolved: 'COMMITMENT_SOURCE_UNRESOLVED',
  CorridorDayNotPermitted: 'CORRIDOR_DAY_NOT_PERMITTED',
  CredentialDeliveryFailed: 'CREDENTIAL_DELIVERY_FAILED',
  CredentialLocked: 'CREDENTIAL_LOCKED',
  CreditLimitExceeded: 'CREDIT_LIMIT_EXCEEDED',
  CsrfValidationFailed: 'CSRF_VALIDATION_FAILED',
  CustodyNotReturned: 'CUSTODY_NOT_RETURNED',
  DeliveryChannelFailed: 'DELIVERY_CHANNEL_FAILED',
  DestinationUnresolved: 'DESTINATION_UNRESOLVED',
  DeviceIntegrityFailed: 'DEVICE_INTEGRITY_FAILED',
  DeviceNotEnrolled: 'DEVICE_NOT_ENROLLED',
  DeviceProofInvalid: 'DEVICE_PROOF_INVALID',
  DeviceSecurityUnsupported: 'DEVICE_SECURITY_UNSUPPORTED',
  DispatchNotCleared: 'DISPATCH_NOT_CLEARED',
  DoorstepWaitNotElapsed: 'DOORSTEP_WAIT_NOT_ELAPSED',
  EvidenceNotStored: 'EVIDENCE_NOT_STORED',
  EvidenceRequired: 'EVIDENCE_REQUIRED',
  EvidenceUploadExpired: 'EVIDENCE_UPLOAD_EXPIRED',
  ExceptionNotAvailableToSelfService: 'EXCEPTION_NOT_AVAILABLE_TO_SELF_SERVICE',
  ExportFileExpired: 'EXPORT_FILE_EXPIRED',
  ExportRetentionNotConfigured: 'EXPORT_RETENTION_NOT_CONFIGURED',
  ExportSourceNotEventComplete: 'EXPORT_SOURCE_NOT_EVENT_COMPLETE',
  FallbackAuthorizationAlreadyConsumed: 'FALLBACK_AUTHORIZATION_ALREADY_CONSUMED',
  FallbackAuthorizationDemandMismatch: 'FALLBACK_AUTHORIZATION_DEMAND_MISMATCH',
  FallbackAuthorizationMethodMismatch: 'FALLBACK_AUTHORIZATION_METHOD_MISMATCH',
  FallbackAuthorizationSuperseded: 'FALLBACK_AUTHORIZATION_SUPERSEDED',
  FallbackRequiresAuthorization: 'FALLBACK_REQUIRES_AUTHORIZATION',
  FinancialClosureIncomplete: 'FINANCIAL_CLOSURE_INCOMPLETE',
  HandoffNotRecorded: 'HANDOFF_NOT_RECORDED',
  HandshakeNotVerified: 'HANDSHAKE_NOT_VERIFIED',
  HubScopeViolation: 'HUB_SCOPE_VIOLATION',
  IdempotencyKeyConflict: 'IDEMPOTENCY_KEY_CONFLICT',
  InsufficientAuthority: 'INSUFFICIENT_AUTHORITY',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  ManifestEmpty: 'MANIFEST_EMPTY',
  ManifestNotStarted: 'MANIFEST_NOT_STARTED',
  MarginNotConfigured: 'MARGIN_NOT_CONFIGURED',
  MfaEnrolmentRequired: 'MFA_ENROLMENT_REQUIRED',
  MfaProofInvalid: 'MFA_PROOF_INVALID',
  MfaRequired: 'MFA_REQUIRED',
  NotificationFailed: 'NOTIFICATION_FAILED',
  NotAssignedRider: 'NOT_ASSIGNED_RIDER',
  NotCustodyHolder: 'NOT_CUSTODY_HOLDER',
  NotFound: 'NOT_FOUND',
  NoChargeApplied: 'NO_CHARGE_APPLIED',
  NoPricingChange: 'NO_PRICING_CHANGE',
  NoRegisteredNumber: 'NO_REGISTERED_NUMBER',
  NoServiceableMotorcycle: 'NO_SERVICEABLE_MOTORCYCLE',
  OrderNotCommerciallyCleared: 'ORDER_NOT_COMMERCIALLY_CLEARED',
  OrderNotOnRun: 'ORDER_NOT_ON_RUN',
  OrderUnpriced: 'ORDER_UNPRICED',
  OtpInvalid: 'OTP_INVALID',
  OutboundChargeUnpaid: 'OUTBOUND_CHARGE_UNPAID',
  ParcelNotAcceptable: 'PARCEL_NOT_ACCEPTABLE',
  ParcelNotInHubCustody: 'PARCEL_NOT_IN_HUB_CUSTODY',
  ParityNotMet: 'PARITY_NOT_MET',
  PaymentAlreadyPending: 'PAYMENT_ALREADY_PENDING',
  PaymentAlreadySettled: 'PAYMENT_ALREADY_SETTLED',
  PaymentAmountMismatch: 'PAYMENT_AMOUNT_MISMATCH',
  PaymentCollectionNotAllowed: 'PAYMENT_COLLECTION_NOT_ALLOWED',
  PaymentFallbackNotVerified: 'PAYMENT_FALLBACK_NOT_VERIFIED',
  PaymentNotConfirmed: 'PAYMENT_NOT_CONFIRMED',
  PaymentProviderUnavailable: 'PAYMENT_PROVIDER_UNAVAILABLE',
  PaymentStatusUnknown: 'PAYMENT_STATUS_UNKNOWN',
  PeriodNotReconciled: 'PERIOD_NOT_RECONCILED',
  PermissionDenied: 'PERMISSION_DENIED',
  PickupAttemptLimitReached: 'PICKUP_ATTEMPT_LIMIT_REACHED',
  PickupMinimumNotMet: 'PICKUP_MINIMUM_NOT_MET',
  RateLimited: 'RATE_LIMITED',
  ReasonNotActive: 'REASON_NOT_ACTIVE',
  ReasonNotValidForCheckpoint: 'REASON_NOT_VALID_FOR_CHECKPOINT',
  ReasonRequired: 'REASON_REQUIRED',
  RecipientNotConfirmed: 'RECIPIENT_NOT_CONFIRMED',
  RecipientPaymentOutstanding: 'RECIPIENT_PAYMENT_OUTSTANDING',
  RecoveryTokenInvalid: 'RECOVERY_TOKEN_INVALID',
  ReplacementRequired: 'REPLACEMENT_REQUIRED',
  ReturnFeeOutstanding: 'RETURN_FEE_OUTSTANDING',
  RiderUnavailable: 'RIDER_UNAVAILABLE',
  RoadExpenseAlreadyApplied: 'ROAD_EXPENSE_ALREADY_APPLIED',
  RoadExpenseNotApproved: 'ROAD_EXPENSE_NOT_APPROVED',
  RunAlreadyStarted: 'RUN_ALREADY_STARTED',
  SelfApprovalForbidden: 'SELF_APPROVAL_FORBIDDEN',
  SelfCancelNotPermittedAfterAssignment: 'SELF_CANCEL_NOT_PERMITTED_AFTER_ASSIGNMENT',
  SenderIdentityAmbiguous: 'SENDER_IDENTITY_AMBIGUOUS',
  SenderSuspended: 'SENDER_SUSPENDED',
  ServiceDateNotPermitted: 'SERVICE_DATE_NOT_PERMITTED',
  ServiceWindowOverrideReasonRequired: 'SERVICE_WINDOW_OVERRIDE_REASON_REQUIRED',
  SessionInvalid: 'SESSION_INVALID',
  SessionSuperseded: 'SESSION_SUPERSEDED',
  SettingInvalid: 'SETTING_INVALID',
  SettingMissing: 'SETTING_MISSING',
  SetupGrantInvalid: 'SETUP_GRANT_INVALID',
  SinglePackageApprovalRequired: 'SINGLE_PACKAGE_APPROVAL_REQUIRED',
  SizeClassRequired: 'SIZE_CLASS_REQUIRED',
  SmsFallbackLimitReached: 'SMS_FALLBACK_LIMIT_REACHED',
  SourceStillActive: 'SOURCE_STILL_ACTIVE',
  StateConflict: 'STATE_CONFLICT',
  StopsUnresolved: 'STOPS_UNRESOLVED',
  StopNotQualifying: 'STOP_NOT_QUALIFYING',
  TerminalForStationDrop: 'TERMINAL_FOR_STATION_DROP',
  TrustDataUnavailable: 'TRUST_DATA_UNAVAILABLE',
  ValidationFailed: 'VALIDATION_FAILED',
  ValueDeclarationRequired: 'VALUE_DECLARATION_REQUIRED',
  VerificationFallbackNotAuthorized: 'VERIFICATION_FALLBACK_NOT_AUTHORIZED',
  WaybillRequired: 'WAYBILL_REQUIRED',
  WorkEmailInUse: 'WORK_EMAIL_IN_USE',
  ZeroCollectionIsFailure: 'ZERO_COLLECTION_IS_FAILURE',
  ZoneNotServicedOnDate: 'ZONE_NOT_SERVICED_ON_DATE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * The HTTP status each code is answered with. One rule for every operation (errors-and-enums.md §4, "Statuses are one rule for
 * every operation", Product decision of 6 October 2026; `AC-SLICE-000-131`):
 *
 * - the codes the axis table of §4 gives a status keep it: `400` `VALIDATION_FAILED`; `401` `SESSION_INVALID` and
 *   `SESSION_SUPERSEDED`; `403` `PERMISSION_DENIED`, `INSUFFICIENT_AUTHORITY`, `HUB_SCOPE_VIOLATION`, `CSRF_VALIDATION_FAILED` and
 *   `MFA_ENROLMENT_REQUIRED` (the one named code that is `403`); `404` `NOT_FOUND`; `409` `STATE_CONFLICT` and
 *   `IDEMPOTENCY_KEY_CONFLICT`; `429` `RATE_LIMITED`; and `503` `TRUST_DATA_UNAVAILABLE`, the contract's only declared `5xx`;
 * - every other code states a business rule (every domain code of §5, `SELF_APPROVAL_FORBIDDEN`, and the sign-in, factor, grant,
 *   challenge and recovery codes) and is `422`;
 * - **`SETTING_MISSING` and `SETTING_INVALID` have no status in any retained document** (§4 gives their meaning and not their
 *   status). They are `null` here and are not given one: the status of the business answers of the hub-settings paths that declare
 *   them is each such operation's own task's (plan §7.16, §7.18), and `statusOf` refuses to answer for them until it is made. The
 *   runtime's own failure to read a setting it needs is not one of them on the wire: it is the code-less `503` (decision B of 12
 *   October 2026, `operational-failure.ts`).
 */
const NAMED_STATUS: Readonly<Partial<Record<ErrorCode, number | null>>> = {
  [ErrorCode.ValidationFailed]: 400,
  [ErrorCode.SessionInvalid]: 401,
  [ErrorCode.SessionSuperseded]: 401,
  [ErrorCode.PermissionDenied]: 403,
  [ErrorCode.InsufficientAuthority]: 403,
  [ErrorCode.HubScopeViolation]: 403,
  [ErrorCode.CsrfValidationFailed]: 403,
  [ErrorCode.MfaEnrolmentRequired]: 403,
  [ErrorCode.NotFound]: 404,
  [ErrorCode.StateConflict]: 409,
  [ErrorCode.IdempotencyKeyConflict]: 409,
  [ErrorCode.RateLimited]: 429,
  [ErrorCode.TrustDataUnavailable]: 503,
  [ErrorCode.SettingMissing]: null,
  [ErrorCode.SettingInvalid]: null,
};

const BUSINESS_RULE_STATUS = 422;

/** The status a code is answered with, or `null` for the two whose status no retained document states. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number | null>> = Object.freeze(
  Object.fromEntries(
    Object.values(ErrorCode).map((code) => [
      code,
      code in NAMED_STATUS ? NAMED_STATUS[code] : BUSINESS_RULE_STATUS,
    ]),
  ) as Record<ErrorCode, number | null>,
);

/** The status of a code. It throws for a code whose status is undecided, so that no status is invented for it. */
export function statusOf(code: ErrorCode): number {
  const status = ERROR_STATUS[code];
  if (status === null) {
    throw new Error(
      `No status is decided for ${code}: the owner decides it before an operation raises it`,
    );
  }
  return status;
}
