-- Reference data (S0.8). Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
-- Everything created here is owned by melarc_owner; no runtime role owns anything.
--
-- Seven tables the API reads and a seed fills (MIGRATION_AND_SEEDING.md section 4): the hub registry, the closed permission
-- catalogue, the role bundles with their grants, the fixed Vendor and Rider policy, the platform and company-wide settings and
-- the reason catalogue. All seven are class PLATFORM in data-scope-registry.md section 4.1. The CREATE TABLE statements and the
-- foreign keys below are the generated part (drizzle-kit, from src/platform/database/schema/reference-data.ts); the rest of
-- this file is written by hand, as that section requires, and is in this migration so that no table exists for a moment
-- without its owner, row-level security, policies and grants.
--
-- Row-level security (data-scope-registry.md section 4.1, the Staff, Vendor, Rider and SYSTEM columns): STAFF reads every row
-- ("global"); SYSTEM reads under the authentication capability alone (the session snapshot is built from bundles and grants);
-- every other principal, and a request with no context, is denied by the closed ELSE. Nothing here lets any principal write: the
-- runtime login holds SELECT and nothing more, and the three policy tables (role_bundle, role_bundle_grant,
-- fixed_permission_policy) never give it more, because a row lock needs UPDATE and the policy protocol coordinates by advisory lock
-- instead (SECURITY_DESIGN.md section 13.10a). The seed's SYSTEM branch (capability seed) and the grants of the provisioning
-- login arrive with the seed (S0.9), in their own migration.
--
-- The two counter guards below keep the contract's rule at the table, whoever writes it: a revision rises by exactly one, the
-- floor moves only together with a raise of the revision and then to the new revision (a reduction), and a bundle never changes
-- audience. The primitive that raises them under the exclusive policy lock is SLICE-009's and the seed's.

CREATE TABLE "fixed_permission_policy" (
	"principal_type" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"minimum_revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "fixed_permission_policy_principal_closed" CHECK ("fixed_permission_policy"."principal_type" IN ('VENDOR', 'RIDER')),
	CONSTRAINT "fixed_permission_policy_revision_positive" CHECK ("fixed_permission_policy"."revision" >= 1),
	CONSTRAINT "fixed_permission_policy_minimum_in_range" CHECK ("fixed_permission_policy"."minimum_revision" >= 1 AND "fixed_permission_policy"."minimum_revision" <= "fixed_permission_policy"."revision")
);
--> statement-breakpoint
CREATE TABLE "hub" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_name_key" UNIQUE("name"),
	CONSTRAINT "hub_name_not_empty" CHECK (length(btrim("hub"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "permission" (
	"key" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	CONSTRAINT "permission_key_grammar" CHECK ("permission"."key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$'),
	CONSTRAINT "permission_domain_closed" CHECK ("permission"."domain" IN ('pickup', 'hub', 'pricing', 'dispatch', 'delivery', 'payment', 'settlement', 'returns', 'vendor', 'staff', 'notification', 'report', 'settings', 'fleet', 'courier', 'audit', 'permission')),
	CONSTRAINT "permission_domain_is_key_prefix" CHECK (split_part("permission"."key", '.', 1) = "permission"."domain")
);
--> statement-breakpoint
CREATE TABLE "reason_code" (
	"code" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"valid_checkpoints" text[],
	"label" text NOT NULL,
	"requires_note" boolean DEFAULT false NOT NULL,
	"requires_photo" boolean DEFAULT false NOT NULL,
	"requires_contact_attempt" boolean DEFAULT false NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"attribution" text NOT NULL,
	"consumes_delivery_attempt" boolean DEFAULT false NOT NULL,
	"requires_ops_review" boolean DEFAULT false NOT NULL,
	"requires_escalation" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"permitted_operations" text[],
	CONSTRAINT "reason_code_code_grammar" CHECK ("reason_code"."code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "reason_code_label_not_empty" CHECK (length(btrim("reason_code"."label")) > 0),
	CONSTRAINT "reason_code_domain_closed" CHECK ("reason_code"."domain" IN ('DELIVERY_FAILURE', 'RECIPIENT_CONTACT', 'PICKUP_STOP_SKIP', 'HANDOFF_FAILURE', 'SESSION_REVOCATION', 'STAFF_PROFILE_REJECTION', 'STAFF_MFA_RESET', 'CREDENTIAL_ADMINISTRATION', 'RIDER_DEVICE_REPLACEMENT', 'RIDER_DEVICE_REVOCATION')),
	CONSTRAINT "reason_code_attribution_closed" CHECK ("reason_code"."attribution" IN ('CUSTOMER', 'MELARC', 'EXTERNAL')),
	CONSTRAINT "reason_code_checkpoints_by_domain" CHECK (("reason_code"."domain" = 'RECIPIENT_CONTACT' AND "reason_code"."valid_checkpoints" IS NOT NULL AND cardinality("reason_code"."valid_checkpoints") >= 1 AND "reason_code"."valid_checkpoints" <@ ARRAY['PRE_DISPATCH', 'NEXT_STOP', 'DOORSTEP']::text[]) OR ("reason_code"."domain" <> 'RECIPIENT_CONTACT' AND "reason_code"."valid_checkpoints" IS NULL)),
	CONSTRAINT "reason_code_operations_by_domain" CHECK (("reason_code"."domain" IN ('SESSION_REVOCATION', 'STAFF_PROFILE_REJECTION', 'STAFF_MFA_RESET', 'CREDENTIAL_ADMINISTRATION', 'RIDER_DEVICE_REPLACEMENT', 'RIDER_DEVICE_REVOCATION') AND "reason_code"."permitted_operations" IS NOT NULL AND cardinality("reason_code"."permitted_operations") >= 1 AND "reason_code"."permitted_operations"::text ~ '^\{[A-Za-z][A-Za-z0-9]*(#[A-Z][A-Z_]*)?(,[A-Za-z][A-Za-z0-9]*(#[A-Z][A-Z_]*)?)*\}$') OR ("reason_code"."domain" NOT IN ('SESSION_REVOCATION', 'STAFF_PROFILE_REJECTION', 'STAFF_MFA_RESET', 'CREDENTIAL_ADMINISTRATION', 'RIDER_DEVICE_REPLACEMENT', 'RIDER_DEVICE_REVOCATION') AND "reason_code"."permitted_operations" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "role_bundle" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"audience" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"reduction_floor" integer DEFAULT 1 NOT NULL,
	"privileged" boolean NOT NULL,
	CONSTRAINT "role_bundle_name_key" UNIQUE("name"),
	CONSTRAINT "role_bundle_name_not_empty" CHECK (length(btrim("role_bundle"."name")) > 0),
	CONSTRAINT "role_bundle_audience_closed" CHECK ("role_bundle"."audience" IN ('STAFF', 'RIDER', 'VENDOR')),
	CONSTRAINT "role_bundle_revision_positive" CHECK ("role_bundle"."revision" >= 1),
	CONSTRAINT "role_bundle_floor_in_range" CHECK ("role_bundle"."reduction_floor" >= 1 AND "role_bundle"."reduction_floor" <= "role_bundle"."revision")
);
--> statement-breakpoint
CREATE TABLE "role_bundle_grant" (
	"bundle_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"hub_scope" text NOT NULL,
	"ownership_scope" text NOT NULL,
	"tier" text NOT NULL,
	CONSTRAINT "role_bundle_grant_pkey" PRIMARY KEY("bundle_id","permission_key"),
	CONSTRAINT "role_bundle_grant_hub_scope_closed" CHECK ("role_bundle_grant"."hub_scope" IN ('none', 'own', 'all')),
	CONSTRAINT "role_bundle_grant_ownership_scope_closed" CHECK ("role_bundle_grant"."ownership_scope" IN ('own', 'assigned', 'any')),
	CONSTRAINT "role_bundle_grant_tier_closed" CHECK ("role_bundle_grant"."tier" IN ('A', 'S', 'P'))
);
--> statement-breakpoint
CREATE TABLE "setting" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"value_type" text NOT NULL,
	"value" jsonb NOT NULL,
	"unit" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setting_key_grammar" CHECK ("setting"."key" ~ '^[A-Za-z][A-Za-z0-9_]*$'),
	CONSTRAINT "setting_scope_closed" CHECK ("setting"."scope" IN ('COMPANY', 'PLATFORM')),
	CONSTRAINT "setting_value_type_closed" CHECK ("setting"."value_type" IN ('integer', 'decimal', 'boolean', 'string', 'list', 'object')),
	CONSTRAINT "setting_unit_not_empty" CHECK (length(btrim("setting"."unit")) > 0),
	CONSTRAINT "setting_description_not_empty" CHECK (length(btrim("setting"."description")) > 0)
);
--> statement-breakpoint
ALTER TABLE "role_bundle_grant" ADD CONSTRAINT "role_bundle_grant_bundle_fkey" FOREIGN KEY ("bundle_id") REFERENCES "public"."role_bundle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bundle_grant" ADD CONSTRAINT "role_bundle_grant_permission_fkey" FOREIGN KEY ("permission_key") REFERENCES "public"."permission"("key") ON DELETE restrict ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "hub" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "permission" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "role_bundle" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "role_bundle_grant" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "fixed_permission_policy" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "setting" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "reason_code" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "hub" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "permission" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "permission" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "role_bundle" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "role_bundle" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "role_bundle_grant" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "role_bundle_grant" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fixed_permission_policy" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fixed_permission_policy" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "setting" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "setting" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reason_code" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reason_code" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hub_read" ON "hub" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN true
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "permission_read" ON "permission" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN true
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "role_bundle_read" ON "role_bundle" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN true
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "role_bundle_grant_read" ON "role_bundle_grant" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN true
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "fixed_permission_policy_read" ON "fixed_permission_policy" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN true
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setting_read" ON "setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN true
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "reason_code_read" ON "reason_code" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN true
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ON "hub" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "permission" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "role_bundle" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "role_bundle_grant" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "fixed_permission_policy" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "setting" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "reason_code" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.role_bundle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.fixed_permission_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.principal_type IS DISTINCT FROM OLD.principal_type THEN
    RAISE EXCEPTION 'a fixed policy row never changes principal type' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'a fixed policy revision rises by exactly one' USING ERRCODE = '23514';
  END IF;
  IF NEW.minimum_revision <> OLD.minimum_revision
     AND NOT (NEW.revision = OLD.revision + 1 AND NEW.minimum_revision = NEW.revision) THEN
    RAISE EXCEPTION 'a fixed policy floor moves only with a reduction, to the new revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.role_bundle_guard() OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.fixed_permission_policy_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.role_bundle_guard() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.fixed_permission_policy_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "role_bundle_guard" BEFORE UPDATE ON "role_bundle"
  FOR EACH ROW EXECUTE FUNCTION melarc.role_bundle_guard();
--> statement-breakpoint
CREATE TRIGGER "fixed_permission_policy_guard" BEFORE UPDATE ON "fixed_permission_policy"
  FOR EACH ROW EXECUTE FUNCTION melarc.fixed_permission_policy_guard();
