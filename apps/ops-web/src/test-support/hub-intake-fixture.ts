import type { components } from '@melarc/api-client';

import type { CountVariance, IntakeCondition } from '../platform/hub-intake/hub-intake-shape';
import { PICKUP_HUB_ID } from './pickup-fixture';
import { MANIFEST_ID, REQUEST_ONE_ID } from './manifest-fixture';

/**
 * Real-shaped answers of the reads and acts of the receiving screens (S1.35), for tests. Every field the contract requires is present and each value is synthetic. The types are the contract's, so
 * nothing here describes the wire a second time. **The rider's declared number of a test is `DECLARED` and is planted only where the contract carries it** (an intake that has been counted): a test of
 * the blind count looks for it, and for what it would be, in everything a page drew and received before the count.
 */
type BaseBody = components['schemas']['HubIntakeBase'];
/**
 * The two shapes of an intake, built from the contract's base: the generated types of `HubIntakePreCount` and `HubIntakePostCount` are `never` (the generator reads their discriminator as the schemas' own names),
 * so the members of the counted shape are written here, held to the contract by `test/hub-intake-contract.test.ts`.
 */
type PreBody = BaseBody & { count_phase: 'PRE_COUNT' };
type PostBody = BaseBody & {
  count_phase: 'POST_COUNT';
  rider_declared_count: number;
  physical_count: number;
  count_variance: CountVariance;
  count_difference?: number;
  condition: IntakeCondition;
  condition_findings?: object[];
  parcel_photo_ids?: string[];
};

export const INTAKE_HUB_ID = PICKUP_HUB_ID;
export const INTAKE_ID = '1b4d6c0e-3a5f-4b7c-8d9e-0f1a2b3c4d5e';
export const OTHER_INTAKE_ID = '2c5e7d1f-4b60-4c8d-9e0f-1a2b3c4d5e6f';
export const INTAKE_RIDER_ID = '3d6f8e20-5c71-4d9e-8f10-2b3c4d5e6f70';
export const INTAKE_RECEIVER_ID = '4e709f31-6d82-4eaf-9021-3c4d5e6f7081';
export const INTAKE_OFFICER_ID = '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
export const INTAKE_FINDING_ID = '5f81a042-7e93-4fb0-8132-4d5e6f708192';
export const INTAKE_ADJUDICATION_ID = '60a2b153-8fa4-40c1-9243-5e6f708192a3';
export const INTAKE_PHOTO_ONE = '71a3c264-90b5-41d2-8354-6f708192a3b4';
export const INTAKE_PHOTO_TWO = '82b4d375-a1c6-42e3-9465-708192a3b4c5';
export const INTAKE_EVIDENCE_ONE = '93c5e486-b2d7-43f4-a576-8192a3b4c5d6';
export const INTAKE_EVIDENCE_TWO = 'a4d6f597-c3e8-44a5-b687-92a3b4c5d6e7';
export const INTAKE_CODE = 'ACC-IN-7KQ2MZ';

/** What the rider declared, in the intakes of these tests that were counted: **the number a blind page must never be given.** It is not a number a count could be by chance. */
export const DECLARED = 7;

/** What a test plants as a declaration where the contract carries none (an intake that was not counted): a number that is no count, so that it is found in what a page drew or received and in nothing else. */
export const PLANTED_DECLARATION = 4137;

const base = (id: string, code: string) => ({
  id,
  code,
  hub_id: INTAKE_HUB_ID,
  pickup_request_id: REQUEST_ONE_ID,
  pickup_manifest_id: MANIFEST_ID,
  handed_over_by: INTAKE_RIDER_ID,
  handed_over_at: '2026-11-14T09:00:00Z',
  declaration_captured_at: '2026-11-14T08:58:00Z',
  active_receiver_id: null,
  lock_acquired_at: null,
});

/** An intake that has not been counted: it has no declaration, as the contract says. */
export function preCountFixture(overrides: Partial<PreBody> = {}): PreBody {
  return {
    ...base(INTAKE_ID, INTAKE_CODE),
    state: 'AWAITING_COUNT',
    count_phase: 'PRE_COUNT',
    ...overrides,
  };
}

/** An intake that has been counted and matched what was declared. */
export function postCountFixture(overrides: Partial<PostBody> = {}): PostBody {
  return {
    ...base(INTAKE_ID, INTAKE_CODE),
    state: 'READY_FOR_ITEMIZATION',
    count_phase: 'POST_COUNT',
    rider_declared_count: DECLARED,
    physical_count: DECLARED,
    count_variance: 'MATCH',
    count_difference: 0,
    condition: 'OK',
    ...overrides,
  };
}

/** An intake counted short of what was declared, in reconciliation. */
export const shortCountFixture = (overrides: Partial<PostBody> = {}): PostBody =>
  postCountFixture({
    state: 'RECONCILIATION_REQUIRED',
    physical_count: DECLARED - 2,
    count_variance: 'SHORT',
    count_difference: -2,
    ...overrides,
  });

/** One finding as `condition_findings` carries it (the contract leaves its members open and describes them: `{ id, kind, condition, outcome, note, evidence_ids, recorded_by, recorded_at }`). */
export function findingFixture(
  overrides: Partial<{
    id: string;
    kind: 'CONDITION' | 'ADJUDICATION';
    condition: string | null;
    outcome: string | null;
    note: string | null;
    evidence_ids: string[];
    recorded_by: string;
    recorded_at: string;
  }> = {},
) {
  return {
    id: INTAKE_FINDING_ID,
    kind: 'CONDITION' as const,
    condition: 'DAMAGED',
    outcome: null,
    note: 'Two cartons crushed at one corner.',
    evidence_ids: [INTAKE_EVIDENCE_ONE],
    recorded_by: INTAKE_RECEIVER_ID,
    recorded_at: '2026-11-14T09:20:00Z',
    ...overrides,
  };
}
