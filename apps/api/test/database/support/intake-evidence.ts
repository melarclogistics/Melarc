import { createHash, randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import { EVIDENCE_STORE } from '../../../src/platform/auth/ports/evidence-store.port.js';
import type { InProcessEvidenceStore } from '../../../src/platform/evidence/in-process.evidence-store.adapter.js';
import type { TestResponse } from '../../../src/test-support/test-client.js';
import { API, OPS, type Actor } from './staff-routes.js';
import type { VendorRoutes } from './vendor-routes.js';

/**
 * The evidence of a pickup intake as a receiving officer makes it, through the real operations (S1.34: `createEvidence` for an owner `PICKUP_INTAKE`, the upload to the in-process
 * stand-in, `completeEvidenceUpload`): the record a condition names in `evidence_ids`, and the one an adjudication does. Test support, as `evidence-photo.ts` is for the rider's.
 */
export const EVIDENCE = `${API}/evidence`;
export const COMPLETE = (id: string): string => `${EVIDENCE}/${id}/complete`;
export const RETRIEVE = (id: string): string => `${EVIDENCE}/${id}/retrieval-authorization`;

/** A few bytes that begin as a JPEG does. */
export const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

export interface IntakeTicket {
  readonly evidence: Record<string, unknown> & { id: string };
  readonly upload: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly expires_at: string;
  };
}

/** The declaration of a record about an intake, with the body a receiver sends. */
export function intakeEvidenceBody(
  intakeId: string,
  purpose: 'CONDITION' | 'OSD' | 'ITEMIZATION' = 'CONDITION',
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    owner_type: 'PICKUP_INTAKE',
    owner_id: intakeId,
    purpose,
    captured_at: new Date(Date.now() - 60_000).toISOString(),
    content_type: 'image/jpeg',
    byte_size: JPEG.length,
    checksum_sha256: createHash('sha256').update(JPEG).digest('hex'),
    ...over,
  };
}

/** Step one: the officer declares the record. */
export const declareIntakeEvidence = (
  actor: Actor,
  payload: Record<string, unknown>,
  key: string = randomUUID(),
): Promise<TestResponse> =>
  actor.client.post(EVIDENCE, payload, { origin: OPS, headers: { 'Idempotency-Key': key } });

/** The bytes go to the store with the instruction the officer was given. */
export function uploadIntakeEvidence(routes: VendorRoutes, ticket: IntakeTicket): void {
  const store = routes.kit.app.app.get<InProcessEvidenceStore>(EVIDENCE_STORE, { strict: false });
  const uploaded = store.redeem({
    method: ticket.upload.method,
    url: ticket.upload.url,
    headers: { ...ticket.upload.headers, 'Content-Length': String(JPEG.length) },
    body: JPEG,
  });
  expect(uploaded.status).toBe(200);
}

/** Step two: the officer says the bytes landed. */
export const completeIntakeEvidence = (
  actor: Actor,
  id: string,
  etag: string,
): Promise<TestResponse> =>
  actor.client.post(COMPLETE(id), undefined, { origin: OPS, headers: { 'If-Match': etag } });

/** A record about an intake, declared, uploaded and stored: the id a condition or an adjudication names. */
export async function storedIntakeEvidence(
  routes: VendorRoutes,
  actor: Actor,
  intakeId: string,
  purpose: 'CONDITION' | 'OSD' | 'ITEMIZATION' = 'CONDITION',
): Promise<string> {
  const declared = await declareIntakeEvidence(actor, intakeEvidenceBody(intakeId, purpose));
  expect(declared.status).toBe(200);
  const ticket = declared.json() as IntakeTicket;
  uploadIntakeEvidence(routes, ticket);
  const completed = await completeIntakeEvidence(
    actor,
    ticket.evidence.id,
    declared.header('etag') ?? '',
  );
  expect(completed.status).toBe(200);
  return ticket.evidence.id;
}

/** A record declared and uploaded and not completed: the one a condition may not name (`EVIDENCE_NOT_STORED`). */
export async function pendingIntakeEvidence(
  routes: VendorRoutes,
  actor: Actor,
  intakeId: string,
  purpose: 'CONDITION' | 'OSD' | 'ITEMIZATION' = 'CONDITION',
): Promise<string> {
  const declared = await declareIntakeEvidence(actor, intakeEvidenceBody(intakeId, purpose));
  expect(declared.status).toBe(200);
  const ticket = declared.json() as IntakeTicket;
  uploadIntakeEvidence(routes, ticket);
  return ticket.evidence.id;
}
