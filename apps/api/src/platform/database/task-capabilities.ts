/**
 * The closed list of task capabilities a `SYSTEM` context may work under (data-scope-registry.md §5.2;
 * SECURITY_DESIGN.md §14.1 and §14.1b). A `SYSTEM` context has no person, so what it may touch is decided by one
 * capability, and no policy tests `SYSTEM` alone. The list is the registry's: a capability is added to the registry
 * first, with the identity that holds its grants and the tables it may touch, and here in the same change, and a
 * test reads the registry and fails when the two disagree.
 *
 * Not in the list, and not accepted until they are: the other task classes of an `Outbox` envelope (§14.7). The first, the notification
 * lane, arrived with the `Outbox` table (S1.12a, migration 0055); the others arrive with the jobs that need them. Where the
 * documents name `outbox_task_permits('<table>')`, a policy of this build tests `melarc.task_capability() = '<class>'` with the
 * envelope's own identifiers beside it (`melarc.outbox_aggregate_id()`, `melarc.outbox_hub_id()`), which is the same permit written
 * as the capability the lint already knows.
 */
export const TASK_CAPABILITIES = [
  'authentication',
  'rate_limit',
  'seed',
  'credential_delivery',
  'bootstrap',
  // The change of a bundle or of a fixed policy after the seed (S0.27; migration 0017). Only the database functions
  // `melarc.change_role_bundle` and `melarc.change_fixed_policy` assert it, for their own statements, and only the migration login
  // may execute them: no application context is opened under it.
  'policy_change',
  // The business-rule configuration read for a server-side rule evaluated on behalf of any principal (S1.4; migration 0042): the hub's
  // settings, service zones and aliases, and the COMPANY-scope settings. Read-only. Opened by the configuration reader of
  // `platform/settings` in its own read transaction, so that a vendor's booking can be priced as an estimate without a vendor context
  // ever reading a table the registry denies it.
  'configuration',
  // The notification lane of the delivery worker (S1.12a; migration 0055; registry §5.1 `worker:notification`): it leases the
  // outbox envelopes of business acts, reloads the one aggregate an envelope names under that envelope's scope, and writes and sends
  // the notifications. Held by the worker's login through the grant set `melarc_worker_cap_notification`, so it is a separation and
  // not only a label: the API's login holds none of the grants.
  'notification',
  // The evidence validation lane of the delivery worker (S1.11; migration 0080; registry §5.1 `worker:evidence_validation`): it expires the abandoned captures
  // (`PENDING_UPLOAD` whose upload window has passed) and keeps them, and is the place the malicious-content check will run (OB-S1-05, the owner's). Held by the
  // worker's login through the grant set `melarc_worker_cap_evidence_validation`, so it is a separation and not only a label: the API's login holds none of the grants.
  'evidence_validation',
] as const;

export type TaskCapability = (typeof TASK_CAPABILITIES)[number];

export const isTaskCapability = (value: unknown): value is TaskCapability =>
  typeof value === 'string' && (TASK_CAPABILITIES as readonly string[]).includes(value);
