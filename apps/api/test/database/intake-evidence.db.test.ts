import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { countIntake, handOver } from './support/handed-over.js';
import {
  EVIDENCE,
  RETRIEVE,
  completeIntakeEvidence,
  declareIntakeEvidence,
  intakeEvidenceBody,
  storedIntakeEvidence,
  uploadIntakeEvidence,
  type IntakeTicket,
} from './support/intake-evidence.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { seedHubConfiguration } from './support/seeded.js';
import { HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.34, the evidence of an intake (`createEvidence`, `completeEvidenceUpload` and `createEvidenceRetrievalAuthorization` for the owner `PICKUP_INTAKE`; `x-permission: owner`; state-machines.md
 * section 17; hub-intake.md section 5.2): a receiving officer attaches the photos of a condition to an intake that has been counted, and the staff of its hub are given a way to read them.
 * Against a real PostgreSQL and the real application, each claim:
 *
 * - **The permission is the act's**: the receiver holding `hub.intake.count` declares and completes a record of a condition; the evidence of an adjudication (`OSD`) is the key of the
 *   adjudication's (`hub.osd.adjudicate`: Senior Ops and Platform Admin, not Ops Staff); the staff of the intake's hub holding `hub.read` read it. A rider, a user without the key and
 *   another hub's officer are refused, and the record of another is the same answer as one that does not exist.
 * - **Only after the count**: an intake that is waiting for its count has no evidence (`STATE_CONFLICT`), as the contract says of the condition it is for.
 * - **The scope is the intake's and is not the client's**: the record belongs to the hub of the intake, and nothing the client sends changes it.
 */
const SENIOR = BUNDLE_IDS.seniorOps;

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

/** An intake of hub A that has been counted (a clean count, so that it is cleared for itemization), and the receiver that counted it. */
async function counted(): Promise<{ id: string; receiver: Actor }> {
  const receiver = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  const done = await handOver(routes, vendor, days, { collected: [3], declared: [3] });
  const id = done.intakes[0]?.id ?? '';
  expect((await countIntake(receiver, id, 3)).status).toBe(200);
  return { id, receiver };
}

const recordOf = async (id: string) =>
  (
    await routes.rows<{
      state: string;
      owner_type: string;
      owner_id: string;
      purpose: string;
      responsible_hub_id: string | null;
      vendor_organization_id: string | null;
      captured_by_principal_type: string;
      captured_by_actor: string;
      retention_policy: string;
      access_rule: string;
    }>(
      `select state, owner_type, owner_id, purpose, responsible_hub_id, vendor_organization_id, captured_by_principal_type, captured_by_actor, retention_policy, access_rule
         from evidence where id = $1`,
      [id],
    )
  )[0];

describe('the evidence of an intake: declared, uploaded and completed by the receiver, read by the staff of the hub', () => {
  // Break caught: an owner with no act (the receiver refused its own record), a record whose scope is not the intake's hub, one made in another name, with another retention category or
  // access rule, or one the staff of the hub cannot be given a way to read; and the way to read it that is cached, or kept.
  it('lets the receiver declare, upload and complete a record of a counted intake, and the staff of its hub read it', async () => {
    const { id, receiver } = await counted();
    const declared = await declareIntakeEvidence(receiver, intakeEvidenceBody(id));
    expect(declared.status).toBe(200);
    expect(declared.header('cache-control')).toBe('no-store');
    const ticket = declared.json() as IntakeTicket;
    expect(ticket.evidence).toMatchObject({
      owner_type: 'PICKUP_INTAKE',
      owner_id: id,
      purpose: 'CONDITION',
      state: 'PENDING_UPLOAD',
      responsible_hub_id: HUB_A,
    });
    expect(await recordOf(ticket.evidence.id)).toMatchObject({
      state: 'PENDING_UPLOAD',
      owner_type: 'PICKUP_INTAKE',
      owner_id: id,
      responsible_hub_id: HUB_A,
      vendor_organization_id: null,
      captured_by_principal_type: 'STAFF',
      captured_by_actor: receiver.identity.id,
      retention_policy: 'PICKUP_INTAKE_EVIDENCE',
      access_rule: 'SUBJECT_READERS',
    });
    uploadIntakeEvidence(routes, ticket);
    const completed = await completeIntakeEvidence(
      receiver,
      ticket.evidence.id,
      declared.header('etag') ?? '',
    );
    expect(completed.status).toBe(200);
    expect(completed.json()).toMatchObject({ id: ticket.evidence.id, state: 'STORED' });

    // The staff of the hub (any holder of hub.read, who need not be the receiver) are given the way to read the stored object, once, uncached.
    const reader = await routes.actor(SENIOR, HUB_A);
    const way = await reader.client.post(RETRIEVE(ticket.evidence.id), undefined, { origin: OPS });
    expect(way.status).toBe(200);
    expect(way.header('cache-control')).toBe('no-store');
    expect(Object.keys(way.json() as object).toSorted()).toEqual([
      'expires_at',
      'headers',
      'method',
      'url',
    ]);
  });

  // Break caught: evidence for an intake that is waiting for its count (the condition it is for is recorded only after the count commits), or any state past it refused.
  it('refuses a record for an intake that is waiting for its count, STATE_CONFLICT, and for one that does not exist', async () => {
    const receiver = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [3] });
    const waiting = done.intakes[0]?.id ?? '';
    const refused = await declareIntakeEvidence(receiver, intakeEvidenceBody(waiting));
    expect(outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
    expect((refused.json() as { details?: { rule?: string } }).details?.rule).toBe(
      'intake_not_counted',
    );
    expect(
      outcome(await declareIntakeEvidence(receiver, intakeEvidenceBody(randomUUID()))),
    ).toEqual([404, 'NOT_FOUND']);
    expect(
      outcome(await declareIntakeEvidence(receiver, intakeEvidenceBody('not-a-uuid'))),
    ).toEqual([400, 'VALIDATION_FAILED']);
    // Nothing was written for it.
    const rows = await routes.rows<{ count: number }>(
      `select count(*)::int as count from evidence where owner_id = $1`,
      [waiting],
    );
    expect(rows[0]?.count).toBe(0);
  });

  // Break caught: an act that is open to a caller whose key it is not: a user without hub.intake.count, a rider, another hub's officer (the intake of another hub is one that does not exist
  // for the declaration); the evidence of an adjudication declared by Ops Staff (who do not hold the key of the adjudication) and the purposes of another owner.
  it('is refused without the key of the act, to a rider, in another hub, and for a purpose that is not the act’s', async () => {
    const { id, receiver } = await counted();
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    const otherHub = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    const senior = await routes.actor(SENIOR, HUB_A);
    const rider = (await handOver(routes, vendor, days, { collected: [3] })).run.rider;
    expect(outcome(await declareIntakeEvidence(finance, intakeEvidenceBody(id)))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    expect(
      outcome(
        await rider.client.post(EVIDENCE, intakeEvidenceBody(id), {
          headers: { 'Idempotency-Key': randomUUID() },
        }),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    // Another hub's officer: the intake is not in its hubs, so for the declaration it does not exist.
    expect(outcome(await declareIntakeEvidence(otherHub, intakeEvidenceBody(id)))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    // A staff member who holds the key of no act of the operation learns nothing of the request's schema: it is refused before the body is read, whatever the body is (AC-SLICE-000-130).
    const malformed = await finance.client.post(EVIDENCE, '{"broken": ', {
      origin: OPS,
      headers: { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' },
    });
    expect(outcome(malformed)).toEqual([403, 'PERMISSION_DENIED']);
    // The evidence of an adjudication needs the key of the adjudication: Ops Staff do not hold it, Senior Ops do.
    expect(outcome(await declareIntakeEvidence(receiver, intakeEvidenceBody(id, 'OSD')))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    expect((await declareIntakeEvidence(senior, intakeEvidenceBody(id, 'OSD'))).status).toBe(200);
    // And a purpose that is no purpose of the owner's act is a malformed request, once the permission is judged.
    expect(
      outcome(
        await declareIntakeEvidence(
          receiver,
          intakeEvidenceBody(id, 'CONDITION', { purpose: 'COLLECTION_PROOF' }),
        ),
      ),
    ).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: a client that chooses the scope of its record (another hub's, a vendor's), its state or its retention; they are the intake's and the server's.
  it('derives the scope from the intake and accepts none from the client', async () => {
    const { id, receiver } = await counted();
    const forged = await declareIntakeEvidence(
      receiver,
      intakeEvidenceBody(id, 'CONDITION', {
        responsible_hub_id: HUB_B,
        vendor_organization_id: vendor.row.organizationId,
        state: 'STORED',
        retention_policy: 'PICKUP_STOP_EVIDENCE',
      }),
    );
    expect(forged.status).toBe(400);
    expect(codeOf(forged)).toBe('VALIDATION_FAILED');
  });

  // Break caught: a record another officer could complete, or one completed before its bytes are there; the record of another is the same answer as one that does not exist.
  it('lets only its declarer complete a record, and a record that does not exist is the same answer', async () => {
    const { id, receiver } = await counted();
    const other = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const declared = await declareIntakeEvidence(receiver, intakeEvidenceBody(id));
    const ticket = declared.json() as IntakeTicket;
    uploadIntakeEvidence(routes, ticket);
    const etag = declared.header('etag') ?? '';
    expect(outcome(await completeIntakeEvidence(other, ticket.evidence.id, etag))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(outcome(await completeIntakeEvidence(receiver, randomUUID(), etag))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect((await recordOf(ticket.evidence.id))?.state).toBe('PENDING_UPLOAD');
    expect((await completeIntakeEvidence(receiver, ticket.evidence.id, etag)).status).toBe(200);
  });

  // Break caught: a way to read a record that is not stored, to another hub's staff, to a user without hub.read, to a rider; and a staff member who holds the read key of a pickup stop's evidence
  // and of an intake's being told one is the other's (the first act found is not the only one a staff member holds).
  it('gives the way to read a stored record to the staff of its hub only, whichever read key of the evidence they hold first', async () => {
    const { id, receiver } = await counted();
    const stored = await storedIntakeEvidence(routes, receiver, id);
    const pending = await declareIntakeEvidence(receiver, intakeEvidenceBody(id));
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    const otherHub = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    const rider = (await handOver(routes, vendor, days, { collected: [3] })).run.rider;
    const asks = (actor: Actor, evidence: string) =>
      actor.client.post(RETRIEVE(evidence), undefined, { origin: OPS });
    // The receiver holds pickup.read (the read key of a stop's evidence, found first) and hub.read: it is given the way all the same.
    expect((await asks(receiver, stored)).status).toBe(200);
    expect(outcome(await asks(receiver, (pending.json() as IntakeTicket).evidence.id))).toEqual([
      422,
      'EVIDENCE_NOT_STORED',
    ]);
    expect(outcome(await asks(otherHub, stored))).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(outcome(await asks(finance, stored))).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      (await rider.client.post(RETRIEVE(stored), undefined, { headers: {} })).status,
    ).toBeGreaterThanOrEqual(400);
  });
});
