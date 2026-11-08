-- The seed's policy branches and the provisioning grants (S0.9). Applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). The tables are 0003's; this file adds what only the seed needs, and nothing the API does.
--
-- A seed writes a forced-row-level-security table as the SYSTEM principal under the seed task capability, never as the migration
-- login and never by bypassing row-level security (MIGRATION_AND_SEEDING.md section 5.1). Each of the seven reference tables gets
-- two policies, each a SYSTEM branch of the one supported structure (system-branch.ts, GBT-E7) that names exactly one capability:
--
--   <table>_seed_read    SELECT, so the seed can count the rows of a table and refuse one that is not empty ("INSERT into an
--                        empty set", data-scope-registry.md section 5.2). It admits no other principal: staff and the
--                        authentication capability keep reading through the policy 0003 gave them (permissive policies add).
--   <table>_seed_insert  INSERT. For role_bundle and fixed_permission_policy the check also requires revision 1: the seed inserts
--                        the first rows of the counters (revision 1, floor 1, MIGRATION_AND_SEEDING.md section 5.1), and a seed that
--                        started above the first would make a later reduction look as if it had already happened. The floor needs no
--                        condition of its own: the table's range check (1 <= floor <= revision) makes it 1 when the revision is 1.
--
-- The label is not the barrier; the grants are. SELECT and INSERT are given to melarc_provisioning alone, so code that runs as the
-- API and asserts the seed capability still holds SELECT and nothing more on these tables (GBT-E6). Nobody holds UPDATE or DELETE on
-- them, the provisioning login included: a change to a bundle or the fixed policy is a migration or the SLICE-009 edit operation,
-- under the exclusive policy lock (SECURITY_DESIGN.md section 13.10a).
--
-- role_bundle_grant.tier becomes nullable. The catalogue (permissions.md section 7) gives the Finance, Rider and Vendor holders no
-- tier, and the tier of a grant is the holder's letter (A, S or P): a value the documents do not state is not invented. A NULL tier
-- satisfies no rule that compares tiers. The closed-set check on the column still binds every value that is written.

ALTER TABLE "role_bundle_grant" ALTER COLUMN "tier" DROP NOT NULL;
--> statement-breakpoint
CREATE POLICY "hub_seed_read" ON "hub" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "hub_seed_insert" ON "hub" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "permission_seed_read" ON "permission" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "permission_seed_insert" ON "permission" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "role_bundle_seed_read" ON "role_bundle" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "role_bundle_seed_insert" ON "role_bundle" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' AND revision = 1
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "role_bundle_grant_seed_read" ON "role_bundle_grant" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "role_bundle_grant_seed_insert" ON "role_bundle_grant" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "fixed_permission_policy_seed_read" ON "fixed_permission_policy" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "fixed_permission_policy_seed_insert" ON "fixed_permission_policy" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' AND revision = 1
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setting_seed_read" ON "setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setting_seed_insert" ON "setting" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "reason_code_seed_read" ON "reason_code" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "reason_code_seed_insert" ON "reason_code" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT, INSERT ON "hub" TO melarc_provisioning;
--> statement-breakpoint
GRANT SELECT, INSERT ON "permission" TO melarc_provisioning;
--> statement-breakpoint
GRANT SELECT, INSERT ON "role_bundle" TO melarc_provisioning;
--> statement-breakpoint
GRANT SELECT, INSERT ON "role_bundle_grant" TO melarc_provisioning;
--> statement-breakpoint
GRANT SELECT, INSERT ON "fixed_permission_policy" TO melarc_provisioning;
--> statement-breakpoint
GRANT SELECT, INSERT ON "setting" TO melarc_provisioning;
--> statement-breakpoint
GRANT SELECT, INSERT ON "reason_code" TO melarc_provisioning;
--> statement-breakpoint
-- Two gaps in what 0003 guards, found in the review of the stage (S0.10), closed here and not by editing 0003:
-- the guard on role_bundle also refuses a change of id (the key of the bundle's policy lock, and what a staff record refers to)
-- and a change of the privileged flag (it decides who may approve, permissions.md section 5) that does not raise the revision;
-- and a permitted operation cannot be NULL (an array with a NULL prints as {NULL}, which the pattern of 0003 reads as a name).
-- CREATE OR REPLACE keeps the function's owner and its revoked privileges.
CREATE OR REPLACE FUNCTION melarc.role_bundle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'a role bundle never changes id' USING ERRCODE = '23514';
  END IF;
  IF NEW.audience IS DISTINCT FROM OLD.audience THEN
    RAISE EXCEPTION 'a role bundle never changes audience' USING ERRCODE = '23514';
  END IF;
  -- Revisions only increase, by one (SECURITY_DESIGN.md section 13.10a).
  IF NEW.revision <> OLD.revision AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'a bundle revision rises by exactly one' USING ERRCODE = '23514';
  END IF;
  -- The floor moves only with a reduction: together with a raise of the revision, and then to the new revision.
  IF NEW.reduction_floor <> OLD.reduction_floor
     AND NOT (NEW.revision = OLD.revision + 1 AND NEW.reduction_floor = NEW.revision) THEN
    RAISE EXCEPTION 'a bundle floor moves only with a reduction, to the new revision' USING ERRCODE = '23514';
  END IF;
  -- Authorization content changes with the revision (domain-model.md section 6.9): the privileged flag is part of it.
  IF NEW.privileged IS DISTINCT FROM OLD.privileged AND NEW.revision = OLD.revision THEN
    RAISE EXCEPTION 'a bundle privileged flag changes only with a raised revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER TABLE "reason_code" ADD CONSTRAINT "reason_code_operations_not_null" CHECK (array_position("reason_code"."permitted_operations", NULL) IS NULL);
