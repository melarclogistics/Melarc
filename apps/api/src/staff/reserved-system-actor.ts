/**
 * The reserved system actor (MIGRATION_AND_SEEDING.md §3.2, constraint four; domain-model.md §6.8): the one identifier that the two
 * seeded bootstrap records hold as both `created_by` and `approved_by`. It is not a person and not an identity of any table: nothing
 * is stored under it, and a real-looking maker would make every later audit of "was the same-actor rule ever bypassed?" return a
 * false negative, because the seeded record would look exactly like a compliant one. A reserved value makes the bootstrap visible
 * for good.
 *
 * The same value is written in migration 0019 (`melarc.reserved_system_actor_id()`), where the `bootstrap` branch of the
 * `staff_identity` insert policy compares against it, and a database test holds the two together. **Nothing reads this value to
 * decide that an identity is a bootstrap identity**: every rule that treats one differently reads the immutable `origin` column
 * (domain-model.md §6.8).
 *
 * It is distinct from the technical identifier of the seed task (`SEED_PRINCIPAL_ID`) and of the bootstrap task
 * (`BOOTSTRAP_PRINCIPAL_ID`), which identify a task in a transaction's context and are never stored as an actor.
 */
export const RESERVED_SYSTEM_ACTOR_ID = '5eed0000-0000-4000-8000-0000000000a1';
