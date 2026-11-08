import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  activateFactor,
  factorRow,
  grantRow,
  insertFactor,
  insertGrant,
  setGrantState,
} from './support/credentials.js';
import {
  API,
  HUB_A,
  OPS,
  outcomeOf,
  startStaffRoutes,
  versionOf,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';

/**
 * S0.37, `resetStaffMfa` against the real application and a real PostgreSQL (`AC-SLICE-000-37`, `-114`, `-119`, `-132`; `GBT-B14`'s
 * behaviour half): a Platform Admin resets another privileged identity's second factor in each of the three recorded states, never
 * from the absence of a factor, never its own, with the reason of the branch the recorded state gives, and without ever creating a
 * factor or a session or showing the acting administrator a seed, a token or a QR.
 */
let routes: StaffRoutes;

beforeAll(async () => {
  routes = await startStaffRoutes();
});

afterAll(async () => {
  await routes.stop();
});

const RESET = (id: string) => `${API}/ops/staff/${id}/mfa/reset`;
const ACTIVE_FACTOR_REASON = { reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE' };
const UNFINISHED_REASON = { reason_code: 'MFA_ENROLMENT_EXPIRED' };

const reset = (
  officer: Actor,
  id: string,
  etag: string | undefined,
  body: Record<string, unknown> = ACTIVE_FACTOR_REASON,
) =>
  officer.client.post(RESET(id), body, {
    origin: OPS,
    headers: etag === undefined ? {} : { 'if-match': etag },
  });

/** Reads the target's version as a Platform Admin does, and resets it. */
async function resetting(
  officer: Actor,
  target: Actor,
  body: Record<string, unknown> = ACTIVE_FACTOR_REASON,
) {
  return reset(officer, target.identity.id, await versionOf(officer, target.identity.id), body);
}

/** A privileged identity (Senior Ops) with a live session: the person whose authenticator is lost. */
const privilegedTarget = (): Promise<Actor> => routes.seniorOps(HUB_A);

/** The target holds a proven factor. */
async function withActiveFactor(target: Actor) {
  const factor = await insertFactor(routes.admin, factorRow(target.identity.id));
  await activateFactor(routes.admin, factor.id);
  return factor;
}

/** Lets a grant's lifetime pass (issued two hours ago, expired an hour ago): the arrangement is the administrator's, with the table's triggers set aside for the one statement. */
async function lapse(grantId: string): Promise<void> {
  await routes.admin.query('alter table setup_grant disable trigger user');
  try {
    await routes.admin.query(
      `update setup_grant set issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1`,
      [grantId],
    );
  } finally {
    await routes.admin.query('alter table setup_grant enable trigger user');
  }
}

interface FactorState {
  readonly id: string;
  readonly status: string;
  readonly revoked_by: string | null;
  readonly revocation_reason_code: string | null;
  readonly created_episode_id: string | null;
  readonly revocation_episode_id: string | null;
  readonly created_by_purpose: string;
}
const factorsOf = (id: string) =>
  routes.rows<FactorState>(
    `select id, status, revoked_by, revocation_reason_code, created_episode_id, revocation_episode_id, created_by_purpose from mfa_factor
      where staff_identity_id = $1 order by ordinal`,
    [id],
  );
const grantsOf = (id: string) =>
  routes.rows<{
    id: string;
    purpose: string;
    state: string;
    issued_by: string | null;
    episode_id: string | null;
    supersedes_grant_id: string | null;
    continued_from_grant_id: string | null;
  }>(
    `select id, purpose, state, issued_by, episode_id, supersedes_grant_id, continued_from_grant_id from setup_grant where principal_id = $1 order by issued_at, id`,
    [id],
  );
const jobsOf = (id: string) =>
  routes.rows<{
    id: string;
    kind: string;
    state: string;
    redemption_record_id: string;
    channel: string;
    payload_erased_at: Date | null;
  }>(
    `select id, kind, state, redemption_record_id, channel, payload_erased_at from credential_delivery_job where principal_id = $1 order by created_at, id`,
    [id],
  );
const sessionsOf = (id: string) =>
  routes.rows<{ id: string; terminated_at: Date | null; termination_reason: string | null }>(
    `select id, terminated_at, termination_reason from session where principal_id = $1 order by issued_at, id`,
    [id],
  );
const resetEvents = (id: string) =>
  routes.rows<{
    actor_id: string;
    enhanced: boolean;
    reason_code: string;
    previous_state: string;
    resulting_state: string;
    related_ids: Record<string, unknown>;
    before_after: Record<string, unknown> | null;
  }>(
    `select actor_id, enhanced, reason_code, previous_state, resulting_state, related_ids, before_after from audit_event
      where event_code = 'auth.mfa.reset' and object_id = $1 order by recorded_at, id`,
    [id],
  );
const stateOf = async (officer: Actor, id: string): Promise<string> =>
  (
    (await officer.client.get(`${API}/staff-identities/${id}`)).json() as {
      mfa_reset_state: string;
    }
  ).mfa_reset_state;

describe('a live factor (state 1) (AC-SLICE-000-37, -119)', () => {
  // Break caught: any of the effects of the act missing or not together: the factor revoked by the administrator into an episode, every
  // session of the target ended MFA_RESET, a re-enrolment grant of that episode queued to the work email, the enhanced event naming
  // the state, the episode, the factor and the grants; and a factor, a session or a secret created or returned.
  it('revokes the factor into a new episode, ends the target’s sessions, queues a re-enrolment grant to its work email, and shows the administrator nothing to enrol with', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await privilegedTarget();
    const factor = await withActiveFactor(target);
    const second = await routes.machinery.issuer.issue({
      principal: { type: 'STAFF', id: target.identity.id },
      correlationId: 'second',
      verifiedCredentialGeneration: 1,
    });
    expect(await stateOf(staffAdmin, target.identity.id)).toBe('FACTOR_ACTIVE');

    const response = await resetting(staffAdmin, target);

    expect(response.status).toBe(200);
    const body = response.json() as {
      sessions_terminated: number;
      reenrolment_grant_issued: boolean;
      coalesced: boolean;
      grant_expires_at: string;
    };
    expect(body).toMatchObject({
      sessions_terminated: 2,
      reenrolment_grant_issued: true,
      coalesced: false,
    });
    expect(new Date(body.grant_expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(Object.keys(body).toSorted()).toEqual([
      'coalesced',
      'grant_expires_at',
      'reenrolment_grant_issued',
      'sessions_terminated',
    ]);

    const factors = await factorsOf(target.identity.id);
    expect(factors).toHaveLength(1);
    const episode = factors[0]?.revocation_episode_id ?? '';
    expect(factors[0]).toMatchObject({
      id: factor.id,
      status: 'REVOKED',
      revoked_by: staffAdmin.identity.id,
      revocation_reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE',
    });
    expect(episode).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await routes.rows(
        "select 1 from mfa_factor where staff_identity_id = $1 and status in ('ACTIVE','PENDING')",
        [target.identity.id],
      ),
    ).toEqual([]);

    const grants = await grantsOf(target.identity.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      purpose: 'MFA_REENROLMENT',
      state: 'PENDING',
      issued_by: staffAdmin.identity.id,
      episode_id: episode,
      supersedes_grant_id: null,
    });
    const jobs = await jobsOf(target.identity.id);
    expect(jobs).toEqual([
      expect.objectContaining({
        kind: 'MFA_REENROLMENT',
        state: 'QUEUED',
        channel: 'EMAIL',
        redemption_record_id: grants[0]?.id,
      }),
    ]);
    const delivered = await routes.deliveredFor(routes.admin, grants[0]?.id ?? '');
    expect(delivered?.destination).toBe(target.identity.workEmail);
    expect(delivered?.link).toMatch(
      /^http:\/\/127\.0\.0\.1:5173\/setup\/mfa#token=[A-Za-z0-9_-]{43}$/,
    );
    expect(response.text).not.toContain(delivered?.token ?? 'x');

    const sessions = await sessionsOf(target.identity.id);
    expect(sessions.map((session) => session.id).toSorted()).toEqual(
      [target.sessionId, second.session.id].toSorted(),
    );
    expect(
      sessions.every(
        (session) => session.terminated_at !== null && session.termination_reason === 'MFA_RESET',
      ),
    ).toBe(true);
    expect(
      await routes.rows('select 1 from session where principal_id = $1 and terminated_at is null', [
        target.identity.id,
      ]),
    ).toEqual([]);
    // audit.md: only the administrator's revocation of another principal's session (ADMIN_REVOKED) is enhanced; "every other termination is
    // ordinary", and the enhanced events of this act are the reset's and the factor's. One ordinary event for each session ended.
    const terminated = await routes.rows<{ enhanced: boolean; reason_code: string | null }>(
      `select enhanced, reason_code from audit_event where event_code = 'auth.session.terminated' and object_id = any($1::uuid[])`,
      [[target.sessionId, second.session.id]],
    );
    expect(terminated).toHaveLength(2);
    expect(terminated.every((event) => !event.enhanced && event.reason_code === 'MFA_RESET')).toBe(
      true,
    );

    const events = await resetEvents(target.identity.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_id: staffAdmin.identity.id,
      enhanced: true,
      reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE',
      previous_state: 'ACTIVE_FACTOR',
      resulting_state: 'ISSUED',
      related_ids: {
        episode_id: episode,
        revoked_factor_id: factor.id,
        new_grant_id: grants[0]?.id,
        superseded_grant_ids: [],
      },
      before_after: {
        reenrolment_grant: { before: 'NONE', after: 'PENDING' },
        mfa_factor: { before: 'ACTIVE', after: 'REVOKED' },
      },
    });
    expect(outcomeOf(await target.client.get(`${API}/auth/session`))).toEqual([
      401,
      'SESSION_INVALID',
    ]);
    expect(await stateOf(staffAdmin, target.identity.id)).toBe('ENROLMENT_UNFINISHED');
  });

  // Break caught (GBT-B14): a factor created in episode A and reset again into B losing A or not gaining B; the re-enrolment grant not
  // consumable, or its continuation naming the wrong parent; an ACTIVE factor made by the reset.
  it('keeps the creation episode of a factor reset again and gains the revocation episode; the grant is consumed by beginMfaReenrolment, not by the administrator', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await privilegedTarget();
    await withActiveFactor(target);
    expect((await resetting(staffAdmin, target)).status).toBe(200);
    const first = (await grantsOf(target.identity.id))[0];
    const episodeA = first?.episode_id ?? '';
    const token = (await routes.deliveredFor(routes.admin, first?.id ?? ''))?.token ?? '';

    const begun = await routes.kit.client
      .fork()
      .post(`${API}/auth/staff/setup/mfa/begin`, { setup_token: token }, { origin: OPS });

    expect(begun.status).toBe(200);
    const created = await factorsOf(target.identity.id);
    expect(created.map((factor) => factor.status)).toEqual(['REVOKED', 'PENDING']);
    expect(created[1]).toMatchObject({
      created_by_purpose: 'MFA_REENROLMENT',
      created_episode_id: episodeA,
    });
    const afterwards = await grantsOf(target.identity.id);
    expect(afterwards.map((grant) => [grant.purpose, grant.state])).toEqual([
      ['MFA_REENROLMENT', 'CONSUMED'],
      ['MFA_ENROLMENT', 'PENDING'],
    ]);
    expect(afterwards[1]).toMatchObject({
      continued_from_grant_id: first?.id,
      supersedes_grant_id: null,
    });

    // The factor is proven (an arrangement of the administrator: the proof itself is another operation's), and another reset follows.
    await activateFactor(routes.admin, created[1]?.id ?? '');
    await routes.admin.query(
      `update setup_grant set state = 'CONSUMED', consumed_at = now() where id = $1`,
      [afterwards[1]?.id],
    );
    const again = await resetting(staffAdmin, target);

    expect(again.status).toBe(200);
    const final = await factorsOf(target.identity.id);
    expect(final[1]).toMatchObject({ status: 'REVOKED', created_episode_id: episodeA });
    expect(final[1]?.revocation_episode_id).not.toBeNull();
    expect(final[1]?.revocation_episode_id).not.toBe(episodeA);
  });
});

describe('a stranded enrolment (state 2) and an unfinished reset (state 3) (AC-SLICE-000-119)', () => {
  // Break caught: a stranded PENDING factor not reached, its lapsed grants rewritten or its terminal ones changed, or the revocation
  // not recorded into an episode.
  it('revokes a stranded PENDING factor, ends only the grants still pending, keeps the state of terminal grants, and issues a grant of the episode', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await privilegedTarget();
    const stranded = await insertFactor(routes.admin, factorRow(target.identity.id));
    const lapsed = await insertGrant(
      routes.admin,
      grantRow({ principalId: target.identity.id, purpose: 'MFA_ENROLMENT' }),
    );
    await lapse(lapsed.id);
    const consumed = await insertGrant(
      routes.admin,
      grantRow({ principalId: target.identity.id, purpose: 'STAFF_CREDENTIAL_SETUP' }),
    );
    await setGrantState(routes.admin, consumed.id, 'CONSUMED');
    expect(await stateOf(staffAdmin, target.identity.id)).toBe('ENROLMENT_UNFINISHED');

    const response = await resetting(staffAdmin, target, UNFINISHED_REASON);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      reenrolment_grant_issued: true,
      coalesced: false,
      sessions_terminated: 1,
    });
    const factors = await factorsOf(target.identity.id);
    expect(factors).toEqual([
      expect.objectContaining({
        id: stranded.id,
        status: 'REVOKED',
        revoked_by: staffAdmin.identity.id,
      }),
    ]);
    expect(factors[0]?.revocation_episode_id).not.toBeNull();
    const grants = await grantsOf(target.identity.id);
    const byId = new Map(grants.map((grant) => [grant.id, grant]));
    expect(byId.get(lapsed.id)?.state).toBe('EXPIRED');
    expect(byId.get(consumed.id)?.state).toBe('CONSUMED');
    const fresh = grants.find((grant) => grant.purpose === 'MFA_REENROLMENT');
    expect(fresh).toMatchObject({
      state: 'PENDING',
      episode_id: factors[0]?.revocation_episode_id,
      supersedes_grant_id: null,
    });
    const events = await resetEvents(target.identity.id);
    expect(events[0]).toMatchObject({
      previous_state: 'STRANDED_ENROLMENT',
      resulting_state: 'ISSUED',
      reason_code: 'MFA_ENROLMENT_EXPIRED',
    });
    expect(events[0]?.related_ids).toMatchObject({
      revoked_factor_id: stranded.id,
      new_grant_id: fresh?.id,
      superseded_grant_ids: [],
    });
    expect(events[0]?.before_after).toEqual({
      reenrolment_grant: { before: 'NONE', after: 'PENDING' },
      mfa_factor: { before: 'PENDING', after: 'REVOKED' },
    });
  });

  /**
   * An identity whose factor an administrator revoked in an earlier reset and whose re-enrolment grant lapsed: the unfinished reset. The
   * earlier grant's lifetime has passed in every case; `EXPIRED` is what a request ends it as, and `PENDING` leaves it as it is between the
   * clock reaching its expiry and anything ending it (the arrangement F05 of 23 October 2026 is about).
   */
  async function unfinishedWith(
    grantState: 'PENDING' | 'EXPIRED',
  ): Promise<{ target: Actor; episode: string; admin: Actor; earlierId: string }> {
    const staffAdmin = await routes.platformAdmin();
    const target = await privilegedTarget();
    const factor = await withActiveFactor(target);
    const episode = randomUUID();
    const earlier = await insertGrant(
      routes.admin,
      grantRow({
        principalId: target.identity.id,
        purpose: 'MFA_REENROLMENT',
        episodeId: episode,
        issuedBy: staffAdmin.identity.id,
      }),
    );
    await routes.admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = now(), revoked_by = $2, revocation_reason_code = 'MFA_AUTHENTICATOR_UNAVAILABLE', revocation_episode_id = $3 where id = $1`,
      [factor.id, staffAdmin.identity.id, episode],
    );
    await lapse(earlier.id);
    if (grantState === 'EXPIRED') await setGrantState(routes.admin, earlier.id, 'EXPIRED');
    return { target, episode, admin: staffAdmin, earlierId: earlier.id };
  }
  const unfinished = () => unfinishedWith('EXPIRED');

  type MessageState = 'QUEUED' | 'LEASED' | 'RETRYABLE';
  /**
   * A message of a grant, in a state a live message can be in, with a deadline of its own `deadlineMinutes` from now (a negative number: a
   * deadline that has passed, with the message created before it). The arrangement is the administrator's, with the table's triggers set
   * aside for the one statement: the worker is what moves a real message through these states.
   */
  async function queueMessage(
    grantId: string,
    principalId: string,
    state: MessageState,
    deadlineMinutes: number,
  ): Promise<void> {
    const created = Math.min(-1, deadlineMinutes - 1);
    await routes.admin.query('alter table credential_delivery_job disable trigger user');
    try {
      await routes.admin.query(
        `insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type, principal_id, channel, state,
                                              attempt_count, next_attempt_at, expires_at, lease_owner, lease_version, lease_expires_at, outcome_class,
                                              provider_dedupe_id, payload_ciphertext, payload_nonce, payload_key_version, payload_envelope_version, created_at)
         values (gen_random_uuid(), 'MFA_REENROLMENT', 'SETUP_GRANT', $1, 'STAFF', $2, 'EMAIL', $3,
                 case when $3 = 'QUEUED' then 0 else 1 end, clock_timestamp(), clock_timestamp() + make_interval(mins => $4::int),
                 case when $3 = 'LEASED' then 'test-worker' end, case when $3 = 'QUEUED' then 0 else 1 end,
                 case when $3 = 'LEASED' then clock_timestamp() + interval '1 minute' end, case when $3 = 'RETRYABLE' then 'UNKNOWN' end,
                 gen_random_uuid()::text, $5, $6, 1, 1, clock_timestamp() + make_interval(mins => $7::int))`,
        [
          grantId,
          principalId,
          state,
          deadlineMinutes,
          Buffer.alloc(40, 7),
          Buffer.alloc(12, 3),
          created,
        ],
      );
    } finally {
      await routes.admin.query('alter table credential_delivery_job enable trigger user');
    }
  }

  // Break caught: an unfinished reset refused because it has no factor to revoke; a new episode where the old one should go on; a
  // predecessor that expired named as superseded.
  it('goes on in the episode of the reset it finishes, with no factor to revoke, and names no expired predecessor', async () => {
    const { target, episode, admin: staffAdmin } = await unfinished();
    expect(await stateOf(staffAdmin, target.identity.id)).toBe('ENROLMENT_UNFINISHED');

    const response = await resetting(staffAdmin, target, UNFINISHED_REASON);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ reenrolment_grant_issued: true, coalesced: false });
    const grants = await grantsOf(target.identity.id);
    expect(grants.map((grant) => [grant.purpose, grant.state, grant.episode_id])).toEqual([
      ['MFA_REENROLMENT', 'EXPIRED', episode],
      ['MFA_REENROLMENT', 'PENDING', episode],
    ]);
    expect(grants[1]?.supersedes_grant_id).toBeNull();
    const factors = await factorsOf(target.identity.id);
    expect(factors).toHaveLength(1);
    expect(factors[0]?.revocation_episode_id).toBe(episode);
    const events = await resetEvents(target.identity.id);
    expect(events[0]).toMatchObject({
      previous_state: 'UNFINISHED_RESET',
      resulting_state: 'ISSUED',
    });
    expect(events[0]?.related_ids).not.toHaveProperty('revoked_factor_id');
    expect(events[0]?.before_after).toEqual({
      reenrolment_grant: { before: 'NONE', after: 'PENDING' },
    });
  });

  // Break caught (AC-SLICE-000-119): a request made while a usable grant or a pending delivery attempt exists issuing a second grant.
  it('coalesces a request made while a usable grant exists: it returns that grant’s expiry and issues and queues nothing', async () => {
    const { target, episode, admin: staffAdmin } = await unfinished();
    const first = await resetting(staffAdmin, target, UNFINISHED_REASON);
    expect(first.status).toBe(200);
    const issued = (await grantsOf(target.identity.id)).at(-1);
    const jobsBefore = await jobsOf(target.identity.id);

    const again = await resetting(staffAdmin, target, UNFINISHED_REASON);

    expect(again.status).toBe(200);
    expect(again.json()).toMatchObject({
      sessions_terminated: 0,
      reenrolment_grant_issued: false,
      coalesced: true,
    });
    expect((again.json() as { grant_expires_at: string }).grant_expires_at).toBe(
      (first.json() as { grant_expires_at: string }).grant_expires_at,
    );
    expect(await grantsOf(target.identity.id)).toHaveLength(2);
    expect(await jobsOf(target.identity.id)).toEqual(jobsBefore);
    const events = await resetEvents(target.identity.id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      previous_state: 'UNFINISHED_RESET',
      resulting_state: 'COALESCED',
      before_after: null,
    });
    expect(events[1]?.related_ids).toEqual({ episode_id: episode, superseded_grant_ids: [] });
    expect(issued?.state).toBe('PENDING');
  });

  // F05 of 23 October 2026. The rule a repeated request is judged by (state-machines.md section 18, AC-SLICE-000-119): a request coalesces
  // while a re-enrolment grant is **usable** (PENDING and not past its expiry on the database's clock) or while a **qualifying delivery**
  // is pending: a message of a grant that is still PENDING, queued, leased or waiting to be retried, and still within its own deadline.
  // A message past its deadline, or one of a grant that has ended, qualifies for nothing: it never keeps a reset coalescing.

  // Break caught: a usable grant no longer coalescing, or one that needed a message beside it.
  it('coalesces on a usable grant alone, with no message at all', async () => {
    const usableOnly = await unfinished();
    const usable = await insertGrant(
      routes.admin,
      grantRow({
        principalId: usableOnly.target.identity.id,
        purpose: 'MFA_REENROLMENT',
        episodeId: usableOnly.episode,
        issuedBy: usableOnly.admin.identity.id,
      }),
    );
    const grantsBefore = await grantsOf(usableOnly.target.identity.id);

    const response = await resetting(usableOnly.admin, usableOnly.target, UNFINISHED_REASON);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      reenrolment_grant_issued: false,
      coalesced: true,
      sessions_terminated: 0,
    });
    expect(await grantsOf(usableOnly.target.identity.id)).toEqual(grantsBefore);
    expect(await jobsOf(usableOnly.target.identity.id)).toEqual([]);
    expect(
      (await grantsOf(usableOnly.target.identity.id)).find((grant) => grant.id === usable.id)
        ?.state,
    ).toBe('PENDING');
  });

  // Break caught: a qualifying delivery no longer coalescing on its own (the clause dropped, or a state of a live message left out of the
  // list), which would issue a second link while the first is still on its way.
  it.each(['QUEUED', 'LEASED', 'RETRYABLE'] as const)(
    'coalesces on a %s message alone, of a grant that is still pending and has passed its expiry, and changes nothing',
    async (state) => {
      const arranged = await unfinishedWith('PENDING');
      await queueMessage(arranged.earlierId, arranged.target.identity.id, state, 30);
      const grantsBefore = await grantsOf(arranged.target.identity.id);
      const jobsBefore = await jobsOf(arranged.target.identity.id);

      const response = await resetting(arranged.admin, arranged.target, UNFINISHED_REASON);

      expect(response.status).toBe(200);
      expect(response.json()).toMatchObject({
        reenrolment_grant_issued: false,
        coalesced: true,
        sessions_terminated: 0,
      });
      expect(await grantsOf(arranged.target.identity.id)).toEqual(grantsBefore);
      expect(await jobsOf(arranged.target.identity.id)).toEqual(jobsBefore);
      expect(grantsBefore[0]?.state).toBe('PENDING');
    },
  );

  // Break caught: the deadline of the message not being read, so that a message nobody will ever send keeps a reset coalescing for ever.
  it.each(['QUEUED', 'LEASED', 'RETRYABLE'] as const)(
    'does not coalesce on a %s message that is past its own deadline: the grant it carries ends as expired and a new one is issued in the episode',
    async (state) => {
      const arranged = await unfinishedWith('PENDING');
      await queueMessage(arranged.earlierId, arranged.target.identity.id, state, -60);

      const response = await resetting(arranged.admin, arranged.target, UNFINISHED_REASON);

      expect(response.status).toBe(200);
      expect(response.json()).toMatchObject({
        reenrolment_grant_issued: true,
        coalesced: false,
      });
      const grants = await grantsOf(arranged.target.identity.id);
      expect(grants.map((grant) => [grant.state, grant.episode_id])).toEqual([
        ['EXPIRED', arranged.episode],
        ['PENDING', arranged.episode],
      ]);
      expect(grants[1]?.supersedes_grant_id).toBeNull();
    },
  );

  // Break caught: the state of the grant not being read, so that a message of a grant that has ended (the arrangement the closeout of S0.37
  // said coalesced) keeps a reset coalescing: the stale-job defect.
  it('does not coalesce on a live message of a grant that has ended, and leaves that grant as it is', async () => {
    const arranged = await unfinishedWith('EXPIRED');
    await queueMessage(arranged.earlierId, arranged.target.identity.id, 'QUEUED', 30);

    const response = await resetting(arranged.admin, arranged.target, UNFINISHED_REASON);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ reenrolment_grant_issued: true, coalesced: false });
    const grants = await grantsOf(arranged.target.identity.id);
    expect(grants.map((grant) => [grant.state, grant.episode_id])).toEqual([
      ['EXPIRED', arranged.episode],
      ['PENDING', arranged.episode],
    ]);
    expect(grants[1]?.supersedes_grant_id).toBeNull();
  });

  // Break caught: an elapsed grant that is still PENDING (nothing has ended it) left as pending when a new grant is issued, or ended as
  // superseded and named as such, which says an administrator replaced a link that had in fact run out.
  it('ends an elapsed pending grant as expired when nothing qualifies, and issues the replacement in the same episode with no supersession of it', async () => {
    const arranged = await unfinishedWith('PENDING');

    const response = await resetting(arranged.admin, arranged.target, UNFINISHED_REASON);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ reenrolment_grant_issued: true, coalesced: false });
    const grants = await grantsOf(arranged.target.identity.id);
    expect(grants).toHaveLength(2);
    expect(grants[0]).toMatchObject({
      id: arranged.earlierId,
      state: 'EXPIRED',
      episode_id: arranged.episode,
    });
    expect(grants[1]).toMatchObject({
      purpose: 'MFA_REENROLMENT',
      state: 'PENDING',
      episode_id: arranged.episode,
      supersedes_grant_id: null,
    });
    const events = await resetEvents(arranged.target.identity.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      previous_state: 'UNFINISHED_RESET',
      resulting_state: 'ISSUED',
    });
    expect(events[0]?.related_ids).toMatchObject({
      new_grant_id: grants[1]?.id,
      superseded_grant_ids: [],
    });
  });

  // Break caught (the other half of the lineage rule): an enrolment continuation that a new grant genuinely replaces no longer ended as
  // superseded and listed. A live re-enrolment grant cannot stand beside a proven factor (the reset that issued it revoked that factor), so
  // the replacement of one is the store's, judged in setup-grant-store.db.test.ts; the table's guard refuses a reissue that names a
  // predecessor of another episode.
  it('still ends a live enrolment continuation as superseded and lists it, naming no predecessor of the new grant', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await privilegedTarget();
    await withActiveFactor(target);
    const continuation = await insertGrant(
      routes.admin,
      grantRow({
        principalId: target.identity.id,
        purpose: 'MFA_ENROLMENT',
        issuedBy: staffAdmin.identity.id,
      }),
    );

    const response = await resetting(staffAdmin, target);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ reenrolment_grant_issued: true, coalesced: false });
    const grants = await grantsOf(target.identity.id);
    expect(grants.find((grant) => grant.id === continuation.id)?.state).toBe('SUPERSEDED');
    const fresh = grants.find(
      (grant) => grant.purpose === 'MFA_REENROLMENT' && grant.state === 'PENDING',
    );
    expect(fresh?.supersedes_grant_id).toBeNull();
    const events = await resetEvents(target.identity.id);
    expect(events[0]?.related_ids).toMatchObject({ superseded_grant_ids: [continuation.id] });
    expect(events[0]?.before_after).toMatchObject({
      superseded_grants: { before: 'PENDING', after: 'SUPERSEDED' },
    });
  });

  // Break caught: two requests made together both issuing (the facts read before the identity lock was held), or the second one failing.
  it('issues one grant for two requests made together: the other coalesces or is refused as stale, and no second grant exists', async () => {
    const arranged = await unfinished();
    const version = await versionOf(arranged.admin, arranged.target.identity.id);

    const [one, two] = await Promise.all([
      reset(arranged.admin, arranged.target.identity.id, version, UNFINISHED_REASON),
      reset(arranged.admin, arranged.target.identity.id, version, UNFINISHED_REASON),
    ]);

    // A stale version is `409 STATE_CONFLICT` (errors-and-enums.md: "Version"); there is no other code for it.
    const statuses = [one.status, two.status].sort();
    expect(statuses.every((status) => status === 200 || status === 409)).toBe(true);
    expect(statuses).toContain(200);
    for (const response of [one, two].filter((each) => each.status === 409)) {
      expect(outcomeOf(response)).toEqual([409, 'STATE_CONFLICT']);
    }
    const issued = [one, two].filter(
      (response) =>
        response.status === 200 &&
        (response.json() as { reenrolment_grant_issued: boolean }).reenrolment_grant_issued,
    );
    expect(issued).toHaveLength(1);
    const pending = (await grantsOf(arranged.target.identity.id)).filter(
      (grant) => grant.purpose === 'MFA_REENROLMENT' && grant.state === 'PENDING',
    );
    expect(pending).toHaveLength(1);
    expect(await jobsOf(arranged.target.identity.id)).toHaveLength(pending.length);
  });

  // Break caught: a stranded factor revoked into a new episode when it was created in one (the lineage of the factor would then name two
  // episodes for one enrolment).
  it('revokes a stranded factor into the episode it was created in, and issues the new grant in it', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await privilegedTarget();
    const episode = randomUUID();
    const parent = await insertGrant(
      routes.admin,
      grantRow({
        principalId: target.identity.id,
        purpose: 'MFA_REENROLMENT',
        episodeId: episode,
        issuedBy: staffAdmin.identity.id,
      }),
    );
    await setGrantState(routes.admin, parent.id, 'CONSUMED');
    await insertFactor(
      routes.admin,
      factorRow(target.identity.id, {
        createdByPurpose: 'MFA_REENROLMENT',
        createdEpisodeId: episode,
      }),
    );

    const response = await resetting(staffAdmin, target, UNFINISHED_REASON);

    expect(response.status).toBe(200);
    const factors = await factorsOf(target.identity.id);
    expect(factors[0]).toMatchObject({ status: 'REVOKED', revocation_episode_id: episode });
    const fresh = (await grantsOf(target.identity.id)).find(
      (grant) => grant.purpose === 'MFA_REENROLMENT' && grant.state === 'PENDING',
    );
    expect(fresh?.episode_id).toBe(episode);
  });

  // Break caught: a stranded bootstrap administrator reset through the API (it is resumed by the provisioning command).
  it('refuses a seeded administrator outside the first state, and resets one with a live factor, each Platform Admin for the other', async () => {
    const first = await routes.actor(BUNDLE_IDS.platformAdmin, null, { origin: 'BOOTSTRAP' });
    const second = await routes.actor(BUNDLE_IDS.platformAdmin, null, { origin: 'BOOTSTRAP' });
    await withActiveFactor(first);
    const stranded = await routes.actor(BUNDLE_IDS.platformAdmin, null, { origin: 'BOOTSTRAP' });
    await insertFactor(
      routes.admin,
      factorRow(stranded.identity.id, { createdByPurpose: 'BOOTSTRAP_SETUP' }),
    );

    const refused = await resetting(second, stranded, UNFINISHED_REASON);
    const reset1 = await resetting(second, first);

    expect(outcomeOf(refused)).toEqual([409, 'STATE_CONFLICT']);
    expect(reset1.status).toBe(200);
    expect((await factorsOf(stranded.identity.id))[0]?.status).toBe('PENDING');
  });
});

describe('what a reset refuses (AC-SLICE-000-37, -119, -132)', () => {
  // Break caught: the absence of a factor taken for eligibility; a non-privileged identity reset; the system's ending of a factor treated
  // as an administrator's.
  it('answers STATE_CONFLICT for an identity with no factor record, one whose latest factor the system ended, and one with no MFA, and changes nothing', async () => {
    const staffAdmin = await routes.platformAdmin();
    const none = await privilegedTarget();
    const system = await privilegedTarget();
    const factor = await withActiveFactor(system);
    await routes.admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = now() where id = $1`,
      [factor.id],
    );
    const ordinary = await routes.opsStaff(HUB_A);

    for (const target of [none, system, ordinary]) {
      expect(await stateOf(staffAdmin, target.identity.id)).toBe('NOT_ELIGIBLE');
      const response = await resetting(staffAdmin, target);
      expect(outcomeOf(response)).toEqual([409, 'STATE_CONFLICT']);
      expect(await grantsOf(target.identity.id)).toEqual([]);
      expect(await jobsOf(target.identity.id)).toEqual([]);
      expect(
        await routes.rows(
          'select 1 from session where principal_id = $1 and terminated_at is null',
          [target.identity.id],
        ),
      ).toHaveLength(1);
    }
  });

  // Break caught: the maker-checker rule missing for a reset, or not last.
  it('refuses a Platform Admin’s reset of their own factor, after the state and the reason', async () => {
    const staffAdmin = await routes.platformAdmin();
    await withActiveFactor(staffAdmin);
    const etag = await versionOf(staffAdmin, staffAdmin.identity.id);

    const own = await reset(staffAdmin, staffAdmin.identity.id, etag);
    const wrongReason = await reset(staffAdmin, staffAdmin.identity.id, etag, UNFINISHED_REASON);

    expect(outcomeOf(own)).toEqual([422, 'SELF_APPROVAL_FORBIDDEN']);
    expect(outcomeOf(wrongReason)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect((await factorsOf(staffAdmin.identity.id))[0]?.status).toBe('ACTIVE');
    expect(await grantsOf(staffAdmin.identity.id)).toEqual([]);
  });

  // Break caught (AC-SLICE-000-132): the branch taken from the client or from mfa_enrolled; a reason of another domain or an empty one.
  it('judges the reason against the branch of the recorded state: the other branch’s reason, an unknown or foreign one is REASON_NOT_ACTIVE, an empty one REASON_REQUIRED', async () => {
    const staffAdmin = await routes.platformAdmin();
    const live = await privilegedTarget();
    await withActiveFactor(live);
    const stranded = await privilegedTarget();
    await insertFactor(routes.admin, factorRow(stranded.identity.id));

    const wrongForLive = await resetting(staffAdmin, live, UNFINISHED_REASON);
    const wrongForStranded = await resetting(staffAdmin, stranded, ACTIVE_FACTOR_REASON);
    const foreign = await resetting(staffAdmin, live, {
      reason_code: 'CREDENTIAL_RECOVERY_ASSISTANCE',
    });
    const unknown = await resetting(staffAdmin, live, { reason_code: 'NO_SUCH_REASON' });
    const empty = await resetting(staffAdmin, live, { reason_code: '' });
    const missing = await resetting(staffAdmin, live, {});

    expect(outcomeOf(wrongForLive)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(outcomeOf(wrongForStranded)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(outcomeOf(foreign)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(outcomeOf(unknown)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(outcomeOf(empty)).toEqual([422, 'REASON_REQUIRED']);
    expect(outcomeOf(missing)).toEqual([400, 'VALIDATION_FAILED']);
    expect((await factorsOf(live.identity.id))[0]?.status).toBe('ACTIVE');
  });

  // Break caught: the note a caller sends never reaching the reason rule, so that a reason whose metadata makes a note mandatory could never
  // be given, or one without it be accepted.
  it('judges the note against a reason that requires one: refused without it, accepted with it', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await privilegedTarget();
    await withActiveFactor(target);
    const code = ACTIVE_FACTOR_REASON.reason_code;

    await routes.admin.query('update reason_code set requires_note = true where code = $1', [code]);
    try {
      const without = await resetting(staffAdmin, target);
      const given = await resetting(staffAdmin, target, {
        ...ACTIVE_FACTOR_REASON,
        note: 'The phone was lost on the bus',
      });

      expect(outcomeOf(without)).toEqual([422, 'REASON_REQUIRED']);
      expect(given.status).toBe(200);
    } finally {
      await routes.admin.query('update reason_code set requires_note = false where code = $1', [
        code,
      ]);
    }
  });

  // Break caught (the adversarial review): the identifier of the path compared with the caller's as text, so that the same identity in upper
  // case slipped past the maker-checker rule of the application and was refused only by a constraint of the table (a 500).
  it('refuses a Platform Admin’s reset of their own factor whatever the case of the identifier in the path', async () => {
    const staffAdmin = await routes.platformAdmin();
    await withActiveFactor(staffAdmin);
    const version = await versionOf(staffAdmin, staffAdmin.identity.id);

    const upper = await reset(staffAdmin, staffAdmin.identity.id.toUpperCase(), version);

    expect(outcomeOf(upper)).toEqual([422, 'SELF_APPROVAL_FORBIDDEN']);
    expect((await factorsOf(staffAdmin.identity.id))[0]?.status).toBe('ACTIVE');
  });

  // Break caught (the race clause of AC-SLICE-000-132): a reset submitted after the factor changed succeeding with the wrong reason.
  it('is STATE_CONFLICT for a stale version, and never a success with the wrong reason for a factor that changed in between', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await privilegedTarget();
    const factor = await withActiveFactor(target);
    const before = await versionOf(staffAdmin, target.identity.id);
    await routes.admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = now() where id = $1`,
      [factor.id],
    );

    const stale = await reset(staffAdmin, target.identity.id, before);
    const fresh = await resetting(staffAdmin, target);
    const missing = await reset(staffAdmin, target.identity.id, undefined);

    expect(outcomeOf(stale)).toEqual([409, 'STATE_CONFLICT']);
    expect(outcomeOf(fresh)).toEqual([409, 'STATE_CONFLICT']);
    expect(outcomeOf(missing)).toEqual([400, 'VALIDATION_FAILED']);
    expect(await grantsOf(target.identity.id)).toEqual([]);
  });

  // Break caught: the version compared before the lock or not at all, which the test above cannot show (the factor it changes also makes
  // the identity ineligible): here only a field of the profile changes, so the version is the only thing that refuses.
  it('is STATE_CONFLICT when the profile changed after the read though its factor did not', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await privilegedTarget();
    const factor = await withActiveFactor(target);
    const before = await versionOf(staffAdmin, target.identity.id);
    await routes.admin.query(
      `update staff_identity set full_name = 'Renamed Since The Read' where id = $1`,
      [target.identity.id],
    );

    const stale = await reset(staffAdmin, target.identity.id, before);

    expect(outcomeOf(stale)).toEqual([409, 'STATE_CONFLICT']);
    expect((await factorsOf(target.identity.id))[0]).toMatchObject({
      id: factor.id,
      status: 'ACTIVE',
    });
    expect(await grantsOf(target.identity.id)).toEqual([]);
    const fresh = await resetting(staffAdmin, target);
    expect(fresh.status).toBe(200);
  });

  // Break caught (AC-SLICE-000-37, -114): the key held by Senior Ops, or checked after the record; an unauthenticated caller; a missing token.
  it('is PERMISSION_DENIED for Senior Ops and Ops Staff, 401 without a session, and CSRF_VALIDATION_FAILED without the token', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await privilegedTarget();
    await withActiveFactor(target);
    const etag = await versionOf(staffAdmin, target.identity.id);
    const senior = await routes.seniorOps(HUB_A);
    const staff = await routes.opsStaff(HUB_A);

    const bySenior = await reset(senior, target.identity.id, etag);
    const byStaff = await reset(staff, target.identity.id, etag);
    const anonymous = await routes.kit.client
      .fork()
      .post(RESET(target.identity.id), ACTIVE_FACTOR_REASON, {
        origin: OPS,
        headers: { 'if-match': etag },
      });
    const noToken = await routes.kit.client
      .fork()
      .post(RESET(target.identity.id), ACTIVE_FACTOR_REASON, {
        origin: OPS,
        csrf: 'omit',
        headers: { 'if-match': etag, cookie: `melarc_session=${staffAdmin.token}` },
      });
    const absent = await reset(staffAdmin, randomUUID(), etag);

    expect(outcomeOf(bySenior)).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcomeOf(byStaff)).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcomeOf(anonymous)[0]).toBe(401);
    expect(outcomeOf(noToken)).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect(outcomeOf(absent)).toEqual([404, 'NOT_FOUND']);
    expect((await factorsOf(target.identity.id))[0]?.status).toBe('ACTIVE');
  });
});

describe('the act is one transaction', () => {
  // Break caught: a reset that keeps the revocation, the sessions or the grant when something after them fails.
  it('leaves the factor, the sessions and the grants as they were when the ledger cannot take an event', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await privilegedTarget();
    await withActiveFactor(target);
    const etag = await versionOf(staffAdmin, target.identity.id);
    const broken = await routes.kit.admin.breakWrites('audit_event');

    const response = await reset(staffAdmin, target.identity.id, etag);
    await broken.mend();

    expect(response.status).toBe(500);
    expect((await factorsOf(target.identity.id))[0]?.status).toBe('ACTIVE');
    expect(await grantsOf(target.identity.id)).toEqual([]);
    expect(await jobsOf(target.identity.id)).toEqual([]);
    expect((await target.client.get(`${API}/auth/session`)).status).toBe(200);
    expect(await resetEvents(target.identity.id)).toEqual([]);
    expect((await reset(staffAdmin, target.identity.id, etag)).status).toBe(200);
  });

  // Break caught (AC-SLICE-000-90's rule for this operation): a message that cannot be queued leaving the factor revoked and the sessions ended.
  it('rolls the whole reset back when the re-enrolment message cannot be queued', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A, {
      workEmail: 'ab<cd>@example.test',
      workEmailCanonical: 'ab<cd>@example.test',
    });
    await withActiveFactor(target);

    const response = await resetting(staffAdmin, target);

    expect(outcomeOf(response)).toEqual([422, 'CREDENTIAL_DELIVERY_FAILED']);
    expect((await factorsOf(target.identity.id))[0]).toMatchObject({
      status: 'ACTIVE',
      revoked_by: null,
      revocation_episode_id: null,
    });
    expect(await grantsOf(target.identity.id)).toEqual([]);
    expect((await target.client.get(`${API}/auth/session`)).status).toBe(200);
    expect(await resetEvents(target.identity.id)).toEqual([]);
  });
});
