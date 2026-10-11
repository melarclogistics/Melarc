import { API_RUNTIME_ROLE } from '../config/load-config.js';

/**
 * The database roles of the technical identities (SECURITY_DESIGN.md §14.6, §14.17, §14.17b; data-scope-registry.md §5).
 * The owner and the migration roles are in `tools/database` (`OWNER_ROLE`, `MIGRATION_ROLE`): nothing at run time uses
 * them. These are the roles a running process connects as, or a grant set a process is given.
 *
 * - The API runtime is the only login the API's configuration may name (`load-config.ts` refuses any other).
 * - The worker base identity holds no protected-business-table grant of its own. A worker runs as the base identity plus
 *   exactly the capabilities its task class needs (§14.17b), and a capability is a `melarc_worker_cap_<task>` grant-set role
 *   that is put in front of its process. The one worker of this slice is the credential-delivery worker (S0.18), so
 *   `provisionRoles` grants its capability to the base login (the login inherits the grants and cannot `SET ROLE` to the
 *   role): the base role itself reads no business table (`GBT-Y5`), what the login reaches is the delivery job and nothing
 *   else, and a process cannot acquire a second capability by asking (`GBT-Y9`). A later worker with another capability is
 *   given it by the task that builds it.
 * - The provisioning identity runs the approved seed and bootstrap procedures as `SYSTEM`. It is in no API's, worker's or
 *   request path's configuration.
 */
export { API_RUNTIME_ROLE };
export const WORKER_RUNTIME_ROLE = 'melarc_worker_runtime';
export const WORKER_CREDENTIAL_DELIVERY_ROLE = 'melarc_worker_cap_credential_delivery';
export const PROVISIONING_ROLE = 'melarc_provisioning';

/** The roles that may log in to an application database besides the migration identity, for a process of their own. */
export const RUNTIME_LOGIN_ROLES = [
  API_RUNTIME_ROLE,
  WORKER_RUNTIME_ROLE,
  PROVISIONING_ROLE,
] as const;
