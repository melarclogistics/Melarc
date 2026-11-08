/**
 * The closed list of task capabilities a `SYSTEM` context may work under (data-scope-registry.md §5.2;
 * SECURITY_DESIGN.md §14.1 and §14.1b). A `SYSTEM` context has no person, so what it may touch is decided by one
 * capability, and no policy tests `SYSTEM` alone. The list is the registry's: a capability is added to the registry
 * first, with the identity that holds its grants and the tables it may touch, and here in the same change, and a
 * test reads the registry and fails when the two disagree.
 *
 * Not in the list, and not accepted until they are: the task classes of an `Outbox` envelope (§14.7), which arrive
 * with the `Outbox` table and its `outbox_task_permits` rule.
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
] as const;

export type TaskCapability = (typeof TASK_CAPABILITIES)[number];

export const isTaskCapability = (value: unknown): value is TaskCapability =>
  typeof value === 'string' && (TASK_CAPABILITIES as readonly string[]).includes(value);
