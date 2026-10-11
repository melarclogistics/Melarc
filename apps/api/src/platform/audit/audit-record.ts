import type {
  AuditEventInput,
  AuditJson,
  AuditJsonObject,
  AuditOutcome,
  AuditScalar,
} from '../auth/ports/audit-writer.port.js';
import { AUDIT_OUTCOMES } from '../auth/ports/audit-writer.port.js';
import { auditActorOf, type AuditActorType } from '../database/audit-actor.js';
import { isUuid, type SecurityContext } from '../database/transaction-context.js';
import { scrubText } from '../logging/scrub-text.js';
import {
  EVENT_REQUIREMENTS,
  conditionalBases,
  diffRuleFor,
  tierOf,
  type EventRequirements,
} from './audit-classification.js';
import { validateMfaResetFacts } from './audit-mfa-reset.js';
import { isAuditEventCode, type AuditEventCode } from './audit-event-codes.js';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_LIMITS,
  AUDIT_OBJECT_TYPES,
  AUDIT_SERIALISATION_VERSION,
} from './audit-vocabulary.js';

/** What the writer refuses, by the names the port's descriptor gives (`raises`). */
export type AuditRefusal =
  'AUDIT_EVENT_CODE_UNKNOWN' | 'AUDIT_DETAIL_REFUSED' | 'AUDIT_EVENT_REFUSED';

/**
 * An event the writer will not store. The message names the field and never repeats a value: what was refused may be a secret,
 * and this error reaches logs. It is a programming defect of the caller, not a condition a request can cause, so it is not an
 * answer to anybody.
 */
export class AuditRefusedError extends Error {
  constructor(
    readonly code: AuditRefusal,
    readonly field: string,
  ) {
    super(`The audit event was refused (${code}): ${field}`);
    this.name = 'AuditRefusedError';
  }
}

/** An event as it is stored: every column of `audit_event` that the writer fills, validated, screened and frozen. */
export interface AuditRecord {
  readonly id: string;
  readonly eventCode: string;
  readonly occurredAt: Date;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly actorBundle: string | null;
  readonly surfaceContext: string;
  readonly deviceContext: AuditJsonObject | null;
  readonly vendorOrganizationId: string | null;
  readonly responsibleHubId: string | null;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly correlationId: string;
  readonly previousState: string | null;
  readonly resultingState: string | null;
  readonly reasonCode: string | null;
  readonly reasonLabel: string | null;
  readonly note: string | null;
  readonly approvalId: string | null;
  readonly beforeAfter: AuditJsonObject | null;
  readonly relatedIds: AuditJsonObject | null;
  readonly detail: Readonly<Record<string, AuditScalar>>;
  readonly outcome: AuditOutcome;
  readonly enhanced: boolean;
  readonly serialisationVersion: number;
}

// ---------------------------------------------------------------------------------------------------------------------------
// What may be written into the facts. The ledger is append-only, so a value that should not be there cannot be taken back out:
// the screen is at the door. It is the writer's own and central (audit.md §9.1: redaction is central, not per call site).
// ---------------------------------------------------------------------------------------------------------------------------

const KEY = /^[a-z][a-z0-9_]*$/;
/** Words that make a name a secret wherever they sit in it once the underscores are taken out (as logging/redaction.ts reads a key). */
const SECRET_WORDS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'csrf',
  'signature',
  'privatekey',
  'apikey',
  'signedurl',
  'totp',
];
/** Short words that make a name a secret only as a whole part of it (`pin_count`, not `shipping`). */
const SECRET_PARTS = new Set(['otp', 'pin', 'seed', 'sig']);
const STATE = /^[A-Z][A-Z0-9_]*$/;
/** `scheme://user:password@host`: the part before the host is not an address, and the scrubber has already taken its password. */
const URL_USERINFO = /:\/\/[^\s/@]*@/g;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** An international number in E.164 form, alone or inside text. */
const PHONE = /(?:^|[^\w])\+[1-9]\d{7,14}(?!\d)/;
const CONTROL = /\p{Cc}/u;

const refuseDetail = (field: string): never => {
  throw new AuditRefusedError('AUDIT_DETAIL_REFUSED', field);
};
const refuseEvent = (field: string): never => {
  throw new AuditRefusedError('AUDIT_EVENT_REFUSED', field);
};

function isSecretName(key: string): boolean {
  const squashed = key.replaceAll('_', '');
  return (
    SECRET_WORDS.some((word) => squashed.includes(word)) ||
    key.split('_').some((part) => SECRET_PARTS.has(part))
  );
}

function screenName(key: string, field: string): void {
  if (key.length > AUDIT_LIMITS.maxKeyLength || !KEY.test(key) || isSecretName(key))
    refuseDetail(field);
}

/** A text value, screened: an address or a number is refused, a secret that travels inside the text is removed. */
function screenText(text: string, field: string, maxLength: number): string {
  if (text.length > maxLength || CONTROL.test(text)) refuseDetail(field);
  const scrubbed = scrubText(text);
  if (EMAIL.test(scrubbed.replaceAll(URL_USERINFO, '://')) || PHONE.test(scrubbed))
    refuseDetail(field);
  return scrubbed;
}

function screenValue(value: unknown, field: string, depth: number): AuditJson {
  if (typeof value === 'string') return screenText(value, field, AUDIT_LIMITS.maxStringLength);
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : refuseDetail(field);
  if (Array.isArray(value)) {
    if (depth >= AUDIT_LIMITS.maxDepth || value.length > AUDIT_LIMITS.maxKeys * 2)
      refuseDetail(field);
    return Object.freeze(
      Array.from(value as unknown[], (item: unknown) => screenValue(item, `${field}[]`, depth + 1)),
    );
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return screenObject(value as Record<string, unknown>, field, depth + 1);
  }
  return refuseDetail(field);
}

function screenObject(
  value: Record<string, unknown>,
  field: string,
  depth: number,
): AuditJsonObject {
  if (depth > AUDIT_LIMITS.maxDepth) refuseDetail(field);
  const keys = Object.keys(value);
  if (keys.length > AUDIT_LIMITS.maxKeys) refuseDetail(field);
  const screened: Record<string, AuditJson> = {};
  for (const key of keys) {
    screenName(key, field);
    screened[key] = screenValue(value[key], `${field}.${key}`, depth);
  }
  return Object.freeze(screened);
}

function structured(value: unknown, field: string): AuditJsonObject | null {
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return refuseDetail(field);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return refuseDetail(field);
  }
  const screened = screenObject(value as Record<string, unknown>, field, 1);
  if (Buffer.byteLength(JSON.stringify(screened)) > AUDIT_LIMITS.maxJsonBytes) refuseDetail(field);
  return screened;
}

function flatDetail(value: unknown): Readonly<Record<string, AuditScalar>> {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return refuseDetail('detail');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > AUDIT_LIMITS.maxKeys) refuseDetail('detail');
  const screened: Record<string, AuditScalar> = {};
  for (const key of keys) {
    screenName(key, 'detail');
    const entry = record[key];
    if (entry !== null && typeof entry === 'object') refuseDetail(`detail.${key}`);
    screened[key] = screenValue(entry, `detail.${key}`, AUDIT_LIMITS.maxDepth) as AuditScalar;
  }
  if (Buffer.byteLength(JSON.stringify(screened)) > AUDIT_LIMITS.maxJsonBytes)
    refuseDetail('detail');
  return Object.freeze(screened);
}

// ---------------------------------------------------------------------------------------------------------------------------
// The fields of the contract that are not free facts.
// ---------------------------------------------------------------------------------------------------------------------------

const optionalUuid = (value: unknown, field: string): string | null => {
  if (value === undefined) return null;
  return isUuid(value) ? value.toLowerCase() : refuseEvent(field);
};

const optionalState = (value: unknown, field: string): string | null => {
  if (value === undefined) return null;
  return typeof value === 'string' &&
    value.length <= AUDIT_LIMITS.maxStateLength &&
    STATE.test(value)
    ? value
    : refuseEvent(field);
};

function actorFor(
  given: AuditEventInput['actor'],
  context: SecurityContext,
): { actorType: AuditActorType; actorId: string | null } {
  const expected = auditActorOf(context);
  if (given === undefined) return expected;
  const type: unknown = given.type;
  const id: unknown = given.id;
  if (typeof type !== 'string' || !(AUDIT_ACTOR_TYPES as readonly string[]).includes(type))
    refuseEvent('actor');
  // The system has no id, and a person always has one (audit.md §3: `actor_id` is null for SYSTEM).
  if (type === 'SYSTEM' ? id !== null : !isUuid(id)) refuseEvent('actor');
  const actorId = typeof id === 'string' ? id.toLowerCase() : null;
  const same = type === expected.actorType && actorId === expected.actorId;
  // A human principal's transaction records that principal. Only a SYSTEM transaction (sign-in, bootstrap: nobody holds a
  // session yet) names the person it authenticated, and it cannot name the system by an id.
  if (!same && (context.principalType !== 'SYSTEM' || type === 'SYSTEM')) refuseEvent('actor');
  // The technical identifier of the capability is not a person, whoever is named: it never becomes an `actor_id` (OB-47).
  if (context.principalType === 'SYSTEM' && actorId === context.principalId.toLowerCase())
    refuseEvent('actor');
  return { actorType: type as AuditActorType, actorId };
}

/**
 * The tier of the event, which the catalogue fixes (G2-06; `audit-classification.ts`). A mandatory enhanced event cannot be
 * downgraded, an ordinary one cannot be raised, and one whose tier depends on the act says which case it is, and the case is
 * checked against the transaction where the transaction can say.
 */
function enforceClassification(
  input: AuditEventInput,
  context: SecurityContext,
  actorType: AuditActorType,
): void {
  const code = input.code as AuditEventCode;
  const tier = tierOf(code);
  const given: unknown = input.enhancedBasis;
  if (tier !== 'CONDITIONAL') {
    if (given !== undefined) refuseEvent('enhancedBasis');
    if (input.enhanced !== (tier === 'ENHANCED')) refuseEvent('enhanced');
    return;
  }
  const bases = conditionalBases(code);
  const basis =
    bases !== undefined && typeof given === 'string' && Object.hasOwn(bases, given)
      ? bases[given]
      : undefined;
  if (basis === undefined) return refuseEvent('enhancedBasis');
  if (input.enhanced !== basis.enhanced) refuseEvent('enhanced');
  if (basis.actorType !== undefined && actorType !== basis.actorType) refuseEvent('enhancedBasis');
  if (
    basis.systemCapability !== undefined &&
    !(context.principalType === 'SYSTEM' && context.taskCapability === basis.systemCapability)
  ) {
    refuseEvent('enhancedBasis');
  }
}

const hasKeys = (object: AuditJsonObject | null, keys: readonly string[]): boolean =>
  object !== null && keys.every((key) => Object.hasOwn(object, key) && object[key] !== null);

/**
 * The facts the catalogue says an event records, for the events whose requirements are settled (`EVENT_REQUIREMENTS`), and the rule
 * of the before and after (audit.md section 6). **The tier does not decide whether an event carries a before and after; the change
 * it records does** (`diffRuleFor`): an enhanced event that changed something carries the values or safe diff of it, and one that
 * changed nothing (a read, a factor accepted or rejected, an export, a rejected or failed attempt, a coalesced request) carries
 * none and keeps its own mandatory evidence instead. No value is invented to satisfy a rule: a fact that is missing is a refusal, and
 * the refusal names the field.
 */
function enforceRequirements(
  input: AuditEventInput,
  facts: {
    readonly objectType: unknown;
    readonly objectId: string | null;
    readonly beforeAfter: AuditJsonObject | null;
    readonly relatedIds: AuditJsonObject | null;
    readonly actorType: AuditActorType;
    readonly actorId: string | null;
  },
): void {
  const requirements: EventRequirements | undefined = Object.hasOwn(EVENT_REQUIREMENTS, input.code)
    ? EVENT_REQUIREMENTS[input.code as AuditEventCode]
    : undefined;
  // No object means no object to name; the catalogue allows that for two events, in the cases it describes, and for no other.
  if (facts.objectId === null && requirements?.objectMayBeAbsent !== true) refuseEvent('object.id');

  const diff = diffRuleFor({
    code: input.code,
    enhanced: input.enhanced,
    outcome: input.outcome,
    resultingState: input.resultingState,
  });
  const hasDiff = facts.beforeAfter !== null && Object.keys(facts.beforeAfter).length > 0;
  if (diff === 'ABSENT' && facts.beforeAfter !== null) refuseEvent('beforeAfter');
  if (diff === 'REQUIRED' && !hasDiff) refuseEvent('beforeAfter');
  if (requirements === undefined) return;

  if (requirements.actorTypes !== undefined && !requirements.actorTypes.includes(facts.actorType)) {
    refuseEvent('actor');
  }
  if (requirements.reason === true && input.reason === undefined) refuseEvent('reason');
  if (
    requirements.previousState !== undefined &&
    !(
      typeof input.previousState === 'string' &&
      requirements.previousState.includes(input.previousState)
    )
  ) {
    refuseEvent('previousState');
  }
  if (
    requirements.resultingState !== undefined &&
    !(
      typeof input.resultingState === 'string' &&
      requirements.resultingState.includes(input.resultingState)
    )
  ) {
    refuseEvent('resultingState');
  }
  if (requirements.responsibleHub === true && input.responsibleHubId === undefined) {
    refuseEvent('responsibleHubId');
  }
  if (
    requirements.relatedIdsPresent === true &&
    (facts.relatedIds === null || Object.keys(facts.relatedIds).length === 0)
  ) {
    refuseEvent('relatedIds');
  }
  if (
    requirements.relatedIdsAnyOf !== undefined &&
    !requirements.relatedIdsAnyOf.some((group) => hasKeys(facts.relatedIds, group))
  ) {
    refuseEvent('relatedIds');
  }
  const whenObject =
    typeof facts.objectType === 'string' && requirements.relatedIdsWhenObject !== undefined
      ? requirements.relatedIdsWhenObject[facts.objectType]
      : undefined;
  if (whenObject !== undefined && !hasKeys(facts.relatedIds, whenObject)) {
    refuseEvent('relatedIds');
  }

  if (input.code === 'auth.mfa.reset') {
    validateMfaResetFacts(
      {
        outcome: input.outcome,
        previousState: input.previousState,
        resultingState: input.resultingState,
        reasonCode: input.reason?.code,
        objectType: facts.objectType,
        objectId: facts.objectId,
        actorId: facts.actorId,
        relatedIds: facts.relatedIds,
        beforeAfter: facts.beforeAfter,
      },
      refuseEvent,
    );
  }
}

/**
 * The record that an event becomes, or a refusal. Pure: it reads the event, the context of the transaction the event is written
 * in, the time and the new identifier it is given, and nothing else.
 *
 * **Where each field comes from.** The actor, the surface and the correlation id come from the transaction's context
 * (`auditActorOf` for the actor: a `SYSTEM` transaction is the null actor, and the technical identifier of its capability never
 * becomes an `actor_id`, OB-47); the code, tier, outcome, object, hub and the facts come from the caller and are checked here;
 * the recording time is the database's and is not set here at all. A code outside the catalogue, an object type outside the
 * closed set and an identifier that is not a uuid are refused, and so is a fact whose name says it is a secret, an address or a
 * number, or anything unbounded. A secret that travels inside a text value is removed (`scrubText`, the scrubber of the logs).
 */
export function buildAuditRecord(
  input: AuditEventInput,
  context: SecurityContext,
  now: Date,
  id: string,
): AuditRecord {
  if (!isAuditEventCode(input.code))
    throw new AuditRefusedError('AUDIT_EVENT_CODE_UNKNOWN', 'code');
  if (typeof input.enhanced !== 'boolean') refuseEvent('enhanced');
  if (!(AUDIT_OUTCOMES as readonly unknown[]).includes(input.outcome)) refuseEvent('outcome');

  const objectType: unknown = input.object.type;
  if (
    typeof objectType !== 'string' ||
    !(AUDIT_OBJECT_TYPES as readonly string[]).includes(objectType)
  ) {
    refuseEvent('object.type');
  }
  const objectId = input.object.id === null ? null : optionalUuid(input.object.id, 'object.id');

  const occurredAt = input.occurredAt ?? now;
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime()))
    refuseEvent('occurredAt');

  let reasonCode: string | null = null;
  let reasonLabel: string | null = null;
  if (input.reason !== undefined) {
    const { code, label } = input.reason;
    if (
      typeof code !== 'string' ||
      code.length > AUDIT_LIMITS.maxStateLength ||
      !STATE.test(code)
    ) {
      refuseEvent('reason.code');
    }
    if (typeof label !== 'string' || label.trim() === '') refuseEvent('reason.label');
    reasonCode = code;
    reasonLabel = screenText(label, 'reason.label', AUDIT_LIMITS.maxLabelLength);
  }

  let actorBundle: string | null = null;
  if (input.actorBundle !== undefined) {
    if (typeof input.actorBundle !== 'string' || input.actorBundle.trim() === '')
      refuseEvent('actorBundle');
    actorBundle = screenText(input.actorBundle, 'actorBundle', AUDIT_LIMITS.maxBundleLength);
  }

  const { actorType, actorId } = actorFor(input.actor, context);
  const beforeAfter = structured(input.beforeAfter, 'beforeAfter');
  const relatedIds = structured(input.relatedIds, 'relatedIds');
  enforceClassification(input, context, actorType);
  enforceRequirements(input, { objectType, objectId, beforeAfter, relatedIds, actorType, actorId });

  return Object.freeze({
    id,
    eventCode: input.code,
    occurredAt,
    actorType,
    actorId,
    actorBundle,
    surfaceContext: context.surface,
    deviceContext: structured(input.deviceContext, 'deviceContext'),
    vendorOrganizationId: optionalUuid(input.vendorOrganizationId, 'vendorOrganizationId'),
    responsibleHubId: optionalUuid(input.responsibleHubId, 'responsibleHubId'),
    objectType: objectType as string,
    objectId,
    // The transaction's, but screened like any text: it may be derived from a client's key, and the ledger is append-only.
    correlationId: screenText(
      context.correlationId,
      'correlationId',
      AUDIT_LIMITS.maxCorrelationLength,
    ),
    previousState: optionalState(input.previousState, 'previousState'),
    resultingState: optionalState(input.resultingState, 'resultingState'),
    reasonCode,
    reasonLabel,
    note:
      input.note === undefined ? null : screenText(input.note, 'note', AUDIT_LIMITS.maxNoteLength),
    approvalId: optionalUuid(input.approvalId, 'approvalId'),
    beforeAfter,
    relatedIds,
    detail: flatDetail(input.detail),
    outcome: input.outcome,
    enhanced: input.enhanced,
    serialisationVersion: AUDIT_SERIALISATION_VERSION,
  });
}
