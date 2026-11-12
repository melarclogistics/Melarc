-- Run A2, 12 November 2026 (finding L5 of the review of Run A: the gauge of the hubs the failure backstop cannot judge undercounts when a batch fills). Forward of 0084; nothing earlier is edited.
--
-- 0084 left the loop over the hubs as soon as a batch was full (`EXIT WHEN more`). A hub that comes later in the order of identifiers than the hub that filled the batch was then not
-- looked at in that call, so a hub whose threshold is missing or unusable and that came after it was not named, and the lane, which keeps the list of the last call it made as the
-- hubs it could not judge (and counts them in the gauge `pickup_backstop_unusable_hubs`), read fewer than there were: zero, when a backlog in an earlier hub outlasted the rounds of a
-- run. The function now judges the threshold of EVERY hub with a failure waiting on every call, and escalates nothing once the batch is full: a hub met after that is judged and,
-- if its threshold is usable, left for the next call. What it escalates, in what order and with what event is as 0084 made it.
--
-- The function is restated whole (CREATE OR REPLACE keeps its owner and its grant, which are stated again below, as 0085 and 0086 did for the guard).
CREATE OR REPLACE FUNCTION melarc.failure_backstop_escalate(p_limit integer)
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
    -- A full batch ends the escalating and not the judging: the hubs after this one are still looked at, so that the hubs named are every hub that cannot be judged (L5).
    IF more THEN
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
