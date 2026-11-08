import type { SessionView } from '../platform/session/session-store';

/**
 * A `CurrentSession` as the API would answer `getCurrentSession`, for tests. Every field the contract requires is
 * present, and each value is synthetic. Pass what a test needs to differ.
 */
export function sessionFixture(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
    principal_type: 'STAFF',
    principal_id: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
    state: 'ACTIVE',
    permissions: ['staff.read'],
    issued_at: '2026-10-23T08:00:00.000Z',
    expires_at: '2026-10-23T16:00:00.000Z',
    last_activity_at: '2026-10-23T08:00:00.000Z',
    termination_reason: null,
    principal_display_name: 'Synthetic Officer',
    authorized_hubs: [
      { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', display_name: 'Synthetic Hub' },
    ],
    ...overrides,
  };
}
