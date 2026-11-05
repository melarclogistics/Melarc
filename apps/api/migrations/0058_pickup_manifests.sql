-- S1.20 (SLICE-001; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md): the pickup manifest and its stops (domain-model.md sections 6.3 and
-- 6.4; data-scope-registry.md `PickupManifest`, `PickupStop`). Applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). The CREATE TABLE statements, the foreign keys and the indexes are the generated part
-- (drizzle-kit, from src/pickup/pickup-manifest.schema.ts and src/pickup/pickup-stop.schema.ts); the rest of this file is written by hand and
-- is in this migration so that no table exists for a moment without its owner, row-level security, policies, grants and triggers.
--
-- Who reads and writes (registry section 4.2; the authorization key is the permission of the operation, set by the data layer from the
-- grant that authorizes it, as the policies of 0024, 0029 and 0045 rely on):
--
--   * pickup_manifest: a STAFF context reads the manifests of the hubs of the operation's grant under a key of the pickup domain, and
--     inserts one only under pickup.manifest.create, and only as a DRAFT. A RIDER context reads a manifest only while it is assigned to
--     that rider and has been dispatched (a draft is not shown to its rider, nor is a manifest that was cancelled before it was
--     dispatched); the read follows the assignment at once, so a rider that is replaced loses it. A VENDOR context reads none: a manifest
--     carries the stops of many vendors (registry). Nothing updates a manifest in this task (its policies and the UPDATE grant arrive with
--     S1.21), and nobody deletes one. A scope probe lets a staff member's miss be told apart from a record that does not exist
--     (SECURITY_DESIGN.md section 14.4b), in a policy FOR SELECT only.
--   * pickup_stop: a STAFF context reads the stops of the hubs of the grant and inserts them only under pickup.manifest.create. A RIDER
--     context reads the stops of a manifest it can read, through that manifest and never through the hub (the registry: child rows
--     inherit the rider assignment from the authoritative manifest relationship). A VENDOR context reads none in this slice: the
--     registry's vendor read of its own stop (through its own request) is a deferred capability, not a change of the registry, and
--     arrives with the first operation that needs it (OB-S1-23). Nothing updates a stop in this task.
--   * The claim: one unreleased stop per request (pickup_stop_request_claim). A stop keeps its request claimed until released_at is set by
--     an explicit authorized act, and the guard below holds that the release is one-way. A skip does not release.
--   * The guards hold what no login may change whatever the policy admits: the identity of a manifest and of a stop, the moves of their
--     states (state-machines.md sections 4 and 5), the frozen terminal rows and the one-way release. The database moves `version`.

CREATE TABLE "pickup_manifest" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"assigned_rider_id" uuid,
	"assigned_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pickup_manifest_code_format" CHECK ("pickup_manifest"."code" ~ '^[A-Z]{3}-MF-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$'),
	CONSTRAINT "pickup_manifest_state_closed" CHECK ("pickup_manifest"."state" IN ('DRAFT', 'DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "pickup_manifest_assignment_pair" CHECK (("pickup_manifest"."assigned_rider_id" IS NULL) = ("pickup_manifest"."assigned_at" IS NULL)),
	CONSTRAINT "pickup_manifest_dispatch_facts" CHECK (("pickup_manifest"."state" = 'DRAFT' AND "pickup_manifest"."dispatched_at" IS NULL) OR "pickup_manifest"."state" = 'CANCELLED' OR ("pickup_manifest"."state" IN ('DISPATCHED', 'IN_PROGRESS', 'COMPLETED') AND "pickup_manifest"."dispatched_at" IS NOT NULL AND "pickup_manifest"."assigned_rider_id" IS NOT NULL)),
	CONSTRAINT "pickup_manifest_start_facts" CHECK (("pickup_manifest"."state" IN ('IN_PROGRESS', 'COMPLETED')) = ("pickup_manifest"."started_at" IS NOT NULL)),
	CONSTRAINT "pickup_manifest_completion_facts" CHECK (("pickup_manifest"."state" = 'COMPLETED') = ("pickup_manifest"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "pickup_stop" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pickup_manifest_id" uuid NOT NULL,
	"pickup_request_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"arrived_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"failure_category" text,
	"failure_reason_snapshot" jsonb,
	"skip_snapshot" jsonb,
	"released_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pickup_stop_sequence_positive" CHECK ("pickup_stop"."sequence" >= 1),
	CONSTRAINT "pickup_stop_state_closed" CHECK ("pickup_stop"."state" IN ('PENDING', 'ARRIVED', 'COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED')),
	CONSTRAINT "pickup_stop_failure_category_closed" CHECK ("pickup_stop"."failure_category" IS NULL OR "pickup_stop"."failure_category" IN ('VENDOR_UNAVAILABLE', 'ACCESS_DENIED', 'PARCEL_NOT_READY', 'REFUSED_COLLECTION')),
	CONSTRAINT "pickup_stop_failure_facts" CHECK (("pickup_stop"."state" = 'FAILED') = ("pickup_stop"."failure_category" IS NOT NULL) AND ("pickup_stop"."failure_reason_snapshot" IS NULL OR "pickup_stop"."state" = 'FAILED')),
	CONSTRAINT "pickup_stop_skip_facts" CHECK ("pickup_stop"."skip_snapshot" IS NULL OR "pickup_stop"."state" = 'SKIPPED'),
	CONSTRAINT "pickup_stop_moment_facts" CHECK (("pickup_stop"."state" <> 'PENDING' OR "pickup_stop"."arrived_at" IS NULL) AND ("pickup_stop"."state" NOT IN ('PENDING', 'ARRIVED') OR "pickup_stop"."resolved_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "pickup_manifest" ADD CONSTRAINT "pickup_manifest_hub_fkey" FOREIGN KEY ("responsible_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_manifest" ADD CONSTRAINT "pickup_manifest_rider_fkey" FOREIGN KEY ("assigned_rider_id") REFERENCES "public"."rider_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- The target of the stop's composite foreign key to its manifest and hub must exist before the key does (the generator puts every index
-- after every foreign key, so this one is placed here by hand and is not created again below).
CREATE UNIQUE INDEX "pickup_manifest_id_hub_key" ON "pickup_manifest" USING btree ("id","responsible_hub_id");--> statement-breakpoint
ALTER TABLE "pickup_stop" ADD CONSTRAINT "pickup_stop_manifest_fkey" FOREIGN KEY ("pickup_manifest_id","responsible_hub_id") REFERENCES "public"."pickup_manifest"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_stop" ADD CONSTRAINT "pickup_stop_request_fkey" FOREIGN KEY ("pickup_request_id") REFERENCES "public"."pickup_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_stop" ADD CONSTRAINT "pickup_stop_hub_fkey" FOREIGN KEY ("responsible_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_manifest_code_key" ON "pickup_manifest" USING btree ("code");--> statement-breakpoint
CREATE INDEX "pickup_manifest_hub_idx" ON "pickup_manifest" USING btree ("responsible_hub_id","state","service_date");--> statement-breakpoint
CREATE INDEX "pickup_manifest_rider_idx" ON "pickup_manifest" USING btree ("assigned_rider_id","state") WHERE "pickup_manifest"."assigned_rider_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_stop_request_claim" ON "pickup_stop" USING btree ("pickup_request_id") WHERE "pickup_stop"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "pickup_stop_manifest_idx" ON "pickup_stop" USING btree ("pickup_manifest_id","sequence");--> statement-breakpoint
CREATE INDEX "pickup_stop_request_idx" ON "pickup_stop" USING btree ("pickup_request_id");--> statement-breakpoint
CREATE INDEX "pickup_stop_hub_idx" ON "pickup_stop" USING btree ("responsible_hub_id","state");--> statement-breakpoint
-- A unique INDEX cannot be deferred, so this one is a constraint added by hand: the stops of a manifest have distinct places, checked at
-- the end of the transaction, so that the complete reordering of S1.21 is one statement that may pass through two stops sharing a number.
ALTER TABLE "pickup_stop" ADD CONSTRAINT "pickup_stop_sequence_key" UNIQUE ("pickup_manifest_id", "sequence") DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "pickup_manifest" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "pickup_stop" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "pickup_manifest" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pickup_manifest" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pickup_stop" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pickup_stop" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pickup_manifest_read" ON "pickup_manifest" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup') AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    WHEN 'RIDER' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup') AND assigned_rider_id = melarc.current_rider_id() AND dispatched_at IS NOT NULL
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_manifest_probe" ON "pickup_manifest" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
--> statement-breakpoint
CREATE POLICY "pickup_manifest_insert" ON "pickup_manifest" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.manifest.create') AND state = 'DRAFT' AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup') AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'RIDER' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup') AND EXISTS (SELECT 1 FROM "pickup_manifest" AS m WHERE m.id = "pickup_stop"."pickup_manifest_id" AND m.assigned_rider_id = melarc.current_rider_id() AND m.dispatched_at IS NOT NULL)
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_insert" ON "pickup_stop" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.manifest.create') AND state = 'PENDING' AND released_at IS NULL AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT, INSERT ON "pickup_manifest" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON "pickup_stop" TO melarc_api_runtime;
--> statement-breakpoint
-- The guard of a manifest: what no login may change, and the only moves of its state (state-machines.md section 4). It refuses a change of
-- the identity of the manifest (id, code, hub, service date, creator and moment of creation), any transition but DRAFT to DISPATCHED or
-- CANCELLED, DISPATCHED to IN_PROGRESS or CANCELLED and IN_PROGRESS to COMPLETED, and any change of a COMPLETED or CANCELLED manifest. What a
-- move needs and sets (the rider, the moments) is decided by the operations and held by the CHECK constraints.
CREATE FUNCTION melarc.pickup_manifest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.service_date IS DISTINCT FROM OLD.service_date
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a pickup manifest keeps its identity, its hub and its service date' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'DRAFT' AND NEW.state IN ('DISPATCHED', 'CANCELLED'))
       OR (OLD.state = 'DISPATCHED' AND NEW.state IN ('IN_PROGRESS', 'CANCELLED'))
       OR (OLD.state = 'IN_PROGRESS' AND NEW.state = 'COMPLETED')
     ) THEN
    RAISE EXCEPTION 'a pickup manifest moves from DRAFT to DISPATCHED or CANCELLED, from DISPATCHED to IN_PROGRESS or CANCELLED and from IN_PROGRESS to COMPLETED, and no other way' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('COMPLETED', 'CANCELLED')
     AND (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version') THEN
    RAISE EXCEPTION 'a completed or cancelled pickup manifest is frozen' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_manifest_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_manifest_guard() FROM PUBLIC;
--> statement-breakpoint
-- The guard of a stop: it refuses a change of the stop's manifest, request and hub, any transition but PENDING to ARRIVED or SKIPPED and
-- ARRIVED to COLLECTED, PARTIALLY_COLLECTED, FAILED or SKIPPED (state-machines.md section 5), a release of the claim that is changed or
-- cleared once set, and any change to a resolved stop but the release of its claim. The release is the one way a request leaves the claim.
CREATE FUNCTION melarc.pickup_stop_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.pickup_manifest_id IS DISTINCT FROM OLD.pickup_manifest_id
     OR NEW.pickup_request_id IS DISTINCT FROM OLD.pickup_request_id
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a pickup stop keeps its manifest, its request and its hub' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'PENDING' AND NEW.state IN ('ARRIVED', 'SKIPPED'))
       OR (OLD.state = 'ARRIVED' AND NEW.state IN ('COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED'))
     ) THEN
    RAISE EXCEPTION 'a pickup stop moves from PENDING to ARRIVED or SKIPPED and from ARRIVED to COLLECTED, PARTIALLY_COLLECTED, FAILED or SKIPPED, and no other way' USING ERRCODE = '23514';
  END IF;
  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'the release of the claim of a pickup stop is never changed or cleared' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED')
     AND (to_jsonb(NEW) - 'released_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at' - 'version') THEN
    RAISE EXCEPTION 'a resolved pickup stop is frozen but for the release of its claim' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_stop_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_guard() FROM PUBLIC;
--> statement-breakpoint
-- The version (the ETag source of a read of the record): the database moves it, whatever the update says, to the next one when anything
-- about the row changed and keeps it otherwise. Fired after the guard (triggers of one event run by name).
CREATE FUNCTION melarc.pickup_manifest_version() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER FUNCTION melarc.pickup_manifest_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_manifest_version() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.pickup_stop_version() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER FUNCTION melarc.pickup_stop_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pickup_manifest_guard" BEFORE UPDATE ON "pickup_manifest"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_manifest_guard();
--> statement-breakpoint
CREATE TRIGGER "pickup_manifest_version" BEFORE UPDATE ON "pickup_manifest"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_manifest_version();
--> statement-breakpoint
CREATE TRIGGER "pickup_stop_guard" BEFORE UPDATE ON "pickup_stop"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_stop_guard();
--> statement-breakpoint
CREATE TRIGGER "pickup_stop_version" BEFORE UPDATE ON "pickup_stop"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_stop_version();