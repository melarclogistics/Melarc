-- Database foundation (B0.4). Applied as melarc_migration_elevated, which is a member of melarc_owner
-- (SECURITY_DESIGN.md section 14.17a; MIGRATION_AND_SEEDING.md section 5.1). Everything created here is
-- owned by melarc_owner. No runtime role owns anything, and none runs DDL.
--
-- This migration holds no domain table. It creates the schema for the platform's own database objects and
-- the context accessors that every row-level-security policy reads (SECURITY_DESIGN.md section 14.4).
-- They read the transaction-local melarc.* settings (section 14.1) and resolve a missing setting to a
-- denying value instead of raising, so a request with no context is refused rather than failing.

CREATE SCHEMA melarc AUTHORIZATION melarc_owner;
--> statement-breakpoint
REVOKE ALL ON SCHEMA melarc FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA melarc TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.principal_type() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('melarc.principal_type', true), ''), 'NONE')
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.hub_scope_mode() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('melarc.hub_scope_mode', true), ''), 'NONE')
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.authorized_hub_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(
           string_to_array(nullif(current_setting('melarc.authorized_hub_ids', true), ''), ',')::uuid[],
           ARRAY[]::uuid[])
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.current_vendor_organization_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('melarc.vendor_organization_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.current_rider_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('melarc.rider_id', true), '')::uuid
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.principal_type() OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.hub_scope_mode() OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.authorized_hub_ids() OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.current_vendor_organization_id() OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.current_rider_id() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.principal_type() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.hub_scope_mode() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.authorized_hub_ids() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.current_vendor_organization_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.current_rider_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.principal_type() TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.hub_scope_mode() TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.authorized_hub_ids() TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.current_vendor_organization_id() TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.current_rider_id() TO melarc_api_runtime;
