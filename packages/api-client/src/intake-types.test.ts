import { describe, expect, expectTypeOf, it } from 'vitest';

import type { components, operations } from './index.ts';

/**
 * The shapes of an intake are satisfiable, and a client can tell them apart (the audit of 15 November 2026, point 2; the third shape, `CHECK_IN`, with contract 5.108.0 and S1.35b).
 *
 * `api-client:check` proves only that the generated file matches the contract. Until contract 5.107.0 the generated `HubIntakePreCount` intersected `"PRE_COUNT" | "POST_COUNT"`, `"PRE_COUNT"` and
 * `"HubIntakePreCount"` for the one property `count_phase`, which is `never`: nothing could be assigned to it, and the Ops Portal's own parsing worked around a type it could not use. The discriminators of
 * the contract now map the wire values (`PRE_COUNT`, `POST_COUNT`) to the two schemas, and this file is a **compile-time** check (`pnpm run typecheck` runs it; the run-time part only keeps the values
 * honest): a representative response is assignable to each generated type, the discriminant narrows the union of every operation that answers one, and the blind-count guarantee stands in the type itself
 * (the pre-count shape has no declaration, §35.5.2).
 */
type PreCount = components['schemas']['HubIntakePreCount'];
type PostCount = components['schemas']['HubIntakePostCount'];
type CheckIn = components['schemas']['HubIntakeCheckIn'];

type Answer<Name extends keyof operations> = operations[Name] extends {
  responses: { 200: { content: { 'application/json': infer Body } } };
}
  ? Body
  : never;
type Listed = Answer<'listHubIntakes'>['items'][number];
type Read = Answer<'getHubIntake'>;
type Locked = Answer<'acquireIntakeLock'>;

const base = {
  id: '0194c0de-0000-7000-8000-000000000001',
  code: 'ACC-IN-AB23CD',
  hub_id: '0194c0de-0000-7000-8000-000000000002',
  pickup_request_id: '0194c0de-0000-7000-8000-000000000003',
  pickup_manifest_id: '0194c0de-0000-7000-8000-000000000004',
  handed_over_by: '0194c0de-0000-7000-8000-000000000005',
  handed_over_at: '2026-11-14T10:00:00Z',
  declaration_captured_at: '2026-11-14T09:58:00Z',
} as const;

const pre = {
  ...base,
  state: 'AWAITING_COUNT',
  count_phase: 'PRE_COUNT',
} satisfies PreCount;

const post = {
  ...base,
  state: 'READY_FOR_ITEMIZATION',
  count_phase: 'POST_COUNT',
  rider_declared_count: 3,
  physical_count: 3,
  count_variance: 'MATCH',
  condition: 'OK',
} satisfies PostCount;

/** What a client does with an answer: it branches on the phase and reads the declaration only where the type has one (a blind-count intake's after its count, a photo intake's from the start). */
function declaredCount(intake: PreCount | PostCount | CheckIn): number | undefined {
  return intake.count_phase === 'PRE_COUNT' ? undefined : intake.rider_declared_count;
}

describe('the generated intake shapes (contract 5.107.0, and 5.108.0 for the third)', () => {
  it('can be satisfied: a representative response is assignable to each shape, and each shape is not never', () => {
    expectTypeOf(pre).toExtend<PreCount>();
    expectTypeOf(post).toExtend<PostCount>();
    expectTypeOf<PreCount>().not.toBeNever();
    expectTypeOf<PostCount>().not.toBeNever();
    expectTypeOf<PreCount['count_phase']>().toEqualTypeOf<'PRE_COUNT'>();
    expectTypeOf<PostCount['count_phase']>().toEqualTypeOf<'POST_COUNT'>();
    expect([pre.count_phase, post.count_phase]).toEqual(['PRE_COUNT', 'POST_COUNT']);
  });

  it('keeps the blind-count guarantee in the type: the pre-count shape has no declaration, no count and no comparison', () => {
    expectTypeOf<PreCount>().not.toHaveProperty('rider_declared_count');
    expectTypeOf<PreCount>().not.toHaveProperty('physical_count');
    expectTypeOf<PreCount>().not.toHaveProperty('count_variance');
    expectTypeOf<PostCount>().toHaveProperty('rider_declared_count');
  });

  it('is told apart by count_phase in every answer that carries one: the list, the read and the lock', () => {
    expectTypeOf<Listed>().toEqualTypeOf<PreCount | PostCount | CheckIn>();
    expectTypeOf<Read>().toEqualTypeOf<PreCount | PostCount | CheckIn>();
    expectTypeOf<Locked>().toEqualTypeOf<PreCount | PostCount | CheckIn>();
    // A value of each operation's answer is taken by the one function that narrows on the phase: a photo intake is the third member, and it too carries the declaration.
    const listed: Listed = post;
    const read: Read = pre;
    const locked: Locked = post;
    const photo: Read = checkIn;
    expect([
      declaredCount(listed),
      declaredCount(read),
      declaredCount(locked),
      declaredCount(photo),
    ]).toEqual([3, undefined, 3, 1]);
  });

  it('answers a condition and an adjudication in the shape of the intake’s mode, and a condition names the parcel it is about', () => {
    expectTypeOf<Answer<'recordIntakeCondition'>>().toEqualTypeOf<CheckIn | PostCount>();
    expectTypeOf<Answer<'adjudicateDiscrepancy'>>().toEqualTypeOf<CheckIn | PostCount>();
    expectTypeOf<components['schemas']['IntakeConditionRecord']>().toHaveProperty('parcel_id');
    expectTypeOf<components['schemas']['IntakeConditionRecord']['parcel_id']>().toEqualTypeOf<
      string | undefined
    >();
  });
});

/**
 * The receiving shapes of Run D (contract 5.108.0, declared by S1.35b-0): the third shape of an intake, a vendor's section, a run's page and what the acts answer. The same compile-time check as above
 * (`pnpm run typecheck` runs it): a representative value is assignable to each generated type, each operation answers the shape the contract names, and the guarantees that live in a type stand there. The
 * third member of the intake read of `getHubIntake`, `listHubIntakes` and `acquireIntakeLock` was added with the application (S1.35b: the conformance check holds an implemented operation to the application),
 * and the narrowing of the three-member union is checked above.
 */
type Parcel = components['schemas']['IntakeParcel'];
type Vendor = components['schemas']['ReceivingVendor'];
type Run = components['schemas']['ReceivingRun'];
type RunRow = components['schemas']['ReceivingRunSummary'];
type Missing = components['schemas']['MissingParcel'];
type ParcelAnswer = components['schemas']['IntakeParcelAnswer'];
type Limits = components['schemas']['EvidenceLimits'];

const parcel = {
  id: '0194c0de-0000-7000-8000-000000000011',
  ordinal: 1,
  origin: 'DOOR_PHOTO',
  state: 'ARRIVED',
  photo_evidence_id: '0194c0de-0000-7000-8000-000000000012',
  arrived_by_name: 'Ama Owusu',
  arrived_at: '2026-11-16T09:12:00Z',
  missing_marked_at: null,
  condition: null,
} satisfies Parcel;

const checkIn = {
  id: base.id,
  code: base.code,
  hub_id: base.hub_id,
  pickup_request_id: base.pickup_request_id,
  pickup_manifest_id: base.pickup_manifest_id,
  run_code: 'ACC-RUN-7K2M9Q',
  state: 'AWAITING_COUNT',
  count_phase: 'CHECK_IN',
  receiving_mode: 'PHOTO_CHECK_IN',
  vendor_name: 'Kente Crafts',
  handed_over_by_name: 'Kofi Mensah',
  handed_over_at: base.handed_over_at,
  parcels_expected: 1,
  rider_declared_count: 1,
  arrived_count: 1,
  received_count: null,
  count_variance: null,
  count_difference: null,
  counted_at: null,
  counted_by_name: null,
  lock: null,
  parcels: [parcel],
  missing_count: 0,
  extra_count: 0,
  damaged_count: 0,
  condition: 'OK',
  condition_findings: [],
} satisfies CheckIn;

/** A blind-count vendor's section: no parcel, and no number of the rider's before the count (D-D3). */
const blindVendor = {
  intake_id: base.id,
  intake_code: base.code,
  intake_etag: '"3f9a"',
  receiving_mode: 'BLIND_COUNT',
  state: 'AWAITING_COUNT',
  vendor_name: 'Accra Beads',
  parcels_expected: null,
  arrived_count: null,
  received_count: null,
  count_variance: null,
  lock: null,
  missing_count: 0,
  extra_count: 0,
  damaged_count: 0,
  parcels: [],
} satisfies Vendor;

const run = {
  run: {
    id: base.pickup_manifest_id,
    code: 'ACC-RUN-7K2M9Q',
    hub_id: base.hub_id,
    hub_name: 'Accra',
    service_date: '2026-11-16',
  },
  rider_name: 'Kofi Mensah',
  handed_over_at: base.handed_over_at,
  vendors: [blindVendor],
} satisfies Run;

/** What a client does with the answer of a correction: it branches on the phase, and only a photo intake has parcels. */
function parcelsOf(intake: CheckIn | PostCount): number {
  return intake.count_phase === 'CHECK_IN' ? intake.parcels.length : 0;
}

describe('the generated receiving shapes (contract 5.108.0, Run D)', () => {
  it('can be satisfied: a representative value is assignable to each shape, and the third shape is told by CHECK_IN', () => {
    expectTypeOf(parcel).toExtend<Parcel>();
    expectTypeOf(checkIn).toExtend<CheckIn>();
    expectTypeOf(blindVendor).toExtend<Vendor>();
    expectTypeOf(run).toExtend<Run>();
    expectTypeOf<CheckIn>().not.toBeNever();
    expectTypeOf<CheckIn['count_phase']>().toEqualTypeOf<'CHECK_IN'>();
    expectTypeOf<CheckIn['receiving_mode']>().toEqualTypeOf<'PHOTO_CHECK_IN'>();
    expectTypeOf<Parcel['state']>().toEqualTypeOf<'EXPECTED' | 'ARRIVED' | 'MISSING' | 'VOID'>();
    expect([checkIn.count_phase, blindVendor.receiving_mode]).toEqual(['CHECK_IN', 'BLIND_COUNT']);
  });

  it('answers each operation with the shape the contract names', () => {
    expectTypeOf<Answer<'finishCheckIn'>>().toEqualTypeOf<CheckIn>();
    expectTypeOf<Answer<'correctIntakeCount'>>().toEqualTypeOf<CheckIn | PostCount>();
    expectTypeOf<Answer<'recordParcelArrival'>>().toEqualTypeOf<ParcelAnswer>();
    expectTypeOf<Answer<'addExtraParcel'>>().toEqualTypeOf<ParcelAnswer>();
    expectTypeOf<Answer<'getReceivingRun'>>().toEqualTypeOf<Run>();
    expectTypeOf<Answer<'listReceivingRuns'>['items'][number]>().toEqualTypeOf<RunRow>();
    expectTypeOf<Answer<'listMissingParcels'>['items'][number]>().toEqualTypeOf<Missing>();
    expectTypeOf<Answer<'getEvidenceLimits'>>().toEqualTypeOf<Limits>();
    // The answer of a correction is told apart by its phase, and a value of each member goes through the one function that narrows.
    const corrected: Answer<'correctIntakeCount'> = checkIn;
    const blind: Answer<'correctIntakeCount'> = post;
    expect([parcelsOf(corrected), parcelsOf(blind)]).toEqual([1, 0]);
  });

  it('keeps the guarantees that live in a type: a blind-count vendor has no declaration and no expected number, and no shape names a phone number', () => {
    expectTypeOf<Vendor>().not.toHaveProperty('rider_declared_count');
    expectTypeOf<Vendor['parcels_expected']>().toEqualTypeOf<number | null>();
    expectTypeOf<RunRow>().not.toHaveProperty('rider_declared_count');
    expect([blindVendor.parcels_expected, blindVendor.parcels.length]).toEqual([null, 0]);
    // Names are display names: no phone number, email or address is a property of any shape that names a person or a vendor.
    for (const shape of ['phone', 'rider_phone', 'phone_number', 'email', 'address'] as const) {
      expectTypeOf<Parcel>().not.toHaveProperty(shape);
      expectTypeOf<CheckIn>().not.toHaveProperty(shape);
      expectTypeOf<Vendor>().not.toHaveProperty(shape);
      expectTypeOf<Run>().not.toHaveProperty(shape);
      expectTypeOf<RunRow>().not.toHaveProperty(shape);
      expectTypeOf<Missing>().not.toHaveProperty(shape);
    }
  });
});
