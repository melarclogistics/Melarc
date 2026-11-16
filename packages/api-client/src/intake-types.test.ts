import { describe, expect, expectTypeOf, it } from 'vitest';

import type { components, operations } from './index.ts';

/**
 * The two shapes of an intake are satisfiable, and a client can tell them apart (the audit of 15 November 2026, point 2).
 *
 * `api-client:check` proves only that the generated file matches the contract. Until contract 5.107.0 the generated `HubIntakePreCount` intersected `"PRE_COUNT" | "POST_COUNT"`, `"PRE_COUNT"` and
 * `"HubIntakePreCount"` for the one property `count_phase`, which is `never`: nothing could be assigned to it, and the Ops Portal's own parsing worked around a type it could not use. The discriminators of
 * the contract now map the wire values (`PRE_COUNT`, `POST_COUNT`) to the two schemas, and this file is a **compile-time** check (`pnpm run typecheck` runs it; the run-time part only keeps the values
 * honest): a representative response is assignable to each generated type, the discriminant narrows the union of every operation that answers one, and the blind-count guarantee stands in the type itself
 * (the pre-count shape has no declaration, §35.5.2).
 */
type PreCount = components['schemas']['HubIntakePreCount'];
type PostCount = components['schemas']['HubIntakePostCount'];

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

/** What a client does with an answer: it branches on the phase and reads the declaration only where the type has one. */
function declaredCount(intake: PreCount | PostCount): number | undefined {
  return intake.count_phase === 'POST_COUNT' ? intake.rider_declared_count : undefined;
}

describe('the generated intake shapes (contract 5.107.0)', () => {
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
    expectTypeOf<Listed>().toEqualTypeOf<PreCount | PostCount>();
    expectTypeOf<Read>().toEqualTypeOf<PreCount | PostCount>();
    expectTypeOf<Locked>().toEqualTypeOf<PreCount | PostCount>();
    // A value of each operation's answer is taken by the one function that narrows on the phase.
    const listed: Listed = post;
    const read: Read = pre;
    const locked: Locked = post;
    expect([declaredCount(listed), declaredCount(read), declaredCount(locked)]).toEqual([
      3,
      undefined,
      3,
    ]);
  });
});
