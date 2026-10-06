/**
 * The security context of a database transaction (SECURITY_DESIGN.md §14.1). Row-level security reads it
 * from transaction-local settings named `melarc.*`; this file is the one place that decides what may be
 * written to them. Only validated values are ever turned into a setting (§14.1b).
 */
export const PRINCIPAL_TYPES = ['STAFF', 'RIDER', 'VENDOR', 'SYSTEM'] as const;
export const SURFACES = ['OPS_PORTAL', 'VENDOR_PWA', 'RIDER_ANDROID', 'SYSTEM'] as const;
export const HUB_SCOPE_MODES = ['SET', 'ALL'] as const;

export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];
export type Surface = (typeof SURFACES)[number];
export type HubScopeMode = (typeof HUB_SCOPE_MODES)[number];

export interface SecurityContext {
  readonly principalType: PrincipalType;
  readonly principalId: string;
  /** Present where the principal has a Session. */
  readonly sessionId?: string;
  readonly surface: Surface;
  /** The permission key of the grant authorizing this operation. */
  readonly authorizationKey?: string;
  /** Resolved from that grant, never from the Session as a whole. `ALL` is never inferred. */
  readonly hubScopeMode?: HubScopeMode;
  /** The effective hub set. An empty set means no hub-scoped rows, never all of them. */
  readonly authorizedHubIds?: readonly string[];
  /** Required for a VENDOR principal. */
  readonly vendorOrganizationId?: string;
  /** Required for a RIDER principal. */
  readonly riderId?: string;
  /** The request or idempotency identifier. */
  readonly correlationId: string;
}

/** One transaction-local setting: its name and the text value that is set. */
export type ContextSetting = readonly [name: string, value: string];

/** The context was refused. Names the invalid fields only: a value is never repeated. */
export class SecurityContextError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Invalid security context: ${fields.join(', ')}`);
    this.name = 'SecurityContextError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The shape of the permission keys in permissions.md. Membership of the closed catalogue is the permission layer's to check. */
const PERMISSION_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** The contract's Idempotency-Key bound, which a correlation id may equal. No control characters (Unicode Cc). */
const CORRELATION_ID = /^\P{Cc}{1,128}$/u;

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/**
 * Validates a context and returns the settings to apply, in a fixed order. Throws, naming the invalid
 * fields, before anything is sent to the database: an invalid context must never open a transaction.
 */
export function toContextSettings(context: unknown): ContextSetting[] {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    throw new SecurityContextError(['context']);
  }
  const given = context as Record<string, unknown>;
  const invalid: string[] = [];
  const settings: ContextSetting[] = [];
  const add = (name: string, value: string) => settings.push([`melarc.${name}`, value]);

  const principalType = given.principalType;
  if (isOneOf(PRINCIPAL_TYPES, principalType)) add('principal_type', principalType);
  else invalid.push('principalType');

  if (isUuid(given.principalId)) add('principal_id', given.principalId.toLowerCase());
  else invalid.push('principalId');

  if (given.sessionId !== undefined) {
    if (isUuid(given.sessionId)) add('session_id', given.sessionId.toLowerCase());
    else invalid.push('sessionId');
  }

  if (isOneOf(SURFACES, given.surface)) add('surface', given.surface);
  else invalid.push('surface');

  if (given.authorizationKey !== undefined) {
    if (typeof given.authorizationKey === 'string' && PERMISSION_KEY.test(given.authorizationKey)) {
      add('authorization_key', given.authorizationKey);
    } else invalid.push('authorizationKey');
  }

  if (given.hubScopeMode !== undefined) {
    if (isOneOf(HUB_SCOPE_MODES, given.hubScopeMode)) add('hub_scope_mode', given.hubScopeMode);
    else invalid.push('hubScopeMode');
  }

  if (given.authorizedHubIds !== undefined) {
    // Array.from reads a hole in a sparse list as undefined: `every` skips holes, and a list with one would
    // be written as `a,,b`, which the accessor cannot read as a set of UUIDs.
    const hubs: unknown[] | undefined = Array.isArray(given.authorizedHubIds)
      ? Array.from(given.authorizedHubIds as unknown[])
      : undefined;
    if (hubs?.every(isUuid) === true) {
      add('authorized_hub_ids', hubs.map((hub) => hub.toLowerCase()).join(','));
    } else invalid.push('authorizedHubIds');
  }

  if (given.vendorOrganizationId !== undefined || principalType === 'VENDOR') {
    if (isUuid(given.vendorOrganizationId)) {
      add('vendor_organization_id', given.vendorOrganizationId.toLowerCase());
    } else invalid.push('vendorOrganizationId');
  }

  if (given.riderId !== undefined || principalType === 'RIDER') {
    if (isUuid(given.riderId)) add('rider_id', given.riderId.toLowerCase());
    else invalid.push('riderId');
  }

  if (typeof given.correlationId === 'string' && CORRELATION_ID.test(given.correlationId)) {
    add('correlation_id', given.correlationId);
  } else invalid.push('correlationId');

  if (invalid.length > 0) throw new SecurityContextError(invalid);
  return settings;
}
