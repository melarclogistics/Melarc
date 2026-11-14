-- S1.32 (SLICE-001): the intake reads and the receive lock (listHubIntakes, getHubIntake, acquireIntakeLock; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.32; features/hub/hub-intake.md section 5.1
-- steps 2 and 3; contracts/state-machines.md section 7, the row "acquire receive lock"; AC-SLICE-001-37, -43 and -77; MSC-DEC-416; OB-S1-92). Forward of 0092; nothing earlier is edited. This migration
-- is applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). No table changes: what it adds is the lock's writes, one hub setting's reader and the one
-- function that serves the declaration once the count is committed.
--
--   * THE LOCK IS ADVISORY AND MOVES NOTHING BUT ITSELF (state-machines.md section 7; section 22.8: "a visual lock alone is not sufficient"). The key of the count (hub.intake.count) writes the two
--     columns of the lock, active_receiver_id and lock_acquired_at, in the name of the staff member who acts, on an intake of the hubs of its grant that is waiting for its count, and it holds no
--     other column: the application's login is granted UPDATE on those two columns and no others, so a count, a state or a condition cannot be written through this key by any statement. The key is
--     also given the read of the intakes of its hubs (the receiver takes the lock and is shown the intake), as hub.read is: the same columns, never the declaration.
--   * WHAT THE DATABASE JUDGES FOR EVERY WRITER (the guard below, restated from 0092 with one branch added). A lock is taken, kept or refreshed only while the intake is waiting for its count. Another
--     receiver takes a held lock over only after the hub's idle time (intake_lock_idle_ttl_minutes, a hub setting: the Product Owner's development value of fifteen minutes, decision D-13) has passed on
--     the database's clock; a hub with no usable value (missing, not a whole number, not within a day) offers no takeover at all, and nothing is invented in its place: an unset time degrades takeover,
--     not correctness (settings.md section 7.3). The holder refreshes its own lock whenever it likes. The moment of a lock is the database's, whatever a writer gives, so that no writer can be born old or
--     never grow idle. A lock is released by writing its two columns null together (the check of the table keeps them together); no operation of this slice does it.
--   * THE VERSION IS THE ETAG AND THE LOCK DOES NOT MOVE IT (AC-SLICE-001-43: the lock does not substitute for the guards). The version trigger of 0092 counted every change but its own; it now leaves the
--     two columns of the lock out as well. A receiver that read an intake holds its ETag through every refresh and takeover of the lock, and a count is refused for the facts of the intake (it has been
--     counted) and never for a lock: two receivers who both submit a count get one success and one STATE_CONFLICT, whatever the lock says.
--   * THE DECLARATION AFTER THE COUNT (OB-S1-92). The application's login cannot read rider_declared_count or prefilled_count (0092), so the read of an intake that has been counted (HubIntakePostCount,
--     which carries the declaration) is made through one SECURITY DEFINER function, melarc.hub_intake_declarations. It answers the declaration of an intake only once it is past AWAITING_COUNT, for staff
--     under hub.read or hub.intake.count, and only the intakes the table shows that context (the owner is bound by row-level security too, and the policies of the table name no role, so they apply to
--     the function exactly as they apply to the caller): the hubs of the grant. Any other context is refused. prefilled_count is served by no function: the contract's post-count shape has no field for it.

-- The idle time of the lock for a hub: the value in force of intake_lock_idle_ttl_minutes, whole minutes from one to a day, or NULL where the hub has none or one that is not that (nothing is invented). It
-- runs with the rights of its invoker (the guard and the application's statement), so it sees what the caller's context may see of the hub's settings: a staff member reads the hubs of its grant.
CREATE FUNCTION melarc.intake_lock_idle_ttl_minutes(p_hub uuid) RETURNS integer LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held jsonb;
  minutes integer;
BEGIN
  SELECT s.value INTO held
    FROM public.hub_setting AS s
   WHERE s.hub_id = p_hub AND s.setting_key = 'intake_lock_idle_ttl_minutes' AND s.scope_ref = '' AND s.effective_from <= pg_catalog.clock_timestamp()
   ORDER BY s.effective_from DESC, s.version DESC
   LIMIT 1;
  IF held IS NULL OR pg_catalog.jsonb_typeof(held) <> 'number' OR (held #>> '{}') !~ '^[0-9]{1,4}$' THEN
    RETURN NULL;
  END IF;
  minutes := (held #>> '{}')::integer;
  IF minutes < 1 OR minutes > 1440 THEN
    RETURN NULL;
  END IF;
  RETURN minutes;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_lock_idle_ttl_minutes(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_lock_idle_ttl_minutes(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_lock_idle_ttl_minutes(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- What the application's login writes of an intake from now on: the two columns of the lock, and no other. (It inserts the columns of a handover and reads the named columns: 0092.)
GRANT UPDATE ("active_receiver_id", "lock_acquired_at") ON "pickup_intake" TO melarc_api_runtime;
--> statement-breakpoint
-- The key of the count reads the intakes of the hubs of its grant, as hub.read does, so that the receiver who takes the lock is shown the intake (the same columns: the grants withhold the declaration
-- whatever a policy admits).
CREATE POLICY "pickup_intake_count_read" ON "pickup_intake" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The lock: the key of the count writes an intake of the hubs of its grant, and what it may leave is an intake that is waiting for its count, held in the name of the staff member who acts. (The guard
-- judges the rest, for every writer, before this check: the idle time of a takeover, the moment, the state.)
CREATE POLICY "pickup_intake_lock" ON "pickup_intake" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
      AND "pickup_intake"."state" = 'AWAITING_COUNT' AND "pickup_intake"."active_receiver_id" = melarc.current_principal_id()
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of an intake as 0092 made it (the last definition), with one branch added at the end: the receive lock (S1.32). Nothing else of the function changes.
CREATE OR REPLACE FUNCTION melarc.pickup_intake_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  run_state text;
  run_completed_at timestamp with time zone;
  idle_minutes integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'AWAITING_COUNT' THEN
      RAISE EXCEPTION 'an intake is opened at AWAITING_COUNT, with nothing counted' USING ERRCODE = '23514';
    END IF;
    SELECT m.state, m.completed_at INTO run_state, run_completed_at
      FROM public.pickup_manifest AS m WHERE m.id = NEW.pickup_manifest_id AND m.responsible_hub_id = NEW.responsible_hub_id;
    IF NOT FOUND OR run_state IS DISTINCT FROM 'COMPLETED' OR run_completed_at IS NULL THEN
      RAISE EXCEPTION 'an intake is opened by the hub handover of a completed run' USING ERRCODE = '23514';
    END IF;
    -- The guard reads whether the request was collected, and never what it was collected at (MSC-DEC-194 part 3).
    IF NOT EXISTS (
      SELECT 1 FROM public.pickup_stop AS s
       WHERE s.pickup_manifest_id = NEW.pickup_manifest_id AND s.pickup_request_id = NEW.pickup_request_id AND s.state IN ('COLLECTED', 'PARTIALLY_COLLECTED')
    ) THEN
      RAISE EXCEPTION 'an intake is opened for a request that was collected on its run' USING ERRCODE = '23514';
    END IF;
    IF melarc.run_custody_holder(NEW.pickup_manifest_id) IS DISTINCT FROM NEW.handed_over_by THEN
      RAISE EXCEPTION 'an intake is opened in the name of the custody holder of its run' USING ERRCODE = '23514';
    END IF;
    -- The receipt is the database's: the moment the handover completed the run, whatever the writer gave.
    NEW.handed_over_at := run_completed_at;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.pickup_request_id IS DISTINCT FROM OLD.pickup_request_id
     OR NEW.pickup_manifest_id IS DISTINCT FROM OLD.pickup_manifest_id
     OR NEW.handed_over_by IS DISTINCT FROM OLD.handed_over_by
     OR NEW.handed_over_at IS DISTINCT FROM OLD.handed_over_at
     OR NEW.declaration_captured_at IS DISTINCT FROM OLD.declaration_captured_at
     OR NEW.rider_declared_count IS DISTINCT FROM OLD.rider_declared_count
     OR NEW.prefilled_count IS DISTINCT FROM OLD.prefilled_count THEN
    RAISE EXCEPTION 'an intake keeps its identity, its run, its request, its hub, its handover and its declaration' USING ERRCODE = '23514';
  END IF;
  IF OLD.physical_count IS NOT NULL
     AND (NEW.physical_count IS DISTINCT FROM OLD.physical_count
          OR NEW.counted_at IS DISTINCT FROM OLD.counted_at
          OR NEW.counted_by IS DISTINCT FROM OLD.counted_by
          OR NEW.count_variance IS DISTINCT FROM OLD.count_variance
          OR NEW.count_difference IS DISTINCT FROM OLD.count_difference) THEN
    RAISE EXCEPTION 'a count, once made, is kept as it was' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'AWAITING_COUNT' AND NEW.state = 'COUNTED')
       OR (OLD.state = 'COUNTED' AND NEW.state IN ('READY_FOR_ITEMIZATION', 'RECONCILIATION_REQUIRED'))
       OR (OLD.state = 'RECONCILIATION_REQUIRED' AND NEW.state = 'READY_FOR_ITEMIZATION')
       OR (OLD.state = 'READY_FOR_ITEMIZATION' AND NEW.state = 'ITEMIZING')
       OR (OLD.state = 'ITEMIZING' AND NEW.state = 'CLOSED')
       OR (OLD.state = 'CLOSED' AND NEW.state = 'ITEMIZING')
     ) THEN
    RAISE EXCEPTION 'an intake moves from AWAITING_COUNT to COUNTED, from COUNTED to READY_FOR_ITEMIZATION or RECONCILIATION_REQUIRED, from RECONCILIATION_REQUIRED to READY_FOR_ITEMIZATION, then to ITEMIZING and CLOSED, and a closed one is reopened to ITEMIZING, and no other way' USING ERRCODE = '23514';
  END IF;

  -- The receive lock (S1.32; state-machines.md section 7, "acquire receive lock"). A lock that is taken, kept or refreshed is for an intake that is waiting for its count, before and after the write.
  -- Another receiver takes a held lock over only after the idle time of the hub on the database's clock, and a hub that has none (or none that is usable) offers no takeover. The moment is the
  -- database's, whatever the writer gave. Clearing the lock (both columns null, which the check of the table keeps together) is not judged here: the count that follows, or an operator, may release it.
  IF NEW.active_receiver_id IS DISTINCT FROM OLD.active_receiver_id OR NEW.lock_acquired_at IS DISTINCT FROM OLD.lock_acquired_at THEN
    IF NEW.active_receiver_id IS NOT NULL THEN
      IF OLD.state <> 'AWAITING_COUNT' OR NEW.state <> 'AWAITING_COUNT' THEN
        RAISE EXCEPTION 'the receive lock is taken on an intake that is waiting for its count' USING ERRCODE = '23514';
      END IF;
      IF OLD.active_receiver_id IS NOT NULL AND NEW.active_receiver_id IS DISTINCT FROM OLD.active_receiver_id THEN
        idle_minutes := melarc.intake_lock_idle_ttl_minutes(NEW.responsible_hub_id);
        IF idle_minutes IS NULL OR OLD.lock_acquired_at > pg_catalog.clock_timestamp() - pg_catalog.make_interval(mins => idle_minutes) THEN
          RAISE EXCEPTION 'the receive lock of another receiver is taken over only after it has been idle for the time of the hub' USING ERRCODE = '23514';
        END IF;
      END IF;
      NEW.lock_acquired_at := pg_catalog.clock_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_intake_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_intake_guard() FROM PUBLIC;
--> statement-breakpoint
-- The version trigger as 0092 made it, with the two columns of the lock left out of what moves the version (the ETag of an intake is the version, and the lock does not substitute for the guards).
CREATE OR REPLACE FUNCTION melarc.pickup_intake_version() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - 'version' - 'active_receiver_id' - 'lock_acquired_at') IS DISTINCT FROM (to_jsonb(OLD) - 'version' - 'active_receiver_id' - 'lock_acquired_at') THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_intake_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_intake_version() FROM PUBLIC;
--> statement-breakpoint
-- The declaration of the intakes that have been counted, for the read that serves them (HubIntakePostCount). The one way the application reads rider_declared_count: it answers only an intake that is past
-- AWAITING_COUNT (a count exists), only to staff under a key that reads intakes, and only the intakes the table shows that context (the policies apply to the owner as to the caller). It serves the
-- declaration and nothing else of the row; what the form was pre-filled with is served by nobody.
CREATE FUNCTION melarc.hub_intake_declarations(p_intake_ids uuid[]) RETURNS TABLE (intake_id uuid, rider_declared_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count') THEN
    RAISE EXCEPTION 'the declaration of a counted intake is read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT i.id, i.rider_declared_count
      FROM public.pickup_intake AS i
     WHERE i.id = ANY (p_intake_ids) AND i.state <> 'AWAITING_COUNT' AND i.physical_count IS NOT NULL
     ORDER BY i.id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.hub_intake_declarations(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.hub_intake_declarations(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.hub_intake_declarations(uuid[]) TO melarc_api_runtime;
