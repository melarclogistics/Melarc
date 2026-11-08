CREATE TABLE "hub_setting" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hub_id" uuid NOT NULL,
	"setting_key" text NOT NULL,
	"scope_ref" text DEFAULT '' NOT NULL,
	"version" integer NOT NULL,
	"value" jsonb NOT NULL,
	"unit" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "hub_setting_version_key" UNIQUE("hub_id","setting_key","scope_ref","version"),
	CONSTRAINT "hub_setting_key_grammar" CHECK ("hub_setting"."setting_key" ~ '^[A-Za-z][A-Za-z0-9_]*$'),
	CONSTRAINT "hub_setting_scope_ref_grammar" CHECK ("hub_setting"."scope_ref" ~ '^([A-Z][A-Z0-9_]*)?$'),
	CONSTRAINT "hub_setting_version_positive" CHECK ("hub_setting"."version" >= 1),
	CONSTRAINT "hub_setting_unit_not_empty" CHECK (length(btrim("hub_setting"."unit")) > 0)
);
--> statement-breakpoint
CREATE TABLE "service_zone" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hub_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"service_area" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_zone_hub_code_key" UNIQUE("hub_id","code"),
	CONSTRAINT "service_zone_id_hub_key" UNIQUE("id","hub_id"),
	CONSTRAINT "service_zone_code_grammar" CHECK ("service_zone"."code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "service_zone_name_not_empty" CHECK (length(btrim("service_zone"."name")) > 0),
	CONSTRAINT "service_zone_service_area_closed" CHECK ("service_zone"."service_area" IN ('ACCRA_TEMA', 'AMASAMAN_ENVIRONS', 'KASOA_CORRIDOR'))
);
--> statement-breakpoint
CREATE TABLE "service_zone_alias" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hub_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_zone_alias_hub_alias_key" UNIQUE("hub_id","alias"),
	CONSTRAINT "service_zone_alias_normalised" CHECK ("service_zone_alias"."alias" = lower(btrim(regexp_replace("service_zone_alias"."alias", '[[:space:]]+', ' ', 'g'))) AND length("service_zone_alias"."alias") > 0),
	CONSTRAINT "service_zone_alias_kind_closed" CHECK ("service_zone_alias"."kind" IN ('LANDMARK', 'AREA'))
);
--> statement-breakpoint
ALTER TABLE "hub_setting" ADD CONSTRAINT "hub_setting_hub_fkey" FOREIGN KEY ("hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_zone" ADD CONSTRAINT "service_zone_hub_fkey" FOREIGN KEY ("hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_zone_alias" ADD CONSTRAINT "service_zone_alias_zone_fkey" FOREIGN KEY ("zone_id","hub_id") REFERENCES "public"."service_zone"("id","hub_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- The hub's configuration (S1.4, SLICE-001; the Product Owner's decision of 29 October 2026, D-02: a bounded launch-fee seed;
-- domain-model.md section 6.20; data-scope-registry.md ServiceZone, ServiceZoneAlias, HubSetting). Applied as
-- melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). The CREATE TABLE statements and the
-- foreign keys above are the generated part (drizzle-kit, from src/platform/database/schema/hub-configuration.ts); the rest of this
-- file is written by hand and is in this migration so that no table exists for a moment without its owner, row-level security,
-- policies and grants.
--
-- These are HUB-scoped reference tables (registry section 4.2). A zone answers serviceability and is never a price input; an alias
-- is the whole address-to-zone rule; a hub setting is versioned and effective-dated. The fields are provisional and minimal:
-- SLICE-014 owns the full design of zones and settings (settings.md section 7.2), and adds proposals and approvals that write the
-- same tables without changing their columns.
--
-- Who reads (registry sections 4.2 and 5.2): a STAFF context reads the rows of the hubs in its scope ("hub in SET/ALL"); the
-- `configuration` capability reads for a server-side rule evaluated on behalf of any principal (a booking estimate under a vendor
-- session, a price at itemization), and reads the COMPANY-scope rows of `setting` and no other; the `seed` capability reads (to
-- count) and inserts, and only inside melarc.seed_hub_configuration below. Every other principal, a vendor and a rider included,
-- and a request with no context, is denied by the closed ELSE.
--
-- Who writes: nobody directly. The runtime login holds SELECT and no write; the provisioning login holds no privilege on these
-- tables at all and reaches them through the one definer function. A trigger refuses UPDATE and DELETE of a row for every login,
-- the owner included: a new version of a setting is a new row, and an old version stays what a charge snapshotted.

ALTER TABLE "service_zone" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "service_zone_alias" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "hub_setting" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "service_zone" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service_zone" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service_zone_alias" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service_zone_alias" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_setting" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_setting" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_zone_read" ON "service_zone" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN melarc.hub_scope_mode() = 'ALL' OR hub_id = ANY (melarc.authorized_hub_ids())
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'configuration'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "service_zone_alias_read" ON "service_zone_alias" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN melarc.hub_scope_mode() = 'ALL' OR hub_id = ANY (melarc.authorized_hub_ids())
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'configuration'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "hub_setting_read" ON "hub_setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN melarc.hub_scope_mode() = 'ALL' OR hub_id = ANY (melarc.authorized_hub_ids())
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'configuration'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "service_zone_seed_read" ON "service_zone" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "service_zone_seed_insert" ON "service_zone" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "service_zone_alias_seed_read" ON "service_zone_alias" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "service_zone_alias_seed_insert" ON "service_zone_alias" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "hub_setting_seed_read" ON "hub_setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "hub_setting_seed_insert" ON "hub_setting" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
-- The configuration capability reads the company-wide business rules (liability cap, declaration threshold, global limits) and no
-- security parameter: the PLATFORM-scope rows (rate limits, lifetimes, attempt limits) stay behind the capabilities that need them.
CREATE POLICY "setting_configuration_read" ON "setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'configuration' AND scope = 'COMPANY'
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ON "service_zone" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "service_zone_alias" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "hub_setting" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.hub_configuration_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the hub configuration is never changed in place: % of a row of % is refused; a new version is a new row', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.hub_configuration_immutable() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.hub_configuration_immutable() FROM PUBLIC;
--> statement-breakpoint
-- allow-delete: the trigger refuses UPDATE and DELETE of a row of the hub's configuration for every login, the owner included
CREATE TRIGGER "service_zone_immutable" BEFORE UPDATE OR DELETE ON "service_zone"
  FOR EACH ROW EXECUTE FUNCTION melarc.hub_configuration_immutable();
--> statement-breakpoint
-- allow-delete: the trigger refuses UPDATE and DELETE of a row of the hub's configuration for every login, the owner included
CREATE TRIGGER "service_zone_alias_immutable" BEFORE UPDATE OR DELETE ON "service_zone_alias"
  FOR EACH ROW EXECUTE FUNCTION melarc.hub_configuration_immutable();
--> statement-breakpoint
-- allow-delete: the trigger refuses UPDATE and DELETE of a row of the hub's configuration for every login, the owner included
CREATE TRIGGER "hub_setting_immutable" BEFORE UPDATE OR DELETE ON "hub_setting"
  FOR EACH ROW EXECUTE FUNCTION melarc.hub_configuration_immutable();
--> statement-breakpoint
-- melarc.seed_hub_configuration: the one way rows enter these tables (MIGRATION_AND_SEEDING.md sections 4 and 5.1). It is the shape of
-- melarc.add_reason_fixtures: a SECURITY DEFINER function owned by melarc_owner, executable by melarc_provisioning alone, that names
-- every table and column itself (no dynamic statement), fixes its search_path, takes its rows as one JSON document, sets the SYSTEM
-- context and the seed capability for its own statements and puts back what the caller had. Once, atomically, serialized: it locks
-- the three tables, then refuses (SQLSTATE 55000, naming the table and its rows) unless all three are empty, so a second run
-- changes nothing and a failed one leaves nothing. The payload holds service_zone and hub_setting (each a non-empty array) and may
-- hold service_zone_alias (none is seeded: the alias data is the Product Owner's to supply). effective_from is the transaction's own
-- time and created_by the reserved system actor, so a caller cannot choose either.
CREATE FUNCTION melarc.seed_hub_configuration(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  found bigint;
  inserted bigint;
  planned bigint;
  report jsonb := '{}'::jsonb;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the hub configuration is seeded at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  IF payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'object'
     OR pg_catalog.jsonb_typeof(payload -> 'service_zone') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(payload -> 'service_zone') = 0
     OR pg_catalog.jsonb_typeof(payload -> 'hub_setting') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(payload -> 'hub_setting') = 0
     OR (payload ? 'service_zone_alias'
         AND (pg_catalog.jsonb_typeof(payload -> 'service_zone_alias') IS DISTINCT FROM 'array'
              OR pg_catalog.jsonb_array_length(payload -> 'service_zone_alias') = 0))
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_object_keys(payload) AS k(name)
        WHERE k.name NOT IN ('service_zone', 'service_zone_alias', 'hub_setting')
     ) THEN
    RAISE EXCEPTION 'the payload is one JSON object with a non-empty array of service_zone rows, a non-empty array of hub_setting rows and, optionally, a non-empty array of service_zone_alias rows' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.service_zone, public.service_zone_alias, public.hub_setting IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);

  SELECT pg_catalog.count(*) INTO found FROM public.service_zone;
  IF found <> 0 THEN
    RAISE EXCEPTION 'the hub configuration is already seeded: table service_zone holds % rows', found
      USING ERRCODE = '55000', TABLE = 'service_zone', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;
  SELECT pg_catalog.count(*) INTO found FROM public.service_zone_alias;
  IF found <> 0 THEN
    RAISE EXCEPTION 'the hub configuration is already seeded: table service_zone_alias holds % rows', found
      USING ERRCODE = '55000', TABLE = 'service_zone_alias', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;
  SELECT pg_catalog.count(*) INTO found FROM public.hub_setting;
  IF found <> 0 THEN
    RAISE EXCEPTION 'the hub configuration is already seeded: table hub_setting holds % rows', found
      USING ERRCODE = '55000', TABLE = 'hub_setting', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;

  planned := pg_catalog.jsonb_array_length(payload -> 'service_zone');
  INSERT INTO public.service_zone (id, hub_id, code, name, service_area)
    SELECT r.id, r.hub_id, r.code, r.name, r.service_area
      FROM pg_catalog.jsonb_populate_recordset(NULL::public.service_zone, payload -> 'service_zone') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> planned THEN
    RAISE EXCEPTION 'table service_zone received % of % rows', inserted, planned USING ERRCODE = '22023', TABLE = 'service_zone';
  END IF;
  report := report || pg_catalog.jsonb_build_object('service_zone', inserted);

  IF payload ? 'service_zone_alias' THEN
    planned := pg_catalog.jsonb_array_length(payload -> 'service_zone_alias');
    INSERT INTO public.service_zone_alias (id, hub_id, zone_id, alias, kind)
      SELECT r.id, r.hub_id, r.zone_id, r.alias, r.kind
        FROM pg_catalog.jsonb_populate_recordset(NULL::public.service_zone_alias, payload -> 'service_zone_alias') AS r;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted <> planned THEN
      RAISE EXCEPTION 'table service_zone_alias received % of % rows', inserted, planned USING ERRCODE = '22023', TABLE = 'service_zone_alias';
    END IF;
    report := report || pg_catalog.jsonb_build_object('service_zone_alias', inserted);
  END IF;

  planned := pg_catalog.jsonb_array_length(payload -> 'hub_setting');
  INSERT INTO public.hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
    SELECT pg_catalog.gen_random_uuid(), r.hub_id, r.setting_key, r.scope_ref, r.version, r.value, r.unit,
           pg_catalog.transaction_timestamp(), melarc.reserved_system_actor_id()
      FROM pg_catalog.jsonb_populate_recordset(NULL::public.hub_setting, payload -> 'hub_setting') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> planned THEN
    RAISE EXCEPTION 'table hub_setting received % of % rows', inserted, planned USING ERRCODE = '22023', TABLE = 'hub_setting';
  END IF;
  report := report || pg_catalog.jsonb_build_object('hub_setting', inserted);

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN report;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.seed_hub_configuration(jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.seed_hub_configuration(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.seed_hub_configuration(jsonb) TO melarc_provisioning;
