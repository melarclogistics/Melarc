import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RequestOptions, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { activateFactor, factorRow, insertFactor } from './support/credentials.js';
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
 * An adversarial pass over the operations of S0.36 and S0.37 (the owner's order of 23 October 2026): what two people doing the same thing at
 * the same moment get, what a request that is not a browser's gets, and what must never be found in a record. Each test states the attack
 * and the one thing it must not achieve. They run against the real application and a real PostgreSQL, and read what happened from a
 * second connection.
 */
const STAFF = `${API}/staff-identities`;
const APPROVE = (id: string) => `${STAFF}/${id}/approve`;
const REISSUE = (id: string) => `${API}/ops/staff/${id}/credential/setup/reissue`;
const RESET = (id: string) => `${API}/ops/staff/${id}/mfa/reset`;
const REVOKE = (id: string) => `${API}/auth/sessions/${id}/revoke`;
const LIST = (type: string, id: string) =>
  `${API}/auth/sessions?principal_type=${type}&principal_id=${id}`;

let routes: StaffRoutes;

beforeAll(async () => {
  routes = await startStaffRoutes();
});

afterAll(async () => {
  await routes.stop();
});

const profile = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  work_email: `adversary.${randomUUID()}@example.com`,
  full_name: 'Esi Quaye',
  role_bundle_id: BUNDLE_IDS.opsStaff,
  primary_hub_id: HUB_A,
  ...overrides,
});

const post = (actor: Actor, path: string, body: unknown, headers: Record<string, string> = {}) =>
  actor.client.post(path, body, { origin: OPS, headers });

const creating = (actor: Actor, body: Record<string, unknown>, key: string = randomUUID()) =>
  post(actor, STAFF, body, { 'idempotency-key': key });

const approving = (
  actor: Actor,
  id: string,
  version: string,
  body: Record<string, unknown> = { approved: true },
) => post(actor, APPROVE(id), body, { 'if-match': version });

const resetting = (actor: Actor, id: string, version: string) =>
  post(actor, RESET(id), { reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE' }, { 'if-match': version });

async function pendingProfile(maker: Actor): Promise<string> {
  const made = await creating(maker, profile());
  expect(made.status).toBe(200);
  return (made.json() as { id: string }).id;
}

const grantsOf = (id: string) =>
  routes.rows<{ id: string; purpose: string; state: string }>(
    `select id, purpose, state from setup_grant where principal_id = $1 order by issued_at, id`,
    [id],
  );
const jobsOf = (id: string) =>
  routes.rows<{ id: string; state: string }>(
    `select id, state from credential_delivery_job where principal_id = $1 order by created_at, id`,
    [id],
  );
const eventsOf = (code: string, objectId: string) =>
  routes.rows<{ id: string }>(
    `select id from audit_event where event_code = $1 and object_id = $2`,
    [code, objectId],
  );

describe('two people doing the same thing at the same moment', () => {
  // Attack: two approvers who read the same version approve at once. They must not both succeed, issue two grants or queue two messages.
  it('lets exactly one of two approvers who read the same version approve, and issues one grant and one message', async () => {
    const maker = await routes.opsStaff(HUB_A);
    const first = await routes.seniorOps(HUB_A);
    const second = await routes.seniorOps(HUB_A);
    const id = await pendingProfile(maker);
    const version = await versionOf(first, id);

    const [one, other] = await Promise.all([
      approving(first, id, version),
      approving(second, id, version),
    ]);

    expect([one.status, other.status].toSorted()).toEqual([200, 409]);
    const loser = one.status === 200 ? other : one;
    expect(outcomeOf(loser)).toEqual([409, 'STATE_CONFLICT']);
    expect(await grantsOf(id)).toHaveLength(1);
    expect(await jobsOf(id)).toHaveLength(1);
    expect(await eventsOf('staff.identity.approved', id)).toHaveLength(1);
  });

  // Attack: one approver approves while another rejects. Exactly one decision stands, and what stands is what the winner did.
  it('lets exactly one of an approval and a rejection of the same version stand, and the profile ends as the winner decided', async () => {
    const maker = await routes.opsStaff(HUB_A);
    const approver = await routes.seniorOps(HUB_A);
    const rejector = await routes.seniorOps(HUB_A);
    const id = await pendingProfile(maker);
    const version = await versionOf(approver, id);

    const [approved, rejected] = await Promise.all([
      approving(approver, id, version),
      approving(rejector, id, version, { approved: false, reason_code: 'STAFF_DETAILS_INCORRECT' }),
    ]);

    expect([approved.status, rejected.status].toSorted()).toEqual([200, 409]);
    const stored = await routes.rows<{ status: string; approved_by: string }>(
      'select status, approved_by from staff_identity where id = $1',
      [id],
    );
    if (approved.status === 200) {
      expect(stored[0]).toMatchObject({ status: 'ACTIVE', approved_by: approver.identity.id });
      expect(await grantsOf(id)).toHaveLength(1);
    } else {
      expect(stored[0]).toMatchObject({ status: 'REJECTED', approved_by: rejector.identity.id });
      expect(await grantsOf(id)).toEqual([]);
    }
  });

  // Attack: the same request sent twice at once with one Idempotency-Key. One profile is made, and nobody is told of a server error.
  it('makes one profile for one Idempotency-Key sent twice at once, and answers neither with a server error', async () => {
    const maker = await routes.opsStaff(HUB_A);
    const body = profile();
    const key = randomUUID();

    const answers = await Promise.all([creating(maker, body, key), creating(maker, body, key)]);

    for (const answer of answers) expect(answer.status).toBeLessThan(500);
    const made = await routes.rows<{ id: string }>(
      'select id from staff_identity where work_email_canonical = $1',
      [String(body.work_email).toLowerCase()],
    );
    expect(made).toHaveLength(1);
    for (const answer of answers.filter((each) => each.status === 200)) {
      expect((answer.json() as { id: string }).id).toBe(made[0]?.id);
    }
  });

  // Attack: two makers claim one work email at once under different keys. One wins; the other is told the address is in use.
  it('lets one of two makers who claim the same work email at once have it, and tells the other WORK_EMAIL_IN_USE', async () => {
    const first = await routes.opsStaff(HUB_A);
    const second = await routes.opsStaff(HUB_A);
    const body = profile();

    const [one, other] = await Promise.all([creating(first, body), creating(second, body)]);

    expect([one.status, other.status].toSorted()).toEqual([200, 422]);
    const loser = one.status === 200 ? other : one;
    expect(outcomeOf(loser)).toEqual([422, 'WORK_EMAIL_IN_USE']);
  });

  // Attack: two Platform Admins reset the same factor at once from the same read. One re-enrolment grant is issued, the factor is ended once.
  it('lets one of two resets of the same version stand: one factor revoked, one re-enrolment grant', async () => {
    const first = await routes.platformAdmin();
    const second = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);
    const factor = await insertFactor(routes.admin, factorRow(target.identity.id));
    await activateFactor(routes.admin, factor.id);
    const version = await versionOf(first, target.identity.id);

    const [one, other] = await Promise.all([
      resetting(first, target.identity.id, version),
      resetting(second, target.identity.id, version),
    ]);

    expect([one.status, other.status].toSorted()).toEqual([200, 409]);
    const pending = (await grantsOf(target.identity.id)).filter(
      (grant) => grant.purpose === 'MFA_REENROLMENT' && grant.state === 'PENDING',
    );
    expect(pending).toHaveLength(1);
    expect(await eventsOf('auth.mfa.reset', target.identity.id)).toHaveLength(1);
  });

  // Attack: two administrators revoke one session at once. It ends once, with one event, and neither is told of a server error.
  it('ends a session once when two administrators revoke it at once', async () => {
    const first = await routes.platformAdmin();
    const second = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);
    const reason = { reason_code: 'SESSION_SECURITY_CONCERN' };

    const answers = await Promise.all([
      post(first, REVOKE(target.sessionId), reason),
      post(second, REVOKE(target.sessionId), reason),
    ]);

    for (const answer of answers) expect(answer.status).toBe(200);
    expect(await eventsOf('auth.session.terminated', target.sessionId)).toHaveLength(1);
  });

  // Attack: two re-issues at once. Never two usable links: at most one grant is pending when both have finished.
  it('leaves one pending setup grant when two re-issues run at once', async () => {
    const maker = await routes.seniorOps(HUB_A);
    const first = await routes.platformAdmin();
    const second = await routes.platformAdmin();
    const id = await pendingProfile(maker);
    expect((await approving(first, id, await versionOf(first, id))).status).toBe(200);
    const version = await versionOf(first, id);
    const reason = { reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE' };

    const answers = await Promise.all([
      post(first, REISSUE(id), reason, { 'if-match': version }),
      post(second, REISSUE(id), reason, { 'if-match': version }),
    ]);

    for (const answer of answers) expect(answer.status).toBeLessThan(500);
    const pending = (await grantsOf(id)).filter((grant) => grant.state === 'PENDING');
    expect(pending).toHaveLength(1);
  });
});

describe('a request that is not a browser’s', () => {
  /** The six operations, each with a caller that holds its key at the tier it needs, so that only the transport is in question. */
  async function operations(): Promise<
    {
      name: string;
      actor: Actor;
      send: (actor: Actor, options: RequestOptions) => Promise<TestResponse>;
    }[]
  > {
    const staffAdmin = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);
    const maker = await routes.opsStaff(HUB_A);
    const id = await pendingProfile(maker);
    const withOptions =
      (path: string, body: unknown, headers: Record<string, string>) =>
      (actor: Actor, options: RequestOptions) =>
        actor.client.post(path, body, { ...options, headers: { ...headers, ...options.headers } });
    return [
      {
        name: 'createStaffIdentity',
        actor: staffAdmin,
        send: withOptions(STAFF, profile(), { 'idempotency-key': randomUUID() }),
      },
      {
        name: 'approveStaffIdentity',
        actor: staffAdmin,
        send: withOptions(APPROVE(id), { approved: true }, { 'if-match': '"x"' }),
      },
      {
        name: 'reissueStaffCredentialSetup',
        actor: staffAdmin,
        send: withOptions(
          REISSUE(id),
          { reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE' },
          { 'if-match': '"x"' },
        ),
      },
      {
        name: 'resetStaffMfa',
        actor: staffAdmin,
        send: withOptions(
          RESET(target.identity.id),
          { reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE' },
          { 'if-match': '"x"' },
        ),
      },
      {
        name: 'revokeSession',
        actor: staffAdmin,
        send: withOptions(
          REVOKE(target.sessionId),
          { reason_code: 'SESSION_SECURITY_CONCERN' },
          {},
        ),
      },
    ];
  }

  // Attack: a page of another site, or a script with the cookie and no synchronizer token. Each unsafe operation refuses it first, and
  // changes nothing.
  it('refuses each operation that changes something when the synchronizer token or the Origin is missing or foreign', async () => {
    const failures: string[] = [];
    for (const operation of await operations()) {
      const variants: [string, RequestOptions][] = [
        ['no token', { csrf: 'omit', origin: OPS }],
        ['a wrong token', { csrf: 'not-the-token', origin: OPS }],
        ['a foreign origin', { origin: 'https://evil.example' }],
        ['no origin', { origin: null }],
      ];
      for (const [label, options] of variants) {
        // The session cookie alone, presented by value: the helper that holds the actor’s own token re-applies it to every request.
        const bare: Actor = { ...operation.actor, client: routes.kit.client.fork() };
        const answer = await operation.send(bare, {
          ...options,
          headers: { cookie: `melarc_session=${operation.actor.token}` },
        });
        if (answer.status !== 403) {
          failures.push(`${operation.name}, ${label}: ${String(answer.status)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // Attack: a Rider's bearer credential, or no credential at all. None of the Ops operations takes either.
  it('refuses a rider’s bearer credential and a request with no session on every operation, with 401', async () => {
    const failures: string[] = [];
    for (const operation of await operations()) {
      const anonymous = await operation.send(
        { ...operation.actor, client: routes.kit.client.fork() },
        { origin: OPS },
      );
      const bearer = await operation.send(
        { ...operation.actor, client: routes.kit.client.fork().bearer('not-a-session-credential') },
        { origin: OPS },
      );
      for (const [label, answer] of [
        ['no session', anonymous],
        ['a bearer credential', bearer],
      ] as const) {
        if (answer.status !== 401)
          failures.push(`${operation.name}, ${label}: ${String(answer.status)}`);
      }
    }
    const list = await routes.kit.client.fork().bearer('x').get(LIST('STAFF', randomUUID()));
    expect(list.status).toBe(401);
    expect(failures).toEqual([]);
  });
});

describe('what must never be found in a record', () => {
  // Attack: the setup token read back from anything the application writes besides the sealed message. It is in the message and nowhere else.
  it('leaves the setup token in no audit event, no response and no readable column of the job or the grant', async () => {
    const maker = await routes.opsStaff(HUB_A);
    const approver = await routes.seniorOps(HUB_A);
    const id = await pendingProfile(maker);
    const version = await versionOf(approver, id);

    const approved = await approving(approver, id, version);
    const grant = (await grantsOf(id))[0];
    const delivered = await routes.deliveredFor(routes.admin, grant?.id ?? '');
    const token = delivered?.token ?? '';
    expect(token.length).toBeGreaterThan(20);

    const reissued = await post(
      approver,
      REISSUE(id),
      { reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE' },
      { 'if-match': await versionOf(approver, id) },
    );
    expect(reissued.status).toBe(200);

    const secondToken = (
      await routes.deliveredFor(routes.admin, (await grantsOf(id)).at(-1)?.id ?? '')
    )?.token;
    for (const secret of [token, secondToken ?? '']) {
      expect(approved.text).not.toContain(secret);
      expect(reissued.text).not.toContain(secret);
      const holders = await routes.rows<{ n: string }>(
        `select (select count(*) from audit_event where audit_event::text like '%' || $1 || '%')
              + (select count(*) from setup_grant where setup_grant::text like '%' || $1 || '%')
              + (select count(*) from staff_identity where staff_identity::text like '%' || $1 || '%') as n`,
        [secret],
      );
      expect(holders[0]?.n).toBe('0');
    }
  });
});

describe('what changes between a read and the act that relies on it', () => {
  // Attack: a Senior Ops reads a harmless profile, the profile is given a privileged bundle, and the Senior Ops approves with the version it
  // read. The tier is judged on the profile as it now is, and the version no longer matches: the approval must not stand.
  it('refuses the approval of a profile that was given a privileged bundle after it was read, and issues nothing', async () => {
    const maker = await routes.opsStaff(HUB_A);
    const senior = await routes.seniorOps(HUB_A);
    const id = await pendingProfile(maker);
    const version = await versionOf(senior, id);
    await routes.admin.query('update staff_identity set role_bundle_id = $2 where id = $1', [
      id,
      BUNDLE_IDS.platformAdmin,
    ]);

    const answer = await approving(senior, id, version);

    expect(outcomeOf(answer)).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    const stored = await routes.rows<{ status: string; approved_by: string | null }>(
      'select status, approved_by from staff_identity where id = $1',
      [id],
    );
    expect(stored[0]).toEqual({ status: 'PENDING_APPROVAL', approved_by: null });
    expect(await grantsOf(id)).toEqual([]);
    expect(await jobsOf(id)).toEqual([]);
  });

  // Attack: a re-issue relying on a read taken before the person set their own password. The credential now exists: nothing is issued.
  it('refuses a re-issue read before the credential was established, and issues nothing more', async () => {
    const maker = await routes.seniorOps(HUB_A);
    const approver = await routes.platformAdmin();
    const id = await pendingProfile(maker);
    expect((await approving(approver, id, await versionOf(approver, id))).status).toBe(200);
    const version = await versionOf(approver, id);
    const grantsBefore = await grantsOf(id);
    await routes.admin.query(
      `update staff_identity set credential_hash = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
              credential_established_at = now(), credential_generation = 1 where id = $1`,
      [id],
    );

    const answer = await post(
      approver,
      REISSUE(id),
      { reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE' },
      { 'if-match': version },
    );

    expect(outcomeOf(answer)).toEqual([409, 'STATE_CONFLICT']);
    expect(await grantsOf(id)).toEqual(grantsBefore);
  });
});
