-- S1.21 (SLICE-001): the planning of a manifest before it goes out: setManifestStopOrder, assignRider and cancelPickupManifest
-- (delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md section 5, S1.21). Applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). Nothing in the shape of a table changes; this migration grants and polices what the three acts write.
--
--   * pickup_manifest: the runtime login may UPDATE state, assigned_rider_id and assigned_at, for a staff member who holds
--     pickup.manifest.assign or pickup.manifest.create in a hub of the grant. The policy lets either key lock any manifest of the hub (so that
--     an act on a manifest that has moved on is refused by the application, not hidden), and what a row may become is held by its check: the
--     assignment keeps the manifest a draft, the creating key (ordering locks the manifest and the cancellation changes it) leaves it a
--     draft or cancels it. The guard of a manifest is replaced (CREATE OR REPLACE) to keep each key to what it is for: the assignment
--     changes the rider and the moment of a draft and nothing else, and the creating key changes the state and nothing else.
--   * pickup_stop: UPDATE of sequence and released_at as well (beside the three of 0059), for the creating key alone, in a hub of the grant,
--     on a stop of a manifest that has not gone further than dispatch, and never leaving a released claim on a stop that is not skipped.
--     Ordering sets the sequence; the cancellation of a manifest skips the stops still to be worked and releases every claim it holds. The
--     guard of a stop is replaced to keep the creating key to those two acts: it changes the sequence and nothing else, or skips a stop and
--     releases its claim together; a resolved stop is still frozen, so it keeps its place in every ordering.
--   * pickup_request: the assignment key may mark a CONFIRMED request as having a rider (rider_assigned), and the guard of a request is
--     replaced to keep that key to that column: it can set the flag and change nothing else.
--   * rider_identity: the assignment key reads the rider's status in the hubs of the grant, as the roster's and the devices' keys do.

GRANT UPDATE ("state", "assigned_rider_id", "assigned_at") ON "pickup_manifest" TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "pickup_manifest_plan" ON "pickup_manifest" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.manifest.create', 'pickup.manifest.assign') AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
      AND (
        (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.assign' AND "pickup_manifest"."state" = 'DRAFT')
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.create' AND "pickup_manifest"."state" IN ('DRAFT', 'CANCELLED'))
      )
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a manifest as 0058 made it, with one rule added for each planning key: it changes what it is for and nothing else.
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
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.create' THEN
    IF (to_jsonb(NEW) - 'state' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'version') THEN
      RAISE EXCEPTION 'the cancellation of a manifest changes its state and nothing else' USING ERRCODE = '23514';
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
GRANT UPDATE ("sequence", "released_at") ON "pickup_stop" TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "pickup_stop_plan" ON "pickup_stop" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.manifest.create') AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids())) AND EXISTS (SELECT 1 FROM "pickup_manifest" AS m WHERE m.id = "pickup_stop"."pickup_manifest_id" AND m.state IN ('DRAFT', 'DISPATCHED'))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.manifest.create') AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids())) AND ("pickup_stop"."released_at" IS NULL OR "pickup_stop"."state" = 'SKIPPED')
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a stop as 0059 made it, with one rule added for the planning key: it orders the stops (the sequence changes and nothing else) or
-- cancels the manifest (a stop is skipped and its claim released together), and does nothing else to a stop. A resolved stop is still frozen
-- but for the release of its claim, so a stop that is no longer to be worked keeps its place in every ordering.
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
  IF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.create' THEN
    IF NEW.sequence IS DISTINCT FROM OLD.sequence THEN
      IF (to_jsonb(NEW) - 'sequence' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'sequence' - 'version') THEN
        RAISE EXCEPTION 'the ordering of the stops changes their sequence and nothing else' USING ERRCODE = '23514';
      END IF;
    ELSIF (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version')
          AND NOT (NEW.state = 'SKIPPED' AND NEW.released_at IS NOT NULL) THEN
      RAISE EXCEPTION 'the cancellation of a manifest skips a stop and releases its claim together' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_stop_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY "pickup_request_assign" ON "pickup_request" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.manifest.assign') AND "pickup_request"."state" = 'CONFIRMED' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_request"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.manifest.assign') AND "pickup_request"."state" = 'CONFIRMED' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_request"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a pickup request as 0053 made it, with one rule added: the assignment key marks a request as having a rider and changes
-- nothing else, and never takes the mark back.
CREATE OR REPLACE FUNCTION melarc.pickup_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.escalated_at IS NOT NULL AND NEW.escalated_at IS DISTINCT FROM OLD.escalated_at THEN
    RAISE EXCEPTION 'an escalation is recorded once and is never taken back or moved' USING ERRCODE = '23514';
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
  IF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.assign'
     AND ((to_jsonb(NEW) - 'rider_assigned' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'rider_assigned' - 'version')
          OR (OLD.rider_assigned AND NOT NEW.rider_assigned)) THEN
    RAISE EXCEPTION 'the assignment of a rider marks a request as having one and changes nothing else' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_request_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_request_guard() FROM PUBLIC;
--> statement-breakpoint
-- The rider's record as 0040 let staff read it, and one key more: the assignment of a rider to a manifest reads the rider's status.
DROP POLICY "rider_identity_staff_read" ON "rider_identity";
--> statement-breakpoint
CREATE POLICY "rider_identity_staff_read" ON "rider_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) IN ('dispatch.read', 'staff.device.register', 'staff.device.reregister', 'staff.device.revoke', 'pickup.manifest.assign')
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
