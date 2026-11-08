import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
 * The corrections of 23 October 2026 to S0.36 and S0.37 (findings F01 to F06), against the real application and a real PostgreSQL, through
 * HTTP as a browser would send it. The plan's section 7.36 records each finding, what was found and what was done.
 */
let routes: StaffRoutes;

beforeAll(async () => {
  routes = await startStaffRoutes();
});

afterAll(async () => {
  await routes.stop();
});

const LIST = `${API}/auth/sessions`;
const NOT_A_UUID = 'not-a-uuid';
const SOME_UUID = '11111111-1111-4111-8111-111111111111';

const list = (officer: Actor, query: string) => officer.client.get(`${LIST}?${query}`);

describe('F03: listSessions asks the tier before the query is validated', () => {
  // Break caught: the tier asked by the use case, after the schema: a caller who holds the key at too low a tier is told what is wrong
  // with their query (and so learns the operation's schema) before they are told they may not (permission-enforcement.md 5.1, step 6).
  it.each([
    ['STAFF', 403, 'INSUFFICIENT_AUTHORITY'],
    ['VENDOR', 403, 'INSUFFICIENT_AUTHORITY'],
  ] as const)(
    'refuses Senior Ops %s sessions as INSUFFICIENT_AUTHORITY even with a principal_id that is not a UUID',
    async (type, status, code) => {
      const senior = await routes.seniorOps(HUB_A);

      const answer = await list(senior, `principal_type=${type}&principal_id=${NOT_A_UUID}`);

      expect(outcomeOf(answer)).toEqual([status, code]);
    },
  );

  // Break caught: the early decision applied to every type, or to none.
  it('serves Senior Ops the rider type: its tier is enough, so the malformed id is the validation answer', async () => {
    const senior = await routes.seniorOps(HUB_A);

    const answer = await list(senior, `principal_type=RIDER&principal_id=${NOT_A_UUID}`);

    expect(outcomeOf(answer)).toEqual([400, 'VALIDATION_FAILED']);
  });

  it.each(['STAFF', 'VENDOR', 'RIDER'])(
    'serves a Platform Admin the %s type: the malformed id is the validation answer',
    async (type) => {
      const admin = await routes.platformAdmin();

      const answer = await list(admin, `principal_type=${type}&principal_id=${NOT_A_UUID}`);

      expect(outcomeOf(answer)).toEqual([400, 'VALIDATION_FAILED']);
    },
  );

  // Break caught: the key checked after the tier, or not at all: a caller who does not hold `staff.read` is told it, whatever the type.
  it('refuses a caller without staff.read as PERMISSION_DENIED, before the tier and the validation', async () => {
    const opsStaff = await routes.opsStaff(HUB_A);

    for (const query of [
      `principal_type=STAFF&principal_id=${NOT_A_UUID}`,
      `principal_type=RIDER&principal_id=${SOME_UUID}`,
      'principal_type=BANANA',
      '',
    ]) {
      expect(outcomeOf(await list(opsStaff, query))).toEqual([403, 'PERMISSION_DENIED']);
    }
  });

  // Break caught: a discriminator the guard cannot read granting authority. A missing, repeated or unknown type is not a type: the
  // caller gets the validation answer for their own query, and never the answer for a type they were not asked about.
  it.each([
    ['missing', `principal_id=${SOME_UUID}`],
    ['empty', `principal_type=&principal_id=${SOME_UUID}`],
    ['unknown', `principal_type=ADMIN&principal_id=${SOME_UUID}`],
    ['in lower case', `principal_type=rider&principal_id=${SOME_UUID}`],
    [
      'repeated, the rider type first',
      `principal_type=RIDER&principal_type=STAFF&principal_id=${SOME_UUID}`,
    ],
    [
      'repeated, the staff type first',
      `principal_type=STAFF&principal_type=RIDER&principal_id=${SOME_UUID}`,
    ],
    ['an object', `principal_type[a]=STAFF&principal_id=${SOME_UUID}`],
  ])('answers the validation of a %s discriminator, and serves nothing', async (_label, query) => {
    const senior = await routes.seniorOps(HUB_A);

    const answer = await list(senior, query);

    expect(outcomeOf(answer)).toEqual([400, 'VALIDATION_FAILED']);
    expect(JSON.stringify(answer.json())).not.toMatch(/items/);
  });

  // Break caught: the floor of an unreadable discriminator being no requirement at all. A session whose grant of the key is held at
  // the lowest tier can be served by no type, and is refused before anything else is said about its query.
  it('refuses a grant held at tier A the same way for a missing, repeated or unknown discriminator', async () => {
    const holder = await routes.seniorOps(HUB_A);
    await routes.admin.query('alter table session disable trigger user');
    try {
      await routes.admin.query(
        `update session set bundle_snapshot = jsonb_set(bundle_snapshot, '{grants}',
           (select jsonb_agg(case when g->>'permission' = 'staff.read' then jsonb_set(g, '{tier}', '"A"') else g end)
              from jsonb_array_elements(bundle_snapshot->'grants') g))
          where id = $1`,
        [holder.sessionId],
      );
    } finally {
      await routes.admin.query('alter table session enable trigger user');
    }

    for (const query of [
      `principal_id=${SOME_UUID}`,
      `principal_type=ADMIN&principal_id=${SOME_UUID}`,
      `principal_type=RIDER&principal_type=STAFF&principal_id=${SOME_UUID}`,
      `principal_type=RIDER&principal_id=${NOT_A_UUID}`,
    ]) {
      expect(outcomeOf(await list(holder, query))).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F04: a note the operation accepted is kept, once, on the event of the act; one it cannot keep is refused to the client first.
// ---------------------------------------------------------------------------------------------------------------------------------

const STAFF = `${API}/staff-identities`;
const APPROVE = (id: string) => `${STAFF}/${id}/approve`;
const REISSUE = (id: string) => `${API}/ops/staff/${id}/credential/setup/reissue`;
const RESET = (id: string) => `${API}/ops/staff/${id}/mfa/reset`;
const REVOKE = (sessionId: string) => `${LIST}/${sessionId}/revoke`;

let sequence = 0;
const uniqueNote = (label: string): string => {
  sequence += 1;
  return `${label} note ${String(sequence)} ${randomUUID().slice(0, 8)}`;
};

/** The maker creates a pending profile and the approver, who may read it, takes its version (an Ops Staff member cannot read a profile). */
async function makeProfile(maker: Actor, reader: Actor): Promise<{ id: string; etag: string }> {
  sequence += 1;
  const made = await maker.client.post(
    STAFF,
    {
      work_email: `note-${String(sequence)}-${randomUUID().slice(0, 8)}@example.test`,
      full_name: 'Kofi Boateng',
      role_bundle_id: BUNDLE_IDS.opsStaff,
      primary_hub_id: HUB_A,
    },
    { origin: OPS, headers: { 'idempotency-key': randomUUID() } },
  );
  expect(made.status).toBe(200);
  const { id } = made.json() as { id: string };
  return { id, etag: await versionOf(reader, id) };
}

const decide = (approver: Actor, id: string, etag: string, body: Record<string, unknown>) =>
  approver.client.post(APPROVE(id), body, { origin: OPS, headers: { 'if-match': etag } });

const eventsWithNote = (note: string) =>
  routes.rows<{ event_code: string; note: string; object_id: string }>(
    'select event_code, note, object_id from audit_event where note = $1 order by recorded_at, id',
    [note],
  );

/** Makes a catalogue reason require a note while `work` runs (the catalogue is the owner's; the test puts it back). */
async function whileRequiringNote<T>(code: string, work: () => Promise<T>): Promise<T> {
  await routes.admin.query('update reason_code set requires_note = true where code = $1', [code]);
  try {
    return await work();
  } finally {
    await routes.admin.query('update reason_code set requires_note = false where code = $1', [
      code,
    ]);
  }
}

/** Makes the ledger refuse the events of one code while `work` runs. */
async function whileLedgerRefuses<T>(eventCode: string, work: () => Promise<T>): Promise<T> {
  await routes.admin.query(`
    create function public.melarc_test_refuse_event() returns trigger language plpgsql as
      $$ begin raise exception 'the event is refused by the test' using errcode = 'P0001'; end $$`);
  await routes.admin.query(`
    create trigger melarc_test_refuse_event before insert on audit_event
      for each row when (new.event_code = '${eventCode}') execute function public.melarc_test_refuse_event()`);
  try {
    return await work();
  } finally {
    await routes.admin.query('drop trigger melarc_test_refuse_event on audit_event');
    await routes.admin.query('drop function public.melarc_test_refuse_event()');
  }
}

/** A note the audit's screening refuses: control characters, an address, a number, too long a text. */
const UNKEEPABLE_NOTES: readonly (readonly [string, string])[] = [
  ['a line break', 'first line\nsecond line'],
  ['a tab', 'column\tcolumn'],
  ['an email address', 'ask kwame@example.test about it'],
  ['an international phone number', 'call +233201234567 first'],
  ['more than 1000 characters', 'x'.repeat(1001)],
];

describe('F04: the note of an operation is kept on its primary event', () => {
  // Break caught: a note judged by the reason rule and then dropped, so that an explanation the operation required (or the caller
  // gave) is nowhere afterwards. Kept once, on the event of the act, not on its side events.
  it('keeps the note of a rejection on staff.identity.rejected, once', async () => {
    const maker = await routes.opsStaff(HUB_A);
    const approver = await routes.seniorOps(HUB_A);
    const { id, etag } = await makeProfile(maker, approver);
    const note = uniqueNote('rejection');

    const rejected = await decide(approver, id, etag, {
      approved: false,
      reason_code: 'STAFF_DETAILS_INCORRECT',
      note,
    });

    expect(rejected.status).toBe(200);
    expect(await eventsWithNote(note)).toEqual([
      { event_code: 'staff.identity.rejected', note, object_id: id },
    ]);
  });

  it('keeps an optional note of an approval on staff.identity.approved, and no note when none was sent', async () => {
    const maker = await routes.opsStaff(HUB_A);
    const approver = await routes.seniorOps(HUB_A);
    const withNote = await makeProfile(maker, approver);
    const without = await makeProfile(maker, approver);
    const note = uniqueNote('approval');

    expect(
      (await decide(approver, withNote.id, withNote.etag, { approved: true, note })).status,
    ).toBe(200);
    expect((await decide(approver, without.id, without.etag, { approved: true })).status).toBe(200);

    expect(await eventsWithNote(note)).toEqual([
      { event_code: 'staff.identity.approved', note, object_id: withNote.id },
    ]);
    const bare = await routes.rows<{ note: string | null }>(
      `select note from audit_event where object_id = $1 and event_code = 'staff.identity.approved'`,
      [without.id],
    );
    expect(bare).toEqual([{ note: null }]);
  });

  it('keeps the note of a re-issue on auth.setup_grant.issued of the new grant, once', async () => {
    const maker = await routes.opsStaff(HUB_A);
    const approver = await routes.seniorOps(HUB_A);
    const { id, etag } = await makeProfile(maker, approver);
    expect((await decide(approver, id, etag, { approved: true })).status).toBe(200);
    const note = uniqueNote('reissue');

    const reissued = await approver.client.post(
      REISSUE(id),
      { reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE', note },
      { origin: OPS, headers: { 'if-match': await versionOf(approver, id) } },
    );

    expect(reissued.status).toBe(200);
    const grantId = (reissued.json() as { id: string }).id;
    expect(await eventsWithNote(note)).toEqual([
      { event_code: 'auth.setup_grant.issued', note, object_id: grantId },
    ]);
  });

  it('keeps the note of a session revocation on the enhanced auth.session.terminated, once', async () => {
    const admin = await routes.platformAdmin();
    const target = await routes.opsStaff(HUB_A);
    const note = uniqueNote('revocation');

    const revoked = await admin.client.post(
      REVOKE(target.sessionId),
      { reason_code: 'SESSION_SECURITY_CONCERN', note },
      { origin: OPS },
    );

    expect(revoked.status).toBe(200);
    expect(await eventsWithNote(note)).toEqual([
      { event_code: 'auth.session.terminated', note, object_id: target.sessionId },
    ]);
  });

  it('keeps the note of a second-factor reset on auth.mfa.reset, once', async () => {
    const admin = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);
    const factor = await insertFactor(routes.admin, factorRow(target.identity.id));
    await activateFactor(routes.admin, factor.id);
    const note = uniqueNote('reset');

    const reset = await admin.client.post(
      RESET(target.identity.id),
      { reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE', note },
      { origin: OPS, headers: { 'if-match': await versionOf(admin, target.identity.id) } },
    );

    expect(reset.status).toBe(200);
    expect(await eventsWithNote(note)).toEqual([
      { event_code: 'auth.mfa.reset', note, object_id: target.identity.id },
    ]);
  });

  // Break caught: a note the operation requires being accepted from a caller who sent none, or a required one that is sent
  // being dropped. The reason decides whether a note is required; with it, the event has it.
  it('requires the note a reason asks for, and keeps the one given', async () => {
    const admin = await routes.platformAdmin();
    const first = await routes.opsStaff(HUB_A);
    const second = await routes.opsStaff(HUB_A);
    const note = uniqueNote('required');
    const body = { reason_code: 'SESSION_SECURITY_CONCERN' };

    await whileRequiringNote('SESSION_SECURITY_CONCERN', async () => {
      const without = await admin.client.post(REVOKE(first.sessionId), body, { origin: OPS });
      const blank = await admin.client.post(
        REVOKE(first.sessionId),
        { ...body, note: '   ' },
        { origin: OPS },
      );
      const given = await admin.client.post(
        REVOKE(second.sessionId),
        { ...body, note },
        { origin: OPS },
      );

      expect(outcomeOf(without)).toEqual([422, 'REASON_REQUIRED']);
      expect(outcomeOf(blank)).toEqual([422, 'REASON_REQUIRED']);
      expect(given.status).toBe(200);
    });
    expect(await eventsWithNote(note)).toHaveLength(1);
  });

  // Break caught: the act standing without the explanation that was required. An event the ledger cannot take fails the act whole.
  it('rolls the act back when the event that carries the note cannot be written', async () => {
    const admin = await routes.platformAdmin();
    const target = await routes.opsStaff(HUB_A);
    const note = uniqueNote('refused ledger');

    const answer = await whileLedgerRefuses('auth.session.terminated', () =>
      admin.client.post(
        REVOKE(target.sessionId),
        { reason_code: 'SESSION_SECURITY_CONCERN', note },
        { origin: OPS },
      ),
    );

    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(await eventsWithNote(note)).toEqual([]);
    const [row] = await routes.rows<{ terminated_at: Date | null }>(
      'select terminated_at from session where id = $1',
      [target.sessionId],
    );
    expect(row?.terminated_at).toBeNull();
  });
});

describe('F04: a note the audit would refuse is refused to the client first (VALIDATION_FAILED, never an unexplained 500)', () => {
  // Break caught: a note that passes the schema and is refused by the audit writer afterwards, which the caller meets as a 500 with
  // no explanation after the act has begun. The refusal is the contract's, names the field, and nothing has changed.
  it.each(UNKEEPABLE_NOTES)('refuses a revocation whose note holds %s', async (_label, note) => {
    const admin = await routes.platformAdmin();
    const target = await routes.opsStaff(HUB_A);

    const answer = await admin.client.post(
      REVOKE(target.sessionId),
      { reason_code: 'SESSION_SECURITY_CONCERN', note },
      { origin: OPS },
    );

    expect(outcomeOf(answer)).toEqual([400, 'VALIDATION_FAILED']);
    expect(JSON.stringify(answer.json())).toContain('/note');
    expect(JSON.stringify(answer.json())).not.toContain(note.slice(0, 12));
    const [row] = await routes.rows<{ terminated_at: Date | null }>(
      'select terminated_at from session where id = $1',
      [target.sessionId],
    );
    expect(row?.terminated_at).toBeNull();
  });

  it.each(UNKEEPABLE_NOTES)(
    'refuses a rejection whose note holds %s, changing nothing',
    async (_label, note) => {
      const maker = await routes.opsStaff(HUB_A);
      const approver = await routes.seniorOps(HUB_A);
      const { id, etag } = await makeProfile(maker, approver);

      const answer = await decide(approver, id, etag, {
        approved: false,
        reason_code: 'STAFF_DETAILS_INCORRECT',
        note,
      });

      expect(outcomeOf(answer)).toEqual([400, 'VALIDATION_FAILED']);
      const [row] = await routes.rows<{ status: string }>(
        'select status from staff_identity where id = $1',
        [id],
      );
      expect(row?.status).toBe('PENDING_APPROVAL');
    },
  );

  it.each(UNKEEPABLE_NOTES)('refuses a re-issue whose note holds %s', async (_label, note) => {
    const maker = await routes.opsStaff(HUB_A);
    const approver = await routes.seniorOps(HUB_A);
    const { id, etag } = await makeProfile(maker, approver);
    expect((await decide(approver, id, etag, { approved: true })).status).toBe(200);
    const grants = await routes.rows('select id from setup_grant where principal_id = $1', [id]);

    const answer = await approver.client.post(
      REISSUE(id),
      { reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE', note },
      { origin: OPS, headers: { 'if-match': await versionOf(approver, id) } },
    );

    expect(outcomeOf(answer)).toEqual([400, 'VALIDATION_FAILED']);
    expect(
      await routes.rows('select id from setup_grant where principal_id = $1', [id]),
    ).toHaveLength(grants.length);
  });

  it.each(UNKEEPABLE_NOTES)(
    'refuses a reset whose note holds %s, changing nothing',
    async (_label, note) => {
      const admin = await routes.platformAdmin();
      const target = await routes.seniorOps(HUB_A);
      const factor = await insertFactor(routes.admin, factorRow(target.identity.id));
      await activateFactor(routes.admin, factor.id);

      const answer = await admin.client.post(
        RESET(target.identity.id),
        { reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE', note },
        { origin: OPS, headers: { 'if-match': await versionOf(admin, target.identity.id) } },
      );

      expect(outcomeOf(answer)).toEqual([400, 'VALIDATION_FAILED']);
      const [row] = await routes.rows<{ status: string }>(
        'select status from mfa_factor where id = $1',
        [factor.id],
      );
      expect(row?.status).toBe('ACTIVE');
    },
  );

  // Break caught: the note judged after the version and the state, so that a caller with a stale version learns of the conflict and not
  // of the malformed body (a malformed body is decided before the version and state checks: openapi.yaml, the four operations).
  it('decides the note before the version: a stale If-Match with an unkeepable note is the validation answer', async () => {
    const maker = await routes.opsStaff(HUB_A);
    const approver = await routes.seniorOps(HUB_A);
    const { id } = await makeProfile(maker, approver);

    const answer = await decide(approver, id, '"stale"', {
      approved: false,
      reason_code: 'STAFF_DETAILS_INCORRECT',
      note: 'ask kwame@example.test',
    });

    expect(outcomeOf(answer)).toEqual([400, 'VALIDATION_FAILED']);
  });

  // The same text is kept as sent when the audit would keep it: a note at the bound, a single line with punctuation and accents.
  it('keeps a note of exactly 1000 characters, and a plain line with accents and punctuation', async () => {
    const admin = await routes.platformAdmin();
    const first = await routes.opsStaff(HUB_A);
    const second = await routes.opsStaff(HUB_A);
    const longest = `${uniqueNote('longest')} `.padEnd(1000, 'y');
    const plain = `Réseau « partagé » (compte n° 7) — vérifié, ok. ${uniqueNote('plain')}`;

    const a = await admin.client.post(
      REVOKE(first.sessionId),
      { reason_code: 'SESSION_SECURITY_CONCERN', note: longest },
      { origin: OPS },
    );
    const b = await admin.client.post(
      REVOKE(second.sessionId),
      { reason_code: 'SESSION_SECURITY_CONCERN', note: plain },
      { origin: OPS },
    );

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await eventsWithNote(longest)).toHaveLength(1);
    expect(await eventsWithNote(plain)).toHaveLength(1);
  });
});
