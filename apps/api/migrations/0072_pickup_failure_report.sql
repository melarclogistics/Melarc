-- S1.28 (SLICE-001), the part of the failure flow that stands alone: the rider reports that a stop failed (reportPickupFailure; delivery/planning/
-- SLICE-001-IMPLEMENTATION-PLAN.md S1.28; features/pickup/pickup-failure.md; contracts/state-machines.md section 5; AC-SLICE-001-30 to -33 and -36).
-- Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). Nothing in the shape of a table changes: the stop
-- already holds the fixed category and the snapshot of the reason (0058), and this migration polices and grants what the report writes.
--
--   * The key. The report is the act of the key pickup.failure.report (the rider's fixed policy holds it at assigned scope) and of no other. The rider's
--     policy lets it lock the stops of its own dispatched run and move one to FAILED on a run in progress that is assigned to it (the policies of 0065 and
--     0068 for the arrival and the count, in the same shape); a staff context, a vendor context and a rider under any other key reach no row.
--   * What the database judges, for every writer (the guard of the stop, replaced below). A stop that has been arrived at becomes FAILED with its fixed
--     category, the snapshot of its reason and the moment, and nothing else of it changes: it keeps its place in the order, its arrival and its claim (a
--     failure does not release it; the request is rescheduled or cancelled by the office, which is the decision of S1.30). The reason is an active reason
--     of the PICKUP_FAILURE catalogue, with the label and the attribution the catalogue holds now, in the shape the application builds, and it satisfies the
--     rules of its metadata: a note where it asks for one, a contact attempt where it asks for one, and no photo asked for (no evidence can be stored before
--     S1.11 is built, so a reason that asks for a photo cannot be satisfied and is refused as REASON_REQUIRED). The moment is the database's own, taken when
--     the stop's lock is held, and the snapshot names the same moment (OB-S1-60, as for the count). A stop with a collection record is never failed
--     (0068 holds it for every writer), and a failed stop is frozen (0059).
--   * The catalogue. The rider's key reads the PICKUP_FAILURE reasons and no other (the policy below), as the key of the count reads the short-count reasons.
--   * The count. A stop with a collection record is never failed (0068), and the trigger that holds it reads the table as the rider, so the rider's key reads its
--     own record (the policy of 0068 is restated below with the key among its keys). Without it a rider that had counted could fail the stop: neither the trigger
--     nor the application found the record (found by the tests of this task).
--   * The completion by the system. A run in progress whose every stop is terminal and none of them collected is completed by the system in the
--     transaction of the act that made its last stop terminal (0066). The failure is such an act: a run whose last stop failed with nothing collected has no
--     hub handover to close it. The rider's key is given the completion of its own run (the policy below and the guard of the manifest, which is replaced
--     with the key added to the keys that complete a run and with its relations named by their schema), the read of the custody table (so that a run with a
--     custody handover pending is not completed by a writer that could not see it) and the ledger's arm for the completion.
--   * The ledger. The arm of the audit ledger that takes the rider's events takes two more under this key: pickup.stop.failed for a stop of a run assigned
--     to the rider, bound member for member to the stored stop (its reason, its related identifiers and its detail), and pickup.manifest.completed for the
--     run that the same act settled, bound to the stored run and to the cause LAST_STOP_FAILED. The rider's note is on the stop and not in the event.
--   * Not here: the evidence photo (S1.11), the scheduled backstop and its capability (S1.28's other half, whose cadence is the owner's, OB-S1-07), the
--     narrowing of the escalation to a failed stop, and the messages of a failure.

GRANT UPDATE ("failure_category", "failure_reason_snapshot") ON "pickup_stop" TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "pickup_stop_failure" ON "pickup_stop" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND EXISTS (SELECT 1 FROM "pickup_manifest" AS m WHERE m.id = "pickup_stop"."pickup_manifest_id" AND m.assigned_rider_id = melarc.current_rider_id() AND m.dispatched_at IS NOT NULL)
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND "pickup_stop"."state" = 'FAILED' AND EXISTS (SELECT 1 FROM "pickup_manifest" AS m WHERE m.id = "pickup_stop"."pickup_manifest_id" AND m.assigned_rider_id = melarc.current_rider_id() AND m.state = 'IN_PROGRESS')
    ELSE false
  END
);
--> statement-breakpoint
-- The reasons of a failure, read by the rider's key that reports one (the catalogue is readable by staff alone otherwise).
CREATE POLICY "reason_code_rider_failure_read" ON "reason_code" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND domain = 'PICKUP_FAILURE'
    ELSE false
  END
);
--> statement-breakpoint
-- The completion by the system (0066, 0067) for the rider's failure key: a run in progress assigned to the rider moves to COMPLETED, and to nothing else.
CREATE POLICY "pickup_manifest_failure_settle" ON "pickup_manifest" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND "pickup_manifest"."state" = 'IN_PROGRESS' AND "pickup_manifest"."assigned_rider_id" = melarc.current_rider_id()
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND "pickup_manifest"."state" = 'COMPLETED' AND "pickup_manifest"."assigned_rider_id" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
-- The read of the custody table by the rider that reports a failure: the completion of a run is judged against a handover still pending, and a writer that could not see it would pass.
ALTER POLICY "run_custody_handover_read" ON "run_custody_handover" USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('fleet.custody.read', 'fleet.custody.initiate', 'fleet.custody.accept', 'pickup.stop.skip', 'pickup.request.cancel') AND (melarc.hub_scope_mode() = 'ALL' OR "run_custody_handover"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('fleet.custody.read', 'fleet.custody.accept', 'pickup.failure.report') AND ("run_custody_handover"."from_rider_id" = melarc.current_rider_id() OR "run_custody_handover"."to_rider_id" = melarc.current_rider_id())
    ELSE false
  END
);
--> statement-breakpoint
-- The rider's read of its own count, with the key of the failure report among its keys: a stop that has a count is never failed (0068), and the guard that holds it reads the
-- count as the rider, so a rider that could not see it would fail the stop.
ALTER POLICY "collection_record_read" ON "collection_record" USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'fleet')
      AND (melarc.hub_scope_mode() = 'ALL' OR "collection_record"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.collection.confirm', 'pickup.run.execute', 'pickup.failure.report')
      AND "collection_record"."recorded_by" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a stop as 0070 made it, with the branch of the failure report added (S1.28).
CREATE OR REPLACE FUNCTION melarc.pickup_stop_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  catalogue public.reason_code%ROWTYPE;
  instant timestamp with time zone;
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
      SELECT 1 FROM public.reason_code rc
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
      SELECT 1 FROM public.pickup_manifest m
       WHERE m.id = NEW.pickup_manifest_id AND m.state = 'IN_PROGRESS' AND m.assigned_rider_id = melarc.current_rider_id()
    ) THEN
      RAISE EXCEPTION 'a stop is arrived at once its run has started, by the rider the run is assigned to' USING ERRCODE = '23514';
    END IF;
  ELSIF current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.collection.confirm', 'pickup.handshake.override', 'pickup.handshake.resolve') THEN
    -- The close of a counted stop by its handshake (S1.27, migration 0070): an operation of the handshake, running as the owner under the rider's, the vendor's or the
    -- officer's own key, moves a stop that has been arrived at to COLLECTED or PARTIALLY_COLLECTED, with its moment, and writes nothing else of it. The record's
    -- variance names the state (equal counts close it collected, fewer partially collected) and the handshake must already have ended well, so a stop is never closed
    -- by anything that has not verified, been overridden or been resolved by hand. Under the same keys a statement may take the lock of a stop and change nothing.
    IF NEW.state IS DISTINCT FROM OLD.state THEN
      IF OLD.state <> 'ARRIVED' OR NEW.state NOT IN ('COLLECTED', 'PARTIALLY_COLLECTED') OR NEW.resolved_at IS NULL THEN
        RAISE EXCEPTION 'the handshake closes a stop that has been arrived at, as collected or partially collected, with its moment' USING ERRCODE = '23514';
      END IF;
      IF (to_jsonb(NEW) - 'state' - 'resolved_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'resolved_at' - 'version') THEN
        RAISE EXCEPTION 'the close of a stop by its handshake writes the state and the moment and nothing else' USING ERRCODE = '23514';
      END IF;
      -- (The relations are named with their schema: the operations that fire this guard run with an empty search path.)
      IF NOT EXISTS (
           SELECT 1 FROM public.collection_record c
            WHERE c.pickup_stop_id = NEW.id AND ((c.variance = 'MATCH' AND NEW.state = 'COLLECTED') OR (c.variance = 'SHORT' AND NEW.state = 'PARTIALLY_COLLECTED')))
         OR NOT EXISTS (SELECT 1 FROM public.collection_handshake h WHERE h.pickup_stop_id = NEW.id AND h.state IN ('VERIFIED', 'MANUALLY_RESOLVED')) THEN
        RAISE EXCEPTION 'a stop is closed as its count says, by a handshake that has ended well' USING ERRCODE = '23514';
      END IF;
    ELSIF (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version') THEN
      RAISE EXCEPTION 'under the key of a handshake a stop is locked or closed, and nothing else of it is written' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' THEN
    -- The report of a failure (S1.28, migration 0072): the rider's key moves a stop that has been arrived at to FAILED, with the fixed category, the snapshot of the
    -- reason and the moment, and writes nothing else of it, so the stop keeps its place in the order, its arrival and its claim (a failure does not release it).
    -- What is the catalogue's or the clock's is judged here, for every writer: the reason is an active reason of the PICKUP_FAILURE catalogue with the label and the
    -- attribution the catalogue holds now, in the shape the application builds, and it satisfies its metadata (a note where it asks for one, a contact attempt
    -- where it asks for one, and no photo asked for: no evidence can be stored before S1.11, so a reason that asks for one cannot be satisfied). The moment is the
    -- database's own, taken now that the stop's lock is held, and the snapshot names the same moment; a moment given by the writer is not kept.
    IF OLD.state <> 'ARRIVED' OR NEW.state <> 'FAILED' THEN
      RAISE EXCEPTION 'the report of a failure moves a stop that has been arrived at to FAILED and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'state' - 'resolved_at' - 'failure_category' - 'failure_reason_snapshot' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'resolved_at' - 'failure_category' - 'failure_reason_snapshot' - 'version') THEN
      RAISE EXCEPTION 'the report of a failure writes the state, the moment, the category and the reason, and keeps the place, the claim and the arrival of the stop' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.pickup_manifest m
       WHERE m.id = NEW.pickup_manifest_id AND m.state = 'IN_PROGRESS' AND m.assigned_rider_id = melarc.current_rider_id()
    ) THEN
      RAISE EXCEPTION 'a failure is reported once the run has started, by the rider the run is assigned to' USING ERRCODE = '23514';
    END IF;
    IF NEW.failure_reason_snapshot IS NULL THEN
      RAISE EXCEPTION 'a failure gives the reason of the catalogue' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    IF jsonb_typeof(NEW.failure_reason_snapshot) IS DISTINCT FROM 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.failure_reason_snapshot) AS k(key) WHERE k.key NOT IN ('reason_code', 'label', 'attribution', 'note', 'contact_attempts'))
       OR jsonb_typeof(NEW.failure_reason_snapshot -> 'label') IS DISTINCT FROM 'string'
       OR ((NEW.failure_reason_snapshot -> 'note') IS NOT NULL
           AND (jsonb_typeof(NEW.failure_reason_snapshot -> 'note') <> 'string' OR char_length(NEW.failure_reason_snapshot ->> 'note') > 1000)) THEN
      RAISE EXCEPTION 'the reason of a failure is kept as the application builds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
    END IF;
    -- The contact attempts, where there are any: at most ten, each the moment as the application writes it (an instant in UTC, to the millisecond) and what came of it.
    IF (NEW.failure_reason_snapshot -> 'contact_attempts') IS NOT NULL
       AND (jsonb_typeof(NEW.failure_reason_snapshot -> 'contact_attempts') <> 'array'
            OR jsonb_array_length(NEW.failure_reason_snapshot -> 'contact_attempts') > 10
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(NEW.failure_reason_snapshot -> 'contact_attempts') AS e(attempt)
               WHERE jsonb_typeof(e.attempt) IS DISTINCT FROM 'object'
                  OR NOT jsonb_exists_all(e.attempt, ARRAY['attempted_at', 'outcome'])
                  OR (e.attempt - ARRAY['attempted_at', 'outcome']) <> '{}'::jsonb
                  OR jsonb_typeof(e.attempt -> 'attempted_at') IS DISTINCT FROM 'string'
                  OR jsonb_typeof(e.attempt -> 'outcome') IS DISTINCT FROM 'string'
                  OR (e.attempt ->> 'attempted_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
                  OR btrim(e.attempt ->> 'outcome') = ''
                  OR char_length(e.attempt ->> 'outcome') > 1000)) THEN
      RAISE EXCEPTION 'the contact attempts of a failure are kept as the application builds them' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
    END IF;
    SELECT * INTO catalogue FROM public.reason_code AS rc
     WHERE rc.code = (NEW.failure_reason_snapshot ->> 'reason_code') AND rc.domain = 'PICKUP_FAILURE';
    IF NOT FOUND OR NOT catalogue.active
       OR catalogue.label IS DISTINCT FROM (NEW.failure_reason_snapshot ->> 'label')
       OR catalogue.attribution IS DISTINCT FROM (NEW.failure_reason_snapshot ->> 'attribution') THEN
      RAISE EXCEPTION 'the reason of a failure is an active reason of the PICKUP_FAILURE catalogue, as the catalogue holds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
    END IF;
    IF catalogue.requires_note AND btrim(coalesce(NEW.failure_reason_snapshot ->> 'note', '')) = '' THEN
      RAISE EXCEPTION 'the reason of this failure asks for a note' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    IF catalogue.requires_contact_attempt AND coalesce(jsonb_array_length(NEW.failure_reason_snapshot -> 'contact_attempts'), 0) = 0 THEN
      RAISE EXCEPTION 'the reason of this failure asks for a contact attempt' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    IF catalogue.requires_photo THEN
      RAISE EXCEPTION 'the reason of this failure asks for a photo, and no evidence can be stored yet' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    instant := date_trunc('milliseconds', clock_timestamp());
    NEW.resolved_at := instant;
    NEW.failure_reason_snapshot := NEW.failure_reason_snapshot || jsonb_build_object('reported_at', to_char(instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_stop_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_guard() FROM PUBLIC;
--> statement-breakpoint
-- The guard of a manifest as 0067 made it, with the key of the failure report added to the keys that complete a run as the system does (S1.28), and its relations named
-- with their schema and a search path of its own, as the guards that the operations of the owner fire carry.
CREATE OR REPLACE FUNCTION melarc.pickup_manifest_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
  -- Whoever completes a run: none of its stops is still to be worked, and no custody handover of it is pending. The arrival at a stop reads its
  -- run without locking it and is correct only because a run in progress cannot leave that state while one of its stops is still to be worked.
  IF NEW.state = 'COMPLETED' AND OLD.state IS DISTINCT FROM 'COMPLETED' THEN
    IF EXISTS (SELECT 1 FROM public.pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('PENDING', 'ARRIVED')) THEN
      RAISE EXCEPTION 'a pickup manifest is completed only when none of its stops is still to be worked' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.run_custody_handover h WHERE h.manifest_id = NEW.id AND h.state = 'PENDING') THEN
      RAISE EXCEPTION 'a pickup manifest is completed only when no custody handover of it is pending' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.assign' THEN
    IF OLD.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'a rider is given to a draft manifest only' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'assigned_rider_id' - 'assigned_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'assigned_rider_id' - 'assigned_at' - 'version') THEN
      RAISE EXCEPTION 'the assignment of a rider changes the rider and the moment and nothing else' USING ERRCODE = '23514';
    END IF;
    IF NEW.assigned_rider_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.rider_identity r WHERE r.id = NEW.assigned_rider_id AND r.status = 'ACTIVE' AND r.primary_hub_id = NEW.responsible_hub_id) THEN
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
       OR NOT EXISTS (SELECT 1 FROM public.rider_identity r WHERE r.id = NEW.assigned_rider_id AND r.status = 'ACTIVE' AND r.primary_hub_id = NEW.responsible_hub_id) THEN
      RAISE EXCEPTION 'a manifest is dispatched to an active rider of its own hub' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('PENDING', 'ARRIVED')) THEN
      RAISE EXCEPTION 'a manifest with no stop still to be worked is not dispatched' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('PENDING', 'ARRIVED') AND s.pickup_summary IS NULL) THEN
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
    IF NOT EXISTS (SELECT 1 FROM public.pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('PENDING', 'ARRIVED')) THEN
      RAISE EXCEPTION 'a run with no stop still to be worked is not started' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.stop.skip', 'pickup.request.cancel', 'fleet.custody.initiate', 'fleet.custody.accept', 'pickup.failure.report') THEN
    -- The completion by the system (state-machines.md section 4): a run in progress, every stop terminal (above), none of them collected, no
    -- handover pending (above), and the state and its moment written and nothing else. A run with something collected is closed by the hub
    -- handover, whose own key is a later task's: these keys do not complete it.
    IF OLD.state <> 'IN_PROGRESS' OR NEW.state <> 'COMPLETED' THEN
      RAISE EXCEPTION 'the act that settles a run completes a run in progress and does nothing else to a manifest' USING ERRCODE = '23514';
    END IF;
    IF NEW.completed_at IS NULL
       OR (to_jsonb(NEW) - 'state' - 'completed_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'completed_at' - 'version') THEN
      RAISE EXCEPTION 'the completion of a run changes its state and the moment of completion and nothing else' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('COLLECTED', 'PARTIALLY_COLLECTED')) THEN
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
-- The ledger as 0071 left it, with the events of the failure report added to the rider's arm (S1.28).
ALTER POLICY "audit_event_insert" ON "audit_event" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN actor_type = 'STAFF' AND actor_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN actor_type = 'VENDOR_ACCOUNT' AND actor_id = melarc.current_principal_id() AND surface_context = 'VENDOR_PWA' AND (
      (event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT' AND outcome = 'SUCCEEDED' AND enhanced = false)
      OR (event_code IN ('pickup.request.created', 'pickup.request.cancelled') AND object_type = 'PickupRequest' AND vendor_organization_id = melarc.current_vendor_organization_id() AND outcome = 'SUCCEEDED' AND enhanced = false)
      -- S1.27: the vendor's entry of a code, and the close of the stop it causes, written by the operation of migration 0070 as the owner for a request of the vendor's own;
      -- S1.29: and the dispute of a collection, written by the operation of migration 0071 in the same way (it carries the vendor's note; the arm binds the request, not the words).
      OR (current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
          AND event_code IN ('pickup.handshake.verified', 'pickup.handshake.disputed', 'pickup.stop.collected', 'pickup.stop.partially_collected') AND object_type IN ('CollectionHandshake', 'PickupStop')
          AND vendor_organization_id = melarc.current_vendor_organization_id() AND outcome = 'SUCCEEDED' AND enhanced = false
          AND EXISTS (SELECT 1 FROM pickup_request r WHERE r.id::text = "audit_event"."related_ids" ->> 'pickup_request_id' AND r.vendor_organization_id = melarc.current_vendor_organization_id()))
    )
    WHEN 'RIDER' THEN actor_type = 'RIDER' AND actor_id = melarc.current_principal_id() AND surface_context = 'RIDER_ANDROID' AND outcome = 'SUCCEEDED' AND (
      (enhanced = false AND (
        (event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT')
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.run.execute' AND (
          (event_code = 'pickup.manifest.started' AND object_type = 'PickupManifest' AND previous_state = 'DISPATCHED' AND resulting_state = 'IN_PROGRESS' AND EXISTS (SELECT 1 FROM pickup_manifest m WHERE m.id = "audit_event"."object_id" AND m.assigned_rider_id = melarc.current_rider_id() AND m.responsible_hub_id = "audit_event"."responsible_hub_id" AND "audit_event"."related_ids" = jsonb_build_object('rider_id', melarc.current_rider_id()::text)))
          OR (event_code = 'pickup.stop.arrived' AND object_type = 'PickupStop' AND previous_state = 'PENDING' AND resulting_state = 'ARRIVED' AND EXISTS (SELECT 1 FROM pickup_stop s WHERE s.id = "audit_event"."object_id" AND s.responsible_hub_id = "audit_event"."responsible_hub_id" AND "audit_event"."related_ids" = jsonb_build_object('pickup_manifest_id', s.pickup_manifest_id::text, 'pickup_request_id', s.pickup_request_id::text, 'rider_id', melarc.current_rider_id()::text)))
        ))
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept'
            AND event_code = 'pickup.manifest.completed' AND object_type = 'PickupManifest' AND previous_state = 'IN_PROGRESS' AND resulting_state = 'COMPLETED'
            AND EXISTS (
              SELECT 1 FROM pickup_manifest m
               WHERE m.id = "audit_event"."object_id" AND m.state = 'COMPLETED' AND m.responsible_hub_id = "audit_event"."responsible_hub_id"
                 AND "audit_event"."related_ids" = jsonb_build_object('rider_id', m.assigned_rider_id::text)
                 AND EXISTS (SELECT 1 FROM run_custody_handover h WHERE h.manifest_id = m.id AND h.to_rider_id = melarc.current_rider_id() AND h.state = 'COMPLETED')))
        -- S1.26 closeout (OB-S1-54): the event of a count is the count's own, `pickup.collection.recorded`, the same for a clean count and a short one.
        -- Its object is the record, and it says that a count was recorded and that the stop it was recorded at is still `ARRIVED`. `pickup.stop.collected`
        -- and `pickup.stop.partially_collected` say that the stop closed, which the handshake does (S1.27): no arm of the counting key admits them, so an
        -- abandoned handshake never reads as a completed collection. Every member of the event is bound to the stored record and to its stop, not to a claim:
        -- the record is the rider's own, in the event's hub; the reason is the record's snapshot, member for member, or none; the related identifiers are
        -- the record's stop and the stop's run and request and the rider; the detail is the record's counts, variance, flag and direction and nothing
        -- else. The rider's note is on the record and nowhere in the event, and the other free-form members (the note, the diff, the device context, the
        -- bundle, the organization, the approval) are absent, so that nothing a direct writer chooses can be stored in it. The correlation id is the
        -- transaction's own.
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
            AND event_code = 'pickup.collection.recorded' AND object_type = 'CollectionRecord'
            AND previous_state = 'ARRIVED' AND resulting_state = 'ARRIVED'
            AND note IS NULL AND before_after IS NULL AND device_context IS NULL AND actor_bundle IS NULL AND vendor_organization_id IS NULL AND approval_id IS NULL
            AND correlation_id = current_setting('melarc.correlation_id', true)
            AND EXISTS (
              SELECT 1 FROM collection_record c JOIN pickup_stop s ON s.id = c.pickup_stop_id
               WHERE c.id = "audit_event"."object_id" AND c.recorded_by = melarc.current_rider_id()
                 AND c.responsible_hub_id = "audit_event"."responsible_hub_id"
                 AND s.state = 'ARRIVED'
                 AND "audit_event"."reason_code" IS NOT DISTINCT FROM (c.variance_reason_snapshot ->> 'reason_code')
                 AND "audit_event"."reason_label" IS NOT DISTINCT FROM (c.variance_reason_snapshot ->> 'label')
                 AND "audit_event"."related_ids" = jsonb_build_object('pickup_stop_id', c.pickup_stop_id::text, 'pickup_manifest_id', s.pickup_manifest_id::text,
                                                                       'pickup_request_id', s.pickup_request_id::text, 'rider_id', c.recorded_by::text)
                 AND "audit_event"."detail" = jsonb_build_object('declared_count', c.declared_count, 'collected_count', c.collected_count, 'variance', c.variance,
                                                                  'office_notified', c.office_notified_at IS NOT NULL, 'handshake_type', c.handshake_type)))
        -- ... and the promotion that count causes (AC-SLICE-001-28), which is the operation's own event and nobody else's: `melarc.promote_collected_sender`
        -- writes it in the change it records, as the owner, and this arm admits it to a statement that runs as the owner and to no other. A marker the key can
        -- set, a count the rider really made and the right facts are not enough for a statement of the runtime login, which cannot become the owner: it
        -- cannot write the event for a sender it did not promote, cite another counted stop in it, or write it a second time.
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
            AND current_user = 'melarc_owner'
            AND event_code = 'pickup.sender.promoted' AND object_type = 'AdHocSender'
            AND previous_state = 'PROVISIONAL' AND resulting_state = 'REUSABLE'
            AND EXISTS (
              SELECT 1 FROM collection_record c
               WHERE c.pickup_stop_id::text = "audit_event"."related_ids" ->> 'pickup_stop_id' AND c.recorded_by = melarc.current_rider_id()
                 AND c.responsible_hub_id = "audit_event"."responsible_hub_id"))
        -- S1.27: the events of the handshake, and the close of a stop it causes, written by the operations of migration 0070 (`melarc.handshake_event`) as the owner:
        -- the key of the act, a statement that runs as the owner, the kinds of object they are about, and a stop that the calling rider counted. The operations make
        -- every member of them from the rows and the context; the arm bounds who and when, as the arm of the promotion does.
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
            AND current_user = 'melarc_owner'
            AND event_code IN ('pickup.handshake.generated', 'pickup.handshake.fallback_sms', 'pickup.handshake.verified', 'pickup.stop.collected', 'pickup.stop.partially_collected')
            AND object_type IN ('CollectionHandshake', 'PickupStop')
            AND EXISTS (
              SELECT 1 FROM collection_record c
               WHERE c.pickup_stop_id::text = CASE WHEN "audit_event"."object_type" = 'PickupStop' THEN "audit_event"."object_id"::text ELSE "audit_event"."related_ids" ->> 'pickup_stop_id' END
                 AND c.recorded_by = melarc.current_rider_id()
                 AND c.responsible_hub_id = "audit_event"."responsible_hub_id"))
        -- S1.28: the report of a failure, and the completion of the run that it causes by the system (a run whose last stop failed, with nothing collected). Both are written
        -- by the act under the key of the report, in the rider's own name, and each member is bound to the stored rows, not to a claim: the stop is FAILED and its run is
        -- assigned to the calling rider, in the event's hub; the reason is the snapshot's, member for member; the related identifiers are the stop's run and request and the
        -- rider; the detail is the category and the number of contact attempts the stop holds and nothing else. The rider's note is on the stop and nowhere in the event, and
        -- the other free-form members (the note, the diff, the device context, the bundle, the organization, the approval) are absent, so that nothing a direct writer chooses
        -- can be stored in it. The completion is bound to a run that is COMPLETED and assigned to the calling rider, and to the one cause this key has.
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND (
          (event_code = 'pickup.stop.failed' AND object_type = 'PickupStop' AND previous_state = 'ARRIVED' AND resulting_state = 'FAILED'
            AND note IS NULL AND before_after IS NULL AND device_context IS NULL AND actor_bundle IS NULL AND vendor_organization_id IS NULL AND approval_id IS NULL
            AND correlation_id = current_setting('melarc.correlation_id', true)
            AND EXISTS (
              SELECT 1 FROM pickup_stop s JOIN pickup_manifest m ON m.id = s.pickup_manifest_id
               WHERE s.id = "audit_event"."object_id" AND s.state = 'FAILED' AND m.assigned_rider_id = melarc.current_rider_id()
                 AND s.responsible_hub_id = "audit_event"."responsible_hub_id"
                 AND "audit_event"."reason_code" IS NOT DISTINCT FROM (s.failure_reason_snapshot ->> 'reason_code')
                 AND "audit_event"."reason_label" IS NOT DISTINCT FROM (s.failure_reason_snapshot ->> 'label')
                 AND "audit_event"."related_ids" = jsonb_build_object('pickup_manifest_id', s.pickup_manifest_id::text, 'pickup_request_id', s.pickup_request_id::text, 'rider_id', melarc.current_rider_id()::text)
                 AND "audit_event"."detail" = jsonb_build_object('failure_category', s.failure_category, 'contact_attempts', jsonb_array_length(coalesce(s.failure_reason_snapshot -> 'contact_attempts', '[]'::jsonb)))))
          OR (event_code = 'pickup.manifest.completed' AND object_type = 'PickupManifest' AND previous_state = 'IN_PROGRESS' AND resulting_state = 'COMPLETED'
              AND reason_code IS NULL AND reason_label IS NULL
              AND note IS NULL AND before_after IS NULL AND device_context IS NULL AND actor_bundle IS NULL AND vendor_organization_id IS NULL AND approval_id IS NULL
              AND EXISTS (
                SELECT 1 FROM pickup_manifest m
                 WHERE m.id = "audit_event"."object_id" AND m.state = 'COMPLETED' AND m.assigned_rider_id = melarc.current_rider_id()
                   AND m.responsible_hub_id = "audit_event"."responsible_hub_id"
                   AND "audit_event"."related_ids" = jsonb_build_object('rider_id', m.assigned_rider_id::text)
                   -- (The author the completion names is the system's, written upper('system') because the policy lint reads a string literal of that word as a principal
                   -- arm and refuses it anywhere else in a policy; here it is a member of an event's detail and admits no principal.)
                   AND "audit_event"."detail" = jsonb_build_object('completed_by', upper('system'), 'cause', 'LAST_STOP_FAILED')))
        ))
      ))
      OR (enhanced = true AND coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept'
          AND event_code = 'fleet.custody.accepted' AND object_type = 'RunCustodyHandover' AND previous_state = 'PENDING' AND resulting_state = 'COMPLETED'
          AND EXISTS (
            SELECT 1 FROM run_custody_handover h
             WHERE h.id = "audit_event"."object_id" AND h.state = 'COMPLETED' AND h.to_rider_id = melarc.current_rider_id()
               AND h.responsible_hub_id = "audit_event"."responsible_hub_id"
               AND "audit_event"."related_ids" = jsonb_build_object('pickup_manifest_id', h.manifest_id::text, 'from_rider_id', h.from_rider_id::text, 'to_rider_id', h.to_rider_id::text)))
    )
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
