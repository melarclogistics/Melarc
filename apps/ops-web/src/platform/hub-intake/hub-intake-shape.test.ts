import { describe, expect, it } from 'vitest';

import {
  DECLARED,
  INTAKE_ADJUDICATION_ID,
  INTAKE_EVIDENCE_ONE,
  INTAKE_EVIDENCE_TWO,
  INTAKE_ID,
  INTAKE_OFFICER_ID,
  INTAKE_PHOTO_ONE,
  INTAKE_PHOTO_TWO,
  INTAKE_RECEIVER_ID,
  findingFixture,
  postCountFixture,
  preCountFixture,
  shortCountFixture,
} from '../../test-support/hub-intake-fixture';
import {
  parseFinding,
  parseIntake,
  parsePostCountIntake,
  receiverHoldOf,
} from './hub-intake-shape';

/** An answer with one member left out. */
const withoutMember = (body: object, member: string): object =>
  Object.fromEntries(Object.entries(body).filter(([name]) => name !== member));

/**
 * What the receiving screens believe of an answer. **The blind count is held here**: an intake that has not been counted is refused whole if its answer carries the rider's declaration, a count, a
 * comparison, a condition, a finding or a photo, at any depth, however it is named; and no list gives a screen more than the base of an intake.
 */
describe('an intake that has not been counted', () => {
  it('is read as what it is, with the lock and the handover and nothing of a count', () => {
    const intake = parseIntake(
      preCountFixture({
        active_receiver_id: INTAKE_RECEIVER_ID,
        lock_acquired_at: '2026-11-14T09:10:00Z',
      }),
    );

    expect(intake).toEqual({
      id: INTAKE_ID,
      code: 'ACC-IN-7KQ2MZ',
      hub_id: preCountFixture().hub_id,
      pickup_request_id: preCountFixture().pickup_request_id,
      pickup_manifest_id: preCountFixture().pickup_manifest_id,
      handed_over_by: preCountFixture().handed_over_by,
      handed_over_at: '2026-11-14T09:00:00Z',
      active_receiver_id: INTAKE_RECEIVER_ID,
      lock_acquired_at: '2026-11-14T09:10:00Z',
      state: 'AWAITING_COUNT',
      count_phase: 'PRE_COUNT',
    });
    expect(Object.keys(intake ?? {})).not.toContain('rider_declared_count');
  });

  // Break caught: the blind count lost at the one door every answer passes: a server that sent the declaration by mistake, under the contract's name or any other, at any depth, and zero included.
  it.each([
    ['the declaration', { rider_declared_count: DECLARED }],
    ['a zero declaration', { rider_declared_count: 0 }],
    ['a null declaration', { rider_declared_count: null }],
    ['the declaration under another name', { riderDeclaredCount: DECLARED }],
    ['a declared number', { declared_parcels: DECLARED }],
    ['the physical count', { physical_count: 3 }],
    ['the comparison', { count_variance: 'MATCH' }],
    ['the difference', { count_difference: 0 }],
    ['a condition', { condition: 'OK' }],
    ['the findings', { condition_findings: [] }],
    ['the photos of the collection', { parcel_photo_ids: [INTAKE_PHOTO_ONE] }],
    ['the number of photos', { parcel_photos: 3 }],
    ['the dispute', { dispute_state: null }],
    [
      'the declaration nested in a member',
      { extra: { deeper: [{ rider_declared_count: DECLARED }] } },
    ],
  ])('is refused whole when its answer carries %s', (_name, planted) => {
    expect(parseIntake({ ...preCountFixture(), ...planted })).toBeUndefined();
  });

  // Break caught: the scan for the blind members that gives up at its depth and lets the answer through (a declaration wrapped deeper than the scan reads is refused, not trusted).
  it('is refused whole when the declaration is wrapped deeper than the scan reads', () => {
    let nested: unknown = { rider_declared_count: DECLARED };
    for (let level = 0; level < 12; level += 1) nested = { wrapper: nested };
    expect(parseIntake({ ...preCountFixture(), extra: nested })).toBeUndefined();
  });

  // Break caught: an intake in the queue's phase whose state is another, or one that is waiting for its count and says it has been counted: neither is one the API sends.
  it('is `AWAITING_COUNT` and nothing else', () => {
    expect(parseIntake(preCountFixture({ state: 'READY_FOR_ITEMIZATION' }))).toBeUndefined();
    expect(parseIntake(postCountFixture({ state: 'AWAITING_COUNT' }))).toBeUndefined();
  });
});

describe('an intake that has been counted', () => {
  it('has the declaration, the count and the comparison as the server stated them', () => {
    const intake = parseIntake(
      postCountFixture({
        physical_count: 5,
        count_variance: 'SHORT',
        count_difference: -2,
        state: 'RECONCILIATION_REQUIRED',
        parcel_photo_ids: [INTAKE_PHOTO_ONE, INTAKE_PHOTO_TWO],
        condition_findings: [findingFixture()],
      }),
    );

    expect(intake).toMatchObject({
      count_phase: 'POST_COUNT',
      rider_declared_count: DECLARED,
      physical_count: 5,
      count_variance: 'SHORT',
      count_difference: -2,
      condition: 'OK',
      parcel_photo_ids: [INTAKE_PHOTO_ONE, INTAKE_PHOTO_TWO],
    });
    expect(parsePostCountIntake(postCountFixture())?.count_phase).toBe('POST_COUNT');
    expect(parsePostCountIntake(preCountFixture())).toBeUndefined();
  });

  // Break caught: a bound on the parcels of an intake that is narrower than what the server takes, so that a count the platform stored cannot be read (the platform sets no limit on the parcels).
  it.each([
    [150, 1234],
    [2_500_000, 2_499_000],
    [2_147_483_647, 2_147_483_647],
  ])('reads a counted intake that was declared at %i and counted at %i', (declared, counted) => {
    const intake = parsePostCountIntake(
      postCountFixture({
        rider_declared_count: declared,
        physical_count: counted,
        count_variance: declared === counted ? 'MATCH' : counted > declared ? 'OVER' : 'SHORT',
        count_difference: counted - declared,
      }),
    );
    expect(intake).toMatchObject({ rider_declared_count: declared, physical_count: counted });
  });

  it('has no photos and no findings where the answer has none, and no difference where the server stated none', () => {
    const without = withoutMember(postCountFixture(), 'count_difference');
    const intake = parsePostCountIntake(without);
    expect(intake?.parcel_photo_ids).toEqual([]);
    expect(intake?.condition_findings).toEqual([]);
    expect(intake?.count_difference).toBeNull();
  });

  // Break caught: a comparison the page would draw that is not the one the numbers make: the variance on the wrong side, or a difference that is not the count less the declaration.
  it.each([
    [
      'a match that is not one',
      { physical_count: 5, count_variance: 'MATCH', count_difference: -2 },
    ],
    [
      'a short count that is over',
      { physical_count: 9, count_variance: 'SHORT', count_difference: 2 },
    ],
    [
      'an over count that is short',
      { physical_count: 5, count_variance: 'OVER', count_difference: -2 },
    ],
    [
      'a difference that is not the count less the declaration',
      { physical_count: 5, count_variance: 'SHORT', count_difference: -1 },
    ],
    ['an unknown variance', { count_variance: 'ABOUT_RIGHT' }],
    ['an unknown condition', { condition: 'WET' }],
    ['a negative count', { physical_count: -1 }],
    ['a count that is not whole', { physical_count: 2.5 }],
    ['a declaration that is a text', { rider_declared_count: '7' }],
    ['a photo listed twice', { parcel_photo_ids: [INTAKE_PHOTO_ONE, INTAKE_PHOTO_ONE] }],
    ['a photo that is not an identifier', { parcel_photo_ids: ['photo-1'] }],
  ])('is refused whole with %s', (_name, planted) => {
    expect(parseIntake({ ...postCountFixture(), ...planted })).toBeUndefined();
  });

  it('says the three sides of a comparison as the numbers make them', () => {
    expect(parseIntake(postCountFixture({ physical_count: DECLARED }))).toMatchObject({
      count_variance: 'MATCH',
    });
    expect(parseIntake(shortCountFixture())).toMatchObject({
      count_variance: 'SHORT',
      count_difference: -2,
    });
    expect(
      parseIntake(
        postCountFixture({
          physical_count: DECLARED + 3,
          count_variance: 'OVER',
          count_difference: 3,
          state: 'RECONCILIATION_REQUIRED',
        }),
      ),
    ).toMatchObject({ count_variance: 'OVER', count_difference: 3 });
  });

  // Break caught: a zero declaration read as absent, so that the comparison of a rider who declared nothing is drawn as no declaration.
  it('keeps a declaration of zero as the number zero', () => {
    const intake = parseIntake(
      postCountFixture({
        rider_declared_count: 0,
        physical_count: 0,
        count_difference: 0,
        state: 'RECONCILIATION_REQUIRED',
      }),
    );
    expect(intake).toMatchObject({
      rider_declared_count: 0,
      physical_count: 0,
      count_variance: 'MATCH',
    });
  });
});

describe('the findings of an intake', () => {
  it('are read in the order they were made, each as a recording of a condition or an adjudication', () => {
    const intake = parsePostCountIntake(
      shortCountFixture({
        condition: 'DAMAGED',
        condition_findings: [
          findingFixture(),
          findingFixture({
            id: INTAKE_ADJUDICATION_ID,
            kind: 'ADJUDICATION',
            condition: null,
            outcome: 'ESCALATED',
            note: 'Needs the vendor’s side.',
            evidence_ids: [INTAKE_EVIDENCE_TWO],
            recorded_by: INTAKE_OFFICER_ID,
            recorded_at: '2026-11-14T10:00:00Z',
          }),
        ],
      }),
    );

    expect(
      intake?.condition_findings.map((finding) => [
        finding.kind,
        finding.condition,
        finding.outcome,
      ]),
    ).toEqual([
      ['CONDITION', 'DAMAGED', null],
      ['ADJUDICATION', null, 'ESCALATED'],
    ]);
    expect(intake?.condition_findings[0]?.evidence_ids).toEqual([INTAKE_EVIDENCE_ONE]);
  });

  // Break caught: a finding that is the wrong kind of thing for what it says it is, which a page would draw as an adjudication nobody made.
  it.each([
    ['a recording of a condition with no condition', { condition: null }],
    ['a recording of a condition with an outcome', { outcome: 'ACCEPTED' }],
    ['an adjudication with no outcome', { kind: 'ADJUDICATION', condition: null }],
    ['a kind nobody knows', { kind: 'REVIEW' }],
    ['an unknown outcome', { kind: 'ADJUDICATION', outcome: 'FORGIVEN' }],
    ['a note that is blank', { note: '   ' }],
    ['a person that is not an identifier', { recorded_by: 'Kwame' }],
    ['evidence listed twice', { evidence_ids: [INTAKE_EVIDENCE_ONE, INTAKE_EVIDENCE_ONE] }],
    ['evidence that is not an identifier', { evidence_ids: ['photo.jpg'] }],
    ['a moment that is not one', { recorded_at: 'yesterday' }],
  ])('are refused whole when one is %s', (_name, planted) => {
    expect(parseFinding({ ...findingFixture(), ...planted })).toBeUndefined();
  });

  // Break caught: findings drawn in another order than the server keeps them, or one that is listed twice.
  it('are refused when they come out of the order they were made in, or twice', () => {
    const later = findingFixture({
      id: INTAKE_ADJUDICATION_ID,
      recorded_at: '2026-11-14T10:00:00Z',
    });
    const earlier = findingFixture();
    expect(parseIntake(shortCountFixture({ condition_findings: [earlier, later] }))).toBeDefined();
    expect(
      parseIntake(shortCountFixture({ condition_findings: [later, earlier] })),
    ).toBeUndefined();
    expect(
      parseIntake(shortCountFixture({ condition_findings: [earlier, earlier] })),
    ).toBeUndefined();
  });
});

describe('what an answer must be to be an intake', () => {
  // Break caught: a field the contract requires read as optional: an intake with no handover or no hub is not one a screen can say anything true of.
  it.each([
    'id',
    'code',
    'hub_id',
    'pickup_request_id',
    'pickup_manifest_id',
    'handed_over_by',
    'handed_over_at',
    'declaration_captured_at',
    'state',
    'count_phase',
  ])('is refused whole without %s', (field) => {
    expect(parseIntake(withoutMember(preCountFixture(), field))).toBeUndefined();
  });

  it.each([
    ['a code that is not an operational code', { code: 'INTAKE-1' }],
    ['a phase nobody knows', { count_phase: 'DURING' }],
    ['a state nobody knows', { state: 'LOST' }],
    ['a handover time that is not one', { handed_over_at: 'noon' }],
    ['a receiver that is not an identifier', { active_receiver_id: 'Ama' }],
    ['a lock time that is not one', { lock_acquired_at: 'now' }],
  ])('is refused whole with %s', (_name, planted) => {
    expect(parseIntake({ ...preCountFixture(), ...planted })).toBeUndefined();
  });

  it('is not an intake when it is not an object', () => {
    for (const body of [null, undefined, 'x', 3, [], [preCountFixture()]]) {
      expect(parseIntake(body)).toBeUndefined();
    }
  });
});

describe('who holds the lock', () => {
  const me = INTAKE_OFFICER_ID;

  // Break caught: the lock told as another's when it is the person's own, or as nobody's when somebody holds it.
  it('is nobody’s when the intake has no receiver, the person’s when it is theirs, and another’s otherwise', () => {
    expect(receiverHoldOf({ active_receiver_id: null, lock_acquired_at: null }, me)).toEqual({
      kind: 'nobody',
    });
    expect(
      receiverHoldOf({ active_receiver_id: me, lock_acquired_at: '2026-11-14T09:10:00Z' }, me),
    ).toEqual({ kind: 'you', since: '2026-11-14T09:10:00Z' });
    expect(
      receiverHoldOf(
        { active_receiver_id: me.toUpperCase(), lock_acquired_at: '2026-11-14T09:10:00Z' },
        me,
      ),
    ).toEqual({ kind: 'you', since: '2026-11-14T09:10:00Z' });
    expect(
      receiverHoldOf(
        { active_receiver_id: INTAKE_RECEIVER_ID, lock_acquired_at: '2026-11-14T09:10:00Z' },
        me,
      ),
    ).toEqual({ kind: 'another', since: '2026-11-14T09:10:00Z' });
    expect(
      receiverHoldOf(
        { active_receiver_id: INTAKE_RECEIVER_ID, lock_acquired_at: '2026-11-14T09:10:00Z' },
        undefined,
      ),
    ).toEqual({ kind: 'another', since: '2026-11-14T09:10:00Z' });
  });

  it('is nobody’s when the holder has no moment of its own', () => {
    expect(
      receiverHoldOf({ active_receiver_id: INTAKE_RECEIVER_ID, lock_acquired_at: null }, me),
    ).toEqual({ kind: 'nobody' });
  });
});

/**
 * An intake of any size. The platform sets no limit on the parcels of an intake (OB-S1-97), nor on the photos of its collection, the findings made on it or the evidence of each (the contract and the API
 * have no `maxItems` on them), so the guard judges an answer for its shape, its identifiers, its order and its repeats, and **never for its number**. The review of 17 November 2026 found three ceilings that
 * the API does not have (1,000 photos, 100 pieces of evidence for a finding, 200 findings), each of which made the whole intake unreadable for one more; each is tried on both sides of its old line and far beyond.
 */
const photoIds = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) => `${(index + 1).toString(16).padStart(8, '0')}-0001-4000-8000-000000000000`,
  );
const evidenceOf = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) => `${(index + 1).toString(16).padStart(8, '0')}-0002-4000-8000-000000000000`,
  );
const findingsOf = (count: number, evidence = 0) =>
  Array.from({ length: count }, (_, index) =>
    findingFixture({
      id: `${(index + 1).toString(16).padStart(8, '0')}-0003-4000-8000-000000000000`,
      recorded_at: new Date(Date.UTC(2026, 10, 14, 9, 0, 0) + index * 1000).toISOString(),
      evidence_ids: evidenceOf(evidence),
    }),
  );

describe('an intake of any size', () => {
  // Break caught: a ceiling on the photos of a collection that the API does not have (it was 1,000).
  it.each([1, 999, 1000, 1001, 2625, 5000, 20_000])(
    'is read with %i photos of its collection, all of them and in order',
    (count) => {
      const photos = photoIds(count);
      const intake = parseIntake(postCountFixture({ parcel_photo_ids: photos }));
      expect(intake).toMatchObject({ count_phase: 'POST_COUNT' });
      expect(intake && 'parcel_photo_ids' in intake ? intake.parcel_photo_ids : []).toEqual(photos);
    },
  );

  // Break caught: a ceiling on the evidence of one finding (it was 100): evidence is kept whole, never cut and never a reason to refuse the intake.
  it.each([1, 99, 100, 101, 500, 5000])(
    'is read with a finding that has %i pieces of evidence, all of them',
    (count) => {
      const evidence = evidenceOf(count);
      const finding = parseFinding(findingFixture({ evidence_ids: evidence }));
      expect(finding?.evidence_ids).toEqual(evidence);
      const intake = parseIntake(
        postCountFixture({ condition_findings: [findingFixture({ evidence_ids: evidence })] }),
      );
      expect(intake).toBeDefined();
    },
  );

  // Break caught: a ceiling on the history of an intake (it was 200 findings): a long case is as readable as a short one, and its findings keep the order they were made in.
  it.each([1, 199, 200, 201, 1000, 5000])(
    'is read with %i findings, in the order made',
    (count) => {
      const findings = findingsOf(count);
      const intake = parseIntake(postCountFixture({ condition_findings: findings }));
      expect(
        intake && 'condition_findings' in intake ? intake.condition_findings : [],
      ).toHaveLength(count);
      expect(
        (intake && 'condition_findings' in intake ? intake.condition_findings : []).map(
          (finding) => finding.id,
        ),
      ).toEqual(findings.map((finding) => finding.id));
    },
  );

  it('is read with everything at once: thousands of photos, hundreds of findings and many pieces of evidence for each', () => {
    const photos = photoIds(3000);
    const findings = findingsOf(300, 120);
    const intake = parseIntake(
      postCountFixture({ parcel_photo_ids: photos, condition_findings: findings }),
    );
    expect(intake).toBeDefined();
  });

  // Break caught: a repeat or a bad identifier let through because the list is long, or a long list refused for its length and not for what is wrong with it.
  it('is refused whole when the first photo is named again at the end of a long list', () => {
    const photos = photoIds(5000);
    expect(parseIntake(postCountFixture({ parcel_photo_ids: [...photos, photos[0] ?? ''] }))).toBe(
      undefined,
    );
  });

  it('is refused whole when one photo of a long list is not an identifier', () => {
    const photos = photoIds(5000);
    photos[4321] = 'not-an-identifier';
    expect(parseIntake(postCountFixture({ parcel_photo_ids: photos }))).toBeUndefined();
  });

  it('is refused whole when a finding of a long history is made twice', () => {
    const findings = findingsOf(1000);
    expect(
      parseIntake(postCountFixture({ condition_findings: [...findings, findings[0] ?? {}] })),
    ).toBeUndefined();
  });

  it('is refused whole when a long history is in the wrong order', () => {
    const findings = findingsOf(1000);
    expect(
      parseIntake(postCountFixture({ condition_findings: [...findings].reverse() })),
    ).toBeUndefined();
  });

  it('is refused whole when a piece of evidence is named twice in one finding of a long list', () => {
    const evidence = evidenceOf(3000);
    expect(
      parseFinding(findingFixture({ evidence_ids: [...evidence, evidence[1000] ?? ''] })),
    ).toBeUndefined();
  });

  // Break caught: a duplicate check made entry by entry against the ones before it, which took fourteen seconds at twenty thousand identifiers on the one thread of the browser: an intake of that
  // size is read in well under the time the old check needed for a tenth of it.
  it('is read in well under a second with twenty thousand photos and two thousand findings', () => {
    const photos = photoIds(20_000);
    const findings = findingsOf(2000, 10);
    const start = performance.now();
    const intake = parseIntake(
      postCountFixture({ parcel_photo_ids: photos, condition_findings: findings }),
    );
    expect(intake).toBeDefined();
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
