import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { Sha256TokenService } from '../../platform/auth/crypto/sha256.token-service.adapter.js';
import type { Clock } from '../../platform/auth/ports/clock.port.js';
import type { IssuedToken, TokenService } from '../../platform/auth/ports/token-service.port.js';
import { RESERVED_SYSTEM_ACTOR_ID } from '../../staff/reserved-system-actor.js';
import { planResume, planSeed, type PlanDependencies } from './bootstrap-plan.js';
import {
  BOOTSTRAP_BUNDLE_ID,
  BootstrapInputError,
  type Custodian,
} from './bootstrap-vocabulary.js';

const NOW = new Date('2026-10-21T08:00:00.000Z');
const CLOCK: Clock = { now: () => NOW, monotonicMilliseconds: () => 0 };
const tokens = new Sha256TokenService();

const FIRST: Custodian = { fullName: 'Kofi Boateng', workEmail: 'kofi.boateng@melarc.example' };
const SECOND: Custodian = { fullName: 'Efua Addo', workEmail: 'Efua.Addo@melarc.example' };

const dependencies = (overrides: Partial<PlanDependencies> = {}): PlanDependencies => ({
  tokens,
  clock: CLOCK,
  correlationId: 'bootstrap-test-run',
  ...overrides,
});

const problemOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BootstrapInputError);
    return (error as BootstrapInputError).problem;
  }
  throw new Error('expected the input to be refused');
};

interface Document {
  readonly administrators: readonly Record<string, unknown>[];
  readonly audit: readonly Record<string, unknown>[];
}
const documentOf = (text: string): Document => JSON.parse(text) as Document;

describe('planning the bootstrap seed (S0.30)', () => {
  // Break caught: a pair that is not two (one email, three emails, none), accepted and written.
  it('takes exactly two custodians', () => {
    expect(problemOf(() => planSeed([], dependencies()))).toBe('CUSTODIAN_COUNT');
    expect(problemOf(() => planSeed([FIRST], dependencies()))).toBe('CUSTODIAN_COUNT');
    expect(
      problemOf(() =>
        planSeed(
          [FIRST, SECOND, { fullName: 'Yaw Owusu', workEmail: 'yaw@melarc.example' }],
          dependencies(),
        ),
      ),
    ).toBe('CUSTODIAN_COUNT');
  });

  // Break caught: two custodians that collapse to one canonical work email, which is one person controlling both identities
  // (MIGRATION_AND_SEEDING.md §3.2); the plan stops before it makes a secret or an identifier.
  it.each([
    ['the same address twice', 'a@melarc.example', 'a@melarc.example'],
    ['a different case', 'a@melarc.example', 'A@Melarc.Example'],
    ['white space around it', 'a@melarc.example', '  a@melarc.example\n'],
    ['a compatibility form (NFKC)', 'a@melarc.example', 'ａ@melarc.example'],
  ])('refuses two custodians that collapse to one email: %s', (_name, first, second) => {
    const issue = vi.fn(() => tokens.issue());
    const countingTokens: Pick<TokenService, 'issue'> = { issue };
    expect(
      problemOf(() =>
        planSeed(
          [
            { fullName: 'One', workEmail: first },
            { fullName: 'Two', workEmail: second },
          ],
          dependencies({ tokens: countingTokens }),
        ),
      ),
    ).toBe('CUSTODIANS_NOT_DISTINCT');
    expect(issue).not.toHaveBeenCalled();
  });

  // Break caught: an address that is not an address, or a blank name, reaching the table's checks as a database error.
  it.each([
    '',
    'no-at-sign',
    'a@',
    '@b.example',
    'a b@melarc.example',
    `${'x'.repeat(320)}@melarc.example`,
  ])('refuses the work email %j', (workEmail) => {
    expect(
      problemOf(() => planSeed([{ fullName: 'One', workEmail }, SECOND], dependencies())),
    ).toBe('CUSTODIAN_EMAIL');
  });

  it.each(['', '   ', '\t\n'])('refuses the custodian name %j', (fullName) => {
    expect(
      problemOf(() => planSeed([{ fullName, workEmail: FIRST.workEmail }, SECOND], dependencies())),
    ).toBe('CUSTODIAN_NAME');
  });

  it('refuses a lone surrogate in an address instead of carrying it into a unique index', () => {
    expect(
      problemOf(() =>
        planSeed(
          [{ fullName: 'One', workEmail: 'a\ud800@melarc.example' }, SECOND],
          dependencies(),
        ),
      ),
    ).toBe('CUSTODIAN_EMAIL');
  });

  describe('the plan it makes', () => {
    const plan = planSeed([FIRST, SECOND], dependencies());
    const document = documentOf(plan.document);

    it('makes one administrator for each custodian, each with an identifier and a grant of its own', () => {
      expect(plan.administrators).toHaveLength(2);
      const [first, second] = plan.administrators;
      expect(first?.fullName).toBe('Kofi Boateng');
      expect(second?.workEmail).toBe('Efua.Addo@melarc.example');
      expect(second?.workEmailCanonical).toBe('efua.addo@melarc.example');
      const ids = plan.administrators.flatMap((a) => [a.id, a.grantId]);
      expect(new Set(ids).size).toBe(4);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/);
    });

    // Break caught: a secret that is not 32 random bytes, two administrators that share one, or a hash that is not the one a
    // presented token is looked up by (the store hashes the decoded bytes, `TokenService`).
    it('holds each secret apart and the database only its hash', () => {
      const [first, second] = plan.administrators;
      expect(first?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first?.secret).not.toBe(second?.secret);
      document.administrators.forEach((entry, at) => {
        const secret = plan.administrators[at]?.secret ?? '';
        const grant = entry.grant as { id: string; token_hash: string };
        expect(grant.id).toBe(plan.administrators[at]?.grantId);
        expect(grant.token_hash).toBe(
          createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('hex'),
        );
        expect(grant.token_hash).toBe(Buffer.from(tokens.hash(secret) ?? []).toString('hex'));
      });
    });

    // Break caught: a secret, an address or a name travelling into the document that the database function (and so its logs and
    // the audit ledger) receives.
    it('carries no secret, no email and no name in the document', () => {
      for (const administrator of plan.administrators) {
        expect(plan.document).not.toContain(administrator.secret);
      }
      const audit = JSON.stringify(document.audit);
      for (const text of ['Kofi', 'Boateng', 'Addo', 'melarc.example', '@']) {
        expect(audit).not.toContain(text);
      }
    });

    it('carries the work email as entered and its canonical form to the function that writes the row', () => {
      expect(document.administrators.map((a) => [a.work_email, a.work_email_canonical])).toEqual([
        ['kofi.boateng@melarc.example', 'kofi.boateng@melarc.example'],
        ['Efua.Addo@melarc.example', 'efua.addo@melarc.example'],
      ]);
    });

    // Break caught: the enhanced events of the identity that are the bootstrap's only trace left out, ordinary, or written
    // by a person: each administrator has its creation, its approval and the issue of its secret recorded by SYSTEM.
    it('records, for each administrator, the creation and the approval as enhanced and the issue of the secret as ordinary', () => {
      expect(document.audit).toHaveLength(6);
      for (const administrator of plan.administrators) {
        const mine = document.audit.filter(
          (row) => row.object_id === administrator.id || row.object_id === administrator.grantId,
        );
        expect(mine.map((row) => row.event_code).sort()).toEqual([
          'auth.setup_grant.issued',
          'staff.identity.approved',
          'staff.identity.created',
        ]);
        for (const row of mine) {
          expect(row.actor_type).toBe('SYSTEM');
          expect(row.actor_id).toBeNull();
          expect(row.surface_context).toBe('SYSTEM');
          expect(row.outcome).toBe('SUCCEEDED');
          expect(row.correlation_id).toBe('bootstrap-test-run');
          expect(row.enhanced).toBe(row.event_code !== 'auth.setup_grant.issued');
        }
      }
    });

    it('records both actors of the approval as the reserved system actor, and states what changed', () => {
      const approved = document.audit.filter((row) => row.event_code === 'staff.identity.approved');
      for (const row of approved) {
        expect(row.related_ids).toMatchObject({
          created_by: RESERVED_SYSTEM_ACTOR_ID,
          approved_by: RESERVED_SYSTEM_ACTOR_ID,
        });
        expect(row.before_after).not.toBeNull();
      }
      const created = document.audit.filter((row) => row.event_code === 'staff.identity.created');
      for (const row of created) {
        expect(row.related_ids).toMatchObject({
          created_by: RESERVED_SYSTEM_ACTOR_ID,
          role_bundle_id: BOOTSTRAP_BUNDLE_ID,
        });
        expect(row.before_after).not.toBeNull();
      }
    });

    it('records the issue of a secret by its purpose and the controlled provisioning channel, never the secret', () => {
      const issued = document.audit.filter((row) => row.event_code === 'auth.setup_grant.issued');
      for (const row of issued) {
        expect(row.object_type).toBe('SetupGrant');
        expect(row.detail).toMatchObject({
          purpose: 'BOOTSTRAP_SETUP',
          channel: 'PROVISIONING_CHANNEL',
        });
      }
    });

    it('stamps every record with the clock the plan was given', () => {
      for (const row of document.audit) expect(row.occurred_at).toBe(NOW.toISOString());
    });
  });
});

const IDENTITY = '0197a0a0-0000-7000-8000-000000000001';
const FACTOR = '0197a0a0-0000-7000-8000-000000000002';
const OLD_GRANT = '0197a0a0-0000-7000-8000-000000000003';

describe('planning the resume command (S0.30; MIGRATION_AND_SEEDING.md §3.3a)', () => {
  const stranded = {
    id: IDENTITY,
    credentialEstablished: true,
    pendingFactorIds: [FACTOR],
    liveBootstrapGrantId: null,
    lapsedGrants: [],
  } as const;

  // Break caught: the re-enrolment path issuing a BOOTSTRAP_SETUP (a revived single-use secret) or the lost-bundle path issuing
  // an MFA_REENROLMENT to an identity with no password.
  it('issues an MFA_REENROLMENT to an identity that has a password, and never a BOOTSTRAP_SETUP', () => {
    const plan = planResume(stranded, dependencies());
    expect(plan.path).toBe('REENROLMENT');
    expect(plan.purpose).toBe('MFA_REENROLMENT');
    expect(plan.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const document = JSON.parse(plan.document) as Record<string, unknown>;
    expect(document).toMatchObject({ identity_id: IDENTITY, path: 'REENROLMENT' });
    expect(plan.document).not.toContain(plan.secret);
  });

  it('supersedes the unconsumed secret of an identity with no password, with a new BOOTSTRAP_SETUP', () => {
    const plan = planResume(
      {
        id: IDENTITY,
        credentialEstablished: false,
        pendingFactorIds: [],
        liveBootstrapGrantId: OLD_GRANT,
        lapsedGrants: [],
      },
      dependencies(),
    );
    expect(plan.path).toBe('BUNDLE_LOST');
    expect(plan.purpose).toBe('BOOTSTRAP_SETUP');
    const document = documentOf(plan.document) as unknown as { audit: Record<string, unknown>[] };
    const codes = document.audit.map((row) => row.event_code);
    expect(codes).toEqual([
      'auth.setup_grant.superseded',
      'auth.setup_grant.issued',
      'auth.bootstrap.resumed',
    ]);
    const superseded = document.audit[0];
    expect(superseded?.object_id).toBe(OLD_GRANT);
    expect(superseded?.related_ids).toMatchObject({ principal_id: IDENTITY });
  });

  // Break caught: the enhanced record of a revoked factor missing, or a revocation recorded for a factor that does not exist.
  it('records the revocation of a stale PENDING factor as an enhanced event and nothing for a factor that is not there', () => {
    const withFactor = JSON.parse(planResume(stranded, dependencies()).document) as {
      audit: Record<string, unknown>[];
    };
    expect(withFactor.audit.map((row) => row.event_code)).toEqual([
      'auth.mfa.revoked',
      'auth.setup_grant.issued',
      'auth.bootstrap.resumed',
    ]);
    const [revoked, issued] = withFactor.audit;
    expect(revoked).toMatchObject({
      object_type: 'MfaFactor',
      object_id: FACTOR,
      enhanced: true,
      actor_type: 'SYSTEM',
      actor_id: null,
      previous_state: 'PENDING',
      resulting_state: 'REVOKED',
    });
    expect(issued).toMatchObject({
      enhanced: false,
      detail: { purpose: 'MFA_REENROLMENT', channel: 'PROVISIONING_CHANNEL' },
    });

    const without = JSON.parse(
      planResume({ ...stranded, pendingFactorIds: [] }, dependencies()).document,
    ) as { audit: Record<string, unknown>[] };
    expect(without.audit.map((row) => row.event_code)).toEqual([
      'auth.setup_grant.issued',
      'auth.bootstrap.resumed',
    ]);
  });

  it('makes a new secret every time it is planned', () => {
    const one = planResume(stranded, dependencies());
    const two = planResume(stranded, dependencies());
    expect(one.secret).not.toBe(two.secret);
    expect(one.grantId).not.toBe(two.grantId);
  });

  it('refuses a state that fits neither path: no password and no secret to supersede', () => {
    expect(() =>
      planResume(
        {
          id: IDENTITY,
          credentialEstablished: false,
          pendingFactorIds: [],
          liveBootstrapGrantId: null,
          lapsedGrants: [],
        },
        dependencies(),
      ),
    ).toThrow(/changed/);
  });

  // Break caught: the shape of the token and of its hash each trusted to the other: a token of the right shape with a hash of the
  // wrong length would put a hash in the document that the database refuses late, or a hash of something else beside the secret.
  it.each([
    ['a token that is too short', { token: 'short', hash: new Uint8Array(32) }],
    ['a token that is not base64url text', { token: '!'.repeat(43), hash: new Uint8Array(32) }],
    ['a hash of 31 bytes', { token: 'A'.repeat(43), hash: new Uint8Array(31) }],
    ['a hash of 33 bytes', { token: 'A'.repeat(43), hash: new Uint8Array(33) }],
    ['a hash that is no bytes', { token: 'A'.repeat(43), hash: 'abcd' as unknown as Uint8Array }],
  ] as const satisfies readonly (readonly [string, IssuedToken])[])(
    'does not let a token service that returns %s through',
    (_name, issued) => {
      expect(() => planResume(stranded, dependencies({ tokens: { issue: () => issued } }))).toThrow(
        /not a 32-byte token/,
      );
      expect(() =>
        planSeed([FIRST, SECOND], dependencies({ tokens: { issue: () => issued } })),
      ).toThrow(/not a 32-byte token/);
    },
  );

  it('accepts a token of the right shape with a hash of 32 bytes', () => {
    const issued: IssuedToken = { token: 'A'.repeat(43), hash: new Uint8Array(32) };
    expect(planResume(stranded, dependencies({ tokens: { issue: () => issued } })).secret).toBe(
      'A'.repeat(43),
    );
  });
});

describe('the summary event of a resume (the owner’s adoption of 21 October 2026, A07; AC-SLICE-000-93)', () => {
  const LAPSED_ONE = '0197a0a0-0000-7000-8000-000000000011';
  const LAPSED_TWO = '0197a0a0-0000-7000-8000-000000000012';
  const FACTOR_TWO = '0197a0a0-0000-7000-8000-000000000004';
  const reenrolment = {
    id: IDENTITY,
    credentialEstablished: true,
    pendingFactorIds: [FACTOR],
    liveBootstrapGrantId: null,
    lapsedGrants: [],
  } as const;
  const lost = {
    id: IDENTITY,
    credentialEstablished: false,
    pendingFactorIds: [],
    liveBootstrapGrantId: OLD_GRANT,
    lapsedGrants: [],
  } as const;

  const summaryOf = (text: string): Record<string, unknown> => {
    const rows = documentOf(text).audit.filter(
      (row) => row.event_code === 'auth.bootstrap.resumed',
    );
    expect(rows).toHaveLength(1);
    return rows[0] ?? {};
  };

  // Break caught: no summary, or two, or one for a path only; AC-SLICE-000-93 asks for one enhanced record per resume.
  it.each([
    ['the re-enrolment', reenrolment],
    ['the lost bundle', lost],
  ] as const)(
    'writes exactly one enhanced summary, by SYSTEM with no actor id, on %s',
    (_path, state) => {
      const event = summaryOf(planResume(state, dependencies()).document);

      expect(event).toMatchObject({
        event_code: 'auth.bootstrap.resumed',
        enhanced: true,
        outcome: 'SUCCEEDED',
        actor_type: 'SYSTEM',
        actor_id: null,
        surface_context: 'SYSTEM',
        object_type: 'StaffIdentity',
        object_id: IDENTITY,
        correlation_id: 'bootstrap-test-run',
      });
    },
  );

  it('names the grant it issued, the reserved actor as a fact, and the path and purpose, on the lost bundle', () => {
    const plan = planResume(lost, dependencies());
    const event = summaryOf(plan.document);

    expect(event.detail).toEqual({
      path: 'BUNDLE_LOST',
      purpose: 'BOOTSTRAP_SETUP',
      channel: 'PROVISIONING_CHANNEL',
    });
    expect(event.related_ids).toEqual({
      principal_id: IDENTITY,
      reserved_system_actor_id: RESERVED_SYSTEM_ACTOR_ID,
      setup_grant_id: plan.grantId,
      superseded_grant_ids: [OLD_GRANT],
      expired_grant_ids: [],
      revoked_factor_ids: [],
    });
    expect(event.before_after).toEqual({
      grants: {
        before: [{ id: OLD_GRANT, purpose: 'BOOTSTRAP_SETUP', state: 'PENDING' }],
        after: [
          { id: OLD_GRANT, purpose: 'BOOTSTRAP_SETUP', state: 'SUPERSEDED' },
          { id: plan.grantId, purpose: 'BOOTSTRAP_SETUP', state: 'PENDING' },
        ],
      },
      factors: { before: [], after: [] },
    });
  });

  // Break caught: the lapsed grants an identity holds ended without a trace, or the factors revoked in no particular order, so that two
  // runs of the same state could differ and the function could not hold the document to what it derives.
  it('names the lapsed grants it ends and the factors it revokes, each by id in ascending order', () => {
    const plan = planResume(
      {
        ...reenrolment,
        pendingFactorIds: [FACTOR_TWO, FACTOR],
        lapsedGrants: [
          { id: LAPSED_TWO, purpose: 'MFA_ENROLMENT' },
          { id: LAPSED_ONE, purpose: 'MFA_REENROLMENT' },
        ],
      },
      dependencies(),
    );
    const event = summaryOf(plan.document);

    expect(event.detail).toEqual({
      path: 'REENROLMENT',
      purpose: 'MFA_REENROLMENT',
      channel: 'PROVISIONING_CHANNEL',
    });
    expect(event.related_ids).toEqual({
      principal_id: IDENTITY,
      reserved_system_actor_id: RESERVED_SYSTEM_ACTOR_ID,
      setup_grant_id: plan.grantId,
      superseded_grant_ids: [],
      expired_grant_ids: [LAPSED_ONE, LAPSED_TWO],
      revoked_factor_ids: [FACTOR, FACTOR_TWO],
    });
    expect(event.before_after).toEqual({
      grants: {
        before: [
          { id: LAPSED_ONE, purpose: 'MFA_REENROLMENT', state: 'PENDING' },
          { id: LAPSED_TWO, purpose: 'MFA_ENROLMENT', state: 'PENDING' },
        ],
        after: [
          { id: LAPSED_ONE, purpose: 'MFA_REENROLMENT', state: 'EXPIRED' },
          { id: LAPSED_TWO, purpose: 'MFA_ENROLMENT', state: 'EXPIRED' },
          { id: plan.grantId, purpose: 'MFA_REENROLMENT', state: 'PENDING' },
        ],
      },
      factors: {
        before: [
          { id: FACTOR, status: 'PENDING' },
          { id: FACTOR_TWO, status: 'PENDING' },
        ],
        after: [
          { id: FACTOR, status: 'REVOKED' },
          { id: FACTOR_TWO, status: 'REVOKED' },
        ],
      },
    });
  });

  // Break caught: the lost-bundle path listing grants it does not end: that path expires nothing, whatever the state lists.
  it('ends no lapsed grant on the lost-bundle path, whatever the state lists', () => {
    const event = summaryOf(
      planResume(
        { ...lost, lapsedGrants: [{ id: LAPSED_ONE, purpose: 'MFA_ENROLMENT' }] },
        dependencies(),
      ).document,
    );

    expect(event.related_ids).toMatchObject({
      expired_grant_ids: [],
      superseded_grant_ids: [OLD_GRANT],
    });
  });

  it('is written beside the detailed events and replaces none of them', () => {
    const codes = documentOf(
      planResume(
        { ...reenrolment, lapsedGrants: [{ id: LAPSED_ONE, purpose: 'MFA_ENROLMENT' }] },
        dependencies(),
      ).document,
    ).audit.map((row) => row.event_code);

    expect(codes).toEqual([
      'auth.mfa.revoked',
      'auth.setup_grant.issued',
      'auth.bootstrap.resumed',
    ]);
  });

  // Break caught: a secret, a hash, an address or a name in the summary, whichever path.
  it.each([
    ['the re-enrolment', reenrolment],
    ['the lost bundle', lost],
  ] as const)('holds no secret, hash, address or name, on %s', (_path, state) => {
    const plan = planResume(state, dependencies());
    const text = JSON.stringify(summaryOf(plan.document));
    const hash = (JSON.parse(plan.document) as { grant: { token_hash: string } }).grant.token_hash;

    expect(text).not.toContain(plan.secret);
    expect(text).not.toContain(hash);
    expect(text).not.toMatch(/@|secret|token|password/i);
  });
});
