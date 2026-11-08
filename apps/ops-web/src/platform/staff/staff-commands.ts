import type { components } from '@melarc/api-client';

import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseMfaResetResult,
  parseRecoveryRequest,
  parseSessionRecord,
  parseSetupGrant,
  parseStaffIdentity,
  parseTrustedBrowsersRevoked,
  type MfaResetOutcome,
  type RecoveryRequestOutcome,
  type SessionRecordView,
  type SetupGrantOutcome,
  type StaffIdentityView,
} from './staff-shape';

/**
 * The commands of the identity screens. Each sends one request and answers with what the API answered, judged (`staff-shape.ts`): a
 * success status with a body that is not what the contract describes is an answer that is not the API's (`unexpected-response`), which a
 * confirmed command reads as an outcome that is not known, because the act may have been done.
 *
 * The version a command acts on (`If-Match`) is the `ETag` of the read, passed in exactly as it was kept. A command carries no
 * `Idempotency-Key` unless its operation declares one: only `createStaffIdentity` does. Nothing here reads a credential, and none of the
 * answers could hold one: the grant a reset or a re-issue issues is delivered to the person it is for and never returned.
 */
export type NewStaffProfile = components['schemas']['StaffIdentityCreate'];

/** The reason and note of an act that asks for them, as the dialog collected them. */
export interface ReasonFields {
  readonly reasonCode: string;
  readonly note?: string;
}

const reasonBody = (command: ReasonFields): { reason_code: string; note?: string } => ({
  reason_code: command.reasonCode,
  ...(command.note === undefined ? {} : { note: command.note }),
});

/** `createStaffIdentity`: the profile, created awaiting approval. */
export async function createStaffIdentity(
  client: ApiClient,
  body: NewStaffProfile,
  idempotencyKey: string,
): Promise<StaffIdentityView> {
  const answer = answerOf(
    await client.POST('/staff-identities', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body,
    }),
  );
  const identity = parseStaffIdentity(answer.data);
  if (identity === undefined) throw unexpectedResponse(answer.status);
  return identity;
}

export type StaffDecision =
  { readonly approved: true } | ({ readonly approved: false } & ReasonFields);

/** `approveStaffIdentity`: approve the profile, or reject it with a reason. */
export async function decideStaffIdentity(
  client: ApiClient,
  id: string,
  version: string,
  decision: StaffDecision,
): Promise<StaffIdentityView> {
  const answer = answerOf(
    await client.POST('/staff-identities/{id}/approve', {
      params: { path: { id }, header: { 'If-Match': version } },
      body: decision.approved ? { approved: true } : { approved: false, ...reasonBody(decision) },
    }),
  );
  const identity = parseStaffIdentity(answer.data);
  if (identity === undefined) throw unexpectedResponse(answer.status);
  return identity;
}

/** `reissueStaffCredentialSetup`: a fresh first-setup link, sent to the person's work email. The link is never in the answer. */
export async function reissueSetupLink(
  client: ApiClient,
  id: string,
  version: string,
  command: ReasonFields,
): Promise<SetupGrantOutcome> {
  const answer = answerOf(
    await client.POST('/ops/staff/{id}/credential/setup/reissue', {
      params: { path: { id }, header: { 'If-Match': version } },
      body: reasonBody(command),
    }),
  );
  const outcome = parseSetupGrant(answer.data);
  if (outcome === undefined) throw unexpectedResponse(answer.status);
  return outcome;
}

/**
 * `recoverStaffCredential` (S0.52b): a recovery link sent to the person's work email for them to set a new password; their password and
 * authenticator stay as they are until they do. The link is never in the answer.
 */
export async function recoverStaffCredential(
  client: ApiClient,
  id: string,
  version: string,
  command: ReasonFields,
): Promise<RecoveryRequestOutcome> {
  const answer = answerOf(
    await client.POST('/ops/staff/{id}/credential/recover', {
      params: { path: { id }, header: { 'If-Match': version } },
      body: reasonBody(command),
    }),
  );
  const outcome = parseRecoveryRequest(answer.data, 'STAFF');
  if (outcome === undefined) throw unexpectedResponse(answer.status);
  return outcome;
}

/** `resetStaffMfa`: the person's second factor revoked, their sessions ended, a new set-up link sent to them. The link is never in the answer. */
export async function resetStaffMfa(
  client: ApiClient,
  id: string,
  version: string,
  command: ReasonFields,
): Promise<MfaResetOutcome> {
  const answer = answerOf(
    await client.POST('/ops/staff/{id}/mfa/reset', {
      params: { path: { id }, header: { 'If-Match': version } },
      body: reasonBody(command),
    }),
  );
  const outcome = parseMfaResetResult(answer.data);
  if (outcome === undefined) throw unexpectedResponse(answer.status);
  return outcome;
}

/** `revokeSession`: one live session ended by an administrator. The operation takes no version and no key: ending an ended session is no harm. */
export async function revokeSession(
  client: ApiClient,
  id: string,
  command: ReasonFields,
): Promise<SessionRecordView> {
  const answer = answerOf(
    await client.POST('/auth/sessions/{id}/revoke', {
      params: { path: { id } },
      body: reasonBody(command),
    }),
  );
  const session = parseSessionRecord(answer.data);
  if (session === undefined) throw unexpectedResponse(answer.status);
  return session;
}

/**
 * `revokeTrustedBrowser`: one of the signed-in person's own trusted browsers removed. It takes no version and no key: removing a removed one is
 * `NOT_FOUND`, which the page reads as done. When the browser removed is the one asking, the answer clears its cookie (the browser does that).
 */
export async function revokeTrustedBrowser(client: ApiClient, id: string): Promise<void> {
  answerOf(await client.DELETE('/auth/staff/trusted-browsers/{id}', { params: { path: { id } } }));
}

/**
 * `revokeStaffTrustedBrowsers`: every valid trusted browser of another person removed by a Platform Admin, with a reason. Answers how many.
 * It takes an `Idempotency-Key` (the audit of 26 October 2026): "every valid browser" is not a fixed set, so a retry under a new key would
 * remove a browser the person was remembered on in between, while a retry under the same key replays the first count and removes nothing.
 */
export async function revokeStaffTrustedBrowsers(
  client: ApiClient,
  id: string,
  command: ReasonFields,
  idempotencyKey: string,
): Promise<number> {
  const answer = answerOf(
    await client.POST('/ops/staff/{id}/trusted-browsers/revoke', {
      params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey } },
      body: reasonBody(command),
    }),
  );
  const revoked = parseTrustedBrowsersRevoked(answer.data);
  if (revoked === undefined) throw unexpectedResponse(answer.status);
  return revoked;
}
