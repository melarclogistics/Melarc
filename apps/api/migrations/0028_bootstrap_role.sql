-- D07 of the audit of 22 October 2026, adopted by the owner: the policies of the `bootstrap` capability are bound to the role the bootstrap
-- functions run as, as well as to the capability. Forward-only; it replaces eleven policies and changes no table, column, grant, trigger
-- or function. It is a new migration and not an edit of 0019 or 0022 because a database may already hold those: a migration that a
-- database has applied is never amended. Applied as melarc_migration_elevated.
--
-- The weakness. A capability is a label (`melarc.task_capability()`), and the policies of 0019 admitted a SYSTEM context under `bootstrap`
-- whoever had opened it. Code that already runs as the API's login, and holds the privileges of its own work, could set the two settings
-- itself and be admitted where the bootstrap functions are: it reads every identity, grant, factor and session through the bootstrap
-- policies, issues a grant, ends a PENDING factor, writes the bootstrap's events as the system, and, the day the API's login is given
-- INSERT on `staff_identity` for `createStaffIdentity`, inserts an ACTIVE Platform Admin of the bootstrap shape with no maker and no
-- checker. Row-level security was meant to be the second line behind the functions, and for this capability it was not.
--
-- The correction. Every arm of the eleven policies names, beside the capability, `current_user = 'melarc_owner'`: the role the four
-- bootstrap functions run as (a SECURITY DEFINER function runs as its owner, and 0019 and 0022 make every one of them melarc_owner's;
-- the provisioning login that calls them is not the owner and holds no privilege on these tables). So the policies admit the bootstrap
-- functions' own statements and nothing else: the API's login, the worker and the provisioning login asserting the label are refused
-- (a SELECT sees no row; a write is refused by row-level security), whatever privileges they hold. Forced row-level security is as it
-- was, no login is made a member of the owner or of the migration role, and no policy is widened: each keeps every condition it had.
-- The migration login, which is a member of the owner and runs `SET ROLE melarc_owner` to try the policies directly in the tests, is as
-- it was. The reader of the policy structure (GBT-E7, `system-branch.ts`) accepts the added conjunct: the arm still names exactly one
-- capability.

ALTER POLICY "staff_identity_bootstrap_select" ON "staff_identity" USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
ALTER POLICY "staff_identity_bootstrap_insert" ON "staff_identity" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner' AND origin = 'BOOTSTRAP' AND status = 'ACTIVE' AND created_by = melarc.reserved_system_actor_id() AND approved_by = melarc.reserved_system_actor_id() AND role_bundle_id = melarc.bootstrap_bundle_id() AND primary_hub_id IS NULL AND credential_established_at IS NULL AND credential_generation = 0
    ELSE false
  END
);
--> statement-breakpoint
ALTER POLICY "staff_identity_bootstrap_lock" ON "staff_identity" USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner' AND origin = 'BOOTSTRAP'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner' AND false
    ELSE false
  END
);
--> statement-breakpoint
ALTER POLICY "setup_grant_bootstrap_select" ON "setup_grant" USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
ALTER POLICY "setup_grant_bootstrap_insert" ON "setup_grant" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner' AND state = 'PENDING' AND principal_type = 'STAFF' AND purpose IN ('BOOTSTRAP_SETUP', 'MFA_REENROLMENT') AND issued_by IS NULL
    ELSE false
  END
);
--> statement-breakpoint
ALTER POLICY "setup_grant_bootstrap_update" ON "setup_grant" USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner' AND state = 'PENDING' AND principal_type = 'STAFF'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner' AND state IN ('SUPERSEDED', 'EXPIRED') AND principal_type = 'STAFF'
    ELSE false
  END
);
--> statement-breakpoint
ALTER POLICY "mfa_factor_bootstrap_select" ON "mfa_factor" USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
ALTER POLICY "mfa_factor_bootstrap_update" ON "mfa_factor" USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner' AND status = 'PENDING'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner' AND status = 'REVOKED' AND revoked_by IS NULL AND revocation_reason_code IS NULL AND revocation_episode_id IS NULL
    ELSE false
  END
);
--> statement-breakpoint
ALTER POLICY "session_bootstrap_select" ON "session" USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
ALTER POLICY "setting_bootstrap_read" ON "setting" USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner' AND key = 'recovery_link_ttl_minutes'
    ELSE false
  END
);
--> statement-breakpoint
-- The audit-insert policy as 0022 left it (the six events the commands write), with the role term.
ALTER POLICY "audit_event_bootstrap_insert" ON "audit_event" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND current_user = 'melarc_owner' AND actor_id IS NULL AND surface_context NOT IN ('OPS_PORTAL', 'VENDOR_PWA', 'RIDER_ANDROID') AND outcome = 'SUCCEEDED' AND ((event_code IN ('staff.identity.created', 'staff.identity.approved', 'auth.mfa.revoked') AND enhanced) OR (event_code IN ('auth.setup_grant.issued', 'auth.setup_grant.superseded') AND NOT enhanced) OR (event_code = 'auth.bootstrap.resumed' AND enhanced AND object_type = 'StaffIdentity' AND object_id IS NOT NULL))
    ELSE false
  END
);
