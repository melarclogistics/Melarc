ALTER TABLE "notification" ADD COLUMN "parameters" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_parameters_closed" CHECK (jsonb_typeof("notification"."parameters") = 'object' AND jsonb_array_length(jsonb_path_query_array("notification"."parameters", 'strict $.keyvalue()')) <= 4 AND NOT jsonb_path_exists("notification"."parameters", 'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][a-z0-9_]{0,31}$"))') AND NOT jsonb_path_exists("notification"."parameters", 'strict $.* ? (@.type() != "string" || !(@ like_regex "^[A-Z][A-Z0-9_]{0,63}$"))'));
--> statement-breakpoint
-- THE HAND-WRITTEN PART (S1.23). Everything above is generated (drizzle-kit, from src/platform/database/schema/notifications.ts): the closed
-- parameters of a notification, which the Vendor's notice of a skip uses to name the reason. The lane (the notification capability) already holds
-- INSERT on the table as a whole, so no grant is added for the column, and the Ops log reads named columns and never this one. Everything below
-- is hand-written.
--
-- S1.23 (SLICE-001): Ops skips a stop, and the system completes a run in progress with nothing collected (skipPickupStop; delivery/planning/
-- SLICE-001-IMPLEMENTATION-PLAN.md S1.23; contracts/state-machines.md sections 4 and 5; AC-SLICE-001-74 and -78; MSC-DEC-412). Applied as
-- melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). Nothing in the shape of a table changes; this
-- migration polices and grants what the two acts write.
--
--   * The skip. It is the act of the key pickup.stop.skip and of no other. 0059 and 0060 granted the runtime login the columns it writes
--     (state, resolved_at, skip_snapshot), so no grant is added for the stop. The policy lets the key, in a hub of the grant, lock any stop and
--     move it to SKIPPED (its USING names no state, as 0065's policies for the rider do not: a stop that has already moved on must be found
--     and refused by the application as STATE_CONFLICT and not hidden from the lock as a stop that is not there; the guard of the stop holds
--     that only a stop still to be worked can move). The guard of the stop then says what that key writes and nothing more: the state, the moment of
--     the skip and the snapshot of the reason (the code of the PICKUP_STOP_SKIP catalogue and no system code, active; a note where the reason
--     says one is required; the snapshot's moment is the moment of the skip). The stop keeps its place in the order, its arrival and its claim,
--     because no other column may change in the same statement.
--   * The completion by the system. A run in progress whose every stop is terminal and none of them collected is completed by the system, in
--     the transaction of the act that turned its last stop terminal (state-machines.md section 4). The act is the officer's own (the actor of
--     the audit event is the officer, with the cause named in it, as for the skip that a cancellation makes), so the manifest is updated in the
--     officer's context: the runtime login may UPDATE the moment of completion beside the state (0060 granted the state), and one policy admits
--     the keys of the acts that can turn a stop terminal in a run in progress to move an IN_PROGRESS manifest of a hub of the grant to
--     COMPLETED. Today those are the skip and the cancellation of a request; the custody handover (S1.24) and the rider's acts on a stop (S1.26
--     onward) add theirs in their own migrations. The guard of the manifest holds what the completion may be, for every writer: none of its stops
--     is still to be worked (0065), nothing was collected (a run that collected something is closed by the hub handover, which is a later
--     task's own rule), and only the state and the moment change.
--   * The hub handover is not this migration's. The key of the hub handover (hub.handover.submit) has no policy and no branch here, so it
--     completes nothing until the task that builds it adds both.

GRANT UPDATE ("completed_at") ON "pickup_manifest" TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "pickup_stop_skip" ON "pickup_stop" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.stop.skip' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.stop.skip' AND "pickup_stop"."state" = 'SKIPPED' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_manifest_settle" ON "pickup_manifest" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.stop.skip', 'pickup.request.cancel') AND "pickup_manifest"."state" = 'IN_PROGRESS' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.stop.skip', 'pickup.request.cancel') AND "pickup_manifest"."state" = 'COMPLETED' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a manifest as 0065 made it, with the rule of the keys that complete a run added.
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
  -- Whoever completes a run: none of its stops is still to be worked. The arrival at a stop reads its run without locking it and is correct only
  -- because a run in progress cannot leave that state while one of its stops is still to be worked.
  IF NEW.state = 'COMPLETED' AND OLD.state IS DISTINCT FROM 'COMPLETED'
     AND EXISTS (SELECT 1 FROM pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('PENDING', 'ARRIVED')) THEN
    RAISE EXCEPTION 'a pickup manifest is completed only when none of its stops is still to be worked' USING ERRCODE = '23514';
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
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.run.execute' THEN
    IF OLD.state <> 'DISPATCHED' OR NEW.state <> 'IN_PROGRESS' THEN
      RAISE EXCEPTION 'the start of a run moves a dispatched manifest to IN_PROGRESS and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'state' - 'started_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'started_at' - 'version') THEN
      RAISE EXCEPTION 'the start of a run changes its state and the moment of the start and nothing else' USING ERRCODE = '23514';
    END IF;
    IF NEW.started_at IS NULL OR NEW.assigned_rider_id IS DISTINCT FROM melarc.current_rider_id() THEN
      RAISE EXCEPTION 'a run is started, with its moment, by the rider it is assigned to' USING ERRCODE = '23514';
    END IF;
    -- The rider's own run shows the rider its stops, so this cannot miss one. The application refuses a start with nothing to work first, with
    -- its own answer; this is the hold for any other writer, as the dispatch has its own for a manifest with no stop to be worked.
    IF NOT EXISTS (SELECT 1 FROM pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('PENDING', 'ARRIVED')) THEN
      RAISE EXCEPTION 'a run with no stop still to be worked is not started' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.stop.skip', 'pickup.request.cancel') THEN
    -- The completion by the system (state-machines.md section 4): a run in progress, every stop terminal (above), none of them collected, and
    -- the state and its moment written and nothing else. A run with something collected is closed by the hub handover, whose own key is a later
    -- task's: these keys do not complete it.
    IF OLD.state <> 'IN_PROGRESS' OR NEW.state <> 'COMPLETED' THEN
      RAISE EXCEPTION 'the act that turns the last stop of a run terminal completes a run in progress and does nothing else to a manifest' USING ERRCODE = '23514';
    END IF;
    IF NEW.completed_at IS NULL
       OR (to_jsonb(NEW) - 'state' - 'completed_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'completed_at' - 'version') THEN
      RAISE EXCEPTION 'the completion of a run changes its state and the moment of completion and nothing else' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('COLLECTED', 'PARTIALLY_COLLECTED')) THEN
      RAISE EXCEPTION 'a run that collected something is completed by its hub handover and not by the system' USING ERRCODE = '23514';
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
-- The guard of a stop as 0065 made it, with the rule of the skip key added.
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
  -- The moment of an arrival is the rider's act and no other writer's. A grant is not per key, and the planning reaches a stop through a policy that
  -- lets it order the stops and cancel the manifest by skipping them together with the release of their claims, a skip whose statement may carry
  -- other columns with it (below). It has no reason to write an arrival, so a change of the moment under it is refused, whatever else the same
  -- statement writes. (The keys of the cancellation of a request and of the skip are held to their own columns by their rules below, which include this one.)
  IF NEW.arrived_at IS DISTINCT FROM OLD.arrived_at
     AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.create' THEN
    RAISE EXCEPTION 'the moment of an arrival is written by the arrival of the rider and by no ordering' USING ERRCODE = '23514';
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
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.cancel' THEN
    -- The cancellation of a request skips the stop that holds it, if it is still to be worked, and writes nothing else: the stop keeps its place in the
    -- order, its claim (the cancelled request must not return to the pool that can be manifested) and the arrival the rider recorded (the evidence
    -- of a visit that happened). The reason is the system's, not one of the catalogue Ops chooses from when it skips a stop for itself. Only a stop
    -- that is still to be worked can be skipped: the moves above allow SKIPPED from PENDING and ARRIVED alone, and a resolved stop is frozen.
    IF NEW.state <> 'SKIPPED' THEN
      RAISE EXCEPTION 'the cancellation of a request skips a stop and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'state' - 'resolved_at' - 'skip_snapshot' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'resolved_at' - 'skip_snapshot' - 'version') THEN
      RAISE EXCEPTION 'the skip a cancellation makes writes the state, the moment and the reason, and keeps the place, the claim and the arrival of the stop' USING ERRCODE = '23514';
    END IF;
    IF NEW.resolved_at IS NULL OR (NEW.skip_snapshot ->> 'reason_code') IS DISTINCT FROM 'REQUEST_CANCELLED' THEN
      RAISE EXCEPTION 'the skip a cancellation makes carries its moment and the reason REQUEST_CANCELLED' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.stop.skip' THEN
    -- Ops's authorised skip (MSC-DEC-412): a stop still to be worked becomes SKIPPED, with its moment and the snapshot of the reason, and nothing
    -- else of it changes, so it keeps its place in the order, its arrival and its claim (a skip does not release it). The reason is a code of the
    -- PICKUP_STOP_SKIP catalogue, active, with a note where the code requires one: the system's own codes (the cancellation of a request or of a
    -- manifest) are not in the catalogue, so the key cannot write them. The moment in the snapshot is the moment of the skip.
    IF NEW.state <> 'SKIPPED' THEN
      RAISE EXCEPTION 'the skip of a stop moves it to SKIPPED and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'state' - 'resolved_at' - 'skip_snapshot' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'resolved_at' - 'skip_snapshot' - 'version') THEN
      RAISE EXCEPTION 'the skip of a stop writes the state, the moment and the reason, and keeps the place, the claim and the arrival of the stop' USING ERRCODE = '23514';
    END IF;
    IF NEW.resolved_at IS NULL
       OR (NEW.skip_snapshot ->> 'skipped_at') IS NULL
       OR (NEW.skip_snapshot ->> 'skipped_at')::timestamptz IS DISTINCT FROM NEW.resolved_at THEN
      RAISE EXCEPTION 'the skip of a stop carries its moment, and the snapshot names the same moment' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM reason_code rc
       WHERE rc.domain = 'PICKUP_STOP_SKIP' AND rc.active AND rc.code = (NEW.skip_snapshot ->> 'reason_code')
         AND (NOT rc.requires_note OR btrim(coalesce(NEW.skip_snapshot ->> 'note', '')) <> '')
    ) THEN
      RAISE EXCEPTION 'the skip of a stop gives an active reason of the PICKUP_STOP_SKIP catalogue, with its note where the reason requires one' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.run.execute' THEN
    IF OLD.state <> 'PENDING' OR NEW.state <> 'ARRIVED' THEN
      RAISE EXCEPTION 'the arrival at a stop moves a pending stop to ARRIVED and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF NEW.arrived_at IS NULL
       OR (to_jsonb(NEW) - 'state' - 'arrived_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'arrived_at' - 'version') THEN
      RAISE EXCEPTION 'the arrival at a stop changes its state and the moment of the arrival and nothing else' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pickup_manifest m
       WHERE m.id = NEW.pickup_manifest_id AND m.state = 'IN_PROGRESS' AND m.assigned_rider_id = melarc.current_rider_id()
    ) THEN
      RAISE EXCEPTION 'a stop is arrived at once its run has started, by the rider the run is assigned to' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_stop_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_guard() FROM PUBLIC;
