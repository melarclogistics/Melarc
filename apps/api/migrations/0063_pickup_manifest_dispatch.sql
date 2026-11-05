ALTER TABLE "pickup_stop" ADD COLUMN "pickup_summary" jsonb;--> statement-breakpoint
ALTER TABLE "pickup_stop" ADD CONSTRAINT "pickup_stop_summary_shape" CHECK ("pickup_stop"."pickup_summary" IS NULL OR (jsonb_typeof("pickup_stop"."pickup_summary") = 'object' AND jsonb_exists_all("pickup_stop"."pickup_summary", ARRAY['reference', 'sender_display_name', 'declared_package_count', 'resolved_pickup_location', 'location_note', 'contact_phone']) AND ("pickup_stop"."pickup_summary" - ARRAY['reference', 'sender_display_name', 'declared_package_count', 'resolved_pickup_location', 'location_note', 'contact_phone']) = '{}'::jsonb AND coalesce(jsonb_typeof("pickup_stop"."pickup_summary" -> 'reference'), '') = 'string' AND coalesce(jsonb_typeof("pickup_stop"."pickup_summary" -> 'sender_display_name'), '') = 'string' AND coalesce(jsonb_typeof("pickup_stop"."pickup_summary" -> 'declared_package_count'), '') = 'number' AND CASE WHEN coalesce(jsonb_typeof("pickup_stop"."pickup_summary" -> 'resolved_pickup_location'), '') = 'object' THEN coalesce(jsonb_typeof(("pickup_stop"."pickup_summary" -> 'resolved_pickup_location') -> 'address'), '') = 'string' AND (("pickup_stop"."pickup_summary" -> 'resolved_pickup_location') - ARRAY['address', 'landmark', 'map_link', 'latitude', 'longitude']) = '{}'::jsonb ELSE false END AND coalesce(jsonb_typeof("pickup_stop"."pickup_summary" -> 'location_note'), '') IN ('string', 'null') AND coalesce(jsonb_typeof("pickup_stop"."pickup_summary" -> 'contact_phone'), '') IN ('string', 'null')));
--> statement-breakpoint
-- THE HAND-WRITTEN PART (S1.21, the dispatch of a manifest; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.21 and OB-S1-21; the Product
-- Owner's decisions of 2 November 2026). Everything above is generated (drizzle-kit, from src/pickup/pickup-stop.schema.ts): the summary a rider
-- is shown for a stop, and the check that holds it to the six members of the contract and no other. Applied as melarc_migration_elevated, a
-- member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
--   * Dispatch is the act of the key pickup.manifest.dispatch and of no other. The runtime login may UPDATE the moment of dispatch beside the
--     state (0060 granted the state), and the summary of a stop. The policy of the manifest lets that key lock any manifest of the hub (so that a
--     dispatch of a manifest that has moved on is refused by the application and not hidden), and what a row may become is held by its check:
--     DISPATCHED. The policy of the stop admits the key only on a stop still to be worked, that holds its claim, has no summary yet and belongs to
--     a draft manifest of the hub, and only to give it one.
--   * The guard of a manifest is replaced (CREATE OR REPLACE) with 0060's rules and two things more. The dispatch key sends a draft out and
--     changes the state and the moment of dispatch and nothing else; it does so only to an ACTIVE rider of the manifest's own hub, only when a stop
--     is still to be worked, and only when every stop still to be worked has its summary: no stop reaches a rider without one (OB-S1-21), for
--     every writer. And the assigning key gives a manifest only an ACTIVE rider of the manifest's own hub: what a grant lets an officer see of a
--     rider is not what makes the rider eligible, and no temporary assignment to another hub exists to say otherwise (HubAssignment, not built).
--   * The guard of a stop is replaced with 0060's rules and one more: the summary is made once, by the dispatch key alone, and never changed; that
--     key changes the summary of a stop and nothing else of it.
--   * The dispatch key reads the rider's status and hub, as the assigning key does (0060): the record of a rider in the hubs of the grant.

GRANT UPDATE ("dispatched_at") ON "pickup_manifest" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("pickup_summary") ON "pickup_stop" TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "pickup_manifest_dispatch" ON "pickup_manifest" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.dispatch' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.dispatch' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids())) AND "pickup_manifest"."state" = 'DISPATCHED'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_dispatch" ON "pickup_stop" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.dispatch' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids())) AND "pickup_stop"."state" IN ('PENDING', 'ARRIVED') AND "pickup_stop"."released_at" IS NULL AND "pickup_stop"."pickup_summary" IS NULL AND EXISTS (SELECT 1 FROM "pickup_manifest" AS m WHERE m.id = "pickup_stop"."pickup_manifest_id" AND m.state = 'DRAFT')
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.dispatch' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids())) AND "pickup_stop"."pickup_summary" IS NOT NULL
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a manifest as 0060 made it, with the dispatch key's rules and the eligibility of the assigned rider added.
CREATE OR REPLACE FUNCTION melarc.pickup_manifest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.assign' THEN
    IF OLD.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'a rider is given to a draft manifest only' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'assigned_rider_id' - 'assigned_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'assigned_rider_id' - 'assigned_at' - 'version') THEN
      RAISE EXCEPTION 'the assignment of a rider changes the rider and the moment and nothing else' USING ERRCODE = '23514';
    END IF;
    IF NEW.assigned_rider_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM rider_identity r WHERE r.id = NEW.assigned_rider_id AND r.status = 'ACTIVE' AND r.primary_hub_id = NEW.responsible_hub_id) THEN
      RAISE EXCEPTION 'a manifest is given an active rider of its own hub' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.create' THEN
    IF (to_jsonb(NEW) - 'state' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'version') THEN
      RAISE EXCEPTION 'the cancellation of a manifest changes its state and nothing else' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.dispatch' THEN
    IF OLD.state <> 'DRAFT' OR NEW.state <> 'DISPATCHED' THEN
      RAISE EXCEPTION 'the dispatch of a manifest sends a draft out and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'state' - 'dispatched_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'dispatched_at' - 'version') THEN
      RAISE EXCEPTION 'the dispatch of a manifest changes its state and the moment of dispatch and nothing else' USING ERRCODE = '23514';
    END IF;
    IF NEW.assigned_rider_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM rider_identity r WHERE r.id = NEW.assigned_rider_id AND r.status = 'ACTIVE' AND r.primary_hub_id = NEW.responsible_hub_id) THEN
      RAISE EXCEPTION 'a manifest is dispatched to an active rider of its own hub' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('PENDING', 'ARRIVED')) THEN
      RAISE EXCEPTION 'a manifest with no stop still to be worked is not dispatched' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('PENDING', 'ARRIVED') AND s.pickup_summary IS NULL) THEN
      RAISE EXCEPTION 'a stop reaches a rider with its summary, and none without it' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_manifest_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_manifest_guard() FROM PUBLIC;
--> statement-breakpoint
-- The guard of a stop as 0060 made it, with the rule of the summary added: it is made once, by the dispatch key alone, and never changed.
CREATE OR REPLACE FUNCTION melarc.pickup_stop_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.pickup_manifest_id IS DISTINCT FROM OLD.pickup_manifest_id
     OR NEW.pickup_request_id IS DISTINCT FROM OLD.pickup_request_id
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.carryover_snapshot IS DISTINCT FROM OLD.carryover_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a pickup stop keeps its manifest, its request, its hub and its carry-over reason' USING ERRCODE = '23514';
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
  IF NEW.pickup_summary IS DISTINCT FROM OLD.pickup_summary THEN
    IF OLD.pickup_summary IS NOT NULL THEN
      RAISE EXCEPTION 'the summary of a pickup stop is made once and never changed' USING ERRCODE = '23514';
    END IF;
    IF coalesce(current_setting('melarc.authorization_key', true), '') <> 'pickup.manifest.dispatch' THEN
      RAISE EXCEPTION 'only the dispatch of a manifest makes the summary of its stops' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.create' THEN
    IF NEW.sequence IS DISTINCT FROM OLD.sequence THEN
      IF (to_jsonb(NEW) - 'sequence' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'sequence' - 'version') THEN
        RAISE EXCEPTION 'the ordering of the stops changes their sequence and nothing else' USING ERRCODE = '23514';
      END IF;
    ELSIF (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version')
          AND NOT (NEW.state = 'SKIPPED' AND NEW.released_at IS NOT NULL) THEN
      RAISE EXCEPTION 'the cancellation of a manifest skips a stop and releases its claim together' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.dispatch'
        AND (to_jsonb(NEW) - 'pickup_summary' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'pickup_summary' - 'version') THEN
    RAISE EXCEPTION 'the dispatch of a manifest makes the summary of a stop and changes nothing else of it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_stop_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_guard() FROM PUBLIC;
--> statement-breakpoint
-- The rider's record as 0060 let staff read it, and one key more: the dispatch of a manifest reads the status and the hub of the rider it goes to.
DROP POLICY "rider_identity_staff_read" ON "rider_identity";
--> statement-breakpoint
CREATE POLICY "rider_identity_staff_read" ON "rider_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) IN ('dispatch.read', 'staff.device.register', 'staff.device.reregister', 'staff.device.revoke', 'pickup.manifest.assign', 'pickup.manifest.dispatch')
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
