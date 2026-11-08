import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IDENTITY_REASON_DOMAINS } from '../../src/platform/database/schema/reference-data.js';
import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { arrangedFixedSession, presenting } from './support/http-sessions.js';
import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { assemble, staffPersona, type Machinery } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.35, `listReasonDefinitions` against the real application and a real PostgreSQL (`AC-SLICE-000-132`, `AC-SLICE-000-44`): the
 * reason catalogue is readable for the operations and the branches that take a reason, by the staff whose session snapshot holds
 * `settings.reason.read`, and by no one else. Every staff session is issued by the real protocol for the seeded bundle, every request
 * is a real HTTP request, and a Rider's and a Vendor's session are rows arranged as their sign-ins (S0.59, S0.48) will leave them.
 */
const PATH = '/api/v1/reason-definitions';
const HUB = HUBS[0]?.id ?? '';

let database: TestDatabase;
let kit: IntegrationKit;
let built: BuiltService;
let machinery: Machinery;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  built = buildService(database, { poolMax: 2 });
  machinery = assemble(built);
  kit = await startIntegrationKit(database, {
    poolMax: 4,
    compiledFixedPolicy: { VENDOR: 1, RIDER: 1 },
    vendorOrganization: () => Promise.resolve('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'),
  });
  // A retired identity reason: the operation filter returns the active ones only, and a filter that does not ask returns it as retired.
  await admin.query(
    `insert into reason_code (code, domain, label, attribution, active, permitted_operations)
     values ('RETIRED_SESSION_REASON', 'SESSION_REVOCATION', 'A retired session reason', 'MELARC', false, ARRAY['revokeSession'])`,
  );
  // A reason of a workflow domain, which no slice seeds yet: the unfiltered read carries it with no permitted operations.
  await admin.query(
    `insert into reason_code (code, domain, valid_checkpoints, label, attribution, consumes_delivery_attempt, active)
     values ('NO_ANSWER_AT_DOOR', 'RECIPIENT_CONTACT', ARRAY['DOORSTEP'], 'No answer at the door', 'CUSTOMER', true, true),
            ('RETIRED_REASON', 'DELIVERY_FAILURE', null, 'A retired reason', 'MELARC', false, false)`,
  );
});

afterAll(async () => {
  await kit.stop();
  await built.close();
  await admin.end();
  await database.drop();
});

interface Reason {
  readonly code: string;
  readonly domain: string;
  readonly active: boolean;
  readonly validCheckpoints: string[] | null;
  readonly permittedOperations: { operationId: string; branch: string | null }[] | null;
}

async function asStaff(bundle: string): Promise<TestClient> {
  const persona = await staffPersona(machinery, admin, { roleBundleId: bundle, primaryHubId: HUB });
  return presenting(kit, persona.issued.token, persona.issued.csrfToken ?? undefined);
}
const reasonsOf = (response: TestResponse): Reason[] => {
  expect(response.status).toBe(200);
  return response.json() as Reason[];
};
const codesOf = (response: TestResponse): string[] =>
  reasonsOf(response).map((reason) => reason.code);
const codeOf = (response: TestResponse): string | undefined =>
  (response.json() as { code?: string }).code;

const STAFF_BUNDLES = [
  ['Ops Staff', BUNDLE_IDS.opsStaff],
  ['Senior Ops', BUNDLE_IDS.seniorOps],
  ['Platform Admin', BUNDLE_IDS.platformAdmin],
] as const;

describe.each(STAFF_BUNDLES)(
  '%s reading the reason catalogue (AC-SLICE-000-132)',
  (_name, bundle) => {
    // Break caught: the branch filter reading the wrong half of `permittedOperations`, or not narrowing at all: the picker of the reset
    // screen would then offer a reason the operation refuses as REASON_NOT_ACTIVE.
    it('is given exactly the reason of each branch of resetStaffMfa', async () => {
      const client = await asStaff(bundle);

      const active = await client.get(`${PATH}?operation=resetStaffMfa&branch=FACTOR_ACTIVE`);
      const unfinished = await client.get(
        `${PATH}?operation=resetStaffMfa&branch=ENROLMENT_UNFINISHED`,
      );

      expect(codesOf(active)).toEqual(['MFA_AUTHENTICATOR_UNAVAILABLE']);
      expect(codesOf(unfinished)).toEqual(['MFA_ENROLMENT_EXPIRED']);
      expect(reasonsOf(active)[0]).toMatchObject({
        active: true,
        permittedOperations: [{ operationId: 'resetStaffMfa', branch: 'FACTOR_ACTIVE' }],
      });
      expect(reasonsOf(unfinished)[0]).toMatchObject({
        active: true,
        permittedOperations: [{ operationId: 'resetStaffMfa', branch: 'ENROLMENT_UNFINISHED' }],
      });
    });

    // Break caught: the unfiltered read dropping a reason, ordered by anything but the code, or carrying permitted operations for a
    // domain that has none; or a response with a hub value, a credential or a note in it.
    it('is given every reason, ordered by code, the identity ones with their permitted operations and the others with null', async () => {
      const client = await asStaff(bundle);

      const response = await client.get(PATH);

      const reasons = reasonsOf(response);
      const codes = reasons.map((reason) => reason.code);
      expect(codes).toEqual(codes.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      expect(codes).toEqual(
        expect.arrayContaining(['MFA_AUTHENTICATOR_UNAVAILABLE', 'NO_ANSWER_AT_DOOR']),
      );
      for (const reason of reasons) {
        const identity = (IDENTITY_REASON_DOMAINS as readonly string[]).includes(reason.domain);
        expect(reason.permittedOperations === null).toBe(!identity);
      }
      const door = reasons.find((reason) => reason.code === 'NO_ANSWER_AT_DOOR');
      expect(door).toMatchObject({ validCheckpoints: ['DOORSTEP'], permittedOperations: null });
      for (const reason of reasons) {
        for (const name of Object.keys(reason)) {
          expect(name).not.toMatch(/hub|credential|secret|password|token|^note$/i);
        }
      }
    });

    // Break caught: the operation filter returning a reason that is not active, which the operation would refuse.
    it('is given only the active reasons by the operation filter, and the others by the filters that do not ask', async () => {
      const client = await asStaff(bundle);

      expect(codesOf(await client.get(`${PATH}?domain=DELIVERY_FAILURE`))).toEqual([
        'RETIRED_REASON',
      ]);
      expect(codesOf(await client.get(`${PATH}?domain=SESSION_REVOCATION`))).toEqual([
        'RETIRED_SESSION_REASON',
        'SESSION_ACCESS_NO_LONGER_REQUIRED',
        'SESSION_SECURITY_CONCERN',
      ]);
      expect(codesOf(await client.get(`${PATH}?operation=revokeSession`))).toEqual([
        'SESSION_ACCESS_NO_LONGER_REQUIRED',
        'SESSION_SECURITY_CONCERN',
      ]);
    });

    // Break caught: the branch filter dropping a reason whose entry names no branch for the operation (a reason that is not narrower
    // than its operation is valid on every branch), or keeping one of another branch.
    it('keeps a reason that names no branch for the operation, and drops one of another branch', async () => {
      const client = await asStaff(bundle);

      expect(
        codesOf(
          await client.get(`${PATH}?operation=approveStaffIdentity&branch=APPROVAL_REJECTED`),
        ),
      ).toEqual(['STAFF_CREATION_NOT_AUTHORISED', 'STAFF_DETAILS_INCORRECT']);
      expect(
        codesOf(
          await client.get(`${PATH}?operation=reissueStaffCredentialSetup&branch=FACTOR_ACTIVE`),
        ),
      ).toEqual(['CREDENTIAL_SETUP_LINK_UNUSABLE']);
      expect(
        codesOf(await client.get(`${PATH}?operation=resetStaffMfa&branch=APPROVAL_REJECTED`)),
      ).toEqual([]);
    });

    // Break caught: the domain and checkpoint filters not narrowing, or a checkpoint matching a reason that has none.
    it('narrows by domain and by checkpoint', async () => {
      const client = await asStaff(bundle);

      expect(codesOf(await client.get(`${PATH}?domain=RECIPIENT_CONTACT`))).toEqual([
        'NO_ANSWER_AT_DOOR',
      ]);
      expect(codesOf(await client.get(`${PATH}?checkpoint=DOORSTEP`))).toEqual([
        'NO_ANSWER_AT_DOOR',
      ]);
      expect(codesOf(await client.get(`${PATH}?checkpoint=PRE_DISPATCH`))).toEqual([]);
      expect(codesOf(await client.get(`${PATH}?domain=NO_SUCH_DOMAIN`))).toEqual([]);
    });

    // Break caught: a filter that is not valid being ignored, which would answer a wider read than the screen asked for.
    it.each([
      ['a branch without an operation', 'branch=FACTOR_ACTIVE'],
      ['an operation outside its enumeration', 'operation=launchMissiles'],
      ['a branch outside its enumeration', 'operation=resetStaffMfa&branch=EVERYTHING'],
      ['a checkpoint outside its enumeration', 'checkpoint=MIDNIGHT'],
    ])('refuses %s with 400 VALIDATION_FAILED', async (_name, query) => {
      const client = await asStaff(bundle);

      const response = await client.get(`${PATH}?${query}`);

      expect([response.status, codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
    });
  },
);

describe('who is refused the reason catalogue (AC-SLICE-000-132, AC-SLICE-000-44)', () => {
  // Break caught: a missing session answered 403, or a held session without the key answered 401 (AC-SLICE-000-44).
  it('answers 401 SESSION_INVALID with no session, and 403 PERMISSION_DENIED to a session that does not hold the key', async () => {
    const none = await kit.client.fork().get(PATH);
    const finance = await (await asStaff(BUNDLE_IDS.finance)).get(PATH);

    expect([none.status, codeOf(none)]).toEqual([401, 'SESSION_INVALID']);
    expect([finance.status, codeOf(finance)]).toEqual([403, 'PERMISSION_DENIED']);
  });

  // Break caught: a Vendor reading a catalogue its bundle does not hold the key of.
  it('answers a Vendor session 403 PERMISSION_DENIED', async () => {
    const vendor = await arrangedFixedSession(kit, admin, 'VENDOR');

    const response = await presenting(kit, vendor.token, vendor.csrf).get(PATH);

    expect([response.status, codeOf(response)]).toEqual([403, 'PERMISSION_DENIED']);
  });

  // Break caught: a Rider, whose scope is assignment-based, read as holding the key everywhere: while no stop or run exists the scope is
  // false, so the answer is PERMISSION_DENIED.
  it('answers a Rider session with no assigned stop or run 403 PERMISSION_DENIED', async () => {
    const rider = await arrangedFixedSession(kit, admin, 'RIDER');

    const response = await kit.client.bearer(rider.token).get(PATH);

    expect([response.status, codeOf(response)]).toEqual([403, 'PERMISSION_DENIED']);
  });

  // Break caught: the catalogue read leaving anything behind in the ledger or the table: it changes nothing.
  it('writes nothing', async () => {
    const client = await asStaff(BUNDLE_IDS.opsStaff);
    const before = await admin.query('select count(*)::int as n from audit_event');

    await client.get(PATH);

    const after = await admin.query('select count(*)::int as n from audit_event');
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
