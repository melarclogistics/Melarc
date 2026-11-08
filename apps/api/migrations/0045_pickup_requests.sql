-- S1.10 and S1.13 (SLICE-001; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md): a vendor's saved pickup locations and financial standing,
-- the ad-hoc sender and the pickup request (domain-model.md sections 6.2, 6.16, 6.18; data-scope-registry.md `VendorPickupLocation`,
-- `AdHocSender`, `PickupRequest`). Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
-- The CREATE TABLE statements and the foreign keys are the generated part (drizzle-kit, from src/vendor/vendor-pickup-location.schema.ts,
-- src/vendor/vendor-financial-standing.schema.ts, src/pickup/ad-hoc-sender.schema.ts and src/pickup/pickup-request.schema.ts); the rest of
-- this file is written by hand and is in this migration so that no table exists for a moment without its owner, row-level security,
-- policies, grants and triggers.
--
-- Who reads and writes (registry sections 4 and 5; the authorization key is the permission of the operation, set by the data layer from the
-- grant that authorizes it, as the policies of 0024 and 0029 rely on):
--
--   * vendor_pickup_location, vendor_financial_standing: read-only in this slice. A STAFF context reads the master (a pickup address is
--     what an Ops user needs to associate a booking) and a VENDOR context its own organisation's, each only while the operation's key is
--     of the pickup or vendor domain. The runtime holds SELECT and no write; the rows come from the non-production fixture and the test
--     kit, and later from SLICE-008 and SLICE-011.
--   * ad_hoc_sender: global (a phone identity is platform-wide). A STAFF context reads it under a pickup or vendor key and inserts it only
--     under pickup.request.create, the one operation that creates a sender together with its request. A vendor, a rider and a recipient
--     read none. Nothing updates a sender yet (the promotion to REUSABLE belongs to the collection that completes).
--   * pickup_request: a STAFF context reads the requests of the hubs of the operation's grant under a pickup, hub, pricing or fleet key,
--     and writes only under the key of the operation that does (an insert under the keys that create a request or its replacement, an
--     update under the keys that confirm, cancel, waive, extend, resolve or approve); a VENDOR context reads and creates its own
--     organisation's and updates it only to cancel while it is PENDING, and never by hub. A scope probe lets a staff member's miss be told
--     apart from a record that does not exist (SECURITY_DESIGN.md section 14.4b), in a policy FOR SELECT only. Every other principal and a
--     request with no context are denied by the closed ELSE. Nobody deletes a request.
--   * vendor_organization: a STAFF context under a key of the pickup domain reads the organisations (the master record a booking is
--     associated with, registry VendorOrganization: global), beside the policy of 0034 for the vendor keys; a vendor reads its own as before.
--   * hub: the `configuration` capability reads a hub (its name, for the hub code of an operational code, MSC-DEC-202) on behalf of any
--     principal, as it reads the hub's zones and settings (0042): a vendor session books without being able to read the hub table.

CREATE TABLE "vendor_pickup_location" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vendor_organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"location" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone,
	CONSTRAINT "vendor_pickup_location_label_not_blank" CHECK (length(btrim("vendor_pickup_location"."label")) > 0),
	CONSTRAINT "vendor_pickup_location_default_is_active" CHECK (NOT "vendor_pickup_location"."is_default" OR "vendor_pickup_location"."active"),
	CONSTRAINT "vendor_pickup_location_has_address" CHECK (jsonb_typeof("vendor_pickup_location"."location") = 'object' AND coalesce(length(btrim("vendor_pickup_location"."location"->>'address')), 0) > 0)
);
--> statement-breakpoint
CREATE TABLE "vendor_financial_standing" (
	"vendor_organization_id" uuid PRIMARY KEY NOT NULL,
	"financial_status" text DEFAULT 'GOOD' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_financial_standing_status_closed" CHECK ("vendor_financial_standing"."financial_status" IN ('GOOD', 'OVERDUE'))
);
--> statement-breakpoint
CREATE TABLE "ad_hoc_sender" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"phone_as_entered" text NOT NULL,
	"business_name" text,
	"pickup_contact_name" text,
	"pickup_location" jsonb,
	"state" text DEFAULT 'PROVISIONAL' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_hoc_sender_phone_key" UNIQUE("phone"),
	CONSTRAINT "ad_hoc_sender_name_not_blank" CHECK (length(btrim("ad_hoc_sender"."name")) > 0),
	CONSTRAINT "ad_hoc_sender_phone_e164" CHECK ("ad_hoc_sender"."phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "ad_hoc_sender_state_closed" CHECK ("ad_hoc_sender"."state" IN ('PROVISIONAL', 'REUSABLE')),
	CONSTRAINT "ad_hoc_sender_location_has_address" CHECK ("ad_hoc_sender"."pickup_location" IS NULL OR (jsonb_typeof("ad_hoc_sender"."pickup_location") = 'object' AND coalesce(length(btrim("ad_hoc_sender"."pickup_location"->>'address')), 0) > 0))
);
--> statement-breakpoint
CREATE TABLE "pickup_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"vendor_organization_id" uuid,
	"ad_hoc_sender_id" uuid,
	"sender_name" text NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"pickup_intent" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"declared_package_count" integer NOT NULL,
	"one_package_exception_id" uuid,
	"pickup_location" jsonb,
	"resolved_pickup_location" jsonb NOT NULL,
	"collection_point" jsonb,
	"collection_reference" jsonb,
	"collection_item" jsonb,
	"destination_location_id" uuid,
	"vendor_pickup_location_id" uuid,
	"primary_phone" text NOT NULL,
	"secondary_phone" text,
	"current_item_description" text,
	"scheduled_service_date" date NOT NULL,
	"location_overrides" jsonb,
	"default_payer_intent" text NOT NULL,
	"split_basis" text,
	"split_sender_amount_minor" integer,
	"split_sender_percentage" numeric(5, 2),
	"declared_value_minor" integer,
	"liability_cap_acknowledged_at" timestamp with time zone,
	"liability_cap_snapshot" jsonb,
	"estimate_snapshot" jsonb,
	"cutoff_exception_state" text,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"attempt_extension_id" uuid,
	"replaces_request_id" uuid,
	"replacement_request_id" uuid,
	"cancellation_reason_code" text,
	"cancellation_reason_label" text,
	"cancelled_by_actor_type" text,
	"cancellation_charge_outcome" text,
	"cancellation_charge_snapshot" jsonb,
	"cancellation_charge_reason_code" text,
	"cancellation_charge_reason_label" text,
	"cancellation_charge_waived_by" uuid,
	"cancellation_charge_waiver_note" text,
	"rider_assigned" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "pickup_request_code_format" CHECK ("pickup_request"."code" ~ '^[A-Z]{3}-PR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$'),
	CONSTRAINT "pickup_request_state_closed" CHECK ("pickup_request"."state" IN ('PENDING', 'CONFIRMED', 'DECLINED', 'CANCELLED')),
	CONSTRAINT "pickup_request_intent_closed" CHECK ("pickup_request"."pickup_intent" IN ('OWN_PACKAGES', 'COLLECT_FOR_VENDOR', 'ADHOC_SENDER')),
	CONSTRAINT "pickup_request_one_sender" CHECK (("pickup_request"."pickup_intent" = 'ADHOC_SENDER' AND "pickup_request"."ad_hoc_sender_id" IS NOT NULL AND "pickup_request"."vendor_organization_id" IS NULL) OR ("pickup_request"."pickup_intent" <> 'ADHOC_SENDER' AND "pickup_request"."vendor_organization_id" IS NOT NULL AND "pickup_request"."ad_hoc_sender_id" IS NULL)),
	CONSTRAINT "pickup_request_minimum_packages" CHECK ("pickup_request"."declared_package_count" >= 2 OR "pickup_request"."one_package_exception_id" IS NOT NULL OR "pickup_request"."state" IN ('PENDING', 'CANCELLED', 'DECLINED')),
	CONSTRAINT "pickup_request_package_count_positive" CHECK ("pickup_request"."declared_package_count" >= 1),
	CONSTRAINT "pickup_request_attempt_positive" CHECK ("pickup_request"."attempt_number" >= 1),
	CONSTRAINT "pickup_request_collection_shape" CHECK (("pickup_request"."pickup_intent" = 'COLLECT_FOR_VENDOR') = ("pickup_request"."collection_point" IS NOT NULL) AND ("pickup_request"."pickup_intent" = 'COLLECT_FOR_VENDOR') = ("pickup_request"."destination_location_id" IS NOT NULL)),
	CONSTRAINT "pickup_request_payer_intent_closed" CHECK ("pickup_request"."default_payer_intent" IN ('RECIPIENT_PAYS', 'SENDER_PAYS_FULL', 'SPLIT')),
	CONSTRAINT "pickup_request_split_consistent" CHECK (("pickup_request"."default_payer_intent" = 'SPLIT') = ("pickup_request"."split_basis" IS NOT NULL) AND ("pickup_request"."split_basis" = 'FIXED_AMOUNT') = ("pickup_request"."split_sender_amount_minor" IS NOT NULL) AND ("pickup_request"."split_basis" = 'PERCENTAGE') = ("pickup_request"."split_sender_percentage" IS NOT NULL)),
	CONSTRAINT "pickup_request_split_basis_closed" CHECK ("pickup_request"."split_basis" IS NULL OR "pickup_request"."split_basis" IN ('FIXED_AMOUNT', 'PERCENTAGE')),
	CONSTRAINT "pickup_request_cap_acknowledgement" CHECK (("pickup_request"."liability_cap_acknowledged_at" IS NULL) = ("pickup_request"."liability_cap_snapshot" IS NULL)),
	CONSTRAINT "pickup_request_cutoff_state_closed" CHECK ("pickup_request"."cutoff_exception_state" IS NULL OR "pickup_request"."cutoff_exception_state" IN ('PENDING_OPS_REVIEW', 'SAME_DAY_APPROVED', 'RESCHEDULED')),
	CONSTRAINT "pickup_request_charge_outcome_closed" CHECK ("pickup_request"."cancellation_charge_outcome" IS NULL OR "pickup_request"."cancellation_charge_outcome" IN ('APPLIED', 'WAIVED', 'NOT_APPLIED', 'UNAVAILABLE', 'EXEMPT')),
	CONSTRAINT "pickup_request_cancelling_actor_closed" CHECK ("pickup_request"."cancelled_by_actor_type" IS NULL OR "pickup_request"."cancelled_by_actor_type" IN ('VENDOR', 'OPS')),
	CONSTRAINT "pickup_request_confirmation_facts" CHECK (("pickup_request"."confirmed_at" IS NULL) = ("pickup_request"."confirmed_by" IS NULL) AND ("pickup_request"."state" <> 'CONFIRMED' OR "pickup_request"."confirmed_at" IS NOT NULL)),
	CONSTRAINT "pickup_request_cancellation_facts" CHECK (("pickup_request"."state" = 'CANCELLED') = ("pickup_request"."cancelled_at" IS NOT NULL) AND ("pickup_request"."cancelled_at" IS NULL) = ("pickup_request"."cancelled_by" IS NULL) AND ("pickup_request"."state" = 'CANCELLED' OR ("pickup_request"."cancellation_reason_code" IS NULL AND "pickup_request"."cancelled_by_actor_type" IS NULL AND "pickup_request"."cancellation_charge_outcome" IS NULL))),
	CONSTRAINT "pickup_request_waiver_facts" CHECK (coalesce("pickup_request"."cancellation_charge_outcome" = 'WAIVED', false) = ("pickup_request"."cancellation_charge_waived_by" IS NOT NULL) AND ("pickup_request"."cancellation_charge_snapshot" IS NOT NULL) = coalesce("pickup_request"."cancellation_charge_outcome" IN ('APPLIED', 'WAIVED'), false)),
	CONSTRAINT "pickup_request_phone_not_blank" CHECK (length(btrim("pickup_request"."primary_phone")) > 0)
);
--> statement-breakpoint
ALTER TABLE "vendor_pickup_location" ADD CONSTRAINT "vendor_pickup_location_org_fkey" FOREIGN KEY ("vendor_organization_id") REFERENCES "public"."vendor_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_financial_standing" ADD CONSTRAINT "vendor_financial_standing_org_fkey" FOREIGN KEY ("vendor_organization_id") REFERENCES "public"."vendor_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_vendor_fkey" FOREIGN KEY ("vendor_organization_id") REFERENCES "public"."vendor_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_sender_fkey" FOREIGN KEY ("ad_hoc_sender_id") REFERENCES "public"."ad_hoc_sender"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_hub_fkey" FOREIGN KEY ("responsible_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_destination_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "public"."vendor_pickup_location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_location_fkey" FOREIGN KEY ("vendor_pickup_location_id") REFERENCES "public"."vendor_pickup_location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_replaces_fkey" FOREIGN KEY ("replaces_request_id") REFERENCES "public"."pickup_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_replacement_fkey" FOREIGN KEY ("replacement_request_id") REFERENCES "public"."pickup_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_pickup_location_org_idx" ON "vendor_pickup_location" USING btree ("vendor_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_pickup_location_one_default" ON "vendor_pickup_location" USING btree ("vendor_organization_id") WHERE "vendor_pickup_location"."is_default" AND "vendor_pickup_location"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_request_code_key" ON "pickup_request" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_request_replaces_once" ON "pickup_request" USING btree ("replaces_request_id") WHERE "pickup_request"."replaces_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pickup_request_hub_idx" ON "pickup_request" USING btree ("responsible_hub_id","state","scheduled_service_date");--> statement-breakpoint
CREATE INDEX "pickup_request_vendor_idx" ON "pickup_request" USING btree ("vendor_organization_id","created_at");

--> statement-breakpoint
ALTER TABLE "vendor_pickup_location" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "vendor_financial_standing" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "ad_hoc_sender" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "pickup_request" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "vendor_pickup_location" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendor_pickup_location" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendor_financial_standing" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendor_financial_standing" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ad_hoc_sender" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ad_hoc_sender" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pickup_request" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pickup_request" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vendor_pickup_location_read" ON "vendor_pickup_location" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'vendor')
    WHEN 'VENDOR' THEN vendor_organization_id = melarc.current_vendor_organization_id() AND split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'vendor')
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "vendor_organization_pickup_read" ON "vendor_organization" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup')
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "vendor_financial_standing_read" ON "vendor_financial_standing" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'vendor')
    WHEN 'VENDOR' THEN vendor_organization_id = melarc.current_vendor_organization_id() AND split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'vendor')
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "ad_hoc_sender_read" ON "ad_hoc_sender" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'vendor')
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "ad_hoc_sender_insert" ON "ad_hoc_sender" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.request.create')
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_request_read" ON "pickup_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'hub', 'pricing', 'fleet') AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN vendor_organization_id = melarc.current_vendor_organization_id() AND split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'pricing')
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_request_probe" ON "pickup_request" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
--> statement-breakpoint
CREATE POLICY "pickup_request_insert" ON "pickup_request" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.request.create', 'pickup.request.cancel', 'pickup.request.cancel_chargeable', 'pickup.failure.resolve') AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.request.create') AND vendor_organization_id = melarc.current_vendor_organization_id() AND state = 'PENDING'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_request_update" ON "pickup_request" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.request.confirm', 'pickup.request.cancel', 'pickup.request.cancel_chargeable', 'pickup.cancellation_charge.waive', 'pickup.attempt.extend', 'pickup.failure.resolve', 'pickup.exception.approve') AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.request.cancel') AND vendor_organization_id = melarc.current_vendor_organization_id() AND state = 'PENDING'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.request.confirm', 'pickup.request.cancel', 'pickup.request.cancel_chargeable', 'pickup.cancellation_charge.waive', 'pickup.attempt.extend', 'pickup.failure.resolve', 'pickup.exception.approve') AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.request.cancel') AND vendor_organization_id = melarc.current_vendor_organization_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "hub_configuration_read" ON "hub" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'configuration'
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ON "vendor_pickup_location" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "vendor_financial_standing" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON "ad_hoc_sender" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "pickup_request" TO melarc_api_runtime;
--> statement-breakpoint
-- The guard of a pickup request: what no login may change, whatever the policy admits, and the only moves of its state (state-machines.md
-- section 3). It refuses a change of the identity of the request (its id, code, sender, hub, intent, creator and moment of creation) and of
-- its chain position, which a replacement fixes at its insert, and any transition but PENDING to CONFIRMED, PENDING to CANCELLED and
-- CONFIRMED to CANCELLED (DECLINED is not built). A CANCELLED request is frozen but for the waiver of its applied charge: the outcome moves
-- from APPLIED to WAIVED with the actor and the note, and nothing else changes. Everything else a request may change (its estimate, its
-- payer intent and locations before it is manifested, its cutoff state, the extension that lifts its cap) is decided by the operations.
CREATE FUNCTION melarc.pickup_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.vendor_organization_id IS DISTINCT FROM OLD.vendor_organization_id
     OR NEW.ad_hoc_sender_id IS DISTINCT FROM OLD.ad_hoc_sender_id
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.pickup_intent IS DISTINCT FROM OLD.pickup_intent
     OR NEW.declared_package_count IS DISTINCT FROM OLD.declared_package_count
     OR NEW.replaces_request_id IS DISTINCT FROM OLD.replaces_request_id
     OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a pickup request keeps its identity, its sender, its hub, its intent, its package count and its place in the chain' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'PENDING' AND NEW.state IN ('CONFIRMED', 'CANCELLED'))
       OR (OLD.state = 'CONFIRMED' AND NEW.state = 'CANCELLED')
     ) THEN
    RAISE EXCEPTION 'a pickup request moves from PENDING to CONFIRMED or CANCELLED and from CONFIRMED to CANCELLED, and no other way' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'CANCELLED' THEN
    IF NOT (
      OLD.cancellation_charge_outcome = 'APPLIED'
      AND NEW.cancellation_charge_outcome = 'WAIVED'
      AND NEW.cancellation_charge_waived_by IS NOT NULL
      AND (to_jsonb(NEW) - 'cancellation_charge_outcome' - 'cancellation_charge_waived_by' - 'cancellation_charge_waiver_note' - 'version')
          = (to_jsonb(OLD) - 'cancellation_charge_outcome' - 'cancellation_charge_waived_by' - 'cancellation_charge_waiver_note' - 'version')
    ) THEN
      RAISE EXCEPTION 'a cancelled pickup request is frozen but for the waiver of its applied charge' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_request_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_request_guard() FROM PUBLIC;
--> statement-breakpoint
-- The version (the ETag of a read of the request): the database moves it, whatever the update says, to the next one when anything about
-- the row changed and keeps it otherwise. Fired after the guard (triggers of one event run by name).
CREATE FUNCTION melarc.pickup_request_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version') THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_request_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_request_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pickup_request_guard" BEFORE UPDATE ON "pickup_request"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_request_guard();
--> statement-breakpoint
CREATE TRIGGER "pickup_request_version" BEFORE UPDATE ON "pickup_request"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_request_version();
