-- Run A2, 12 November 2026 (findings M1, M2 and L2 of the review of Run A; the Product Owner's decision D-A8). Forward of 0080; nothing earlier is edited.
--
--   * The lifetime of an upload instruction and the size of the file are held by the guard for every writer (M1). Until now the service alone compared them with the platform
--     settings (`evidence_upload_authorization_ttl_minutes`, `evidence_upload_max_bytes`): the guard and the checks of 0080 accepted any positive value, so a writer that was not the service
--     could grant itself an instruction that lived a year, and an API instance that re-signed a retry from the row would have signed it for a year. The guard now refuses a record
--     whose lifetime is longer than the setting, or whose declared size is larger, reading the same rows the service reads, so a value the owner changes holds everywhere at once.
--     A record keeps the lifetime it was made with, and a shorter one is no harm.
--   * The tolerance on the moment of a capture is a platform setting (D-A8): `evidence_capture_clock_tolerance_minutes`, 5 minutes, held where the moment is checked. 0080 refused any capture
--     ahead of the database's clock, which refused a photo taken at the door by a phone whose clock runs a little fast. The guard now allows the setting's minutes of lead and no more; it
--     bounds the future only (a capture is never refused for being old).
--   * The three limits are read through one helper that fails closed (M1): a setting that is missing, is not a number, is not whole or is below its floor refuses the record with the reason
--     SETTING_MISSING, and no value is invented. The rider's key reads the new setting beside the three it already reads.
--   * The read of a request under the failure key is the rider's own (L2). 0080 let an owner-run statement under that key read EVERY request (its policy had no row condition); it now reaches
--     only the request of a stop on the caller's assigned run in progress, which is the one thing `melarc.evidence_pickup_stop_scope` asks of it.
--
-- The guard is restated whole (CREATE OR REPLACE keeps its owner, its trigger and its revocation, which are stated again below, as 0081 did).

-- 1. The setting, for a database the reference seed has already filled (the seed refuses a database that holds a row, so it can never be seeded again), once, under the seed capability,
-- as 0080 does for the other two. A database that has not been seeded gets the same row from the seed (tools/seed/settings.ts); a test holds the two equal.
DO $evidence_tolerance$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
BEGIN
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);
  IF EXISTS (SELECT 1 FROM public.setting) THEN
    INSERT INTO public.setting (key, scope, value_type, value, unit, description)
    SELECT v.key, v.scope, v.value_type, v.value, v.unit, v.description
      FROM (VALUES
        ('evidence_capture_clock_tolerance_minutes', 'PLATFORM', 'integer', '5'::jsonb, 'minutes', 'How far ahead of the server’s clock the moment of an evidence capture may be, for a phone whose clock runs fast: decided by the Product Owner on 12 November 2026.')
      ) AS v(key, scope, value_type, value, unit, description)
     WHERE NOT EXISTS (SELECT 1 FROM public.setting AS held WHERE held.key = v.key);
  END IF;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$evidence_tolerance$;
--> statement-breakpoint
-- 2. The rider's key reads four evidence settings and no other platform row (staff read every setting already: setting_read). The policy is stated again with the fourth key.
DROP POLICY "setting_evidence_read" ON "setting";
--> statement-breakpoint
CREATE POLICY "setting_evidence_read" ON "setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report'
      AND key IN ('evidence_upload_max_bytes', 'evidence_upload_allowed_mime_types', 'evidence_upload_authorization_ttl_minutes', 'evidence_capture_clock_tolerance_minutes')
    ELSE false
  END
);
--> statement-breakpoint
-- 3. melarc.evidence_limit: a whole-number platform setting of the evidence record, or the refusal that says it is not there. It runs with the invoker's rights (the guard that calls it does), so
-- it sees what the writer's context may see: the rider's key sees the four above, and a context that sees none gets the refusal, never a value.
CREATE FUNCTION melarc.evidence_limit(p_key text, p_minimum integer) RETURNS integer LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held jsonb;
  amount numeric;
BEGIN
  SELECT s.value INTO held FROM public.setting AS s WHERE s.key = p_key;
  IF held IS NULL OR pg_catalog.jsonb_typeof(held) <> 'number' THEN
    RAISE EXCEPTION 'the setting % is missing or is not a number', p_key USING ERRCODE = '23514', DETAIL = 'reason=SETTING_MISSING';
  END IF;
  amount := (held #>> '{}')::numeric;
  IF amount <> pg_catalog.trunc(amount) OR amount < p_minimum OR amount > 2147483647 THEN
    RAISE EXCEPTION 'the setting % is not a whole number of at least % that fits', p_key, p_minimum USING ERRCODE = '23514', DETAIL = 'reason=SETTING_MISSING';
  END IF;
  RETURN amount::integer;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.evidence_limit(text, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.evidence_limit(text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.evidence_limit(text, integer) TO melarc_api_runtime;
--> statement-breakpoint
-- 4. The guard as 0080 made it, with the moment of a capture held to the tolerance and the lifetime and the size held to their settings, in that order after the checks it already made.
CREATE OR REPLACE FUNCTION melarc.evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  derived record;
  instant timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence is retained and never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING_UPLOAD' OR NEW.uploaded_at IS NOT NULL OR NEW.validated_signature IS NOT NULL THEN
      RAISE EXCEPTION 'evidence is declared pending its upload' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
    END IF;
    -- The moment of a capture may run ahead of the database's clock by the platform's tolerance and no more (D-A8). It bounds the future only.
    IF NEW.captured_at > instant + pg_catalog.make_interval(mins => melarc.evidence_limit('evidence_capture_clock_tolerance_minutes', 0)) THEN
      RAISE EXCEPTION 'the moment of a capture is not ahead of the clock by more than the tolerance' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
    END IF;
    -- The lifetime of the upload instruction and the size of the file are the platform's settings, for every writer (finding M1 of the review of Run A). A shorter lifetime is no harm.
    IF NEW.upload_ttl_seconds::bigint > melarc.evidence_limit('evidence_upload_authorization_ttl_minutes', 1)::bigint * 60 THEN
      RAISE EXCEPTION 'the upload instruction of evidence lives no longer than the platform setting grants' USING ERRCODE = '23514', DETAIL = 'reason=UPLOAD_LIFETIME_EXCEEDED';
    END IF;
    IF NEW.byte_size::bigint > melarc.evidence_limit('evidence_upload_max_bytes', 1)::bigint THEN
      RAISE EXCEPTION 'evidence is no larger than the platform setting grants' USING ERRCODE = '23514', DETAIL = 'reason=UPLOAD_SIZE_EXCEEDED';
    END IF;
    -- The instants are the database's own: a writer does not choose when a record was made or when its upload window ends (to the second, so that the upload instruction can be made again, identically).
    NEW.created_at := pg_catalog.date_trunc('second', instant);
    NEW.upload_expires_at := NEW.created_at + pg_catalog.make_interval(secs => NEW.upload_ttl_seconds);
    NEW.version := 1;
    -- Under the rider's key the scope is derived from the stop and is not the writer's to give (GBT-M9).
    IF NEW.owner_type = 'PICKUP_STOP'
       AND melarc.principal_type() = 'RIDER'
       AND coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' THEN
      SELECT * INTO derived FROM melarc.evidence_pickup_stop_scope(NEW.owner_id);
      NEW.responsible_hub_id := derived.out_hub;
      NEW.vendor_organization_id := derived.out_vendor;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_type IS DISTINCT FROM OLD.owner_type OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
     OR NEW.captured_by_actor IS DISTINCT FROM OLD.captured_by_actor OR NEW.captured_by_principal_type IS DISTINCT FROM OLD.captured_by_principal_type
     OR NEW.device_context IS DISTINCT FROM OLD.device_context OR NEW.storage_ref IS DISTINCT FROM OLD.storage_ref
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id OR NEW.vendor_organization_id IS DISTINCT FROM OLD.vendor_organization_id
     OR NEW.access_rule IS DISTINCT FROM OLD.access_rule OR NEW.retention_policy IS DISTINCT FROM OLD.retention_policy
     OR NEW.content_type IS DISTINCT FROM OLD.content_type OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256 OR NEW.upload_ttl_seconds IS DISTINCT FROM OLD.upload_ttl_seconds
     OR NEW.upload_expires_at IS DISTINCT FROM OLD.upload_expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'evidence keeps its owner, its scope, its storage reference and what was declared of it' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'PENDING_UPLOAD' THEN
    RAISE EXCEPTION 'stored and expired evidence is final' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  IF NEW.state = 'STORED' THEN
    IF instant >= OLD.upload_expires_at THEN
      RAISE EXCEPTION 'the upload window of this evidence has passed' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_UPLOAD_EXPIRED';
    END IF;
    NEW.uploaded_at := instant;
  ELSIF NEW.state = 'EXPIRED' THEN
    IF instant < OLD.upload_expires_at THEN
      RAISE EXCEPTION 'an upload window that is still open does not expire' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
    END IF;
  ELSE
    RAISE EXCEPTION 'evidence changes by being stored or by expiring, and in no other way' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.evidence_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.evidence_guard() FROM PUBLIC;
--> statement-breakpoint
-- 5. The request the failure key reaches. 0080 admitted an owner-run statement under the rider's failure key to every request; the row condition is the request of a stop on the caller's assigned
-- run in progress (the stop's own state is judged by the function that asks, `melarc.evidence_pickup_stop_scope`, which also needs the stop to be arrived at and held).
-- The condition is a function and not a subquery in the policy: a policy that names another table makes every role that reads this one need that table's privileges (the executor checks
-- them whether or not the arm is taken), and the notification lane reads requests and holds no privilege on stops. The function reads the stops only when it is called, and the arm calls it
-- for the owner-run statement of a rider alone. It runs with the invoker's rights, which is the owner's there; the logins that read requests are granted the right to call it, as they are
-- granted the functions the other policies call (0000, 0002).
CREATE FUNCTION melarc.rider_run_holds_request(p_request uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.pickup_stop AS s JOIN public.pickup_manifest AS m ON m.id = s.pickup_manifest_id
     WHERE s.pickup_request_id = p_request AND m.state = 'IN_PROGRESS' AND m.assigned_rider_id = melarc.current_rider_id()
  );
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.rider_run_holds_request(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.rider_run_holds_request(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.rider_run_holds_request(uuid) TO melarc_api_runtime, melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
DROP POLICY "pickup_request_evidence_rider_read" ON "pickup_request";
--> statement-breakpoint
CREATE POLICY "pickup_request_evidence_rider_read" ON "pickup_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND current_user = 'melarc_owner'
      AND melarc.rider_run_holds_request("pickup_request"."id")
    ELSE false
  END
);
