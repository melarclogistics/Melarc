import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import type { ReasonFields } from '../staff/staff-commands';
import { parseRecoveryRequest, type RecoveryRequestOutcome } from '../staff/staff-shape';
import { parseVendorSetupGrant, type VendorSetupGrantOutcome } from './vendor-shape';

/**
 * The two acts of the vendor screens (S0.52b) on an account's credential. Each sends the version the page read (`If-Match`) and a reason, and
 * answers with what the API answered, judged; neither carries an `Idempotency-Key` (their operations declare none). **Neither answer could hold
 * a secret or a link**: a setup grant and a recovery link go to the account's registered channel, never back to the officer.
 */
const reasonBody = (command: ReasonFields): { reason_code: string; note?: string } => ({
  reason_code: command.reasonCode,
  ...(command.note === undefined ? {} : { note: command.note }),
});

/** `reissueVendorCredentialSetup`: a fresh setup link for an account that holds no secret yet, sent to its delivery channel. */
export async function reissueVendorSetupLink(
  client: ApiClient,
  id: string,
  version: string,
  command: ReasonFields,
): Promise<VendorSetupGrantOutcome> {
  const answer = answerOf(
    await client.POST('/ops/vendors/{id}/credential/setup/reissue', {
      params: { path: { id }, header: { 'If-Match': version } },
      body: reasonBody(command),
    }),
  );
  const outcome = parseVendorSetupGrant(answer.data, id);
  if (outcome === undefined) throw unexpectedResponse(answer.status);
  return outcome;
}

/** `recoverVendorCredential`: a recovery link for an account that holds a secret, sent to its delivery channel with the identifier. */
export async function recoverVendorCredential(
  client: ApiClient,
  id: string,
  version: string,
  command: ReasonFields,
): Promise<RecoveryRequestOutcome> {
  const answer = answerOf(
    await client.POST('/ops/vendors/{id}/credential/recover', {
      params: { path: { id }, header: { 'If-Match': version } },
      body: reasonBody(command),
    }),
  );
  const outcome = parseRecoveryRequest(answer.data, 'VENDOR');
  if (outcome === undefined) throw unexpectedResponse(answer.status);
  return outcome;
}
