-- SecurityContext v2 accessors (S0.4a). Applied as melarc_migration_elevated, a member of melarc_owner
-- (SECURITY_DESIGN.md section 14.17a; MIGRATION_AND_SEEDING.md section 5.1). Everything created here is owned by
-- melarc_owner; no runtime role owns anything.
--
-- Three more settings of the transaction-local context (section 14.1) get an accessor beside the five of
-- 0000_database_foundation.sql:
--   melarc.task_capability()       the one capability a SYSTEM context works under (section 14.4). A SYSTEM branch
--                                  of a policy tests it, never SYSTEM alone. NONE when unset, which no branch names.
--   melarc.scope_probe_id()        the one record id the scope probe may see across hubs (section 14.4b). NULL when
--                                  unset, so the probe disjunct of a hub policy is never true.
--   melarc.current_principal_id()  the authenticated principal, for the rows a principal owns (section 14.16).
--
-- Each resolves a missing or empty setting to a denying value instead of raising, and casts a present one: a
-- malformed value raises and aborts the statement (section 14.4a). The application never lets one reach a setting
-- (section 14.1b); the abort is the backstop behind it.
--
-- The roles added later for workers and provisioning (S0.5) are granted EXECUTE on these with the five above.

CREATE FUNCTION melarc.task_capability() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('melarc.task_capability', true), ''), 'NONE')
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.scope_probe_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('melarc.scope_probe_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.current_principal_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('melarc.principal_id', true), '')::uuid
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.task_capability() OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.scope_probe_id() OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.current_principal_id() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.task_capability() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.scope_probe_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.current_principal_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.task_capability() TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.scope_probe_id() TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.current_principal_id() TO melarc_api_runtime;
