-- S1.28 (SLICE-001), AC-SLICE-001-34, OB-S1-07 and OB-S1-66: the failure backstop and the narrowing of the escalation (the Product Owner's decisions of 11 November 2026, D-A1;
-- delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md section 11; features/pickup/pickup-failure.md section 5; contracts/state-machines.md section 3). Applied as melarc_migration_elevated,
-- a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). It is a NEW migration: nothing earlier is edited. It changes no table and adds no column or setting: the threshold is
-- the hub's stale_failure_backstop_hours, which the launch hub's configuration already holds (24), and the cadence of the lane is the worker's configuration.
--
--   1. The escalation of a request is held for every writer (the guard below). A request is escalated only when it is CONFIRMED and one of its stops FAILED: escalation is a resolution of
--      a failure, as the contract, pickup-failure.md section 5.1, section 21.6 of the master specification and OB-S1-66 all say, and the service refuses it with the same rule
--      (no_failed_stop). The capability of the backstop writes the moment of the escalation and nothing else of a request.
--   2. The backstop is ONE function (melarc.failure_backstop_escalate), executable by the capability role melarc_worker_cap_pickup_backstop alone, which the worker's login inherits. The role
--      holds no privilege on any table. The function runs as the owner, and the policies below admit its statements only: a statement of any other login does not meet the owner arm, and
--      the capability test is in every one of them. It escalates a request whose failed stop has sat undecided longer than the hub's threshold and does nothing else:
--        * undecided is: the request is still CONFIRMED and has not been escalated (a request that was rescheduled or cancelled is CANCELLED, and one an officer escalated has the moment);
--        * the failure moment is the stop's resolved_at, which the database took when the rider's report was written;
--        * the threshold is the value in force of stale_failure_backstop_hours of the request's hub, a whole number of hours from 1 to 8760. A hub whose value is missing or not that is
--          NOT judged: nothing of it is escalated, and the function says so (its hubs are returned, so that the lane can raise its alert); nothing is invented in its place;
--        * two lanes at once escalate a request once: the candidates are locked with SKIP LOCKED, the statement that sets the moment repeats the conditions, and the guard refuses a second
--          moment;
--        * each escalation sets the moment (escalated_at) and writes the enhanced event pickup.request.escalated in the same change, by SYSTEM with no actor and the trigger BACKSTOP, with
--          the threshold in hours and the seconds the failure waited, so that the escalation is recorded with its trigger.
--   3. The policies. Each names the capability, the owner (current_user), and the rows it reaches; a policy of its own for each table, beside the others, because the SYSTEM arm of a policy
--      names one capability and no other condition that can undo it.

-- The guard of a pickup request as 0064 made it (the function is spliced from that file), with two rules added: the moment of an escalation is recorded only for a confirmed request that
-- has a stop that failed, and the backstop writes that moment and nothing else.
CREATE OR REPLACE FUNCTION melarc.pickup_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acting_key text := coalesce(current_setting('melarc.authorization_key', true), '');
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
  -- S1.28 (0084; OB-S1-66): an escalation is a resolution of a FAILED request. The moment is recorded only for a confirmed request that has a stop that failed, whoever writes it: the officer
  -- of the Ops decision queue and the backstop alike. The stops are read as the invoker, through row-level security: the officer of the request's hub reads them under the key of the
  -- escalation, and the backstop reads the failed ones under its capability.
  IF OLD.escalated_at IS NULL AND NEW.escalated_at IS NOT NULL THEN
    IF OLD.state <> 'CONFIRMED' OR NEW.state <> 'CONFIRMED' THEN
      RAISE EXCEPTION 'only a confirmed request is escalated' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pickup_stop AS failed WHERE failed.pickup_request_id = NEW.id AND failed.state = 'FAILED') THEN
      RAISE EXCEPTION 'only a request whose stop failed is escalated' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
    END IF;
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
  IF NEW.rider_assigned IS DISTINCT FROM OLD.rider_assigned THEN
    IF acting_key = 'pickup.manifest.assign' THEN
      IF NOT (NEW.rider_assigned AND NOT OLD.rider_assigned) THEN
        RAISE EXCEPTION 'the assignment of a rider marks a request as having one and never takes the mark back' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.pickup_stop AS held
          JOIN public.pickup_manifest AS run ON run.id = held.pickup_manifest_id
         WHERE held.pickup_request_id = NEW.id AND held.released_at IS NULL AND run.assigned_rider_id IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'a request is marked as having a rider only while a stop that has not released its claim holds it on a manifest that has one' USING ERRCODE = '23514';
      END IF;
    ELSIF acting_key = 'pickup.manifest.create' THEN
      IF NOT (OLD.rider_assigned AND NOT NEW.rider_assigned) THEN
        RAISE EXCEPTION 'the cancellation of a manifest takes the mark of a rider from a request and never gives it' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.pickup_stop AS held WHERE held.pickup_request_id = NEW.id AND held.released_at IS NULL
      ) OR NOT EXISTS (
        SELECT 1 FROM public.pickup_stop AS released WHERE released.pickup_request_id = NEW.id AND released.released_at IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'the mark of a rider is taken from a request only when its claim has been released and no stop holds it any more' USING ERRCODE = '23514';
      END IF;
    ELSIF acting_key <> '' THEN
      RAISE EXCEPTION 'only the assignment of a rider and the cancellation of a manifest change the mark of a rider on a request' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF acting_key IN ('pickup.manifest.assign', 'pickup.manifest.create')
     AND (to_jsonb(NEW) - 'rider_assigned' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'rider_assigned' - 'version') THEN
    RAISE EXCEPTION 'a planning act marks or unmarks a request as having a rider and changes nothing else' USING ERRCODE = '23514';
  END IF;
  -- The backstop (0084) sets the moment of an escalation and nothing else of a request, for every statement it can make.
  IF melarc.principal_type() = 'SYSTEM' AND melarc.task_capability() = 'pickup_backstop'
     AND (to_jsonb(NEW) - 'escalated_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'escalated_at' - 'version') THEN
    RAISE EXCEPTION 'the backstop sets the moment of an escalation and changes nothing else of a request' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_request_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_request_guard() FROM PUBLIC;
--> statement-breakpoint

-- The confirmed requests the function reads, and the ones it escalates: the moment is set on a confirmed request that has none, and the new row is a confirmed request that has one.
CREATE POLICY "pickup_request_backstop_read" ON "pickup_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'pickup_backstop' AND current_user = 'melarc_owner' AND "pickup_request"."state" = 'CONFIRMED'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_request_backstop_escalate" ON "pickup_request" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'pickup_backstop' AND current_user = 'melarc_owner' AND "pickup_request"."state" = 'CONFIRMED' AND "pickup_request"."escalated_at" IS NULL
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'pickup_backstop' AND current_user = 'melarc_owner' AND "pickup_request"."state" = 'CONFIRMED' AND "pickup_request"."escalated_at" IS NOT NULL
    ELSE false
  END
);
--> statement-breakpoint
-- The stops that failed, read to find the request and to say how long the failure has waited. No write.
CREATE POLICY "pickup_stop_backstop_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'pickup_backstop' AND current_user = 'melarc_owner' AND "pickup_stop"."state" = 'FAILED'
    ELSE false
  END
);
--> statement-breakpoint
-- The threshold of a hub, and no other row of the hub's settings.
CREATE POLICY "hub_setting_backstop_read" ON "hub_setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'pickup_backstop' AND current_user = 'melarc_owner' AND setting_key = 'stale_failure_backstop_hours' AND scope_ref = ''
    ELSE false
  END
);
--> statement-breakpoint
-- The one event the lane writes: the enhanced escalation of a request, by SYSTEM with no actor (a ledger row with no actor is a SYSTEM row: audit_event_system_has_no_actor_id) and the
-- trigger BACKSTOP, about a request that carries the moment of an escalation in the hub the event names. A policy of its own, beside the ledger's, as 0070 did for the notification lane.
CREATE POLICY "audit_event_insert_backstop" ON "audit_event" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'pickup_backstop' AND current_user = 'melarc_owner' AND actor_id IS NULL
      AND event_code = 'pickup.request.escalated' AND object_type = 'PickupRequest' AND outcome = 'SUCCEEDED' AND enhanced = true
      AND approval_id IS NULL AND note IS NULL AND device_context IS NULL AND actor_bundle IS NULL AND (detail ->> 'trigger') = 'BACKSTOP'
      AND EXISTS (SELECT 1 FROM "pickup_request" AS escalated
                   WHERE escalated.id = "audit_event"."object_id" AND escalated.responsible_hub_id = "audit_event"."responsible_hub_id"
                     AND escalated.vendor_organization_id IS NOT DISTINCT FROM "audit_event"."vendor_organization_id" AND escalated.escalated_at IS NOT NULL)
    ELSE false
  END
);
--> statement-breakpoint

-- melarc.failure_backstop_escalate: the backstop's one operation. It answers the failure backstop capability and nobody else (SQLSTATE 42501), takes the most requests one run may escalate
-- (from one to a thousand), and answers how many it escalated, whether the batch was full (so there may be more) and the hubs it could not judge because their threshold is missing or
-- unusable. It reads the hubs that have a request in the Ops decision context (confirmed, not escalated, one of its stops failed), one at a time in the order of their identifiers.
CREATE FUNCTION melarc.failure_backstop_escalate(p_limit integer)
RETURNS TABLE (out_escalated integer, out_more boolean, out_unusable_hubs uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  hub_row record;
  candidate record;
  failed record;
  held jsonb;
  threshold integer;
  moment timestamp with time zone;
  done integer := 0;
  more boolean := false;
  unusable uuid[] := ARRAY[]::uuid[];
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'SYSTEM' OR melarc.task_capability() IS DISTINCT FROM 'pickup_backstop' THEN
    RAISE EXCEPTION 'the failures left undecided are escalated by the failure backstop, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'a run of the backstop takes from one to a thousand requests' USING ERRCODE = '22023';
  END IF;

  FOR hub_row IN
    SELECT DISTINCT r.responsible_hub_id AS hub_id
      FROM public.pickup_request AS r
     WHERE r.state = 'CONFIRMED' AND r.escalated_at IS NULL
       AND EXISTS (SELECT 1 FROM public.pickup_stop AS f WHERE f.pickup_request_id = r.id AND f.state = 'FAILED')
     ORDER BY 1
  LOOP
    -- The threshold in force for the hub: a whole number of hours from 1 to 8760. Anything else is a hub the backstop cannot judge, and is told so.
    held := NULL;
    SELECT s.value INTO held
      FROM public.hub_setting AS s
     WHERE s.hub_id = hub_row.hub_id AND s.setting_key = 'stale_failure_backstop_hours' AND s.scope_ref = '' AND s.effective_from <= pg_catalog.clock_timestamp()
     ORDER BY s.effective_from DESC, s.version DESC
     LIMIT 1;
    threshold := NULL;
    IF held IS NOT NULL AND pg_catalog.jsonb_typeof(held) = 'number' AND (held #>> '{}') ~ '^[0-9]{1,4}$' THEN
      threshold := (held #>> '{}')::integer;
      IF threshold < 1 OR threshold > 8760 THEN
        threshold := NULL;
      END IF;
    END IF;
    IF threshold IS NULL THEN
      unusable := pg_catalog.array_append(unusable, hub_row.hub_id);
      CONTINUE;
    END IF;

    FOR candidate IN
      SELECT r.id AS request_id, r.vendor_organization_id AS vendor_id
        FROM public.pickup_request AS r
       WHERE r.responsible_hub_id = hub_row.hub_id AND r.state = 'CONFIRMED' AND r.escalated_at IS NULL
         AND EXISTS (SELECT 1 FROM public.pickup_stop AS f
                      WHERE f.pickup_request_id = r.id AND f.state = 'FAILED'
                        AND f.resolved_at <= pg_catalog.clock_timestamp() - pg_catalog.make_interval(hours => threshold))
       ORDER BY (SELECT min(f.resolved_at) FROM public.pickup_stop AS f WHERE f.pickup_request_id = r.id AND f.state = 'FAILED'), r.id
       LIMIT p_limit - done + 1
         FOR UPDATE OF r SKIP LOCKED
    LOOP
      -- One more than the run takes is asked for, only to learn whether the batch was full.
      IF done >= p_limit THEN
        more := true;
        EXIT;
      END IF;
      SELECT f.id, f.resolved_at INTO failed
        FROM public.pickup_stop AS f
       WHERE f.pickup_request_id = candidate.request_id AND f.state = 'FAILED'
       ORDER BY f.resolved_at, f.id
       LIMIT 1;
      moment := pg_catalog.clock_timestamp();
      -- The request is locked and was read as confirmed and not escalated: the statement finds it, and the guard holds the rule for the statement as for any other.
      UPDATE public.pickup_request SET escalated_at = moment
       WHERE id = candidate.request_id AND state = 'CONFIRMED' AND escalated_at IS NULL;
      INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, vendor_organization_id, responsible_hub_id, object_type, object_id,
                                      correlation_id, previous_state, resulting_state, before_after, related_ids, detail, outcome, enhanced, serialisation_version)
        VALUES (pg_catalog.uuidv7(), 'pickup.request.escalated', moment, 'SYSTEM', NULL, 'SYSTEM', candidate.vendor_id, hub_row.hub_id, 'PickupRequest', candidate.request_id,
                pg_catalog.current_setting('melarc.correlation_id', true), 'CONFIRMED', 'CONFIRMED',
                pg_catalog.jsonb_build_object('escalated_at', pg_catalog.jsonb_build_object('before', NULL::text,
                  'after', pg_catalog.to_char(moment AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
                pg_catalog.jsonb_build_object('pickup_stop_id', failed.id::text),
                pg_catalog.jsonb_build_object('trigger', 'BACKSTOP', 'threshold_hours', threshold,
                  'waited_seconds', pg_catalog.floor(pg_catalog.date_part('epoch', moment - failed.resolved_at))::bigint),
                'SUCCEEDED', true, 1);
      done := done + 1;
    END LOOP;
    EXIT WHEN more;
  END LOOP;

  RETURN QUERY SELECT done, more, unusable;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.failure_backstop_escalate(integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.failure_backstop_escalate(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.failure_backstop_escalate(integer) TO melarc_worker_cap_pickup_backstop;
