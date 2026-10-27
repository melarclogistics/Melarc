import { describe, expect, it } from 'vitest';

import { NotReadyError, ReadinessRegistry } from '../../health/readiness.registry.js';
import type { UnitOfWork } from '../ports/unit-of-work.port.js';
import { ReferenceDataReadiness } from './reference-data-readiness.js';

type Run = UnitOfWork['run'];

/** A unit of work that answers `seeded` to whatever work it is given, and remembers the context it was opened under. */
function unitOfWork(answer: () => Promise<boolean>) {
  const contexts: Parameters<Run>[0][] = [];
  const run = ((context: Parameters<Run>[0]) => {
    contexts.push(context);
    return answer();
  }) as unknown as Run;
  return { run, contexts };
}

describe('ReferenceDataReadiness (an instance over a database the seed has not filled is not ready)', () => {
  // Break caught: an instance reporting ready over an empty reference database, so that every sign-in answers 503 while the platform
  // sends it traffic (the owner met exactly this on 25 October 2026: the migrations had run and the seed had not).
  it('is ready when the reference data is there', async () => {
    const check = new ReferenceDataReadiness({
      unitOfWork: unitOfWork(() => Promise.resolve(true)),
    });

    await expect(check.check()).resolves.toBeUndefined();
  });

  it('is not ready, with its own reason, when the reference data is missing', async () => {
    const check = new ReferenceDataReadiness({
      unitOfWork: unitOfWork(() => Promise.resolve(false)),
    });

    await expect(check.check()).rejects.toMatchObject({
      name: 'NotReadyError',
      reason: 'reference_data_missing',
    });
  });

  // Break caught: a database that does not answer read as an unseeded one, so that the remedy told ("run the seed") is the wrong one.
  it('lets a database that does not answer be the dependency that failed, not a missing seed', async () => {
    const down = new Error('connect ECONNREFUSED');
    const check = new ReferenceDataReadiness({
      unitOfWork: unitOfWork(() => Promise.reject(down)),
    });

    await expect(check.check()).rejects.toBe(down);
    await expect(check.check()).rejects.not.toBeInstanceOf(NotReadyError);
  });

  // Break caught: the read made under a request's context, or under a principal that cannot read the reference tables.
  it('reads under the authentication capability, as the system, in a transaction of its own', async () => {
    const opened = unitOfWork(() => Promise.resolve(true));
    await new ReferenceDataReadiness({ unitOfWork: opened }).check();

    expect(opened.contexts).toHaveLength(1);
    expect(opened.contexts[0]).toMatchObject({
      principalType: 'SYSTEM',
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId: 'readiness',
    });
  });

  it('is told by the registry as the reason it stands for, and as a dependency when the read fails', async () => {
    const missing = new ReadinessRegistry();
    missing.register(
      new ReferenceDataReadiness({ unitOfWork: unitOfWork(() => Promise.resolve(false)) }),
    );
    const broken = new ReadinessRegistry();
    broken.register(
      new ReferenceDataReadiness({ unitOfWork: unitOfWork(() => Promise.reject(new Error('x'))) }),
    );

    expect(await missing.failingChecks()).toEqual([
      { name: 'reference-data', reason: 'reference_data_missing' },
    ]);
    expect(await broken.failingChecks()).toEqual([
      { name: 'reference-data', reason: 'dependency_unavailable' },
    ]);
  });
});
