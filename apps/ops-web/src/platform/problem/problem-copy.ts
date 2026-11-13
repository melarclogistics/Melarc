import { ApiError } from '@melarc/api-client/browser';

import type { ForbiddenKind } from '../../components/ui/forbidden-state/ForbiddenState';
import { OperationFailure, type Violation } from '../api/api-response';
import { StaleSessionError } from '../session/session-boundary';
import { refusalText } from './capability-words';
import { MANIFEST_COPY } from './manifest-copy';
import { NOTIFICATION_COPY } from './notification-copy';
import { PICKUP_COPY } from './pickup-copy';
import { PICKUP_WORK_COPY } from './pickup-work-copy';
import { RIDER_COPY } from './rider-copy';
import { STAFF_COPY } from './staff-copy';
import { RATE_LIMITED_MESSAGE, rateLimitWaitSeconds } from './rate-limit';
import { VENDOR_COPY } from './vendor-copy';

/**
 * What a failed call is, for the person looking at the screen, and the words for it.
 *
 * The words belong to the Ops Portal and not to the server: the `message` of an error is a diagnostic for engineers and is never shown
 * (surfaces/ops-portal.md section 8), so a failure is read by its machine `code`, its status and where it happened. Copy is keyed by
 * **operation, context and code** in the one table below, because one global message per code is not enough: the same `VALIDATION_FAILED`
 * says a different thing about a note and about a reason (COMPONENT_PATTERNS section 33). The generic wording is proposed here for the
 * Product Owner to review as part of the composed screens, and no customer-facing wording is invented beyond it.
 */
export type ProblemKind =
  /** A refusal of authority. `forbidden` says which, and the screen names the permission, never a role. */
  | 'forbidden'
  | 'not-found'
  /** The record is not in the state, or at the version, the command expected: it changed. */
  | 'conflict'
  /** The request, or something in it, was not accepted: validation, or a reason. */
  | 'invalid'
  /**
   * The request was too fast (`RATE_LIMITED`, `429`): the one handling of `rate-limit.ts` beside this file. The words are the calm
   * `RATE_LIMITED_MESSAGE` unless the table has words for the operation (the screens reached before sign-in), `waitSeconds` is the wait the
   * page keeps its automatic reads still for (`platform/query/read-hold.ts`), and the command palette shows the words in its status line, not
   * in an error alert.
   */
  | 'rate-limited'
  /** The API answered and declined for some other reason. */
  | 'refused'
  /** No answer, an answer that is not the API's, or a fault: the outcome of a command may be unknown. */
  | 'unavailable'
  /** The session ended. The session boundary has taken the person away; a screen shows nothing. */
  | 'session-ended'
  /** The answer was for a session that has gone. Nothing is shown and nothing is kept. */
  | 'stale';

export interface Problem {
  readonly kind: ProblemKind;
  /** For a `forbidden` problem, which refusal it is. */
  readonly forbidden?: ForbiddenKind;
  /** Approved presentation copy; empty for the two kinds that show nothing. Never the server's `message`. */
  readonly message: string;
  /** The machine code the API gave, when it gave one. */
  readonly code?: string;
  /** The request id, for a person to quote when they ask for help. */
  readonly reference?: string;
  /** Where a request was refused (place and rule, never a value), when the API said. */
  readonly violations?: readonly Violation[];
  /** The rule a refusal declares (`details.rule`: `service_date_passed`), a machine name the screen words itself. */
  readonly rule?: string;
  /** The stops a refusal names (`details.stops`), as identifiers. */
  readonly stops?: readonly string[];
  /**
   * For a `rate-limited` problem: the whole seconds the page keeps its automatic reads still, from one to a minute: what the API asked in
   * `Retry-After`, or a few seconds when it asked for nothing usable (`rateLimitWaitSeconds`).
   */
  readonly waitSeconds?: number;
}

/** Where a call was made, so that the words can be the right ones for it. */
export interface ProblemPlace {
  /** The `operationId` of the call. */
  readonly operation?: string;
  /** What the call was for on the screen: a field (`note`, `reason`), or a part of a page. */
  readonly context?: string;
}

/** One line of the copy table. A line with no `operation`, `context` or `code` speaks for all of them. */
export interface CopyRule {
  readonly operation?: string;
  readonly context?: string;
  readonly code?: string;
  readonly text: string;
}

/**
 * The words of the five pre-sign-in screens (S0.43). Every one of them is shown to a person the system knows nothing about, so none says
 * anything that is true of one address and not another: the password step has one refusal, the grant pages have one error for every grant
 * that cannot be used, and a lock is told at the second step alone, to a person who has proved the password (ops-portal.md section 7).
 */
const TOO_MANY_ATTEMPTS = 'Too many attempts. Wait a minute, then try again.';
const CHALLENGE_FINISHED = 'This attempt is finished. Sign in again.';
export const GRANT_CANNOT_BE_USED =
  'This link cannot be used. It may have expired, or it may already have been used.';
const SIX_DIGITS = 'Enter the six digits shown in your authenticator app.';
/** The one error of a recovery link (ops-portal.md section 7, `/recovery/complete`): it never says which way the link was dead. */
export const RECOVERY_LINK_CANNOT_BE_USED =
  'This link cannot be used. It may have expired, it may already have been used, or a newer recovery may have replaced it.';

/** The operations a person reaches with no session. Each one answers a too-fast request with the same plain wait. */
const PRE_SIGN_IN_OPERATIONS = [
  'staffSignIn',
  'completeStaffMfaSignIn',
  'completeStaffCredentialSetup',
  'beginMfaReenrolment',
  'completeMfaEnrolment',
  'requestCredentialRecovery',
  'completeCredentialRecovery',
] as const;

const GRANT_OPERATIONS = [
  'completeStaffCredentialSetup',
  'beginMfaReenrolment',
  'completeMfaEnrolment',
] as const;

/**
 * The copy table. The most specific rule that matches wins (see {@link lookupCopy}). An operation's own wording goes here when its screen
 * is built, with that screen's tests; these are the ones the foundation and the pre-sign-in screens need. The context `unknown-outcome` is
 * the wording of a command that got no answer, where the act may or may not have been done.
 */
export const PROBLEM_COPY: readonly CopyRule[] = [
  ...PRE_SIGN_IN_OPERATIONS.map((operation): CopyRule => ({
    operation,
    code: 'RATE_LIMITED',
    text: TOO_MANY_ATTEMPTS,
  })),
  ...GRANT_OPERATIONS.map((operation): CopyRule => ({
    operation,
    code: 'SETUP_GRANT_INVALID',
    text: GRANT_CANNOT_BE_USED,
  })),
  {
    operation: 'staffSignIn',
    code: 'INVALID_CREDENTIALS',
    text: 'The email or password is not correct.',
  },
  {
    operation: 'staffSignIn',
    context: 'email',
    code: 'VALIDATION_FAILED',
    text: 'Enter your work email address.',
  },
  {
    operation: 'staffSignIn',
    context: 'password',
    code: 'VALIDATION_FAILED',
    text: 'A password has at most 128 characters.',
  },
  {
    operation: 'staffSignIn',
    context: 'unknown-outcome',
    text: 'The server could not be reached or could not finish this. Try again.',
  },
  {
    operation: 'completeStaffMfaSignIn',
    code: 'MFA_PROOF_INVALID',
    text: 'That code was not accepted.',
  },
  { operation: 'completeStaffMfaSignIn', code: 'CHALLENGE_UNUSABLE', text: CHALLENGE_FINISHED },
  { operation: 'completeStaffMfaSignIn', code: 'INVALID_CREDENTIALS', text: CHALLENGE_FINISHED },
  {
    operation: 'completeStaffMfaSignIn',
    code: 'CHALLENGE_EXPIRED',
    text: 'That took too long. Sign in again.',
  },
  {
    operation: 'completeStaffMfaSignIn',
    code: 'CREDENTIAL_LOCKED',
    text: 'This account is locked for fifteen minutes. Recovering the password clears it.',
  },
  {
    operation: 'completeStaffMfaSignIn',
    code: 'MFA_ENROLMENT_REQUIRED',
    text: 'You cannot sign in until your authenticator is set up. If your set-up link has expired or was already used, ask someone who can reset authenticators to reset yours: a new link will be sent to your work email.',
  },
  {
    operation: 'completeStaffMfaSignIn',
    context: 'code',
    code: 'VALIDATION_FAILED',
    text: SIX_DIGITS,
  },
  {
    operation: 'completeStaffMfaSignIn',
    context: 'unknown-outcome',
    text: 'We could not confirm whether the code was accepted. Try a new code. If that is refused, sign in again.',
  },
  {
    operation: 'completeStaffCredentialSetup',
    context: 'password',
    code: 'VALIDATION_FAILED',
    text: 'Use 12 to 128 characters. Spaces are allowed, and nothing else is required.',
  },
  {
    operation: 'completeStaffCredentialSetup',
    context: 'unknown-outcome',
    text: 'We could not confirm whether your password was set. Try again. If the link is then refused, try signing in.',
  },
  {
    operation: 'requestCredentialRecovery',
    context: 'email',
    code: 'VALIDATION_FAILED',
    text: 'Enter your work email address.',
  },
  {
    operation: 'requestCredentialRecovery',
    context: 'unknown-outcome',
    text: 'We could not confirm whether your request was received. Try again.',
  },
  {
    operation: 'completeCredentialRecovery',
    code: 'RECOVERY_TOKEN_INVALID',
    text: RECOVERY_LINK_CANNOT_BE_USED,
  },
  {
    operation: 'completeCredentialRecovery',
    context: 'password',
    code: 'VALIDATION_FAILED',
    text: 'Use 12 to 128 characters. Spaces are allowed, and nothing else is required.',
  },
  {
    operation: 'completeCredentialRecovery',
    context: 'unknown-outcome',
    text: 'We could not confirm whether your password was changed. Try again. If the link is then refused, try signing in with the new password.',
  },
  {
    operation: 'beginMfaReenrolment',
    context: 'unknown-outcome',
    text: 'We could not confirm whether this started. Try again. If the link is then refused, ask for a new one.',
  },
  {
    operation: 'completeMfaEnrolment',
    code: 'MFA_PROOF_INVALID',
    text: 'That code was not accepted. Your authenticator is not set up yet. Try the next code it shows.',
  },
  {
    operation: 'completeMfaEnrolment',
    context: 'code',
    code: 'VALIDATION_FAILED',
    text: SIX_DIGITS,
  },
  {
    operation: 'completeMfaEnrolment',
    context: 'unknown-outcome',
    text: 'We could not confirm whether your authenticator was set up. Try a new code. If the link is then refused, try signing in.',
  },
  {
    code: 'CSRF_VALIDATION_FAILED',
    text: 'The request could not be verified. Reload the page and try again.',
  },
  {
    code: 'IDEMPOTENCY_KEY_CONFLICT',
    text: 'This request clashed with an earlier attempt. Check the record before trying again.',
  },
  { operation: 'signOut', text: 'Sign-out did not finish, so you are still signed in.' },
  { operation: 'listReasonDefinitions', text: 'The reasons could not be loaded.' },
  { operation: 'getQueueSummary', text: 'The summary of what is waiting could not be read.' },
  { operation: 'lookupRecords', text: 'The search could not be completed.' },
  {
    context: 'note',
    code: 'VALIDATION_FAILED',
    text: 'The note was not accepted. Keep it to one line, and leave out email addresses and telephone numbers.',
  },
  { context: 'note', code: 'REASON_REQUIRED', text: 'A note is needed for this reason.' },
  {
    context: 'reason',
    code: 'REASON_NOT_ACTIVE',
    text: 'That reason can no longer be used for this. Choose another.',
  },
  {
    context: 'reason',
    code: 'VALIDATION_FAILED',
    text: 'That reason was not accepted. Choose another.',
  },
  { context: 'reason', code: 'REASON_REQUIRED', text: 'Choose a reason.' },
  ...STAFF_COPY,
  ...VENDOR_COPY,
  ...RIDER_COPY,
  ...PICKUP_COPY,
  ...MANIFEST_COPY,
  ...PICKUP_WORK_COPY,
  ...NOTIFICATION_COPY,
];

const DEFAULT_MESSAGE: Readonly<Record<Exclude<ProblemKind, 'forbidden'>, string>> = {
  'not-found': 'This record could not be found.',
  conflict: 'This record changed after you opened it. Reload it to see its current state.',
  invalid: 'Some of what was entered was not accepted. Check it and try again.',
  'rate-limited': RATE_LIMITED_MESSAGE,
  refused: 'The request was not accepted.',
  unavailable: 'The server could not be reached or could not finish this. Try again.',
  'session-ended': '',
  stale: '',
};

// What a refusal says is the table's (`capability-words.ts`), for every kind: the message a problem carries is the sentence the refusal components draw, one wording.
const FORBIDDEN_MESSAGE: Readonly<Record<ForbiddenKind, string>> = {
  'permission-missing': refusalText('permission-missing', undefined),
  'insufficient-authority': refusalText('insufficient-authority', undefined),
  'outside-hubs': refusalText('outside-hubs', undefined),
  'approval-required': refusalText('approval-required', undefined),
  'unavailable-here': refusalText('unavailable-here', undefined),
};

/** The refusals of authority, by the code that names them (errors-and-enums.md section 4). */
const FORBIDDEN_BY_CODE: ReadonlyMap<string, ForbiddenKind> = new Map([
  ['PERMISSION_DENIED', 'permission-missing'],
  ['INSUFFICIENT_AUTHORITY', 'insufficient-authority'],
  ['HUB_SCOPE_VIOLATION', 'outside-hubs'],
  ['SELF_APPROVAL_FORBIDDEN', 'approval-required'],
]);

const KIND_BY_CODE: ReadonlyMap<string, Exclude<ProblemKind, 'forbidden'>> = new Map([
  ['NOT_FOUND', 'not-found'],
  ['STATE_CONFLICT', 'conflict'],
  ['VALIDATION_FAILED', 'invalid'],
  ['REASON_REQUIRED', 'invalid'],
  ['REASON_NOT_ACTIVE', 'invalid'],
  ['RATE_LIMITED', 'rate-limited'],
]);

/**
 * The words for a place, from a table of rules: the rule that names the operation, the context and the code beats one that names two of
 * them, which beats one that names one. An operation's wording beats a context's, which beats a code's. A rule that names something
 * the place does not have never matches, and nothing matches a place by default. With `codeOnly` a rule must name the code, which is how a
 * failure with a meaning of its own (a missing record, a conflict) is kept from being worded as the operation's general failure.
 */
export function lookupCopy(
  rules: readonly CopyRule[],
  place: { readonly operation?: string; readonly context?: string; readonly code?: string },
  options: { readonly codeOnly?: boolean } = {},
): string | undefined {
  const { operation, context, code } = place;
  const candidates: readonly (readonly [
    string | undefined,
    string | undefined,
    string | undefined,
  ])[] = [
    [operation, context, code],
    [operation, undefined, code],
    [operation, context, undefined],
    [operation, undefined, undefined],
    [undefined, context, code],
    [undefined, undefined, code],
    [undefined, context, undefined],
  ];
  for (const [wantedOperation, wantedContext, wantedCode] of candidates) {
    if (wantedOperation === undefined && wantedContext === undefined && wantedCode === undefined) {
      continue;
    }
    // A rule for a whole operation says what its failures are in general; it does not speak over a code that has a meaning of its own.
    if (options.codeOnly === true && wantedCode === undefined) continue;
    const rule = rules.find(
      (candidate) =>
        candidate.operation === wantedOperation &&
        candidate.context === wantedContext &&
        candidate.code === wantedCode,
    );
    if (rule !== undefined) return rule.text;
  }
  return undefined;
}

/** The copy of the table for a place, if it has a rule. For a field's own words, which no whole-call problem carries. */
export function copyFor(
  place: { readonly operation?: string; readonly context?: string; readonly code?: string },
  options: { readonly codeOnly?: boolean } = {},
): string | undefined {
  return lookupCopy(PROBLEM_COPY, place, options);
}

/** What a failed call is, and the words for it. Anything that is not an `ApiError` is a fault of the page or the network and is `unavailable`. */
export function problemOf(error: unknown, place: ProblemPlace = {}): Problem {
  if (error instanceof StaleSessionError) return { kind: 'stale', message: '' };
  if (!(error instanceof ApiError)) {
    return {
      kind: 'unavailable',
      message: copyFor(place) ?? DEFAULT_MESSAGE.unavailable,
    };
  }

  const { code, requestId: reference } = error;
  if (error.endsSession) {
    return { kind: 'session-ended', message: '', ...(code === undefined ? {} : { code }) };
  }

  const forbidden =
    error.kind === 'http' && code !== undefined ? FORBIDDEN_BY_CODE.get(code) : undefined;
  const refusedAs =
    error.kind === 'http' && code !== undefined ? KIND_BY_CODE.get(code) : undefined;
  let kind: ProblemKind;
  if (forbidden !== undefined) kind = 'forbidden';
  else if (refusedAs !== undefined) kind = refusedAs;
  else if (error.kind !== 'http' || (error.status !== undefined && error.status >= 500)) {
    kind = 'unavailable';
  } else kind = 'refused';

  const general = kind === 'unavailable' || kind === 'refused';
  // A refusal that declares the rule it broke (`details.rule`) is worded by the rule when the page gave no context of its own: the table keeps
  // a rule's words under the operation, the rule as context and the code, and a rule it has no words for falls back to the operation's own.
  const ruled =
    error instanceof OperationFailure && error.rule !== undefined && place.context === undefined
      ? { ...place, context: error.rule }
      : place;
  const worded = copyFor(
    { ...ruled, ...(code === undefined ? {} : { code }) },
    { codeOnly: !general },
  );
  const message =
    worded ??
    (forbidden !== undefined
      ? FORBIDDEN_MESSAGE[forbidden]
      : DEFAULT_MESSAGE[kind as Exclude<ProblemKind, 'forbidden'>]);

  return {
    kind,
    message,
    ...(forbidden === undefined ? {} : { forbidden }),
    ...(code === undefined ? {} : { code }),
    ...(reference === undefined ? {} : { reference }),
    ...(error instanceof OperationFailure && error.violations.length > 0
      ? { violations: error.violations }
      : {}),
    ...(error instanceof OperationFailure && error.rule !== undefined ? { rule: error.rule } : {}),
    ...(error instanceof OperationFailure && error.stops.length > 0 ? { stops: error.stops } : {}),
    ...(kind === 'rate-limited'
      ? {
          waitSeconds: rateLimitWaitSeconds(
            error instanceof OperationFailure ? error.retryAfterSeconds : undefined,
          ),
        }
      : {}),
  };
}
