import { describe, expect, it } from 'vitest';

import { saturation, sharedAddressNeed, stageResult } from './capacity-model.js';

describe('the arithmetic of the capacity measurement (S0.65)', () => {
  it('says a stage as its latencies, its throughput over the whole stage, and its refusals apart', () => {
    const stage = stageResult(4, [100, 120, 110, 400], 200, 1);
    expect(stage).toMatchObject({ concurrency: 4, runs: 4, medianMs: 115, p95Ms: 400, refused: 1 });
    expect(stage.throughputPerSecond).toBe(20);
    expect(() => stageResult(0, [1], 1, 0)).toThrow(RangeError);
    expect(() => stageResult(1, [1], 0, 0)).toThrow(RangeError);
  });

  // Break caught: a saturation point read where throughput still grew, which would propose too little capacity.
  it('finds the stage after which more concurrency bought less than a tenth more throughput', () => {
    // 10, 20, 33 and 35 a second: the step from 4 to 8 adds 5%, so 4 is the last that was worth its concurrency.
    const stages = [
      stageResult(1, [100], 100, 0),
      stageResult(2, [100, 100], 100, 0),
      stageResult(4, [100, 100, 100, 100], 120, 0),
      stageResult(
        8,
        Array.from({ length: 8 }, () => 100),
        230,
        0,
      ),
    ];
    expect(saturation(stages)?.concurrency).toBe(4);
    expect(saturation(stages.slice(0, 2))).toBeUndefined();
  });

  it('turns the owner’s figures for people behind one address into the sign-ins a minute it needs, and the share of capacity', () => {
    expect(sharedAddressNeed({ people: 40, windowMinutes: 10 }, 10)).toEqual({
      signInsPerMinute: 4,
      shareOfCapacity: 0.007,
    });
    expect(sharedAddressNeed({ people: 41, windowMinutes: 10 }, 10).signInsPerMinute).toBe(5);
    expect(() => sharedAddressNeed({ people: 0, windowMinutes: 10 }, 10)).toThrow(RangeError);
  });
});
