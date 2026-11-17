import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EVIDENCE_STORE } from '../../src/platform/auth/ports/evidence-store.port.js';
import type { InProcessEvidenceStore } from '../../src/platform/evidence/in-process.evidence-store.adapter.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { JPEG } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, codeOf } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * The audit's G-04: **`createEvidence` replayed with the same `Idempotency-Key` after the record has moved on, and `completeEvidenceUpload` with a version the record no longer has**, against a
 * real PostgreSQL and the real application (`evidence-routes.db.test.ts` holds the replay of a record still pending).
 *
 * What the service does, from its own account (`evidence.service.ts`): a replay keeps only the record's identifier, so it **reads the record again and answers it as it now is** (its state,
 * its `ETag` of the version it now has, the capability to upload made again from the row, which is a pure function of the record and so the same address); it asks nothing of the owner
 * again, makes no second record and changes nothing. A completion judges the `If-Match` first, against the token recomputed from the record under the same read, so **a version from before the
 * record was stored or expired is `STATE_CONFLICT`, whatever the record's state is now** (never the expiry's answer and never the stored record handed back to a caller that read an older one);
 * only the current version of a stored record is answered with the record again, and only the current version of an expired one is told `EVIDENCE_UPLOAD_EXPIRED`.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let store: InProcessEvidenceStore;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  store = routes.kit.app.app.get<InProcessEvidenceStore>(EVIDENCE_STORE, { strict: false });
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const EVIDENCE = `${API}/evidence`;
const COMPLETE = (id: string) => `${EVIDENCE}/${id}/complete`;

/** A run in progress with one stop the rider has arrived at. */
const run = (): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 1,
    stopStates: ['ARRIVED'],
  });
const stopOf = (arranged: ArrangedRun): string => {
  const stop = arranged.stops[0];
  if (stop === undefined) throw new Error('stop');
  return stop.id;
};

const bodyFor = (owner: string): Record<string, unknown> => ({
  owner_type: 'PICKUP_STOP',
  owner_id: owner,
  purpose: 'COLLECTION_PROOF',
  captured_at: new Date(Date.now() - 60_000).toISOString(),
  content_type: 'image/jpeg',
  byte_size: JPEG.length,
  checksum_sha256: createHash('sha256').update(JPEG).digest('hex'),
});

const declare = (
  rider: ArrangedRider,
  payload: Record<string, unknown>,
  key: string,
): Promise<TestResponse> =>
  rider.client.post(EVIDENCE, payload, { headers: { 'Idempotency-Key': key } });

const complete = (rider: ArrangedRider, id: string, etag: string): Promise<TestResponse> =>
  rider.client.post(COMPLETE(id), undefined, { headers: { 'If-Match': etag } });

interface Ticket {
  readonly evidence: Record<string, unknown> & { id: string; state: string };
  readonly upload: {
    method: string;
    url: string;
    headers: Record<string, string>;
    expires_at: string;
  };
}

const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

const rowOf = (id: string) =>
  routes
    .rows<{
      state: string;
      version: number;
      created_at: Date;
      upload_ttl_seconds: number;
      uploaded_at: Date | null;
    }>(
      `select state, version, created_at, upload_ttl_seconds, uploaded_at from evidence where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);
const recordsOf = (stopId: string) =>
  routes.rows<{ id: string }>(`select id from evidence where owner_id = $1`, [stopId]);

/** The record the rider declared under `key` and uploaded the bytes of, with what it was answered. */
async function declaredAndUploaded(arranged: ArrangedRun, key: string) {
  const payload = bodyFor(stopOf(arranged));
  const answered = await declare(arranged.rider, payload, key);
  expect(answered.status, answered.text).toBe(200);
  const ticket = answered.json() as Ticket;
  const uploaded = store.redeem({
    method: ticket.upload.method,
    url: ticket.upload.url,
    headers: { ...ticket.upload.headers, 'Content-Length': String(JPEG.length) },
    body: JPEG,
  });
  expect(uploaded.status).toBe(200);
  return { payload, ticket, etag: answered.header('etag') ?? '' };
}

/**
 * The window of a record closed and the record expired, as the sweep leaves one (`expired` at the next version): the guard is switched off for the one statement that moves the window into the
 * past, and the version trigger is left on, so that the version moves as it does when the sweep expires a record.
 */
async function expired(id: string): Promise<void> {
  await routes.admin.query('alter table evidence disable trigger evidence_guard');
  try {
    await routes.admin.query(
      `update evidence set state = 'EXPIRED', created_at = now() - interval '2 hours', upload_expires_at = now() - interval '1 hour' where id = $1`,
      [id],
    );
  } finally {
    await routes.admin.query('alter table evidence enable trigger evidence_guard');
  }
}

describe('createEvidence replayed with the same key after the record has moved on', () => {
  // Break caught: a replay that answers the record as it was declared (pending, with the first version), makes a second record, runs the declaration again for a stop that has moved on, or loses the
  // capability or its no-store header; and a replay under the same key of another request that is accepted.
  it('answers a record that is STORED now as it now is, with the version it now has and the capability made again from the row, and makes nothing', async () => {
    const arranged = await run();
    const key = randomUUID();
    const { payload, ticket, etag } = await declaredAndUploaded(arranged, key);
    const done = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(done.status, done.text).toBe(200);
    const storedEtag = done.header('etag') ?? '';
    expect(storedEtag).not.toBe(etag);
    const before = await rowOf(ticket.evidence.id);
    expect(before).toMatchObject({ state: 'STORED', version: 2 });

    const replayed = await declare(arranged.rider, payload, key);

    expect(replayed.status, replayed.text).toBe(200);
    const again = replayed.json() as Ticket;
    // The record as it is now: the same record, stored, and the answer a completion gave.
    expect(again.evidence.id).toBe(ticket.evidence.id);
    expect(again.evidence.state).toBe('STORED');
    expect(again.evidence).toEqual(done.json());
    expect(replayed.header('etag')).toBe(storedEtag);
    expect(replayed.header('cache-control')).toBe('no-store');
    // The capability is made again from the row, which has not changed: the same address for the same window.
    expect(again.upload.url).toBe(ticket.upload.url);
    expect(again.upload.expires_at).toBe(ticket.upload.expires_at);
    // It made nothing and changed nothing.
    expect(await recordsOf(stopOf(arranged))).toEqual([{ id: ticket.evidence.id }]);
    expect(await rowOf(ticket.evidence.id)).toEqual(before);
    // Another request under the same key is still a conflict.
    const other = await declare(arranged.rider, { ...payload, byte_size: JPEG.length + 1 }, key);
    expect(outcome(other)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    expect(await recordsOf(stopOf(arranged))).toHaveLength(1);
    // The version the replay told is the current one: completing with it answers the stored record again and changes nothing.
    const completedAgain = await complete(arranged.rider, ticket.evidence.id, storedEtag);
    expect(completedAgain.status, completedAgain.text).toBe(200);
    expect(await rowOf(ticket.evidence.id)).toEqual(before);
  });

  // Break caught: a replay of an expired record that answers it pending, gives it the version it had, or hands out a window that is open again; the capability of a record that is expired is
  // as the record is (made from its own instants, so already over).
  it('answers a record that has EXPIRED as it now is, with a capability whose window is over, and the version it tells is the one that is told EVIDENCE_UPLOAD_EXPIRED', async () => {
    const arranged = await run();
    const key = randomUUID();
    const { payload, ticket, etag } = await declaredAndUploaded(arranged, key);
    await expired(ticket.evidence.id);
    const row = await rowOf(ticket.evidence.id);
    expect(row).toMatchObject({ state: 'EXPIRED', version: 2, uploaded_at: null });

    const replayed = await declare(arranged.rider, payload, key);

    expect(replayed.status, replayed.text).toBe(200);
    const again = replayed.json() as Ticket;
    expect(again.evidence).toMatchObject({ id: ticket.evidence.id, state: 'EXPIRED' });
    expect(replayed.header('etag')).not.toBe(etag);
    expect(replayed.header('cache-control')).toBe('no-store');
    // A pure function of the record: its creation and its lifetime, which are over.
    // (The store counts the window from the second the record was made in.)
    const endsAt =
      Math.floor((row?.created_at.getTime() ?? 0) / 1000) * 1000 +
      (row?.upload_ttl_seconds ?? 0) * 1000;
    expect(new Date(again.upload.expires_at).getTime()).toBe(endsAt);
    expect(endsAt).toBeLessThan(Date.now());
    expect(await recordsOf(stopOf(arranged))).toHaveLength(1);
    expect(await rowOf(ticket.evidence.id)).toEqual(row);

    // The version the replay told is the record's own: the expiry's answer. The version of before the expiry is a stale one, whatever the record is now.
    expect(
      outcome(await complete(arranged.rider, ticket.evidence.id, replayed.header('etag') ?? '')),
    ).toEqual([422, 'EVIDENCE_UPLOAD_EXPIRED']);
    expect(outcome(await complete(arranged.rider, ticket.evidence.id, etag))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect(await rowOf(ticket.evidence.id)).toEqual(row);
  });
});

describe('completeEvidenceUpload with a version the record no longer has', () => {
  // Break caught: a stored record handed back to a caller that read an older version (the stored shortcut taken before the version is judged), or a stale completion that changes the record.
  it('refuses the version from before the record was stored, STATE_CONFLICT, though the record is stored now, and the current version is answered again', async () => {
    const arranged = await run();
    const { ticket, etag } = await declaredAndUploaded(arranged, randomUUID());
    const id = ticket.evidence.id;
    const done = await complete(arranged.rider, id, etag);
    expect(done.status, done.text).toBe(200);
    const stored = await rowOf(id);
    expect(stored).toMatchObject({ state: 'STORED', version: 2 });

    // The version the declaration was answered with is not the record's now.
    const stale = await complete(arranged.rider, id, etag);
    expect(outcome(stale)).toEqual([409, 'STATE_CONFLICT']);
    expect(await rowOf(id)).toEqual(stored);
    // Nor is a version the record never had.
    expect(outcome(await complete(arranged.rider, id, '"never-had"'))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    // The current version is the record's own answer, and nothing moves.
    const current = await complete(arranged.rider, id, done.header('etag') ?? '');
    expect(current.status, current.text).toBe(200);
    expect(current.json()).toEqual(done.json());
    expect(await rowOf(id)).toEqual(stored);
  });

  // Break caught: a completion that does not check the version it was given against the record under its read (two completions of the same version both stored, or one of them answered
  // with a server error), or one that stores a record twice.
  it('lets exactly one of two completions of the same version store the record, and tells the other STATE_CONFLICT', async () => {
    const arranged = await run();
    const { ticket, etag } = await declaredAndUploaded(arranged, randomUUID());
    const id = ticket.evidence.id;

    const answers = await Promise.all([
      complete(arranged.rider, id, etag),
      complete(arranged.rider, id, etag),
    ]);

    expect(answers.map((answer) => answer.status).toSorted()).toEqual([200, 409]);
    const refused = answers.find((answer) => answer.status === 409);
    expect(refused === undefined ? undefined : outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
    expect(await rowOf(id)).toMatchObject({ state: 'STORED', version: 2 });
  });
});
