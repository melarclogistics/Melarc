import { describe, expect, it } from 'vitest';

import { APP_ENVS } from '../../platform/config/config-settings.js';
import {
  REASON_ATTRIBUTIONS,
  REASON_DOMAINS,
} from '../../platform/database/schema/reference-data.js';
import { IDENTITY_REASONS } from '../seed/reasons.js';
import {
  FIXTURE_CODE_PREFIX,
  FixturesRefusedError,
  REASON_FIXTURES,
  assertFixturesAllowed,
  fixturePlan,
} from './fixtures.js';

/**
 * The test-only fixtures (S0.9; MIGRATION_AND_SEEDING.md section 4: "Test-only reason fixtures stay outside the seed, are visibly
 * named as fixtures and are refused in production, so they can never become an accidental production seed").
 */
describe('assertFixturesAllowed', () => {
  // Break caught: fixtures run in production (a reason that exists to make a test pass becomes a production reason).
  it('refuses production', () => {
    expect(() => {
      assertFixturesAllowed('production');
    }).toThrow(FixturesRefusedError);
  });

  it.each(['local', 'staging'])(
    'allows %s, where the specifications allow fixtures',
    (environment) => {
      expect(() => {
        assertFixturesAllowed(environment);
      }).not.toThrow();
    },
  );

  // Break caught: a guard that refuses the one spelling it knows. An environment that is not one of the known three, a different
  // case, a missing value: all refused, because the guard names what is allowed and not what is forbidden.
  it.each([
    undefined,
    null,
    '',
    'prod',
    'Production',
    'PRODUCTION',
    ' production',
    'development',
    42,
    {},
  ])('refuses %j, which is not a known non-production environment', (environment) => {
    expect(() => {
      assertFixturesAllowed(environment);
    }).toThrow(FixturesRefusedError);
  });

  it('allows exactly the environments that are not production', () => {
    const allowed = APP_ENVS.filter((environment) => {
      try {
        assertFixturesAllowed(environment);
        return true;
      } catch {
        return false;
      }
    });
    expect(allowed).toEqual(APP_ENVS.filter((environment) => environment !== 'production'));
  });

  it('says what was refused and never repeats the value it was given', () => {
    try {
      assertFixturesAllowed('postgres://user:CANARY-SECRET@host/db');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('CANARY-SECRET');
      expect((error as Error).message).toMatch(/fixtures/i);
    }
  });
});

describe('the reason fixtures', () => {
  // Break caught: a fixture that looks like a real reason (nothing in a listing would show that it is a test aid), or one that
  // collides with a real code and is refused by, or worse replaces, the seeded row.
  it('are visibly named as fixtures, and none is a code of the seed', () => {
    const seeded = new Set(IDENTITY_REASONS.map((reason) => reason.code));
    expect(REASON_FIXTURES.length).toBeGreaterThan(0);
    for (const fixture of REASON_FIXTURES) {
      expect(fixture.code.startsWith(FIXTURE_CODE_PREFIX), fixture.code).toBe(true);
      expect(fixture.label.startsWith('Fixture: '), fixture.code).toBe(true);
      expect(seeded.has(fixture.code), fixture.code).toBe(false);
    }
    expect(new Set(REASON_FIXTURES.map((fixture) => fixture.code)).size).toBe(
      REASON_FIXTURES.length,
    );
  });

  it('use the closed sets of the reason table', () => {
    for (const fixture of REASON_FIXTURES) {
      expect(REASON_DOMAINS as readonly string[], fixture.code).toContain(fixture.domain);
      expect(REASON_ATTRIBUTIONS as readonly string[], fixture.code).toContain(fixture.attribution);
      expect(fixture.code, fixture.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  // Break caught: a fixture operation that is a real operation of the contract, so that a test using it passes for a reason
  // the product could grant. A fixture can be used to show "this reason does not permit this operation" and an inactive reason.
  it('include an inactive reason and one that no real operation permits', () => {
    expect(REASON_FIXTURES.some((fixture) => !fixture.active)).toBe(true);
    expect(
      REASON_FIXTURES.some((fixture) =>
        fixture.permittedOperations.every((operation) => operation.startsWith('fixtureOnly')),
      ),
    ).toBe(true);
  });
});

describe('the fixture plan', () => {
  it('writes the reason fixtures and nothing else, by the fixtures function, and takes no policy key', () => {
    const plan = fixturePlan();
    expect(plan.entryPoint).toBe('add_reason_fixtures');
    expect(Object.keys(plan.payload)).toEqual(['reason_code']);
    expect(plan.payload.reason_code).toHaveLength(REASON_FIXTURES.length);
    expect(plan.labels).toEqual({ reason_code: 'reason_code (fixtures)' });
    expect(plan.locks).toEqual([]);
  });

  // Break caught: a fixture row whose code the function would refuse (it writes codes that start with FIXTURE_ and no others), or a
  // payload that could carry a real reason.
  it('carries only rows whose code starts with the fixture prefix', () => {
    for (const row of fixturePlan().payload.reason_code ?? []) {
      expect(String(row.code)).toMatch(/^FIXTURE_[A-Z0-9_]+$/);
    }
  });
});
