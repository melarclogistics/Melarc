import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { primaryHubOfStaff } from '../platform/lookup/primary-hub.js';

/**
 * An authorised staff read or act on an intake of another hub than the actor's own is audited, without contents (audit.md sections 5.4 and 6): one `auth.hub_boundary.crossed`, enhanced,
 * naming the intake and its hub. A staff member with no primary hub (a Platform Admin) crosses every hub it reaches. The receiving side's reads, its lock and its count all say so alike.
 */
export async function noteHubCrossing(
  audit: AuditWriter,
  handle: TransactionHandle,
  authorized: AuthorizedRequest,
  intake: { readonly id: string; readonly responsible_hub_id: string },
): Promise<void> {
  const baseline = await primaryHubOfStaff(handle, authorized.session.principalId);
  if (intake.responsible_hub_id === baseline) return;
  await audit.write(handle, {
    code: 'auth.hub_boundary.crossed',
    enhanced: true,
    outcome: 'SUCCEEDED',
    object: { type: 'PickupIntake', id: intake.id },
    responsibleHubId: intake.responsible_hub_id,
  });
}
