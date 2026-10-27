import type { components } from '@melarc/api-client';

import { sessionFixture } from './session-fixture';
import { errorResponse, json, signedInApi, type Handler } from './fake-api';
import { BUNDLES } from './staff-fixture';
import type { SessionView } from '../platform/session/session-store';

/** The sort of person the staff screens are tested as. Each lists the keys that kind of person's session holds (a hint; the fake server decides nothing). */
export const KEYS = {
  /** Holds every key of the identity screens (a Platform Admin). */
  everything: [
    'staff.read',
    'staff.identity.create',
    'staff.identity.approve',
    'staff.mfa.reset',
    'staff.session.revoke',
    'permission.assignable_bundle.read',
    'settings.reason.read',
  ],
  /** Reads staff and decides on profiles (a Senior Ops): no reset of an authenticator. */
  approver: [
    'staff.read',
    'staff.identity.create',
    'staff.identity.approve',
    'staff.session.revoke',
    'permission.assignable_bundle.read',
    'settings.reason.read',
  ],
  /** Makes profiles and cannot read the staff list (an Ops Staff). */
  maker: ['staff.identity.create', 'permission.assignable_bundle.read', 'settings.reason.read'],
  /** Reads staff and nothing else. */
  reader: ['staff.read'],
} as const;

export function sessionWith(
  keys: readonly string[],
  overrides: Partial<SessionView> = {},
): SessionView {
  return sessionFixture({ permissions: [...keys], ...overrides });
}

type StaffIdentityBody = components['schemas']['StaffIdentity'];

export const staffPage = (items: StaffIdentityBody[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

export const bundlesAnswer = (): Response => json(200, { items: BUNDLES });

/** The API of a browser where this session is signed in, with the handlers a test adds. */
export function staffApi(
  session: SessionView,
  handlers: Record<string, Handler> = {},
): Record<string, Handler> {
  return { ...signedInApi(session), ...handlers };
}

export const refusal = (status: number, code: string, details?: unknown): Response =>
  errorResponse(status, code, details);

/** The entity tag of a version, as the API sends it. */
export const etag = (version: string): Record<string, string> => ({ ETag: `"${version}"` });
