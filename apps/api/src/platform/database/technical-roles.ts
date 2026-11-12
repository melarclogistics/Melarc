import { API_RUNTIME_ROLE } from '../config/load-config.js';

/**
 * The database roles of the technical identities (SECURITY_DESIGN.md §14.6, §14.17, §14.17b; data-scope-registry.md §5).
 * The owner role is in `tools/database` (`OWNER_ROLE`): nothing at run time uses it. The migration role is named here because
 * the access matrix gives it the one capability no application context is opened under (`policy_change`, S0.27); no process of
 * the application connects as it. The rest are the roles a running process connects as, or a grant set a process is given.
 *
 * - The API runtime is the only login the API's configuration may name (`load-config.ts` refuses any other).
 * - The worker base identity holds no protected-business-table grant of its own. A worker runs as the base identity plus
 *   exactly the capabilities its task class needs (§14.17b), and a capability is a `melarc_worker_cap_<task>` grant-set role
 *   that is put in front of its process. The delivery worker (S0.18) carries two: the credential delivery and, since S1.12a,
 *   the notification lane (one process, two lanes), so `provisionRoles` grants both capabilities to the base login (the login
 *   inherits the grants and cannot `SET ROLE` to either role): the base role itself reads no business table (`GBT-Y5`), what
 *   the login reaches is the delivery job and the lane's tables and nothing else, and a process cannot acquire a further
 *   capability by asking (`GBT-Y9`). A later worker with another capability is given it by the task that builds it.
 * - The provisioning identity runs the approved seed and bootstrap procedures as `SYSTEM`. It is in no API's, worker's or
 *   request path's configuration.
 */
export { API_RUNTIME_ROLE };
export const WORKER_RUNTIME_ROLE = 'melarc_worker_runtime';
export const WORKER_CREDENTIAL_DELIVERY_ROLE = 'melarc_worker_cap_credential_delivery';
/** The grant set of the notification lane (S1.12a): the same login, a second capability, and no more than the lane's tables. */
export const WORKER_NOTIFICATION_ROLE = 'melarc_worker_cap_notification';
/**
 * The grant set of the evidence validation lane (S1.11): the same login, a third capability, and no more than the lane needs of the evidence table (it reads the id, the state and
 * the end of the upload window, and writes the state, to expire an abandoned capture).
 */
export const WORKER_EVIDENCE_VALIDATION_ROLE = 'melarc_worker_cap_evidence_validation';
export const PROVISIONING_ROLE = 'melarc_provisioning';
/**
 * The role migrations run as (SECURITY_DESIGN.md §14.17a). `tools/database/safety.ts` holds the same string, because it cannot
 * import from the platform (a root script imports it under Node's type stripping); `safety.test.ts` holds the two equal.
 */
export const MIGRATION_ROLE = 'melarc_migration_elevated';

/** The roles that may log in to an application database besides the migration identity, for a process of their own. */
export const RUNTIME_LOGIN_ROLES = [
  API_RUNTIME_ROLE,
  WORKER_RUNTIME_ROLE,
  PROVISIONING_ROLE,
] as const;
