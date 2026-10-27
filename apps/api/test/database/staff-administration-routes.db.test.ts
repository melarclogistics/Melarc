import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { changeRoleBundle } from '../../src/platform/authorization/policy-change/policy-change.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { BUNDLE_IDS, GRANTS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { deliveredReader, deliveryKeyEnv } from './support/delivered.js';
import { presenting } from './support/http-sessions.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { assemble, staffPersona, type Machinery } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.36, `createStaffIdentity`, `approveStaffIdentity` and `reissueStaffCredentialSetup` against the real application and a real
 * PostgreSQL (`AC-SLICE-000-06`, `-33`, `-85`, `-86`, `-89`, `-90`, `-116`, `-117`, `-122`, `-129`): the maker's act, the checker's, and the
 * re-issue of the grant that lapsed. Every session is issued by the real protocol for the seeded bundle it holds; every refusal is the
 * contract's code and status; what the application did is read from a second connection and never from its own.
 */
const HUB_A = HUBS[0]?.id ?? '';
const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
const OPS = 'http://127.0.0.1:5173';
const API = '/api/v1';
const STAFF = `${API}/staff-identities`;
const ONE = (id: string) => `${STAFF}/${id}`;
const APPROVE = (id: string) => `${STAFF}/${id}/approve`;
const REISSUE = (id: string) => `${API}/ops/staff/${id}/credential/setup/reissue`;

let database: TestDatabase;
let kit: IntegrationKit;
let built: BuiltService;
let machinery: Machinery;
let admin: pg.Client;
const keys = deliveryKeyEnv();
const deliveredFor = deliveredReader(keys.env);

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [HUB_B]);
  built = buildService(database, { poolMax: 2 });
  machinery = assemble(built);
  kit = await startIntegrationKit(database, {
    poolMax: 4,
    env: keys.keysOnly,
    compiledFixedPolicy: { VENDOR: 1, RIDER: 1 },
    vendorOrganization: () => Promise.resolve('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'),
  });
});

afterAll(async () => {
  await kit.stop();
  await built.close();
  await admin.end();
  await database.drop();
});

interface Actor {
  readonly client: TestClient;
  readonly identity: StaffRow;
  /** The session credential by value, for a request that must present it without the synchronizer token. */
  readonly token: string;
}

/** A staff member of the seeded bundle, in the hub given (or none), holding a session issued by the real protocol. */
async function actor(bundle: string, hub: string | null = HUB_A): Promise<Actor> {
  const persona = await staffPersona(machinery, admin, { roleBundleId: bundle, primaryHubId: hub });
  return {
    client: presenting(kit, persona.issued.token, persona.issued.csrfToken ?? undefined),
    identity: persona.identity,
    token: persona.issued.token,
  };
}
const opsStaff = (hub: string | null = HUB_A) => actor(BUNDLE_IDS.opsStaff, hub);
const seniorOps = (hub: string | null = HUB_A) => actor(BUNDLE_IDS.seniorOps, hub);
const platformAdmin = () => actor(BUNDLE_IDS.platformAdmin, null);

let sequence = 0;
const emailFor = (tag: string): string => {
  sequence += 1;
  return `${tag}-${String(sequence)}-${randomUUID().slice(0, 8)}@example.test`;
};

function profileBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    work_email: emailFor('new'),
    full_name: 'Kofi Boateng',
    role_bundle_id: BUNDLE_IDS.opsStaff,
    primary_hub_id: HUB_A,
    ...overrides,
  };
}

const headersFor = (extra: Record<string, string> = {}) => ({
  origin: OPS,
  headers: { 'idempotency-key': randomUUID(), ...extra },
});

const codeOf = (response: TestResponse): string | undefined =>
  (response.json() as { code?: string }).code;
const outcomeOf = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

interface Identity {
  readonly id: string;
  readonly work_email: string;
  readonly full_name: string;
  readonly phone: string | null;
  readonly status: string;
  readonly role_bundle_id: string;
  readonly primary_hub_id: string | null;
  readonly mfa_enrolled: boolean;
  readonly mfa_reset_state: string;
  readonly created_by: string;
  readonly approved_by: string | null;
}

/** The maker makes a profile; the answer, its id and its ETag. */
async function make(
  maker: Actor,
  overrides: Record<string, unknown> = {},
): Promise<{
  response: TestResponse;
  id: string;
  etag: string | undefined;
  body: Record<string, unknown>;
}> {
  const body = profileBody(overrides);
  const response = await maker.client.post(STAFF, body, headersFor());
  const made = response.status === 200 ? (response.json() as Identity) : undefined;
  return { response, id: made?.id ?? '', etag: response.header('etag') ?? undefined, body };
}

/** The version a reader sees: the ETag a staff-targeted mutation takes back in `If-Match`. */
async function versionOf(reader: Actor, id: string): Promise<string> {
  const response = await reader.client.get(ONE(id));
  expect(response.status).toBe(200);
  const etag = response.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  return etag;
}

const approve = (
  checker: Actor,
  id: string,
  etag: string | undefined,
  body: Record<string, unknown> = { approved: true },
): Promise<TestResponse> =>
  checker.client.post(APPROVE(id), body, {
    origin: OPS,
    headers: etag === undefined ? {} : { 'if-match': etag },
  });

const reissue = (
  officer: Actor,
  id: string,
  etag: string | undefined,
  body: Record<string, unknown> = { reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE' },
): Promise<TestResponse> =>
  officer.client.post(REISSUE(id), body, {
    origin: OPS,
    headers: etag === undefined ? {} : { 'if-match': etag },
  });

/** Makes a catalogue reason require a note for the duration of `work` (the catalogue is the owner's; the test puts it back). */
async function whileRequiringNote<T>(code: string, work: () => Promise<T>): Promise<T> {
  await admin.query('update reason_code set requires_note = true where code = $1', [code]);
  try {
    return await work();
  } finally {
    await admin.query('update reason_code set requires_note = false where code = $1', [code]);
  }
}

type Row = Readonly<Record<string, unknown>>;
const rows = <T extends Row = Row>(text: string, values: unknown[] = []): Promise<T[]> =>
  kit.observe.rows<T>(text, values);

const stored = async (id: string) =>
  (
    await rows<{
      status: string;
      approved_by: string | null;
      created_by: string;
      origin: string;
      credential_generation: string;
      work_email: string;
      work_email_canonical: string;
      phone: string | null;
      primary_hub_id: string | null;
      role_bundle_id: string;
    }>(
      `select status, approved_by, created_by, origin, credential_generation::text, work_email, work_email_canonical, phone,
              primary_hub_id, role_bundle_id from staff_identity where id = $1`,
      [id],
    )
  )[0];

const grantsOf = (id: string) =>
  rows<{
    id: string;
    purpose: string;
    state: string;
    issued_by: string | null;
    supersedes_grant_id: string | null;
    expires_at: Date | null;
  }>(
    `select id, purpose, state, issued_by, supersedes_grant_id, expires_at from setup_grant where principal_id = $1 order by issued_at, id`,
    [id],
  );

const jobsOf = (id: string) =>
  rows<{
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

const eventsOf = (code: string, objectId: string) =>
  rows<{
    actor_id: string | null;
    actor_type: string;
    enhanced: boolean;
    outcome: string;
    reason_code: string | null;
    previous_state: string | null;
    resulting_state: string | null;
    related_ids: Record<string, unknown> | null;
    before_after: Record<string, unknown> | null;
    detail: Record<string, unknown>;
  }>(
    `select actor_id, actor_type, enhanced, outcome, reason_code, previous_state, resulting_state, related_ids, before_after, detail
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );

describe('createStaffIdentity (AC-SLICE-000-33, -116, -117, -129)', () => {
  // Break caught: the operation not reaching a route, answering the wrong shape, or any member of the profile not what the maker sent.
  it('creates a pending profile in the maker’s hub and answers it with an ETag, naming the maker and no checker', async () => {
    const maker = await opsStaff();
    const { response, id, etag, body } = await make(maker, { phone: '+233244123456' });

    expect(response.status).toBe(200);
    const created = response.json() as Identity;
    expect(created).toEqual({
      id,
      work_email: body.work_email,
      full_name: 'Kofi Boateng',
      phone: '+233244123456',
      status: 'PENDING_APPROVAL',
      role_bundle_id: BUNDLE_IDS.opsStaff,
      primary_hub_id: HUB_A,
      mfa_enrolled: false,
      mfa_reset_state: 'NOT_ELIGIBLE',
      created_by: maker.identity.id,
      approved_by: null,
    });
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(await stored(id)).toMatchObject({
      status: 'PENDING_APPROVAL',
      origin: 'MAKER_CHECKER',
      approved_by: null,
      credential_generation: '0',
    });
  });

  // Break caught: the ETag of the creation not the one a later read gives, so that the approver's token would never match.
  it('gives the ETag that the approver’s read of the same profile gives', async () => {
    const maker = await opsStaff();
    const approver = await seniorOps();
    const { id, etag } = await make(maker);

    expect(await versionOf(approver, id)).toBe(etag);
  });

  // Break caught (AC-SLICE-000-33): a password, an mfa_enrolled value, a status or a maker accepted from the request.
  it.each([
    ['a password', { password: 'correct horse battery staple' }],
    ['an mfa_enrolled value', { mfa_enrolled: true }],
    ['a status', { status: 'ACTIVE' }],
    ['a maker', { created_by: randomUUID() }],
    ['an origin', { origin: 'BOOTSTRAP' }],
  ])('refuses a request that carries %s, and creates nothing', async (_name, extra) => {
    const maker = await opsStaff();
    const before = await rows<{ n: string }>('select count(*)::text as n from staff_identity');

    const { response } = await make(maker, extra);

    expect(outcomeOf(response)).toEqual([400, 'VALIDATION_FAILED']);
    expect(await rows<{ n: string }>('select count(*)::text as n from staff_identity')).toEqual(
      before,
    );
  });

  // Break caught: the operation holding no Idempotency-Key, or repeating a command that already succeeded.
  it('answers a repeated key with the original answer, once, and another body under the key with IDEMPOTENCY_KEY_CONFLICT', async () => {
    const maker = await opsStaff();
    const body = profileBody();
    const key = randomUUID();

    const first = await maker.client.post(STAFF, body, {
      origin: OPS,
      headers: { 'idempotency-key': key },
    });
    const again = await maker.client.post(STAFF, body, {
      origin: OPS,
      headers: { 'idempotency-key': key },
    });
    const different = await maker.client.post(
      STAFF,
      { ...body, full_name: 'Someone Else' },
      { origin: OPS, headers: { 'idempotency-key': key } },
    );

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.text).toBe(first.text);
    expect(again.header('etag')).toBe(first.header('etag'));
    expect(outcomeOf(different)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    expect(
      await rows('select 1 from staff_identity where work_email = $1', [body.work_email]),
    ).toHaveLength(1);
    expect(await eventsOf('staff.identity.created', (first.json() as Identity).id)).toHaveLength(1);
  });

  it('refuses a request without an Idempotency-Key', async () => {
    const maker = await opsStaff();
    const response = await maker.client.post(STAFF, profileBody(), { origin: OPS });
    expect(outcomeOf(response)).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught (AC-SLICE-000-129): the work email compared as typed, or folded beyond the canonical form.
  it('holds a work email to its canonical form, stores it as entered, and folds neither dots nor plus-tags', async () => {
    const maker = await opsStaff();
    const local = `Ama.Mensah.${randomUUID().slice(0, 8)}`;
    const first = await make(maker, { work_email: `${local}@Example.COM` });
    const second = await make(maker, { work_email: `${local.toLowerCase()}@example.com` });
    const third = await make(maker, { work_email: `${local.toLowerCase()}+ops@example.com` });
    const padded = await make(maker, {
      work_email: ` Kofi.Boateng.${randomUUID().slice(0, 8)}@Example.COM `,
    });

    expect(first.response.status).toBe(200);
    expect((first.response.json() as Identity).work_email).toBe(`${local}@Example.COM`);
    expect((await stored(first.id))?.work_email_canonical).toBe(
      `${local.toLowerCase()}@example.com`,
    );
    expect(outcomeOf(second.response)).toEqual([422, 'WORK_EMAIL_IN_USE']);
    expect(third.response.status).toBe(200);
    expect(padded.response.status).toBe(200);
    expect((await stored(padded.id))?.work_email_canonical).toBe(
      (padded.body.work_email as string).trim().toLowerCase(),
    );
  });

  // Break caught: a value that is not an address, a name, or a phone number reaching the table.
  it.each([
    ['an address that is not one once canonicalised', { work_email: '   not an address   ' }],
    ['an address with no domain dot', { work_email: 'kofi@localhost' }],
    // An address the canonical form accepts but no message can be sent to: the profile would never be approvable (the adversarial review).
    ['an address with a trailing semicolon', { work_email: 'kofi.boateng@example.com;' }],
    ['an address with a comma', { work_email: 'kofi,boateng@example.com' }],
    ['an address with quotation marks', { work_email: '"kofi"@example.com' }],
    [
      'an address with a full-width at sign',
      { work_email: `kofi${String.fromCharCode(0xff20)}example.com` },
    ],
    ['a blank name', { full_name: '   ' }],
    [
      'a name with a NUL byte, which the table cannot store',
      { full_name: 'Kofi' + String.fromCharCode(0) + 'Boateng' },
    ],
    ['a name with a line break', { full_name: 'Kofi\nBoateng' }],
    ['a name with a right-to-left override', { full_name: 'Kofi\u202EBoateng' }],
    ['a name with a bidirectional isolate', { full_name: 'Kofi\u2066Boateng' }],
    ['a name with a line separator', { full_name: 'Kofi\u2028Boateng' }],
    ['a name with a paragraph separator', { full_name: 'Kofi\u2029Boateng' }],
    ['a name with a zero-width space', { full_name: 'Kofi\u200BBoateng' }],
    ['a name with a word joiner', { full_name: 'Kofi\u2060Boateng' }],
    ['a name with a byte order mark', { full_name: 'Kofi\uFEFFBoateng' }],
    [
      'a name with an escape character',
      { full_name: 'Kofi' + String.fromCharCode(27) + '[31mBoateng' },
    ],
    ['a phone number that is not E.164', { phone: '0244123456' }],
    ['a bundle that does not exist', { role_bundle_id: randomUUID() }],
    ['the fixed Rider bundle', { role_bundle_id: BUNDLE_IDS.rider }],
    ['the fixed Vendor bundle', { role_bundle_id: BUNDLE_IDS.vendor }],
  ])('refuses %s with VALIDATION_FAILED', async (_name, overrides) => {
    const maker = await opsStaff();
    const { response } = await make(maker, overrides);
    expect(outcomeOf(response)).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught (AC-SLICE-000-117): a privileged bundle refused, or granting anything, to the maker who names it.
  it('lets a maker name a privileged bundle and grants nothing: the profile is pending and cannot sign in', async () => {
    const maker = await seniorOps();
    const { response, id } = await make(maker, { role_bundle_id: BUNDLE_IDS.platformAdmin });

    expect(response.status).toBe(200);
    expect((response.json() as Identity).status).toBe('PENDING_APPROVAL');
    expect(await grantsOf(id)).toEqual([]);
    expect(await rows('select 1 from session where principal_id = $1', [id])).toEqual([]);
  });

  // Break caught: a maker placing a profile in a hub it does not act in; a scoped maker leaving the hub out.
  it('places a profile only in the maker’s hubs; an all-hub maker may name any hub or none', async () => {
    const scoped = await opsStaff(HUB_A);
    const admin1 = await platformAdmin();

    const elsewhere = await make(scoped, { primary_hub_id: HUB_B });
    const hubless = await make(scoped, { primary_hub_id: undefined });
    const anywhere = await make(admin1, { primary_hub_id: HUB_B });
    const none = await make(admin1, { primary_hub_id: undefined });

    expect(outcomeOf(elsewhere.response)).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(outcomeOf(hubless.response)).toEqual([400, 'VALIDATION_FAILED']);
    expect(anywhere.response.status).toBe(200);
    expect((await stored(anywhere.id))?.primary_hub_id).toBe(HUB_B);
    expect(none.response.status).toBe(200);
    expect((await stored(none.id))?.primary_hub_id).toBeNull();
    const nonexistentHub = await make(admin1, { primary_hub_id: randomUUID() });
    expect(outcomeOf(nonexistentHub.response)).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught (AC-SLICE-000-116): a role without the key allowed to make a profile; an anonymous caller; a missing token.
  it('refuses a caller without the key, one with no session, and a request without the synchronizer token', async () => {
    const finance = await actor(BUNDLE_IDS.finance, HUB_A);
    const maker = await opsStaff();

    const noKey = await finance.client.post(STAFF, profileBody(), headersFor());
    const anonymous = await kit.client.fork().post(STAFF, profileBody(), headersFor());
    const noToken = await kit.client.fork().post(STAFF, profileBody(), {
      csrf: 'omit',
      origin: OPS,
      headers: { 'idempotency-key': randomUUID(), cookie: `melarc_session=${maker.token}` },
    });

    expect(outcomeOf(noKey)).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcomeOf(anonymous)[0]).toBe(401);
    expect(outcomeOf(noToken)).toEqual([403, 'CSRF_VALIDATION_FAILED']);
  });

  // Break caught (the adversarial review): an Idempotency-Key the idempotency record refuses (empty, or with a control character) reaching it
  // inside the transaction and answering 500; the contract bounds only its length.
  it.each([
    ['an empty Idempotency-Key', ''],
    ['an Idempotency-Key with a tab', 'key\twith-a-tab'],
  ])('refuses %s with VALIDATION_FAILED', async (_name, key) => {
    const maker = await opsStaff();
    const response = await maker.client.post(STAFF, profileBody(), {
      origin: OPS,
      headers: { 'idempotency-key': key },
    });
    expect(outcomeOf(response)).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: a Rider’s bearer credential reaching an Ops Portal operation because the contract’s default security names it.
  it('refuses a Rider’s bearer credential, which the contract’s default security names but this operation does not serve', async () => {
    const bearer = await kit.client
      .fork()
      .bearer('not-a-session-credential')
      .post(STAFF, profileBody(), headersFor());

    expect(outcomeOf(bearer)[0]).toBe(401);
  });

  // Break caught: the event missing, at the wrong tier, or under another actor; a grant or a message made at creation.
  it('records the maker’s ordinary event and issues no grant and queues no message', async () => {
    const maker = await opsStaff();
    const { id } = await make(maker);

    const events = await eventsOf('staff.identity.created', id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_id: maker.identity.id,
      actor_type: 'STAFF',
      enhanced: false,
      outcome: 'SUCCEEDED',
      resulting_state: 'PENDING_APPROVAL',
    });
    expect(await grantsOf(id)).toEqual([]);
    expect(await jobsOf(id)).toEqual([]);
  });

  // Break caught: the act not atomic: a profile left behind, or an idempotency record kept, when the ledger cannot take the event.
  it('leaves nothing behind when the event cannot be recorded, and a retry under the key then runs the command', async () => {
    const maker = await opsStaff();
    const body = profileBody();
    const key = randomUUID();
    const broken = await kit.admin.breakWrites('audit_event');

    const refused = await maker.client.post(STAFF, body, {
      origin: OPS,
      headers: { 'idempotency-key': key },
    });
    await broken.mend();

    expect(refused.status).toBe(500);
    expect(
      await rows('select 1 from staff_identity where work_email = $1', [body.work_email]),
    ).toEqual([]);
    const retried = await maker.client.post(STAFF, body, {
      origin: OPS,
      headers: { 'idempotency-key': key },
    });
    expect(retried.status).toBe(200);
  });
});

describe('approveStaffIdentity (AC-SLICE-000-85, -86, -90, -117, -122)', () => {
  // Break caught: the approval not reaching the grant its criterion names, the record not becoming ACTIVE, or the two actors not
  // both on the record and on the event (the exclusion would be unfalsifiable afterwards).
  it('activates the profile the approver read, naming both actors, and issues exactly one grant with one queued message', async () => {
    const maker = await opsStaff();
    const approver = await seniorOps();
    const { id } = await make(maker);
    const etag = await versionOf(approver, id);

    const response = await approve(approver, id, etag);

    expect(response.status).toBe(200);
    const decided = response.json() as Identity;
    expect(decided).toMatchObject({
      id,
      status: 'ACTIVE',
      created_by: maker.identity.id,
      approved_by: approver.identity.id,
      mfa_enrolled: false,
      mfa_reset_state: 'NOT_ELIGIBLE',
    });
    expect(response.header('etag')).toBe(await versionOf(approver, id));
    expect(response.header('etag')).not.toBe(etag);
    expect(await stored(id)).toMatchObject({
      status: 'ACTIVE',
      approved_by: approver.identity.id,
      credential_generation: '0',
    });

    const grants = await grantsOf(id);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      purpose: 'STAFF_CREDENTIAL_SETUP',
      state: 'PENDING',
      issued_by: approver.identity.id,
    });
    const jobs = await jobsOf(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: 'SETUP_GRANT',
      state: 'QUEUED',
      channel: 'EMAIL',
      redemption_record_id: grants[0]?.id,
    });

    const approved = await eventsOf('staff.identity.approved', id);
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      actor_id: approver.identity.id,
      enhanced: true,
      outcome: 'SUCCEEDED',
      previous_state: 'PENDING_APPROVAL',
      resulting_state: 'ACTIVE',
      related_ids: { created_by: maker.identity.id, approved_by: approver.identity.id },
    });
    const issued = await eventsOf('auth.setup_grant.issued', grants[0]?.id ?? '');
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      enhanced: false,
      detail: { purpose: 'STAFF_CREDENTIAL_SETUP', channel: 'EMAIL' },
    });
  });

  // Break caught: the token reaching a response, a log, a row or an event; the message going anywhere but the identity's work email.
  it('puts the token only in the sealed job, and the job’s link on the Ops origin, to the work email and nowhere else', async () => {
    const maker = await opsStaff();
    const approver = await seniorOps();
    const { id, body } = await make(maker);
    const response = await approve(approver, id, await versionOf(approver, id));
    const grants = await grantsOf(id);

    const delivered = await deliveredFor(admin, grants[0]?.id ?? '');

    expect(delivered?.destination).toBe(body.work_email);
    expect(delivered?.link).toMatch(
      /^http:\/\/127\.0\.0\.1:5173\/setup\/credential#token=[A-Za-z0-9_-]{43}$/,
    );
    const token = delivered?.token ?? '';
    expect(response.text).not.toContain(token);
    expect(
      JSON.stringify(
        await rows('select * from audit_event where object_id = $1 or related_ids::text like $2', [
          id,
          `%${grants[0]?.id ?? ''}%`,
        ]),
      ),
    ).not.toContain(token);
    expect(
      JSON.stringify(
        await rows('select id, token_hash from setup_grant where id = $1', [grants[0]?.id]),
      ),
    ).not.toContain(token);
  });

  // Break caught (AC-SLICE-000-85): the maker approving their own profile; and the order of refusal: a stale token before the rule.
  it('refuses the maker’s own approval last: SELF_APPROVAL_FORBIDDEN, after a stale ETag has been STATE_CONFLICT', async () => {
    const maker = await seniorOps();
    const { id, etag } = await make(maker);

    const stale = await approve(maker, id, '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"');
    const own = await approve(maker, id, etag);

    expect(outcomeOf(stale)).toEqual([409, 'STATE_CONFLICT']);
    expect(outcomeOf(own)).toEqual([422, 'SELF_APPROVAL_FORBIDDEN']);
    expect((await stored(id))?.status).toBe('PENDING_APPROVAL');
    expect(await grantsOf(id)).toEqual([]);
    expect(await jobsOf(id)).toEqual([]);
  });

  // Break caught (the owner's decision of 25 October 2026): the maker-checker rule refusing a Platform Admin the profile they made, so that
  // the highest authority has to ask a colleague; or admitting them for some roles only. The rule is the tier of the grant that
  // authorizes the act (P), never a role's name; the audit event keeps both ids, which here are one.
  it('lets a Platform Admin approve a profile they made, whatever its role, with no second person', async () => {
    const staffAdmin = await platformAdmin();
    const ordinary = await make(staffAdmin);
    const privileged = await make(staffAdmin, { role_bundle_id: BUNDLE_IDS.platformAdmin });

    const first = await approve(staffAdmin, ordinary.id, ordinary.etag);
    const second = await approve(staffAdmin, privileged.id, privileged.etag);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    for (const [answer, id] of [
      [first, ordinary.id],
      [second, privileged.id],
    ] as const) {
      expect(answer.json()).toMatchObject({
        id,
        status: 'ACTIVE',
        created_by: staffAdmin.identity.id,
        approved_by: staffAdmin.identity.id,
      });
      expect(await stored(id)).toMatchObject({
        status: 'ACTIVE',
        created_by: staffAdmin.identity.id,
        approved_by: staffAdmin.identity.id,
      });
      expect(await grantsOf(id)).toHaveLength(1);
      expect(await jobsOf(id)).toHaveLength(1);
      const events = await eventsOf('staff.identity.approved', id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor_id: staffAdmin.identity.id,
        related_ids: { created_by: staffAdmin.identity.id, approved_by: staffAdmin.identity.id },
      });
    }
  });

  it('lets a Platform Admin reject a profile they made, with a reason', async () => {
    const staffAdmin = await platformAdmin();
    const { id, etag } = await make(staffAdmin);

    const rejected = await approve(staffAdmin, id, etag, {
      approved: false,
      reason_code: 'STAFF_CREATION_NOT_AUTHORISED',
    });

    expect(rejected.status).toBe(200);
    expect(rejected.json()).toMatchObject({
      status: 'REJECTED',
      approved_by: staffAdmin.identity.id,
    });
    expect(await grantsOf(id)).toEqual([]);
  });

  // Break caught: the exemption widened to the maker's key or to the profile's role: it is the acting grant's tier. A Senior Ops
  // member (the approval at tier S) who made a profile is refused, for an ordinary bundle and for a rejection as for an approval.
  it('still refuses a maker whose grant is below the Platform Admin tier, for an approval and for a rejection', async () => {
    const maker = await seniorOps();
    const { id, etag } = await make(maker);

    const approved = await approve(maker, id, etag);
    const rejected = await approve(maker, id, etag, {
      approved: false,
      reason_code: 'STAFF_CREATION_NOT_AUTHORISED',
    });

    expect(outcomeOf(approved)).toEqual([422, 'SELF_APPROVAL_FORBIDDEN']);
    expect(outcomeOf(rejected)).toEqual([422, 'SELF_APPROVAL_FORBIDDEN']);
    expect((await stored(id))?.status).toBe('PENDING_APPROVAL');
    expect(await grantsOf(id)).toEqual([]);
  });

  // Break caught (AC-SLICE-000-85, -117): the tier of the bundle not asked, or asked of the wrong grant.
  it('needs a Platform Admin for a privileged bundle: Senior Ops is INSUFFICIENT_AUTHORITY, Ops Staff PERMISSION_DENIED', async () => {
    const maker = await opsStaff();
    const senior = await seniorOps();
    const staffAdmin = await platformAdmin();
    const other = await platformAdmin();
    const ordinary = await make(maker);
    const privileged = await make(await seniorOps(), { role_bundle_id: BUNDLE_IDS.seniorOps });

    const asSenior = await approve(
      senior,
      privileged.id,
      await versionOf(staffAdmin, privileged.id),
    );
    const asOpsStaff = await approve(
      maker,
      privileged.id,
      await versionOf(staffAdmin, privileged.id),
    );
    const ordinaryBySenior = await approve(
      senior,
      ordinary.id,
      await versionOf(senior, ordinary.id),
    );
    const privilegedByAdmin = await approve(
      staffAdmin,
      privileged.id,
      await versionOf(other, privileged.id),
    );

    expect(outcomeOf(asSenior)).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    expect(outcomeOf(asOpsStaff)).toEqual([403, 'PERMISSION_DENIED']);
    expect(ordinaryBySenior.status).toBe(200);
    expect(privilegedByAdmin.status).toBe(200);
    expect((await stored(privileged.id))?.status).toBe('ACTIVE');
    expect(await grantsOf(privileged.id)).toHaveLength(1);
  });

  // Break caught (AC-SLICE-000-86): a version taken before a later change still approving; a failed sign-in moving the ETag; a missing token.
  it('takes the ETag of the read: a stale one is STATE_CONFLICT, a failed sign-in does not move it, and none is a malformed request', async () => {
    const maker = await opsStaff();
    const approver = await seniorOps();
    const { id } = await make(maker);
    const before = await versionOf(approver, id);

    await admin.query(`update staff_identity set failed_attempt_count = 4 where id = $1`, [id]);
    expect(await versionOf(approver, id)).toBe(before);

    await admin.query(`update staff_identity set full_name = 'Kofi B. Boateng' where id = $1`, [
      id,
    ]);
    const stale = await approve(approver, id, before);
    const missing = await approve(approver, id, undefined);
    const current = await approve(approver, id, await versionOf(approver, id));

    expect(outcomeOf(stale)).toEqual([409, 'STATE_CONFLICT']);
    expect(outcomeOf(missing)).toEqual([400, 'VALIDATION_FAILED']);
    expect(current.status).toBe(200);
  });

  // Break caught: the comparison made before the lock (a token that matched when the request began, then a change committed before the
  // lock was taken); the act proceeding on a version it did not compare.
  it('compares the ETag after taking the identity’s lock: a change committed while the request waited for it is a STATE_CONFLICT', async () => {
    const maker = await opsStaff();
    const approver = await seniorOps();
    const { id } = await make(maker);
    const etag = await versionOf(approver, id);

    // The administrator holds the identity's lock, changes the profile and commits only after the request has been sent.
    await admin.query('begin');
    await admin.query('select 1 from staff_identity where id = $1 for no key update', [id]);
    const pending = approve(approver, id, etag);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await admin.query(
      `update staff_identity set full_name = 'Changed While Waiting' where id = $1`,
      [id],
    );
    await admin.query('commit');
    const response = await pending;

    expect(outcomeOf(response)).toEqual([409, 'STATE_CONFLICT']);
    expect((await stored(id))?.status).toBe('PENDING_APPROVAL');
    expect(await grantsOf(id)).toEqual([]);
  });

  // Break caught: a profile of another hub approved, or told apart from one that does not exist (the existence rule), after the body is read.
  it('answers a profile outside the approver’s hubs HUB_SCOPE_VIOLATION and one that does not exist NOT_FOUND, before the body is read', async () => {
    const approver = await seniorOps(HUB_A);
    const maker = await opsStaff(HUB_A);
    const staffAdmin = await platformAdmin();
    const there = await make(await platformAdmin(), { primary_hub_id: HUB_B });
    const etag = await versionOf(staffAdmin, there.id);
    expect(maker.identity.id).not.toBe('');

    const outside = await approve(approver, there.id, etag, { approved: 'maybe' });
    const missing = await approve(approver, randomUUID(), etag, { approved: 'maybe' });
    const malformed = await approve(staffAdmin, there.id, etag, { approved: 'maybe' });

    expect(outcomeOf(outside)).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(outcomeOf(missing)).toEqual([404, 'NOT_FOUND']);
    expect(outcomeOf(malformed)).toEqual([400, 'VALIDATION_FAILED']);
    expect(outside.text).not.toContain(there.body.work_email as string);
  });

  // Break caught: a decided profile decided again.
  it('refuses to decide a profile that is no longer awaiting approval', async () => {
    const maker = await opsStaff();
    const approver = await seniorOps();
    const { id } = await make(maker);
    await approve(approver, id, await versionOf(approver, id));

    const again = await approve(approver, id, await versionOf(approver, id));

    expect(outcomeOf(again)).toEqual([409, 'STATE_CONFLICT']);
    expect(await grantsOf(id)).toHaveLength(1);
  });

  // Break caught (AC-SLICE-000-122): a rejection with no reason, with a reason of another domain, or that does not release the address.
  it('rejects a pending profile with a reason of its domain, terminally, and releases its work email', async () => {
    const maker = await opsStaff();
    const approver = await seniorOps();
    const { id, body } = await make(maker);
    const etag = await versionOf(approver, id);

    const none = await approve(approver, id, etag, { approved: false });
    const blank = await approve(approver, id, etag, { approved: false, reason_code: '  ' });
    const unknown = await approve(approver, id, etag, {
      approved: false,
      reason_code: 'NO_SUCH_REASON',
    });
    const foreign = await approve(approver, id, etag, {
      approved: false,
      reason_code: 'MFA_ENROLMENT_EXPIRED',
    });
    const inUse = await make(maker, { work_email: body.work_email });
    const rejected = await approve(approver, id, etag, {
      approved: false,
      reason_code: 'STAFF_DETAILS_INCORRECT',
    });
    const reused = await make(maker, { work_email: body.work_email });

    expect(outcomeOf(none)).toEqual([422, 'REASON_REQUIRED']);
    expect(outcomeOf(blank)).toEqual([422, 'REASON_REQUIRED']);
    expect(outcomeOf(unknown)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(outcomeOf(foreign)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(outcomeOf(inUse.response)).toEqual([422, 'WORK_EMAIL_IN_USE']);
    expect(rejected.status).toBe(200);
    expect(rejected.json()).toMatchObject({
      status: 'REJECTED',
      approved_by: approver.identity.id,
    });
    expect(reused.response.status).toBe(200);
    expect(await grantsOf(id)).toEqual([]);
    expect(await jobsOf(id)).toEqual([]);
    const events = await eventsOf('staff.identity.rejected', id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      enhanced: true,
      reason_code: 'STAFF_DETAILS_INCORRECT',
      previous_state: 'PENDING_APPROVAL',
      resulting_state: 'REJECTED',
    });
    const again = await approve(approver, id, await versionOf(approver, id), { approved: true });
    expect(outcomeOf(again)).toEqual([409, 'STATE_CONFLICT']);
  });

  // Break caught: the note a caller sends never reaching the reason rule, so that a reason whose metadata makes a note mandatory could
  // never be given (REASON_REQUIRED whatever was sent), or one without it be accepted.
  it('judges the note against a reason that requires one: refused without it, accepted with it', async () => {
    const maker = await opsStaff();
    const approver = await seniorOps();
    const { id } = await make(maker);
    const etag = await versionOf(approver, id);
    const reject = { approved: false, reason_code: 'STAFF_DETAILS_INCORRECT' };

    await whileRequiringNote('STAFF_DETAILS_INCORRECT', async () => {
      const without = await approve(approver, id, etag, reject);
      const blank = await approve(approver, id, etag, { ...reject, note: '   ' });
      const given = await approve(approver, id, etag, { ...reject, note: 'The surname is wrong' });

      expect(outcomeOf(without)).toEqual([422, 'REASON_REQUIRED']);
      expect(outcomeOf(blank)).toEqual([422, 'REASON_REQUIRED']);
      expect(given.status).toBe(200);
      expect(given.json()).toMatchObject({ status: 'REJECTED' });
    });
  });

  // Break caught (AC-SLICE-000-122): a rejection of a privileged profile at a lower tier. A Platform Admin rejects it, whether the maker
  // or another (the maker needs no second person, the owner's decision of 25 October 2026).
  it('takes the approval’s tier for a rejection: a privileged profile only by a Platform Admin, the maker or another', async () => {
    const maker = await platformAdmin();
    const senior = await seniorOps();
    const other = await platformAdmin();
    const byMakerProfile = await make(maker, { role_bundle_id: BUNDLE_IDS.platformAdmin });
    const byOtherProfile = await make(maker, { role_bundle_id: BUNDLE_IDS.platformAdmin });
    const etag = await versionOf(other, byMakerProfile.id);
    const otherEtag = await versionOf(other, byOtherProfile.id);
    const reject = { approved: false, reason_code: 'STAFF_CREATION_NOT_AUTHORISED' };

    const bySenior = await approve(senior, byMakerProfile.id, etag, reject);
    const byMaker = await approve(maker, byMakerProfile.id, etag, reject);
    const byOther = await approve(other, byOtherProfile.id, otherEtag, reject);

    expect(outcomeOf(bySenior)).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    expect(byMaker.status).toBe(200);
    expect(byOther.status).toBe(200);
    expect((await stored(byMakerProfile.id))?.status).toBe('REJECTED');
    expect((await stored(byOtherProfile.id))?.status).toBe('REJECTED');
  });

  // Break caught (AC-SLICE-000-90): an approval whose message cannot be queued that keeps the decision, the grant or the event.
  it('rolls the whole act back when the message cannot be queued, and succeeds once it can', async () => {
    const maker = await opsStaff();
    const approver = await seniorOps();
    const { id } = await make(maker);
    // An address no message can be queued to (create refuses one now, so the profile is arranged: the application never makes this).
    await admin.query(
      `update staff_identity set work_email = $2, work_email_canonical = $2 where id = $1`,
      [id, `ab<cd>${randomUUID().slice(0, 6)}@example.test`],
    );
    const etag = await versionOf(approver, id);

    const refused = await approve(approver, id, etag);

    expect(outcomeOf(refused)).toEqual([422, 'CREDENTIAL_DELIVERY_FAILED']);
    expect(await versionOf(approver, id)).toBe(etag);
    expect(await stored(id)).toMatchObject({ status: 'PENDING_APPROVAL', approved_by: null });
    expect(await grantsOf(id)).toEqual([]);
    expect(await jobsOf(id)).toEqual([]);
    expect(await eventsOf('staff.identity.approved', id)).toEqual([]);
    expect(
      await rows(
        "select 1 from audit_event where event_code = 'auth.setup_grant.issued' and related_ids->>'principal_id' = $1",
        [id],
      ),
    ).toEqual([]);

    // The address is mended (an arrangement the application never makes), the profile is read again and approved.
    await admin.query(
      `update staff_identity set work_email = $2, work_email_canonical = $2 where id = $1`,
      [id, emailFor('mended')],
    );
    const second = await approve(approver, id, await versionOf(approver, id));
    expect(second.status).toBe(200);
    expect(await grantsOf(id)).toHaveLength(1);
    expect(await jobsOf(id)).toHaveLength(1);
  });

  // Break caught: the act not one transaction: a failure after the decision leaves the profile active with no grant.
  it('leaves nothing behind when a write fails in the middle of the act', async () => {
    const maker = await opsStaff();
    const approver = await seniorOps();
    const { id } = await make(maker);
    const etag = await versionOf(approver, id);
    const broken = await kit.admin.breakWrites('credential_delivery_job');

    const response = await approve(approver, id, etag);
    await broken.mend();

    expect(response.status).toBe(500);
    expect(await stored(id)).toMatchObject({ status: 'PENDING_APPROVAL', approved_by: null });
    expect(await grantsOf(id)).toEqual([]);
    expect(await eventsOf('staff.identity.approved', id)).toEqual([]);
    expect(await versionOf(approver, id)).toBe(etag);
  });
});

describe('reissueStaffCredentialSetup (AC-SLICE-000-89)', () => {
  /** An approved identity whose grant has lapsed unused: the state the operation exists for. */
  async function lapsed(
    bundle: string = BUNDLE_IDS.opsStaff,
  ): Promise<{ id: string; maker: Actor; approver: Actor; first: string }> {
    const maker = await seniorOps();
    const approver = await platformAdmin();
    const { id } = await make(maker, { role_bundle_id: bundle });
    expect((await approve(approver, id, await versionOf(approver, id))).status).toBe(200);
    const first = (await grantsOf(id))[0]?.id ?? '';
    // A grant keeps everything but its state: letting its lifetime pass is the administrator's arrangement, with the table's own triggers
    // set aside for the one statement and set back at once.
    await admin.query('alter table setup_grant disable trigger user');
    try {
      await admin.query(
        `update setup_grant set issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1`,
        [first],
      );
    } finally {
      await admin.query('alter table setup_grant enable trigger user');
    }
    return { id, maker, approver, first };
  }

  // Break caught: no operation reaching the state "ACTIVE with no credential and no usable grant"; the earlier grant staying usable.
  it('issues a fresh grant to the work email, supersedes the earlier one and refuses the earlier token', async () => {
    const { id, approver } = await lapsed();

    const response = await reissue(approver, id, await versionOf(approver, id));

    expect(response.status).toBe(200);
    const view = response.json() as Record<string, unknown>;
    expect(view).toMatchObject({
      principal_type: 'STAFF',
      principal_id: id,
      purpose: 'STAFF_CREDENTIAL_SETUP',
      state: 'PENDING',
      consumed_at: null,
    });
    expect(Object.keys(view).toSorted()).toEqual([
      'consumed_at',
      'expires_at',
      'id',
      'issued_at',
      'principal_id',
      'principal_type',
      'purpose',
      'state',
    ]);
    expect(JSON.stringify(view)).not.toContain('token');
    const grants = await grantsOf(id);
    expect(grants.map((grant) => grant.state)).toEqual(['EXPIRED', 'PENDING']);
    const fresh = grants.at(-1);
    expect(fresh).toMatchObject({ id: view.id, issued_by: approver.identity.id });
    const jobs = await jobsOf(id);
    expect(jobs.at(-1)).toMatchObject({ state: 'QUEUED', redemption_record_id: fresh?.id });
    expect((await deliveredFor(admin, fresh?.id ?? ''))?.link).toMatch(
      /\/setup\/credential#token=/,
    );
    const issuedEvents = await eventsOf('auth.setup_grant.issued', fresh?.id ?? '');
    expect(issuedEvents[0]).toMatchObject({
      reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE',
      enhanced: false,
    });
  });

  // Break caught: the note never reaching the reason rule of a re-issue (see the rejection).
  it('judges the note against a reason that requires one: refused without it, accepted with it', async () => {
    const maker = await seniorOps();
    const approver = await platformAdmin();
    const { id } = await make(maker);
    await approve(approver, id, await versionOf(approver, id));

    await whileRequiringNote('CREDENTIAL_SETUP_LINK_UNUSABLE', async () => {
      const etag = await versionOf(approver, id);
      const reason = { reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE' };
      const without = await reissue(approver, id, etag, reason);
      const given = await reissue(approver, id, etag, { ...reason, note: 'The email bounced' });

      expect(outcomeOf(without)).toEqual([422, 'REASON_REQUIRED']);
      expect(given.status).toBe(200);
    });
  });

  // Break caught: a pending grant that is not superseded by a re-issue: two usable links, the earlier refused only by accident.
  it('supersedes a grant that is still pending, cancels its message and refuses its token at the setup', async () => {
    const maker = await seniorOps();
    const approver = await platformAdmin();
    const { id } = await make(maker);
    await approve(approver, id, await versionOf(approver, id));
    const first = (await grantsOf(id))[0]?.id ?? '';
    const token = (await deliveredFor(admin, first))?.token ?? '';

    const response = await reissue(approver, id, await versionOf(approver, id));

    expect(response.status).toBe(200);
    const grants = await grantsOf(id);
    expect(grants.map((grant) => grant.state)).toEqual(['SUPERSEDED', 'PENDING']);
    expect(grants[1]?.supersedes_grant_id).toBe(first);
    const jobs = await jobsOf(id);
    expect(jobs.map((job) => job.state)).toEqual(['CANCELLED', 'QUEUED']);
    expect(jobs[0]?.payload_erased_at).not.toBeNull();
    const refused = await kit.client
      .fork()
      .post(
        `${API}/auth/staff/setup/credential`,
        { setup_token: token, password: 'correct horse battery staple' },
        { origin: OPS },
      );
    expect(outcomeOf(refused)).toEqual([422, 'SETUP_GRANT_INVALID']);
  });

  // Break caught (AC-SLICE-000-89): an identity that already holds a credential given another onboarding link.
  it('refuses an identity that already holds a credential with STATE_CONFLICT', async () => {
    const { id, approver } = await lapsed();
    await admin.query(
      `update staff_identity set credential_hash = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA', credential_established_at = now(), credential_generation = 1 where id = $1`,
      [id],
    );

    const response = await reissue(approver, id, await versionOf(approver, id));

    expect(outcomeOf(response)).toEqual([409, 'STATE_CONFLICT']);
    expect(await grantsOf(id)).toHaveLength(1);
  });

  // Break caught: a profile that is not approved, or a seeded administrator, given a link to an address nobody verified.
  it('refuses a profile that is not approved, and a seeded administrator, with STATE_CONFLICT', async () => {
    const approver = await platformAdmin();
    const pendingOne = await make(await seniorOps());
    const seeded = await insertStaff(
      admin,
      staffRow({
        origin: 'BOOTSTRAP',
        status: 'ACTIVE',
        roleBundleId: BUNDLE_IDS.platformAdmin,
        primaryHubId: null,
        credentialHash: null,
        credentialEstablishedAt: null,
      }),
    );

    const onPending = await reissue(
      approver,
      pendingOne.id,
      await versionOf(approver, pendingOne.id),
    );
    const onSeeded = await reissue(approver, seeded.id, await versionOf(approver, seeded.id));

    expect(outcomeOf(onPending)).toEqual([409, 'STATE_CONFLICT']);
    expect(outcomeOf(onSeeded)).toEqual([409, 'STATE_CONFLICT']);
    expect(await grantsOf(seeded.id)).toEqual([]);
  });

  // Break caught: the reason not required, or taken from another domain.
  it('requires a reason of its domain: REASON_REQUIRED, REASON_NOT_ACTIVE', async () => {
    const { id, approver } = await lapsed();
    const etag = await versionOf(approver, id);

    const none = await reissue(approver, id, etag, { reason_code: '' });
    const foreign = await reissue(approver, id, etag, { reason_code: 'MFA_ENROLMENT_EXPIRED' });
    const recovery = await reissue(approver, id, etag, {
      reason_code: 'CREDENTIAL_RECOVERY_ASSISTANCE',
    });

    expect(outcomeOf(none)).toEqual([422, 'REASON_REQUIRED']);
    expect(outcomeOf(foreign)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(outcomeOf(recovery)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(await grantsOf(id)).toHaveLength(1);
  });

  // Break caught (AC-SLICE-000-89): the tier of the bundle not asked; a stale version accepted.
  it('needs a Platform Admin for a privileged profile, and the ETag of the read', async () => {
    const { id: privilegedId, approver } = await lapsed(BUNDLE_IDS.seniorOps);
    const senior = await seniorOps();
    const stale = await versionOf(approver, privilegedId);
    await admin.query(`update staff_identity set full_name = 'Renamed' where id = $1`, [
      privilegedId,
    ]);

    const bySenior = await reissue(senior, privilegedId, await versionOf(approver, privilegedId));
    const staleOne = await reissue(approver, privilegedId, stale);
    const ok = await reissue(approver, privilegedId, await versionOf(approver, privilegedId));

    expect(outcomeOf(bySenior)).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    expect(outcomeOf(staleOne)).toEqual([409, 'STATE_CONFLICT']);
    expect(ok.status).toBe(200);
  });

  // Break caught: a Senior Ops re-issuing to an ordinary profile refused for a tier it does not need; Ops Staff allowed.
  it('lets Senior Ops re-issue to an ordinary profile in its hub, and refuses Ops Staff and another hub', async () => {
    const { id } = await lapsed();
    const senior = await seniorOps(HUB_A);
    const elsewhere = await seniorOps(HUB_B);
    const staff = await opsStaff();
    const viewer = await platformAdmin();
    const etag = await versionOf(viewer, id);

    const byStaff = await reissue(staff, id, etag);
    const byOtherHub = await reissue(elsewhere, id, etag);
    const bySenior = await reissue(senior, id, etag);

    expect(outcomeOf(byStaff)).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcomeOf(byOtherHub)).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(bySenior.status).toBe(200);
  });

  // Break caught: a re-issue whose message cannot be queued that leaves the earlier grant superseded.
  it('leaves the earlier grant as it was when the new message cannot be queued', async () => {
    const maker = await seniorOps();
    const approver = await platformAdmin();
    const { id } = await make(maker);
    await approve(approver, id, await versionOf(approver, id));
    await admin.query(
      `update staff_identity set work_email = 'ab<cd>@example.test', work_email_canonical = 'ab<cd>@example.test' where id = $1`,
      [id],
    );
    const before = await grantsOf(id);

    const response = await reissue(approver, id, await versionOf(approver, id));

    expect(outcomeOf(response)).toEqual([422, 'CREDENTIAL_DELIVERY_FAILED']);
    expect(await grantsOf(id)).toEqual(before);
    expect((await jobsOf(id)).map((job) => job.state)).toEqual(['QUEUED']);
  });
});

// Last in the file, because it changes a seeded bundle (and puts it back).
describe('the hubs a session lists (the owner’s decision of 25 October 2026)', () => {
  interface Listed {
    readonly authorized_hub_ids: string[];
    readonly authorized_hubs: { id: string; display_name: string }[];
  }
  const listedFor = async (who: Actor): Promise<Listed> => {
    const response = await who.client.get(`${API}/auth/session`);
    expect(response.status).toBe(200);
    return response.json() as Listed;
  };

  // Break caught: a Platform Admin shown no hub, so that the page cannot offer a primary hub to choose: the grants of the bundle are of
  // the all-hub scope and the session's list of hub ids is empty, which is the authority and stays as it is.
  it('lists every hub there is for a principal whose grants reach all hubs, and leaves the authority list as it was issued', async () => {
    const staffAdmin = await platformAdmin();
    const every = await rows<{ id: string; name: string }>(
      'select id, name from hub order by name, id',
    );

    const view = await listedFor(staffAdmin);

    expect(every.length).toBeGreaterThanOrEqual(2);
    expect(view.authorized_hubs).toEqual(
      every.map((hub) => ({ id: hub.id, display_name: hub.name })),
    );
    expect(view.authorized_hub_ids).toEqual([]);
  });

  // Break caught: the all-hub list given to a principal whose grants are of the own-hub scope.
  it('lists only its own hub for a principal whose grants are hub-scoped', async () => {
    for (const who of [await opsStaff(HUB_A), await seniorOps(HUB_A)]) {
      const view = await listedFor(who);

      expect(view.authorized_hub_ids).toEqual([HUB_A]);
      expect(view.authorized_hubs.map((hub) => hub.id)).toEqual([HUB_A]);
    }
  });
});

describe('the authority a session was issued with (AC-SLICE-000-06)', () => {
  // Break caught (AC-SLICE-000-06): the approval resolving the bundle at read time. A widening made by the S0.27 primitive ends no
  // session and raises the revision: the session issued before it keeps the snapshot it was issued with (own hub), and a session issued
  // after it holds the widened authority (all hubs).
  it('acts on the snapshot the session was issued with, and a bundle changed by the primitive reaches only the sessions issued after', async () => {
    const maker = await platformAdmin();
    const there = await make(maker, { primary_hub_id: HUB_B });
    const before = await seniorOps(HUB_A);
    const etag = await versionOf(maker, there.id);
    const migration = clientFor(database.urlFor(MIGRATION_ROLE));
    await migration.connect();
    const seeded = GRANTS.filter((grant) => grant.bundleId === BUNDLE_IDS.seniorOps).map(
      (grant) => ({
        permissionKey: grant.permissionKey,
        hubScope: grant.hubScope,
        ownershipScope: grant.ownershipScope,
        tier: grant.tier,
      }),
    );
    const widened = seeded.map((grant) => ({
      ...grant,
      hubScope:
        grant.permissionKey === 'staff.identity.approve' || grant.permissionKey === 'staff.read'
          ? ('all' as const)
          : grant.hubScope,
    }));
    try {
      const result = await changeRoleBundle(migration, {
        bundleId: BUNDLE_IDS.seniorOps,
        grants: widened,
        correlationId: 'ac-06-widening',
      });
      expect(result.kind).toBe('ADDITION');
      expect(result.endedSessionIds).toEqual([]);
      const after = await seniorOps(HUB_A);

      const withOldSnapshot = await approve(before, there.id, etag);
      const withNewSnapshot = await approve(after, there.id, await versionOf(after, there.id));

      expect(outcomeOf(withOldSnapshot)).toEqual([403, 'HUB_SCOPE_VIOLATION']);
      expect(withNewSnapshot.status).toBe(200);
      expect((await stored(there.id))?.status).toBe('ACTIVE');
    } finally {
      // The seeded bundle is put back (a reduction, which ends the sessions this test issued after the widening), so that no later
      // test of this file meets a bundle the seed did not make.
      await changeRoleBundle(migration, {
        bundleId: BUNDLE_IDS.seniorOps,
        grants: seeded,
        correlationId: 'ac-06-restored',
      });
      await migration.end();
    }
  });
});
