import type { components } from '@melarc/api-client';

/**
 * The runtime judgement of the answers of the identity operations (the same discipline as `session-shape.ts` and `pre-sign-in-shape.ts`,
 * U05 of 23 October 2026). The send boundary guarantees JSON and the generated client gives an answer a type, but a type is a promise
 * nobody checked at run time: a proxy's `{}` would be shown as a person with an approve button, a list from another version as the queue
 * an approver works down, a session list as the sessions to cut.
 *
 * It is not a second description of the wire. The types stay the contract's, and `test/staff-contract.test.ts` reads the contract and holds
 * each list below to its schema. What each parser returns is what it judged and nothing else: a field the contract adds and this does not
 * read is not carried into a screen, and a credential a server should never send has nowhere to go.
 */
export const STAFF_STATUSES = [
  'PENDING_APPROVAL',
  'ACTIVE',
  'REJECTED',
  'SUSPENDED',
  'OFFBOARDED',
] as const;

export const MFA_RESET_STATES = ['FACTOR_ACTIVE', 'ENROLMENT_UNFINISHED', 'NOT_ELIGIBLE'] as const;

export const PRINCIPAL_TYPES = ['STAFF', 'RIDER', 'VENDOR'] as const;

const SESSION_STATES = ['ACTIVE', 'TERMINATED'] as const;

const TERMINATION_REASONS = [
  'SIGNED_OUT',
  'SUPERSEDED_BY_NEW_LOGIN',
  'REPLACED_BY_NEW_SESSION',
  'EXPIRED',
  'CREDENTIAL_CHANGED',
  'SUSPENDED',
  'OFFBOARDED',
  'ADMIN_REVOKED',
  'AUTHORITY_CHANGED',
  'HUB_SCOPE_CHANGED',
  'DEVICE_REVOKED',
  'DEVICE_REPLACED',
  'MFA_RESET',
] as const;

export const STAFF_FIELDS = {
  StaffIdentity: {
    required: [
      'id',
      'work_email',
      'full_name',
      'status',
      'role_bundle_id',
      'mfa_enrolled',
      'mfa_reset_state',
      'created_by',
    ],
    optional: ['phone', 'primary_hub_id', 'approved_by'],
    enums: { status: STAFF_STATUSES, mfa_reset_state: MFA_RESET_STATES },
  },
  AssignableStaffRoleBundle: {
    required: ['id', 'name', 'requires_platform_admin_approval'],
    optional: [],
    enums: {},
  },
  SessionRecord: {
    required: ['id', 'principal_type', 'state', 'expires_at'],
    optional: ['principal_id', 'issued_at', 'last_activity_at', 'termination_reason'],
    enums: {
      principal_type: PRINCIPAL_TYPES,
      state: SESSION_STATES,
      termination_reason: TERMINATION_REASONS,
    },
  },
  MfaResetResult: {
    required: ['sessions_terminated'],
    optional: ['reenrolment_grant_issued', 'coalesced', 'grant_expires_at'],
    enums: {},
  },
  SetupGrant: {
    required: ['id', 'principal_type', 'principal_id', 'purpose', 'state', 'issued_at'],
    optional: ['expires_at'],
    enums: {},
  },
  TrustedBrowser: {
    required: ['id', 'label', 'created_at', 'expires_at', 'last_used_at', 'current'],
    optional: [],
    enums: {},
  },
  TrustedBrowsersRevoked: {
    required: ['revoked'],
    optional: [],
    enums: {},
  },
} as const;

export type StaffIdentityView = components['schemas']['StaffIdentity'];
export type StaffStatus = StaffIdentityView['status'];
export type MfaResetState = StaffIdentityView['mfa_reset_state'];
export type AssignableBundleView = components['schemas']['AssignableStaffRoleBundle'];
export type SessionRecordView = components['schemas']['SessionRecord'];
export type PrincipalType = SessionRecordView['principal_type'];
export type TrustedBrowserView = components['schemas']['TrustedBrowser'];

export interface StaffIdentityPageView {
  readonly items: readonly StaffIdentityView[];
  /** The token of the next page, or nothing when this is the last. */
  readonly nextPageToken: string | null;
}

/** What a reset came to, without anything that could open an account: counts, and when the grant that is usable now lapses. */
export interface MfaResetOutcome {
  readonly sessionsTerminated: number;
  /** This call queued a new grant. */
  readonly grantIssued: boolean;
  /** A usable grant or a pending delivery already existed, so nothing new was issued. */
  readonly coalesced: boolean;
  readonly grantExpiresAt: string | null;
}

/** What a re-issue came to: that a setup grant is pending, and when it lapses. The grant itself is never in the answer. */
export interface SetupGrantOutcome {
  readonly expiresAt: string | null;
}

/**
 * What an administrator's recovery came to (`RecoveryRequest`; S0.52): a link is pending, how it travels, until when, and whether this call
 * was absorbed by a link already live (nothing was sent then). The token is never in the answer, and the shape has no place for one.
 */
export interface RecoveryRequestOutcome {
  readonly coalesced: boolean;
  readonly channel: 'EMAIL' | 'SMS';
  readonly expiresAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The most entries a page of the staff list can hold (the contract's largest `page_size`). */
const MAX_PAGE_ITEMS = 100;
/** Not paged by the contract, and small by design; a list far beyond this is not the API's. */
const MAX_BUNDLES = 200;
const MAX_SESSIONS = 500;
/** An identity holds at most five valid trusted browsers (staff-authentication.md section 5.8); a list far beyond that is not the API's. */
const MAX_TRUSTED_BROWSERS = 50;
/** The contract's `maxLength` of a trusted browser's label. */
const MAX_BROWSER_LABEL = 80;
const MAX_TERMINATED = 10_000;
const MAX_TEXT = 512;
const MAX_TOKEN = 2048;

// The judges below are shared with the vendor screens' shapes (`platform/vendor/vendor-shape.ts`), which read the same kinds of field.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isOneOf = <const List extends readonly string[]>(
  list: List,
  value: unknown,
): value is List[number] => typeof value === 'string' && list.includes(value);

export function uuidOf(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

export function instantOf(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** A line of text a screen may draw: something other than blanks, bounded, on one line. */
export function lineOf(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= MAX_TEXT &&
    !hasControlCharacter(value)
    ? value
    : undefined;
}

/** A field that may be absent or null, judged when it is there. `undefined` (the field is bad) is told from `null`/absent (nothing). */
export function optional<T>(
  value: unknown,
  judge: (value: unknown) => T | undefined,
): T | null | undefined {
  if (value === undefined || value === null) return null;
  return judge(value);
}

/** The identity the answer describes, or nothing when it is not one the screens may show. */
export function parseStaffIdentity(body: unknown): StaffIdentityView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const email = lineOf(body.work_email);
  const name = lineOf(body.full_name);
  const bundle = uuidOf(body.role_bundle_id);
  const createdBy = uuidOf(body.created_by);
  const phone = optional(body.phone, lineOf);
  const hub = optional(body.primary_hub_id, uuidOf);
  const approvedBy = optional(body.approved_by, uuidOf);
  if (
    id === undefined ||
    email === undefined ||
    name === undefined ||
    bundle === undefined ||
    createdBy === undefined ||
    phone === undefined ||
    hub === undefined ||
    approvedBy === undefined ||
    !isOneOf(STAFF_STATUSES, body.status) ||
    !isOneOf(MFA_RESET_STATES, body.mfa_reset_state) ||
    typeof body.mfa_enrolled !== 'boolean'
  ) {
    return undefined;
  }
  return {
    id,
    work_email: email,
    full_name: name,
    status: body.status,
    role_bundle_id: bundle,
    mfa_enrolled: body.mfa_enrolled,
    mfa_reset_state: body.mfa_reset_state,
    created_by: createdBy,
    // A field the answer left out stays left out; one it set to null is null.
    ...(body.phone === undefined ? {} : { phone }),
    ...(body.primary_hub_id === undefined ? {} : { primary_hub_id: hub }),
    ...(body.approved_by === undefined ? {} : { approved_by: approvedBy }),
  };
}

/** A page of the staff list, or nothing when the answer is not one. One entry that is not an identity makes the whole page unusable. */
export function parseStaffIdentityPage(body: unknown): StaffIdentityPageView | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const token = body.next_page_token;
  if (token !== null && !(typeof token === 'string' && token !== '' && token.length <= MAX_TOKEN)) {
    return undefined;
  }
  const items: StaffIdentityView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const identity = parseStaffIdentity(entry);
    if (identity === undefined) return undefined;
    // A person listed twice would be two rows of one, and a key that React cannot tell apart.
    if (seen.has(identity.id.toLowerCase())) return undefined;
    seen.add(identity.id.toLowerCase());
    items.push(identity);
  }
  return { items, nextPageToken: token };
}

/** The bundles a form may offer, or nothing when the answer is not the list. */
export function parseAssignableBundles(body: unknown): AssignableBundleView[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_BUNDLES) {
    return undefined;
  }
  const bundles: AssignableBundleView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const id = uuidOf(entry.id);
    const name = lineOf(entry.name);
    if (
      id === undefined ||
      name === undefined ||
      typeof entry.requires_platform_admin_approval !== 'boolean'
    ) {
      return undefined;
    }
    if (seen.has(id.toLowerCase())) return undefined;
    seen.add(id.toLowerCase());
    bundles.push({
      id,
      name,
      requires_platform_admin_approval: entry.requires_platform_admin_approval,
    });
  }
  return bundles;
}

/** A session of the list, or nothing when the answer is not one. No credential, token hash or bundle is ever read. */
export function parseSessionRecord(body: unknown): SessionRecordView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const expiresAt = instantOf(body.expires_at);
  const principalId = optional(body.principal_id, uuidOf);
  const issuedAt = optional(body.issued_at, instantOf);
  const lastActivityAt = optional(body.last_activity_at, instantOf);
  const reason = body.termination_reason;
  if (
    id === undefined ||
    expiresAt === undefined ||
    principalId === undefined ||
    issuedAt === undefined ||
    lastActivityAt === undefined ||
    !isOneOf(PRINCIPAL_TYPES, body.principal_type) ||
    !isOneOf(SESSION_STATES, body.state) ||
    !(reason === undefined || reason === null || isOneOf(TERMINATION_REASONS, reason))
  ) {
    return undefined;
  }
  return {
    id,
    principal_type: body.principal_type,
    state: body.state,
    expires_at: expiresAt,
    ...(principalId === null ? {} : { principal_id: principalId }),
    ...(issuedAt === null ? {} : { issued_at: issuedAt }),
    ...(lastActivityAt === null ? {} : { last_activity_at: lastActivityAt }),
    ...(reason === undefined ? {} : { termination_reason: reason }),
  };
}

/** The sessions of a principal, or nothing when the answer is not the list. */
export function parseSessionRecords(body: unknown): SessionRecordView[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_SESSIONS) {
    return undefined;
  }
  const sessions: SessionRecordView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const session = parseSessionRecord(entry);
    if (session === undefined) return undefined;
    if (seen.has(session.id.toLowerCase())) return undefined;
    seen.add(session.id.toLowerCase());
    sessions.push(session);
  }
  return sessions;
}

/**
 * What a reset of a second factor came to. Nothing that could open an account is read: the grant is delivered to the person it is for and
 * is never in the answer, and if a server sent one anyway there is nowhere for it to go.
 */
export function parseMfaResetResult(body: unknown): MfaResetOutcome | undefined {
  if (!isRecord(body)) return undefined;
  const count = body.sessions_terminated;
  const issued = body.reenrolment_grant_issued;
  const coalesced = body.coalesced;
  const expiresAt = optional(body.grant_expires_at, instantOf);
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > MAX_TERMINATED ||
    !(issued === undefined || typeof issued === 'boolean') ||
    !(coalesced === undefined || typeof coalesced === 'boolean') ||
    expiresAt === undefined
  ) {
    return undefined;
  }
  return {
    sessionsTerminated: count,
    grantIssued: issued === true,
    coalesced: coalesced === true,
    grantExpiresAt: expiresAt,
  };
}

/** The answer of a re-issue of a staff member's first setup link: a pending staff credential grant, and when it lapses. Never the grant. */
export function parseSetupGrant(body: unknown): SetupGrantOutcome | undefined {
  if (!isRecord(body)) return undefined;
  const expiresAt = optional(body.expires_at, instantOf);
  if (
    uuidOf(body.id) === undefined ||
    uuidOf(body.principal_id) === undefined ||
    instantOf(body.issued_at) === undefined ||
    body.principal_type !== 'STAFF' ||
    body.purpose !== 'STAFF_CREDENTIAL_SETUP' ||
    body.state !== 'PENDING' ||
    expiresAt === undefined
  ) {
    return undefined;
  }
  return { expiresAt };
}

/** The answer of `recoverStaffCredential` or `recoverVendorCredential` for a principal of `type`, or nothing when it is not one. */
export function parseRecoveryRequest(
  body: unknown,
  type: 'STAFF' | 'VENDOR',
): RecoveryRequestOutcome | undefined {
  if (!isRecord(body)) return undefined;
  const expiresAt = instantOf(body.expires_at);
  const coalesced = body.coalesced === undefined ? false : body.coalesced;
  if (
    uuidOf(body.id) === undefined ||
    body.principal_type !== type ||
    !isOneOf(['EMAIL', 'SMS'] as const, body.channel) ||
    body.state !== 'PENDING' ||
    expiresAt === undefined ||
    optional(body.initiated_by, uuidOf) === undefined ||
    typeof coalesced !== 'boolean'
  ) {
    return undefined;
  }
  return { coalesced, channel: body.channel, expiresAt };
}

/**
 * A trusted browser of a list: a label and dates, and whether it is the browser asking. Nothing that could be used to sign in is read, and a
 * credential a server should never send has nowhere to go (staff-authentication.md section 5.8).
 */
export function parseTrustedBrowser(body: unknown): TrustedBrowserView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const label = lineOf(body.label);
  const createdAt = instantOf(body.created_at);
  const expiresAt = instantOf(body.expires_at);
  const lastUsedAt = optional(body.last_used_at, instantOf);
  if (
    id === undefined ||
    label === undefined ||
    label.length > MAX_BROWSER_LABEL ||
    createdAt === undefined ||
    expiresAt === undefined ||
    lastUsedAt === undefined ||
    typeof body.current !== 'boolean'
  ) {
    return undefined;
  }
  return {
    id,
    label,
    created_at: createdAt,
    expires_at: expiresAt,
    last_used_at: lastUsedAt,
    current: body.current,
  };
}

/** The trusted browsers of a list, or nothing when the answer is not the list. One browser at most is the one asking. */
export function parseTrustedBrowsers(body: unknown): TrustedBrowserView[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_TRUSTED_BROWSERS) {
    return undefined;
  }
  const browsers: TrustedBrowserView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const browser = parseTrustedBrowser(entry);
    if (browser === undefined || seen.has(browser.id.toLowerCase())) return undefined;
    seen.add(browser.id.toLowerCase());
    browsers.push(browser);
  }
  return browsers.filter((browser) => browser.current).length <= 1 ? browsers : undefined;
}

/** How many trusted browsers an administrator's removal ended, or nothing when the answer is not a count. */
export function parseTrustedBrowsersRevoked(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  const count = body.revoked;
  return typeof count === 'number' &&
    Number.isInteger(count) &&
    count >= 0 &&
    count <= MAX_TRUSTED_BROWSERS
    ? count
    : undefined;
}
