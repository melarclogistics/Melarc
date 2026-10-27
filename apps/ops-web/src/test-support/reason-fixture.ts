import type { components } from '@melarc/api-client';

/** A reason of the catalogue as `listReasonDefinitions` answers it. Every value is synthetic. */
export type ReasonFixture = components['schemas']['ReasonDefinition'];

export function reasonFixture(overrides: Partial<ReasonFixture> = {}): ReasonFixture {
  return {
    code: 'DEMO_REASON_ONE',
    domain: 'IDENTITY',
    label: 'Demo reason one',
    attribution: 'MELARC',
    active: true,
    consumesDeliveryAttempt: false,
    requiresNote: false,
    permittedOperations: [{ operationId: 'resetStaffMfa', branch: 'FACTOR_ACTIVE' }],
    ...overrides,
  };
}
