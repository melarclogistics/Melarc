import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import {
  activateFactor,
  factorRow,
  grantRow,
  insertFactor,
  insertGrant,
} from './support/credentials.js';
import { arrangedFixedSession, presenting } from './support/http-sessions.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { assemble, staffPersona, type Machinery } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.35, `listStaffIdentities` and `getStaffIdentity` against the real application and a real PostgreSQL (`AC-SLICE-000-07`, `-30`,
 * `-44`, `-128`): a staff read is row-level security and the scope probe, an authorised read of a record outside the actor's own hub is
 * audited without contents, and the version a read carries is the ETag the staff-targeted mutations will take.
 *
 * A Senior Ops and a Platform Admin session are issued by the real protocol for the seeded bundles. The all-hub `staff.read` of a
 * Platform Admin is what the seed grants it (Product decision, 22 October 2026; `bootstrap-journey.db.test.ts` walks a seeded
 * administrator to it from the bootstrap), so nothing is arranged: no grant is written into a session by hand.
 */
const HUB_A = HUBS[0]?.id ?? '';
const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
const HUB_C = 'c0c0c0c0-0000-4000-8000-00000000000c';
const LIST = '/api/v1/staff-identities';
const ONE = (id: string) => `/api/v1/staff-identities/${id}`;

let database: TestDatabase;
let kit: IntegrationKit;
let built: BuiltService;
let machinery: Machinery;
let admin: pg.Client;
let sequence = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi'), ($2, 'Tamale')`, [
    HUB_B,
    HUB_C,
  ]);
  built = buildService(database, { poolMax: 2 });
  machinery = assemble(built);
  kit = await startIntegrationKit(database, {
    poolMax: 4,
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

/** A target identity with a unique name, so that a list narrowed by `q` holds this test's identities and no other. */
async function target(
  tag: string,
  overrides: Partial<StaffRow> = {},
): Promise<StaffRow & { readonly tag: string }> {
  sequence += 1;
  const row = await insertStaff(
    admin,
    staffRow({ fullName: `${tag} ${String(sequence)}`, ...overrides }),
  );
  return { ...row, tag };
}

/** A fresh tag: a name no other test's identities carry. */
const freshTag = (): string => `Zq${randomUUID().slice(0, 8)}`;

async function seniorOps(
  hub: string | null = HUB_A,
): Promise<{ client: TestClient; identity: StaffRow }> {
  const persona = await staffPersona(machinery, admin, {
    roleBundleId: BUNDLE_IDS.seniorOps,
    primaryHubId: hub,
  });
  return {
    client: presenting(kit, persona.issued.token, persona.issued.csrfToken ?? undefined),
    identity: persona.identity,
  };
}

/** A seeded Platform Admin, issued a session by the real protocol, with the primary hub given (or none, as the bootstrap makes it). */
async function allHubReader(
  hub: string | null,
): Promise<{ client: TestClient; identity: StaffRow }> {
  const persona = await staffPersona(machinery, admin, {
    roleBundleId: BUNDLE_IDS.platformAdmin,
    primaryHubId: hub,
  });
  return {
    client: presenting(kit, persona.issued.token, persona.issued.csrfToken ?? undefined),
    identity: persona.identity,
  };
}

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
interface Page {
  readonly items: Identity[];
  readonly next_page_token: string | null;
}
const codeOf = (response: TestResponse): string | undefined =>
  (response.json() as { code?: string }).code;
const pageOf = (response: TestResponse): Page => {
  expect(response.status).toBe(200);
  return response.json() as Page;
};
const namesOf = (response: TestResponse): string[] =>
  pageOf(response).items.map((item) => item.full_name);

interface Crossing {
  readonly actor_id: string;
  readonly actor_type: string;
  readonly responsible_hub_id: string | null;
  readonly object_type: string;
  readonly object_id: string | null;
  readonly enhanced: boolean;
  readonly outcome: string;
  readonly related_ids: Record<string, unknown> | null;
  readonly before_after: unknown;
  readonly detail: Record<string, unknown>;
}
const crossingsOf = (actor: StaffRow): Promise<Crossing[]> =>
  kit.observe.rows<Crossing>(
    `select actor_id, actor_type, responsible_hub_id, object_type, object_id, enhanced, outcome, related_ids, before_after, detail
       from audit_event where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by recorded_at, id`,
    [actor.id],
  );

describe('reading one identity (AC-SLICE-000-07, AC-SLICE-000-30)', () => {
  // Break caught: the scope of staff.read not applying to a read by id, a record of another hub answered, or answered with its contents.
  it('returns an identity of the actor’s hub, refuses one of another hub with HUB_SCOPE_VIOLATION and none of its contents, and finds nothing for an identifier that matches nothing', async () => {
    const { client } = await seniorOps(HUB_A);
    const here = await target('Here', { primaryHubId: HUB_A });
    const there = await target('There', { primaryHubId: HUB_B });

    const read = await client.get(ONE(here.id));
    const refused = await client.get(ONE(there.id));
    const nothing = await client.get(ONE(randomUUID()));

    expect(read.status).toBe(200);
    expect((read.json() as Identity).id).toBe(here.id);
    expect([refused.status, codeOf(refused)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(refused.text).not.toContain(there.fullName);
    expect(refused.text).not.toContain(there.workEmail);
    expect([nothing.status, codeOf(nothing)]).toEqual([404, 'NOT_FOUND']);
  });

  // Break caught: an existing record with no hub at all answered as a record of another hub (the probe reads a hub and there is none).
  it('answers an identity with no primary hub, outside the actor’s hubs, as NOT_FOUND', async () => {
    const { client } = await seniorOps(HUB_A);
    const hubless = await target('Hubless', { primaryHubId: null });

    const response = await client.get(ONE(hubless.id));

    expect([response.status, codeOf(response)]).toEqual([404, 'NOT_FOUND']);
  });

  // Break caught: the key's check coming after the record is considered (AC-SLICE-000-07: "refused before either record is
  // considered"), so that an Ops Staff user learns by the answer which records exist.
  it('refuses a user who does not hold staff.read PERMISSION_DENIED for both records and for the list', async () => {
    const persona = await staffPersona(machinery, admin, {
      roleBundleId: BUNDLE_IDS.opsStaff,
      primaryHubId: HUB_A,
    });
    const client = presenting(kit, persona.issued.token, persona.issued.csrfToken ?? undefined);
    const here = await target('Here', { primaryHubId: HUB_A });
    const there = await target('There', { primaryHubId: HUB_B });

    for (const path of [ONE(here.id), ONE(there.id), ONE(randomUUID()), LIST]) {
      const response = await client.get(path);
      expect([response.status, codeOf(response)]).toEqual([403, 'PERMISSION_DENIED']);
    }
  });

  // Break caught: a path that is not an identifier looked up, or answered as a record that does not exist.
  it('refuses an identifier that is not a UUID with 400 VALIDATION_FAILED', async () => {
    const { client } = await seniorOps(HUB_A);

    const response = await client.get(ONE('not-a-uuid'));

    expect([response.status, codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: the read carrying a field the contract marks secret, or the shape wandering: exactly the contract's properties, no
  // credential, no failed-attempt count, no lock.
  it('returns the properties of StaffIdentity and no credential, factor or failed-attempt property', async () => {
    const { client } = await seniorOps(HUB_A);
    const row = await target('Shape', { primaryHubId: HUB_A });
    await admin.query(
      "update staff_identity set failed_attempt_count = 3, locked_until = now() + interval '5 minutes' where id = $1",
      [row.id],
    );

    const body = (await client.get(ONE(row.id))).json() as Record<string, unknown>;

    expect(Object.keys(body).toSorted()).toEqual(
      [
        'approved_by',
        'created_by',
        'full_name',
        'id',
        'mfa_enrolled',
        'mfa_reset_state',
        'phone',
        'primary_hub_id',
        'role_bundle_id',
        'status',
        'work_email',
      ].toSorted(),
    );
    expect(body).toMatchObject({
      id: row.id,
      work_email: row.workEmail,
      full_name: row.fullName,
      phone: null,
      status: 'ACTIVE',
      role_bundle_id: row.roleBundleId,
      primary_hub_id: HUB_A,
      mfa_enrolled: false,
      mfa_reset_state: 'NOT_ELIGIBLE',
      created_by: row.createdBy,
      approved_by: row.approvedBy,
    });
  });
});

describe('listing identities (AC-SLICE-000-07, AC-SLICE-000-30)', () => {
  // Break caught: a list that reaches the identities of another hub, whatever the use case's own query says.
  it('returns only the identities of the actor’s hub', async () => {
    const { client } = await seniorOps(HUB_A);
    const tag = freshTag();
    await target(tag, { primaryHubId: HUB_A });
    await target(tag, { primaryHubId: HUB_B });
    await target(tag, { primaryHubId: null });

    const items = pageOf(await client.get(`${LIST}?q=${tag}`)).items;

    expect(items.map((item) => item.primary_hub_id)).toEqual([HUB_A]);
  });

  // Break caught: a filter that widens what the scope allows: the hub filter is checked against the actor's hubs, never trusted.
  it('returns nothing for a hub filter outside the actor’s hubs, and the hub for one inside', async () => {
    const { client } = await seniorOps(HUB_A);
    const tag = freshTag();
    const here = await target(tag, { primaryHubId: HUB_A });
    await target(tag, { primaryHubId: HUB_B });

    expect(namesOf(await client.get(`${LIST}?q=${tag}&hub_id=${HUB_B}`))).toEqual([]);
    expect(namesOf(await client.get(`${LIST}?q=${tag}&hub_id=${HUB_A}`))).toEqual([here.fullName]);
  });

  // Break caught: the approver's queue not being found by status, or a status outside the enumeration being ignored.
  it('narrows by status (the approver’s queue is PENDING_APPROVAL) and refuses a status outside the enumeration', async () => {
    const { client } = await seniorOps(HUB_A);
    const tag = freshTag();
    await target(tag, { primaryHubId: HUB_A });
    const pending = await target(tag, {
      primaryHubId: HUB_A,
      status: 'PENDING_APPROVAL',
      approvedBy: null,
    });

    expect(namesOf(await client.get(`${LIST}?q=${tag}&status=PENDING_APPROVAL`))).toEqual([
      pending.fullName,
    ]);
    const refused = await client.get(`${LIST}?status=ARCHIVED`);
    expect([refused.status, codeOf(refused)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: the search matching on the wrong thing, case-sensitively, or treating the wildcards of the pattern language as
  // wildcards of the search: a percent sign is a percent sign.
  it('matches the name or the work email, ignoring case, and takes a wildcard character literally', async () => {
    const { client } = await seniorOps(HUB_A);
    const tag = freshTag();
    const byName = await target(tag, { primaryHubId: HUB_A });
    const byEmail = await insertStaff(
      admin,
      staffRow({
        fullName: 'Somebody Else',
        workEmail: `${tag.toLowerCase()}-mail@example.test`,
        workEmailCanonical: `${tag.toLowerCase()}-mail@example.test`,
        primaryHubId: HUB_A,
      }),
    );
    await target(`${tag}%`, { primaryHubId: HUB_A });

    const upper = pageOf(await client.get(`${LIST}?q=${tag.toUpperCase()}`)).items.map(
      (item) => item.id,
    );
    const percent = namesOf(await client.get(`${LIST}?q=${encodeURIComponent(`${tag}%`)}`));

    expect(upper).toEqual(expect.arrayContaining([byName.id, byEmail.id]));
    expect(percent).toHaveLength(1);
    expect(percent[0]).toContain('%');
    const wild = await client.get(`${LIST}?q=${encodeURIComponent('%')}`);
    expect(pageOf(wild).items.every((item) => item.full_name.includes('%'))).toBe(true);
  });

  // Break caught: a page that skips or repeats an identity, a last page that promises another, or a token that is not read back.
  it('pages with an opaque token: every identity once, in order, and null on the last page', async () => {
    const { client } = await seniorOps(HUB_A);
    const tag = freshTag();
    const made: string[] = [];
    for (let at = 0; at < 5; at += 1)
      made.push((await target(tag, { primaryHubId: HUB_A })).fullName);

    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const response: TestResponse = await client.get(
        `${LIST}?q=${tag}&page_size=2${token === null ? '' : `&page_token=${encodeURIComponent(token)}`}`,
      );
      const page = pageOf(response);
      seen.push(...page.items.map((item) => item.full_name));
      token = page.next_page_token;
      pages += 1;
    } while (token !== null && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual(made);
  });

  // Break caught: a page boundary that falls between identities created at one and the same moment (a bulk creation in one
  // transaction): the position is the moment with its microseconds and then the id, so none is skipped and none is repeated.
  it('pages identities that share one creation moment: each once, in the order of their ids', async () => {
    const { client } = await seniorOps(HUB_A);
    const tag = freshTag();
    const made: string[] = [];
    await admin.query('begin');
    try {
      for (let at = 0; at < 5; at += 1) made.push((await target(tag, { primaryHubId: HUB_A })).id);
      await admin.query('commit');
    } catch (error) {
      await admin.query('rollback');
      throw error;
    }
    const moments = await admin.query<{ n: string }>(
      `select count(distinct created_at) as n from staff_identity where full_name like $1`,
      [`${tag}%`],
    );

    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const response: TestResponse = await client.get(
        `${LIST}?q=${tag}&page_size=2${token === null ? '' : `&page_token=${encodeURIComponent(token)}`}`,
      );
      const page = pageOf(response);
      seen.push(...page.items.map((item) => item.id));
      token = page.next_page_token;
      pages += 1;
    } while (token !== null && pages < 10);

    expect(moments.rows[0]?.n).toBe('1');
    expect(pages).toBe(3);
    expect(seen).toEqual(made.toSorted());
  });

  // Break caught: a token that is not one reaching SQL or answering a list; a page size outside 1 to 100 answered.
  it.each([
    ['a token that is not one', 'page_token=not-a-token'],
    ['a token that names no position', `page_token=${Buffer.from('[1,2]').toString('base64url')}`],
    [
      'a token with the impossible moment 2026-99-99 29:90:90+99',
      `page_token=${Buffer.from(JSON.stringify(['2026-99-99 29:90:90+99', randomUUID()])).toString('base64url')}`,
    ],
    [
      'a token with a 30th of February',
      `page_token=${Buffer.from(JSON.stringify(['2026-02-30 00:00:00+00', randomUUID()])).toString('base64url')}`,
    ],
    ['a page size of 0', 'page_size=0'],
    ['a page size of 101', 'page_size=101'],
    ['a search longer than 128 characters', `q=${'a'.repeat(129)}`],
  ])('refuses %s with 400 VALIDATION_FAILED', async (_name, query) => {
    const { client } = await seniorOps(HUB_A);

    const response = await client.get(`${LIST}?${query}`);

    expect([response.status, codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: the list carrying an ETag (it is for discovery; the ETag comes from the read of the chosen record).
  it('carries no ETag and writes nothing for a read inside the actor’s hub', async () => {
    const { client, identity } = await seniorOps(HUB_A);
    const tag = freshTag();
    await target(tag, { primaryHubId: HUB_A });

    const response = await client.get(`${LIST}?q=${tag}`);

    expect(response.header('etag')).toBeNull();
    expect(await crossingsOf(identity)).toEqual([]);
  });
});

describe('who is refused (AC-SLICE-000-44)', () => {
  // Break caught: a missing session answered 403 (or a held session without the key 401).
  it('answers 401 SESSION_INVALID with no session, on both reads', async () => {
    const row = await target('Anyone', { primaryHubId: HUB_A });

    for (const path of [LIST, ONE(row.id)]) {
      const response = await kit.client.fork().get(path);
      expect([response.status, codeOf(response)]).toEqual([401, 'SESSION_INVALID']);
    }
  });

  // Break caught: a Vendor reading colleagues' personal data, or a Rider's bearer credential accepted by an Ops-only operation.
  it('answers a Vendor 403 PERMISSION_DENIED and a Rider’s bearer credential 401 SESSION_INVALID', async () => {
    const vendor = await arrangedFixedSession(kit, admin, 'VENDOR');
    const rider = await arrangedFixedSession(kit, admin, 'RIDER');

    const asVendor = await presenting(kit, vendor.token, vendor.csrf).get(LIST);
    const asRider = await kit.client.bearer(rider.token).get(LIST);

    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);
    expect([asRider.status, codeOf(asRider)]).toEqual([401, 'SESSION_INVALID']);
  });
});

describe('a read outside the actor’s own hub is audited once, without contents (AC-SLICE-000-128)', () => {
  // Break caught: a cross-hub read that leaves no trace, one that is written twice, one for a read inside the hub, or one that carries
  // the record's contents; the actor, the hub and a reference to the record are what it holds.
  it('writes one auth.hub_boundary.crossed for each read of a record of another hub and none for a record of the actor’s own', async () => {
    const reader = await allHubReader(HUB_A);
    const other = await allHubReader(HUB_A);
    const inA = await target('Inside', { primaryHubId: HUB_A });
    const inB = await target('Outside', { primaryHubId: HUB_B });

    await reader.client.get(ONE(inB.id));
    await reader.client.get(ONE(inA.id));
    await reader.client.get(ONE(inB.id));
    await other.client.get(ONE(inB.id));

    const events = await crossingsOf(reader.identity);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        actor_id: reader.identity.id,
        actor_type: 'STAFF',
        responsible_hub_id: HUB_B,
        object_type: 'StaffIdentity',
        object_id: inB.id,
        enhanced: true,
        outcome: 'SUCCEEDED',
        before_after: null,
        detail: {},
      });
    }
    expect(JSON.stringify(events)).not.toContain(inB.fullName);
    expect(JSON.stringify(events)).not.toContain(inB.workEmail);
    // The same holds for the other staff principal.
    expect(await crossingsOf(other.identity)).toHaveLength(1);
  });

  // Break caught: a record with no hub treated as foreign, so that every read of a bootstrap administrator by an all-hub reader writes
  // an event naming no hub.
  it('writes nothing for a record with no primary hub', async () => {
    const reader = await allHubReader(HUB_A);
    const hubless = await target('Hubless', { primaryHubId: null });

    expect((await reader.client.get(ONE(hubless.id))).status).toBe(200);

    expect(await crossingsOf(reader.identity)).toEqual([]);
  });

  // Break caught: a list that writes an event per row, names the returned ids, carries content, or audits the actor's own hub.
  it('writes one bounded event for each foreign hub a list represents, naming the hub and the operation and no row', async () => {
    const reader = await allHubReader(HUB_A);
    const tag = freshTag();
    const a1 = await target(tag, { primaryHubId: HUB_A });
    const b1 = await target(tag, { primaryHubId: HUB_B });
    const b2 = await target(tag, { primaryHubId: HUB_B });
    const c1 = await target(tag, { primaryHubId: HUB_C });

    expect(pageOf(await reader.client.get(`${LIST}?q=${tag}`)).items).toHaveLength(4);

    const events = await crossingsOf(reader.identity);
    expect(
      events.map((event) => [event.object_type, event.object_id, event.responsible_hub_id]),
    ).toEqual([HUB_B, HUB_C].map((hub) => ['HUB', hub, hub]));
    for (const event of events) {
      expect(event).toMatchObject({
        enhanced: true,
        outcome: 'SUCCEEDED',
        related_ids: { operation_id: 'listStaffIdentities' },
        before_after: null,
        detail: {},
      });
    }
    const text = JSON.stringify(events);
    for (const row of [a1, b1, b2, c1]) {
      expect(text).not.toContain(row.id);
      expect(text).not.toContain(row.fullName);
    }
  });

  // Break caught: the hubs of the page's lookahead row (fetched to know whether another page follows) being audited as read.
  it('audits the hubs of the rows a page returns and not the one that tells whether another page follows', async () => {
    const reader = await allHubReader(HUB_A);
    const tag = freshTag();
    await target(tag, { primaryHubId: HUB_A });
    await target(tag, { primaryHubId: HUB_B });

    const page = pageOf(await reader.client.get(`${LIST}?q=${tag}&page_size=1`));

    expect(page.items).toHaveLength(1);
    expect(page.next_page_token).not.toBeNull();
    expect(await crossingsOf(reader.identity)).toEqual([]);
  });

  // Break caught: an actor with no primary hub having a baseline: it has none of its own, so every hub it reads is foreign.
  it('treats every hub a principal with no primary hub reads as foreign, one event for each hub of a list', async () => {
    const reader = await allHubReader(null);
    const tag = freshTag();
    const a1 = await target(tag, { primaryHubId: HUB_A });
    await target(tag, { primaryHubId: HUB_B });

    expect((await reader.client.get(ONE(a1.id))).status).toBe(200);
    expect(await crossingsOf(reader.identity)).toHaveLength(1);

    expect(pageOf(await reader.client.get(`${LIST}?q=${tag}`)).items).toHaveLength(2);

    const events = await crossingsOf(reader.identity);
    expect(events.slice(1).map((event) => event.object_id)).toEqual([HUB_A, HUB_B]);
  });

  // Break caught: a refused read audited as a crossing: only an authorised read is.
  it('writes nothing for a read that is refused', async () => {
    const { client, identity } = await seniorOps(HUB_A);
    const there = await target('There', { primaryHubId: HUB_B });

    expect((await client.get(ONE(there.id))).status).toBe(403);

    expect(await crossingsOf(identity)).toEqual([]);
  });
});

describe('the ETag and the posture of the second factor (domain-model.md section 6.8, AC-SLICE-000-132)', () => {
  const etagOf = async (client: TestClient, id: string): Promise<string | null> =>
    (await client.get(ONE(id))).header('etag');

  /** A privileged identity with a PENDING factor and the enrolment grant the credential setup issued, ending at `expiresAt`. */
  async function enrolling(expiresAt: Date) {
    const row = await target('Enrolling', {
      primaryHubId: HUB_A,
      roleBundleId: BUNDLE_IDS.seniorOps,
    });
    await insertFactor(admin, factorRow(row.id));
    const grant = await insertGrant(
      admin,
      grantRow({
        principalId: row.id,
        purpose: 'MFA_ENROLMENT',
        issuedAt: new Date(Date.now() - 60_000),
        expiresAt,
      }),
    );
    return { row, grant };
  }

  const versionOf = async (id: string): Promise<number> =>
    (
      await admin.query<{ version: number }>('select version from staff_identity where id = $1', [
        id,
      ])
    ).rows[0]?.version ?? -1;

  // Break caught: no ETag, a weak one, the integer form of the other records, or a token that is not the same for the same record.
  it('carries one opaque strong token, the same for the same record on every read', async () => {
    const { client } = await seniorOps(HUB_A);
    const row = await target('Version', { primaryHubId: HUB_A });

    const first = await etagOf(client, row.id);
    const second = await etagOf(client, row.id);

    expect(first).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(second).toBe(first);
  });

  // Break caught: a token that stays still when a returned field changes, so that an If-Match taken from a read matches a record that
  // has changed; or one that moves for a failed sign-in, a lock or a rehash of the credential at a new cost, which no read returns
  // (domain-model.md section 6.8: "not a failed attempt").
  it('moves when the record changes and never for a failed attempt, a lock or a rehash', async () => {
    const { client } = await seniorOps(HUB_A);
    const row = await target('Moves', { primaryHubId: HUB_A });
    const before = await etagOf(client, row.id);

    await admin.query(
      `update staff_identity set failed_attempt_count = 4, locked_until = now() + interval '1 minute' where id = $1`,
      [row.id],
    );
    const afterFailure = await etagOf(client, row.id);
    await admin.query(`update staff_identity set credential_hash = $2 where id = $1`, [
      row.id,
      '$argon2id$v=19$m=19456,t=2,p=1$cmVoYXNoZWQ$cmVoYXNoZWQtaGFzaA',
    ]);
    const afterRehash = await etagOf(client, row.id);
    await admin.query(`update staff_identity set full_name = 'Renamed ${row.tag}' where id = $1`, [
      row.id,
    ]);
    const afterRename = await etagOf(client, row.id);

    expect(afterFailure).toBe(before);
    expect(afterRehash).toBe(before);
    expect(afterRename).not.toBe(before);
  });

  // Break caught (F02): the credential's replacement not moving the token. No read shows the credential, so the representation is
  // the same; the identity's durable revision is what carries it, and the token must follow it.
  it('moves when the credential is replaced, although no field of the read changes', async () => {
    const { client } = await seniorOps(HUB_A);
    const row = await target('Replaced', { primaryHubId: HUB_A });
    const before = await etagOf(client, row.id);
    const shown = (await client.get(ONE(row.id))).json();

    await admin.query(
      `update staff_identity set credential_generation = credential_generation + 1, credential_established_at = clock_timestamp() where id = $1`,
      [row.id],
    );
    const after = await etagOf(client, row.id);

    expect((await client.get(ONE(row.id))).json()).toEqual(shown);
    expect(after).not.toBe(before);
  });

  // Break caught: a factor's enrolment or revocation not moving the token, or the token following something other than what the read
  // shows: the token is for the representation, so a revocation by the system that returns the record to what it showed before any
  // factor is the same representation, and the same token.
  it('moves with the posture a factor gives the record: created, enrolled, revoked by the system', async () => {
    const { client } = await seniorOps(HUB_A);
    const row = await target('Factor', { primaryHubId: HUB_A, roleBundleId: BUNDLE_IDS.seniorOps });
    const before = await etagOf(client, row.id);
    const factor = await insertFactor(admin, factorRow(row.id));
    const created = await etagOf(client, row.id);
    await activateFactor(admin, factor.id);
    const enrolled = await etagOf(client, row.id);
    await admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
      [factor.id],
    );
    const revoked = await etagOf(client, row.id);

    expect(new Set([before, created, enrolled]).size).toBe(3);
    expect(revoked).not.toBe(enrolled);
    expect(revoked).toBe(before);
  });

  // Break caught (F02): a grant that lapses changing what the read says (a stranded enrolment becomes eligible for a reset) while the
  // token stays, because nothing was written to any row: the facts are judged at the read, and the token is made of the result.
  it('moves when a grant lapses with the passing of time, though no row is written', async () => {
    const { client } = await seniorOps(HUB_A);
    const { row, grant } = await enrolling(new Date(Date.now() + 4_000));
    const first = await client.get(ONE(row.id));
    const versionBefore = await versionOf(row.id);

    await admin.query(
      `select pg_sleep(greatest(0, extract(epoch from (expires_at - clock_timestamp())) + 0.2)) from setup_grant where id = $1`,
      [grant.id],
    );
    const second = await client.get(ONE(row.id));

    expect((first.json() as Identity).mfa_reset_state).toBe('NOT_ELIGIBLE');
    expect((second.json() as Identity).mfa_reset_state).toBe('ENROLMENT_UNFINISHED');
    expect(second.header('etag')).not.toBe(first.header('etag'));
    expect(await versionOf(row.id)).toBe(versionBefore);
  });

  // Break caught (F02): a delivery attempt leaving the queue changing the reset state (a pending message no longer blocks it) under an
  // unchanged token: the job is a row of a table the identity's version never sees.
  it('moves when a pending delivery of the grant ends, with the identity’s own revision unchanged', async () => {
    const { client } = await seniorOps(HUB_A);
    const { row, grant } = await enrolling(new Date(Date.now() + 30 * 60_000));
    await admin.query(`alter table setup_grant disable trigger all`);
    await admin.query(
      `update setup_grant set expires_at = clock_timestamp() - interval '1 minute', issued_at = issued_at - interval '1 hour' where id = $1`,
      [grant.id],
    );
    await admin.query(`alter table setup_grant enable trigger all`);
    const jobId = randomUUID();
    await admin.query(
      `insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type, principal_id,
                                            channel, state, next_attempt_at, expires_at, provider_dedupe_id, payload_ciphertext,
                                            payload_nonce, payload_key_version, payload_envelope_version)
       values ($1, 'MFA_REENROLMENT', 'SETUP_GRANT', $2, 'STAFF', $3, 'EMAIL', 'QUEUED', now(),
               now() + interval '1 hour', $4, decode(repeat('ab', 40), 'hex'), decode(repeat('cd', 12), 'hex'), 1, 1)`,
      [jobId, grant.id, row.id, randomUUID()],
    );
    const queued = await client.get(ONE(row.id));
    const versionBefore = await versionOf(row.id);

    await admin.query(
      `update credential_delivery_job set state = 'CANCELLED', outcome_class = 'CANCELLED', payload_ciphertext = null, payload_nonce = null,
                                          payload_key_version = null, payload_envelope_version = null, payload_erased_at = clock_timestamp()
        where id = $1`,
      [jobId],
    );
    const ended = await client.get(ONE(row.id));

    expect((queued.json() as Identity).mfa_reset_state).toBe('NOT_ELIGIBLE');
    expect((ended.json() as Identity).mfa_reset_state).toBe('ENROLMENT_UNFINISHED');
    expect(ended.header('etag')).not.toBe(queued.header('etag'));
    expect(await versionOf(row.id)).toBe(versionBefore);
  });

  // Break caught (F02): a bundle's privilege moving the posture of the identities that hold it (only a privileged identity has a second
  // factor to reset) under an unchanged token and an unchanged revision of the identity.
  it('moves when the privilege of the identity’s bundle changes, with the identity’s own revision unchanged', async () => {
    const { client } = await seniorOps(HUB_A);
    const row = await target('Privilege', {
      primaryHubId: HUB_A,
      roleBundleId: BUNDLE_IDS.seniorOps,
    });
    const factor = await insertFactor(admin, factorRow(row.id));
    await activateFactor(admin, factor.id);
    const privileged = await client.get(ONE(row.id));
    const versionBefore = await versionOf(row.id);

    await admin.query(`alter table role_bundle disable trigger all`);
    try {
      await admin.query(`update role_bundle set privileged = false where id = $1`, [
        BUNDLE_IDS.seniorOps,
      ]);
      const plain = await client.get(ONE(row.id));

      expect((privileged.json() as Identity).mfa_reset_state).toBe('FACTOR_ACTIVE');
      expect((plain.json() as Identity).mfa_reset_state).toBe('NOT_ELIGIBLE');
      expect(plain.header('etag')).not.toBe(privileged.header('etag'));
      expect(await versionOf(row.id)).toBe(versionBefore);
    } finally {
      await admin.query(`update role_bundle set privileged = true where id = $1`, [
        BUNDLE_IDS.seniorOps,
      ]);
      await admin.query(`alter table role_bundle enable trigger all`);
    }
  });

  // Break caught: the posture read from the caller's own context (which row-level security answers with nothing: an identity with a
  // proven factor read as one with none), or mfa_enrolled standing in for the reset state.
  it('shows mfa_enrolled and mfa_reset_state from the recorded factor, for the read and for the list', async () => {
    const { client } = await seniorOps(HUB_A);
    const tag = freshTag();
    const proven = await target(tag, { primaryHubId: HUB_A, roleBundleId: BUNDLE_IDS.seniorOps });
    const factor = await insertFactor(admin, factorRow(proven.id));
    await activateFactor(admin, factor.id);
    const plain = await target(tag, { primaryHubId: HUB_A, roleBundleId: BUNDLE_IDS.opsStaff });

    const one = (await client.get(ONE(proven.id))).json() as Identity;
    const items = pageOf(await client.get(`${LIST}?q=${tag}`)).items;

    expect([one.mfa_enrolled, one.mfa_reset_state]).toEqual([true, 'FACTOR_ACTIVE']);
    expect(items.map((item) => [item.id, item.mfa_enrolled, item.mfa_reset_state])).toEqual([
      [proven.id, true, 'FACTOR_ACTIVE'],
      [plain.id, false, 'NOT_ELIGIBLE'],
    ]);
  });
});
