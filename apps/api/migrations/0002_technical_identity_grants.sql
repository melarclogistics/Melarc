-- The worker and the provisioning identities read the security context (S0.5). Applied as melarc_migration_elevated, a
-- member of melarc_owner (SECURITY_DESIGN.md section 14.17a; MIGRATION_AND_SEEDING.md section 5.1).
--
-- Every row-level-security policy reads the transaction-local context through the accessor functions of schema melarc, and
-- a policy runs with the privileges of the role that issued the statement. So each login that can be subject to a policy
-- needs USAGE on the schema and EXECUTE on the accessors, or its statements fail instead of being answered by the policy.
-- That is all this migration grants: no table, no other function and no schema other than melarc. What a worker or the
-- provisioning identity may touch is decided by the access matrix per capability (data-scope-registry.md section 5.2),
-- table by table, in the migration that creates each table.
--
-- The roles are created by provisioning before any migration runs (the same order as melarc_api_runtime in
-- 0000_database_foundation.sql). melarc_worker_cap_credential_delivery is a grant set and receives nothing here: a task
-- puts a capability in front of its process, and the base identity alone holds no business grant (GBT-Y5).

GRANT USAGE ON SCHEMA melarc TO melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.principal_type() TO melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.hub_scope_mode() TO melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.authorized_hub_ids() TO melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.current_vendor_organization_id() TO melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.current_rider_id() TO melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.task_capability() TO melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.scope_probe_id() TO melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.current_principal_id() TO melarc_worker_runtime, melarc_provisioning;
