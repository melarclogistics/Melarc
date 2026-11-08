-- S1.22 (SLICE-001): a rider starts the run it was given and arrives at a stop of it (startRun, arriveAtPickupStop;
-- delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.22; contracts/state-machines.md sections 4 and 5; AC-SLICE-001-14, -16 and -80; the Product
-- Owner's decisions of 2 November 2026, OB-S1-31). Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section
-- 5.1). Nothing in the shape of a table changes. This migration polices and grants what the two acts write, and it is the first to do so for a RIDER
-- context: until now a rider read a run and wrote nothing but its own sign-out.
--
--   * The key. Both acts are the act of the key pickup.run.execute (the rider's fixed policy holds it at assigned scope) and of no other: the
--     policies below name it, and a staff context, a vendor context and a rider under any other key reach no row. A rider has no hub dimension:
--     a forged hub scope on a rider's context reaches the staff arm of no policy, because every arm of these is a RIDER arm and the rest is closed.
--   * pickup_manifest: the runtime login may UPDATE the moment of the start beside the state (0060 granted the state). The policy lets a rider
--     lock its own dispatched manifest in any state (so that an act on a run that has moved on is refused by the application, as STATE_CONFLICT,
--     and not hidden as a run that is not the rider's), and what the row may become is held by its check: IN_PROGRESS. The assignment is the
--     rider's: a manifest assigned to another rider, a draft and a manifest cancelled before it went out are not shown to this rider by the read
--     policy of 0058 and are not reached here either.
--   * pickup_stop: the runtime login may UPDATE the moment of the arrival beside the state (0059 granted the state). The policy lets a rider lock
--     the stops of its own dispatched manifest, whatever their state, and the check holds what a stop may become: ARRIVED, on a manifest that is in
--     progress and assigned to this rider. The stops are reached through the manifest, never through the hub (the registry: child rows inherit the
--     assignment of the rider from the authoritative manifest).
--   * The guard of a manifest is replaced (CREATE OR REPLACE) with 0063's rules and one more for the key of the rider's acts: it sends a dispatched
--     manifest to IN_PROGRESS with the moment of the start, in the name of the rider it is assigned to, and changes nothing else. The guard of a stop
--     is replaced with 0063's rules and one more: the key moves a pending stop to ARRIVED with the moment, once the manifest is in progress and the
--     rider is its rider, and changes nothing else of the stop. Both read the manifest through the rider's own row-level security, which shows
--     it a run that is its own and dispatched, so a run the guard cannot see is a refusal and never a pass. The grant of the moment of an arrival
--     is the runtime login's and not a key's, so the stop's guard also refuses a change of it under the two staff keys that reach a stop and are
--     not held to their own columns (the cancellation of a request and the planning); the dispatch is held to its own column already.
--   * The ledger. The arm of the audit ledger that took only the rider's sign-out takes the two events of these acts: pickup.manifest.started for a
--     run assigned to the rider and pickup.stop.arrived for a stop of one, in the rider's own name, from its own surface, under the key of the act,
--     ordinary tier and SUCCEEDED, and nothing else; each carries the facts of its act and no other (the states, the hub of the object and the
--     identifiers it relates). The other arms are restated word for word.
--   * The request is not touched. The rider does not read the request (the registry: a rider reads the stop's summary and never the request), and
--     the closing of the vendor's window to cancel was the assignment's (AC-SLICE-001-12), so neither act writes or reads a request.
--   * The correction of the same task (the Product Owner's review of 2 November 2026, on OB-S1-38 and OB-S1-39). The arrival judges the stop alone and
--     reads its run without locking it, which is sound only if the database holds, for every writer, what the application's transactions do:
--     - A cancelled request and a stop that is still to be worked never coexist. The cancellation of a request cancels it and skips its stop together, at
--       once, and asks the office for no separate step, so the rule is a constraint checked at the END of the transaction, on both tables
--       (pickup_request_cancelled_open_stop, pickup_stop_cancelled_request): either order of the two statements is the one transaction, and a
--       cancellation that leaves a stop to be worked behind is refused whole. A stop that has released its claim holds nothing.
--     - The key of the cancellation is held to the skip. A grant is the login's and not a key's, so the guard of a stop says what that key writes: a stop
--       that is still to be worked becomes SKIPPED with its moment and the reason REQUEST_CANCELLED, and its place in the order, its claim and its
--       arrival are kept (the arrival is the evidence of a visit that happened; the claim keeps a cancelled request from being planned again).
--     - A run is completed only when none of its stops is still to be worked, and started only while one is. The first move to COMPLETED is a later
--       task's; the rule it must keep is the manifest guard's from now on.
--     - The stop has its probe policy beside its read policy (0058), so that a staff member's miss on another hub's stop is told from a stop that does
--       not exist (getPickupStop), as the manifest's and the request's are.

GRANT UPDATE ("started_at") ON "pickup_manifest" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("arrived_at") ON "pickup_stop" TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "pickup_manifest_run" ON "pickup_manifest" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.run.execute' AND "pickup_manifest"."assigned_rider_id" = melarc.current_rider_id() AND "pickup_manifest"."dispatched_at" IS NOT NULL
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.run.execute' AND "pickup_manifest"."assigned_rider_id" = melarc.current_rider_id() AND "pickup_manifest"."dispatched_at" IS NOT NULL AND "pickup_manifest"."state" = 'IN_PROGRESS'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_run" ON "pickup_stop" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.run.execute' AND EXISTS (SELECT 1 FROM "pickup_manifest" AS m WHERE m.id = "pickup_stop"."pickup_manifest_id" AND m.assigned_rider_id = melarc.current_rider_id() AND m.dispatched_at IS NOT NULL)
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.run.execute' AND "pickup_stop"."state" = 'ARRIVED' AND EXISTS (SELECT 1 FROM "pickup_manifest" AS m WHERE m.id = "pickup_stop"."pickup_manifest_id" AND m.assigned_rider_id = melarc.current_rider_id() AND m.state = 'IN_PROGRESS')
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a manifest as 0063 made it, with the rule of the rider's key added.
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
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_manifest_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_manifest_guard() FROM PUBLIC;
--> statement-breakpoint
-- The guard of a stop as 0063 made it, with the rule of the rider's key added.
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
  -- statement writes. (The key of the cancellation of a request is held to its own columns by its rule below, which includes this one.)
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
--> statement-breakpoint
-- The audit ledger's insert policy as 0048 left it, with the Rider arm taking the two events of these acts beside its sign-out. The Staff, Vendor
-- and SYSTEM arms and the closed ELSE are restated word for word. The events are about the rider's own run or stop (the manifest is assigned to this
-- rider, the stop is one the read policy shows it), in its own name and from its own surface, under the key of the act, ordinary and SUCCEEDED.
-- They are also exactly the facts of the act, because a ledger row is evidence: the states it moved between, the hub of the object it is about
-- and the identifiers it relates (the rider, and for a stop its run and its request), each equal to what the rows themselves say.
ALTER POLICY "audit_event_insert" ON "audit_event" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN actor_type = 'STAFF' AND actor_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN actor_type = 'VENDOR_ACCOUNT' AND actor_id = melarc.current_principal_id() AND surface_context = 'VENDOR_PWA' AND (
      (event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT' AND outcome = 'SUCCEEDED' AND enhanced = false)
      OR (event_code IN ('pickup.request.created', 'pickup.request.cancelled') AND object_type = 'PickupRequest' AND vendor_organization_id = melarc.current_vendor_organization_id() AND outcome = 'SUCCEEDED' AND enhanced = false)
    )
    WHEN 'RIDER' THEN actor_type = 'RIDER' AND actor_id = melarc.current_principal_id() AND surface_context = 'RIDER_ANDROID' AND outcome = 'SUCCEEDED' AND enhanced = false AND (
      (event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT')
      OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.run.execute' AND (
        (event_code = 'pickup.manifest.started' AND object_type = 'PickupManifest' AND previous_state = 'DISPATCHED' AND resulting_state = 'IN_PROGRESS' AND EXISTS (SELECT 1 FROM pickup_manifest m WHERE m.id = "audit_event"."object_id" AND m.assigned_rider_id = melarc.current_rider_id() AND m.responsible_hub_id = "audit_event"."responsible_hub_id" AND "audit_event"."related_ids" = jsonb_build_object('rider_id', melarc.current_rider_id()::text)))
        OR (event_code = 'pickup.stop.arrived' AND object_type = 'PickupStop' AND previous_state = 'PENDING' AND resulting_state = 'ARRIVED' AND EXISTS (SELECT 1 FROM pickup_stop s WHERE s.id = "audit_event"."object_id" AND s.responsible_hub_id = "audit_event"."responsible_hub_id" AND "audit_event"."related_ids" = jsonb_build_object('pickup_manifest_id', s.pickup_manifest_id::text, 'pickup_request_id', s.pickup_request_id::text, 'rider_id', melarc.current_rider_id()::text)))
      ))
    )
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
-- A cancelled request and a stop that is still to be worked never coexist (OB-S1-38; the review of 2 November 2026). The rule is checked at the END of
-- the transaction, on both tables, because the cancellation of a request is one transaction that cancels the request and skips its stop (the
-- application writes the request first and the stop after), and must be accepted whole in either order and refused whole if it leaves the stop
-- behind: the office is asked for no separate step. A stop "held" is one whose claim is not released, and "still to be worked" is PENDING or ARRIVED.
-- The functions read the two tables as the transaction's own context sees them, as the guards do; the writers that can cancel a request see its stop
-- (the key of the cancellation is the one that skips it), and a context that cannot (a vendor, which cancels only a request no stop holds) is not
-- one that can leave a stop behind. Written after pickup_request_source_cancelled (0053), whose form these follow.
CREATE FUNCTION melarc.pickup_request_cancelled_open_stop() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- The request as the transaction leaves it, and not as this event saw it.
  IF EXISTS (SELECT 1 FROM public.pickup_request AS r WHERE r.id = NEW.id AND r.state = 'CANCELLED')
     AND EXISTS (SELECT 1 FROM public.pickup_stop AS s WHERE s.pickup_request_id = NEW.id AND s.released_at IS NULL AND s.state IN ('PENDING', 'ARRIVED')) THEN
    RAISE EXCEPTION 'a cancelled pickup request is not held by a stop that is still to be worked'
      USING ERRCODE = '23514', CONSTRAINT = 'pickup_request_cancelled_open_stop';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_request_cancelled_open_stop() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_request_cancelled_open_stop() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pickup_request_cancelled_open_stop" AFTER INSERT OR UPDATE ON "pickup_request"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'CANCELLED') EXECUTE FUNCTION melarc.pickup_request_cancelled_open_stop();
--> statement-breakpoint
CREATE FUNCTION melarc.pickup_stop_cancelled_request() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- The stop as the transaction leaves it: one made or kept to be worked for a request that is cancelled is the other side of the same rule.
  IF EXISTS (SELECT 1 FROM public.pickup_stop AS s WHERE s.id = NEW.id AND s.released_at IS NULL AND s.state IN ('PENDING', 'ARRIVED'))
     AND EXISTS (SELECT 1 FROM public.pickup_request AS r WHERE r.id = NEW.pickup_request_id AND r.state = 'CANCELLED') THEN
    RAISE EXCEPTION 'a stop that is still to be worked does not hold a cancelled pickup request'
      USING ERRCODE = '23514', CONSTRAINT = 'pickup_stop_cancelled_request';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_stop_cancelled_request() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_cancelled_request() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pickup_stop_cancelled_request" AFTER INSERT OR UPDATE ON "pickup_stop"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state IN ('PENDING', 'ARRIVED') AND NEW.released_at IS NULL) EXECUTE FUNCTION melarc.pickup_stop_cancelled_request();
--> statement-breakpoint
-- The probe policy of the stop, beside its read policy (0058), as the manifest's and the request's: the record-scope guard of getPickupStop reads
-- the hub of a stop by id, for a staff member only, to tell a stop outside the hubs of its grant (HUB_SCOPE_VIOLATION) from one that does not exist.
-- It reaches no other statement: the id it compares with is set by the guard for that one read.
CREATE POLICY "pickup_stop_probe" ON "pickup_stop" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
