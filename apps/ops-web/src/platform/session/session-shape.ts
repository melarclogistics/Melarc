import type { SessionView } from './session-store';

/**
 * The runtime judgement of an answer of `getCurrentSession` (U05 of 23 October 2026). The send boundary guarantees JSON and the generated
 * client gives the answer a type, but a type is a promise nobody checked at run time: a proxy's `{}`, a body from an older or newer
 * server, or a malformed list would be taken for a person and shown as one. This is the check, for **the fields the session foundation
 * consumes** and the discriminators that decide whether the answer is one the Ops Portal may sign somebody in on.
 *
 * It is not a second description of the wire. The type of the answer stays the contract's (`SessionView` is the generated
 * `CurrentSession`), and `test/session-contract.test.ts` reads the contract and holds this list to it: every field named here is a field
 * of `CurrentSession`, and the required ones are exactly the ones the contract requires. A field the contract adds and this does not
 * read is not copied through: the result holds what was judged and nothing else.
 */
export const SESSION_FIELDS = {
  required: [
    'id',
    'principal_type',
    'state',
    'expires_at',
    'principal_display_name',
    'authorized_hubs',
  ],
  /** `principal_id` is the id the screens compare a record's maker with, to say "you created this"; the server decides, whatever they say. */
  optional: ['permissions', 'principal_id'],
  /** The Ops Portal's session is a staff member's. A vendor's or a rider's is a valid answer of the contract and is not one to sign in on here. */
  principalTypes: ['STAFF'],
  /** A session that has ended is not one to be signed in on. */
  states: ['ACTIVE'],
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The shape of a key of the permission catalogue (permissions.md section 7): two or three lower-case segments joined by dots. */
const PERMISSION_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/;
const MAX_PERMISSION_KEY = 128;

/** Whether a string is shaped like a key of the permission catalogue. The route registry holds its keys to the same shape the session's are held to. */
export function isPermissionKey(key: string): boolean {
  return key.length <= MAX_PERMISSION_KEY && PERMISSION_KEY.test(key);
}
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = (list: readonly string[], value: unknown): value is string =>
  typeof value === 'string' && list.includes(value);

function instantOf(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

function hubsOf(value: unknown): SessionView['authorized_hubs'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hubs: { id: string; display_name: string }[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const { id, display_name: name } = entry;
    if (typeof id !== 'string' || !UUID.test(id) || typeof name !== 'string') return undefined;
    // A hub listed twice would be two rows of one, and a key that React cannot tell apart.
    if (seen.has(id.toLowerCase())) return undefined;
    seen.add(id.toLowerCase());
    hubs.push({ id, display_name: name });
  }
  return hubs;
}

function permissionsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys: string[] = [];
  for (const key of value as unknown[]) {
    if (typeof key !== 'string' || !isPermissionKey(key)) return undefined;
    keys.push(key);
  }
  return keys;
}

/**
 * The session the answer describes, or nothing when it is not a session the Ops Portal may sign somebody in on: not an object, a field
 * missing or of the wrong kind, a hub or a permission that is not one, an unknown or foreign principal type, a session that has ended. The
 * caller treats nothing as an answer that is not the API's (`unexpected-response`), so the person is not signed in on it and can retry.
 */
export function parseCurrentSession(body: unknown): SessionView | undefined {
  if (!isRecord(body)) return undefined;
  const { id, principal_type: type, state, principal_display_name: name } = body;
  const expiresAt = instantOf(body.expires_at);
  const hubs = hubsOf(body.authorized_hubs);
  if (
    typeof id !== 'string' ||
    id === '' ||
    !isOneOf(SESSION_FIELDS.principalTypes, type) ||
    !isOneOf(SESSION_FIELDS.states, state) ||
    expiresAt === undefined ||
    hubs === undefined ||
    !(typeof name === 'string' || name === null)
  ) {
    return undefined;
  }

  const listed = body.permissions;
  const permissions = listed === undefined ? undefined : permissionsOf(listed);
  if (listed !== undefined && permissions === undefined) return undefined;

  const principalId = body.principal_id;
  if (principalId !== undefined && !(typeof principalId === 'string' && UUID.test(principalId))) {
    return undefined;
  }

  return {
    id,
    principal_type: type as SessionView['principal_type'],
    state: state as SessionView['state'],
    expires_at: expiresAt,
    principal_display_name: name,
    authorized_hubs: hubs,
    ...(permissions === undefined ? {} : { permissions }),
    ...(principalId === undefined ? {} : { principal_id: principalId }),
  };
}
