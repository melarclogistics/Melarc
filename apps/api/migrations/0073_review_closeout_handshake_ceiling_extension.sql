-- Review closeout of S1.27 to S1.29 (SLICE-001), 5 November 2026. A forward migration: 0070, 0071 and 0072 are not edited (the text of each has been given to a reviewer
-- in an archive, and what an archive was run against cannot be established from here). Applied as melarc_migration_elevated, a member of melarc_owner.
--
--   1. The length of a handshake code is kept with each code. The lane used to read the platform's handshake_code_length again when it made the code it texts, so a setting changed
--      between the issue and the send (or between a fallback and its retry) made a code the digest did not match. collection_handshake.code_length is set with the code, by the
--      operations that make one, from the length the application made the digest with; they refuse a length that is not the platform's now (reason=CODE_LENGTH_CHANGED), so a
--      length and a digest never disagree. The rows that exist take the platform's length as of this migration (the one every code so far was made with unless the setting was
--      changed after it was made, which cannot be known), and the guard freezes the inputs of a code (its length and its key version) with its generation. The notification
--      lane no longer reads the setting at all.
--   2. The vendor's registered number is the credential's, not the organisation's business contact (F-23). The domain model keeps the business contact apart from the
--      authentication channel ("a business contact is not an authentication channel"); the code of the fallback is a one-time secret sent to the vendor, the kind of message the
--      vendor's credential channel carries. The number is VendorCredential.recovery_phone where delivery_channel is PHONE: the number the vendor's own setup and recovery messages
--      are delivered to, which it has had to receive to establish its secret. The lane reads it through one function that answers only the notification lane, for the request its
--      envelope names, and only while a fallback code is live for it.
--   3. The sub-ceiling of the operations that cause an outbound text (provider_initiating_operation_ceiling_per_minute, settings.md section 7.7) is counted by the limiter: its
--      name is admitted by the closed set of the admission table, and the limiter's capability may read its setting.
--   4. The door wait (rider_door_wait_minutes): a failure of the category VENDOR_UNAVAILABLE is accepted once the hub's door wait has passed since the rider arrived, by the
--      database's clock, for every writer. The setting is read by one function that answers the rider's key.
--   5. A contact attempt is a method, a moment, an outcome and an optional note (the guard of the stop holds the shape).
--   6. The attempt extension is truthful: its ceilings are null when it lifted none, and it records whether it released a refused collection (the generated statements).

--> statement-breakpoint
ALTER TABLE "rate_limit_admission" DROP CONSTRAINT "rate_limit_admission_bucket_closed";--> statement-breakpoint
ALTER TABLE "pickup_attempt_extension" ALTER COLUMN "ceiling_before" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pickup_attempt_extension" ALTER COLUMN "ceiling_after" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pickup_attempt_extension" ADD COLUMN "releases_refused_collection" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_limit_admission" ADD CONSTRAINT "rate_limit_admission_bucket_closed" CHECK ("rate_limit_admission"."bucket" IN ('rate_limit_staff_signin', 'rate_limit_privileged_mfa', 'rate_limit_vendor_signin', 'rate_limit_rider_challenge', 'rate_limit_recovery', 'rate_limit_authenticated_api', 'provider_initiating_operation_ceiling_per_minute'));--> statement-breakpoint
ALTER TABLE "pickup_attempt_extension" ADD CONSTRAINT "pickup_attempt_extension_does_something" CHECK (("pickup_attempt_extension"."ceiling_before" IS NULL) = ("pickup_attempt_extension"."ceiling_after" IS NULL) AND ("pickup_attempt_extension"."ceiling_before" IS NOT NULL OR "pickup_attempt_extension"."releases_refused_collection"));
--> statement-breakpoint
-- The handshake's foreign key to the request goes. The request is the stop's, which the guard checks on every insert ("a handshake names the request its stop holds") and
-- forbids changing, and the stop is itself held by the request by a key of its own. A second key made every insert of a handshake take a key-share lock on the request row
-- while the insert held the stop, and the cancellation of a request takes the request and then its stops: each waits for what the other holds (a deadlock, which the database
-- ends by aborting one of them). Without the key an insert takes no lock on the request, and the order of the cancellation is the only order there is.
ALTER TABLE "collection_handshake" DROP CONSTRAINT "collection_handshake_request_fkey";
--> statement-breakpoint
-- The length of the codes of a handshake. The rows that exist take the platform's length as of this migration (4 when the setting cannot be read: the confirmed value, MSC-DEC-256);
-- a constant default fills them without a trigger, and is dropped so that every later row states its length.
DO $code_length$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  length_now integer;
BEGIN
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);
  SELECT CASE WHEN pg_catalog.jsonb_typeof(s.value) = 'number' AND (s.value #>> '{}') ~ '^[0-9]{1,3}$' THEN (s.value #>> '{}')::integer END
    INTO length_now FROM public.setting AS s WHERE s.key = 'handshake_code_length';
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  IF length_now IS NULL OR length_now < 4 OR length_now > 8 THEN
    length_now := 4;
  END IF;
  EXECUTE pg_catalog.format('ALTER TABLE public.collection_handshake ADD COLUMN code_length smallint NOT NULL DEFAULT %s', length_now);
  ALTER TABLE public.collection_handshake ALTER COLUMN code_length DROP DEFAULT;
END
$code_length$;
--> statement-breakpoint
ALTER TABLE "collection_handshake" ADD CONSTRAINT "collection_handshake_code_length_range" CHECK ("collection_handshake"."code_length" BETWEEN 4 AND 8);
--> statement-breakpoint
-- The guard of the handshake as 0070 made it, with the rule that the inputs of a code are fixed with its generation.
CREATE OR REPLACE FUNCTION melarc.collection_handshake_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.attempts <> 0 OR NEW.fallback_sends > 1 THEN
      RAISE EXCEPTION 'a handshake begins at its first version with no wrong code' USING ERRCODE = '23514';
    END IF;
    -- The relations are named with their schema: the operations that fire this guard run with an empty search path.
    IF NOT EXISTS (
      SELECT 1 FROM public.collection_record c
       WHERE c.pickup_stop_id = NEW.pickup_stop_id AND c.responsible_hub_id = NEW.responsible_hub_id AND c.handshake_type = NEW.direction
    ) THEN
      RAISE EXCEPTION 'a handshake is made for a counted stop, in the direction its record fixes' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pickup_stop s WHERE s.id = NEW.pickup_stop_id AND s.pickup_request_id = NEW.pickup_request_id) THEN
      RAISE EXCEPTION 'a handshake names the request its stop holds' USING ERRCODE = '23514';
    END IF;
    IF NEW.state NOT IN ('CODE_GENERATED', 'VERIFIED') THEN
      RAISE EXCEPTION 'a handshake is made with a code, or established by an override' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.pickup_stop_id IS DISTINCT FROM OLD.pickup_stop_id OR NEW.pickup_request_id IS DISTINCT FROM OLD.pickup_request_id
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id OR NEW.direction IS DISTINCT FROM OLD.direction OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a handshake keeps its stop, its request, its hub, its direction and the moment it was made' USING ERRCODE = '23514';
  END IF;
  IF NEW.code_generation < OLD.code_generation OR NEW.code_generation > OLD.code_generation + 1
     OR NEW.attempts < OLD.attempts OR NEW.fallback_sends < OLD.fallback_sends OR NEW.fallback_sends > OLD.fallback_sends + 1 THEN
    RAISE EXCEPTION 'the counters of a handshake only grow, one code at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'CODE_GENERATED' AND NEW.state IN ('CODE_DELIVERED', 'VERIFIED', 'EXPIRED', 'EXHAUSTED'))
    OR (OLD.state = 'CODE_DELIVERED' AND NEW.state IN ('CODE_GENERATED', 'VERIFIED', 'EXPIRED', 'EXHAUSTED'))
    OR (OLD.state IN ('EXPIRED', 'EXHAUSTED') AND NEW.state IN ('VERIFIED', 'MANUALLY_RESOLVED'))
    OR (OLD.state IN ('VERIFIED', 'MANUALLY_RESOLVED') AND NEW.state = 'DISPUTED')
  ) THEN
    RAISE EXCEPTION 'a handshake moves along the state machine of section 6 and no other way' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('VERIFIED', 'MANUALLY_RESOLVED', 'DISPUTED')
     AND (to_jsonb(NEW) - 'state' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'version') THEN
    RAISE EXCEPTION 'a handshake that has ended well changes no more than its state, and only to DISPUTED' USING ERRCODE = '23514';
  END IF;
  -- What a code is made from (its generation, the key version and the length) is fixed with the generation: whoever makes the code again makes the same one.
  IF NEW.code_generation = OLD.code_generation
     AND (NEW.code_length IS DISTINCT FROM OLD.code_length OR NEW.code_key_version IS DISTINCT FROM OLD.code_key_version) THEN
    RAISE EXCEPTION 'the length and the key version of a code are fixed with its generation' USING ERRCODE = '23514';
  END IF;
  IF NEW.code_generation = OLD.code_generation + 1 AND NOT (OLD.state IN ('CODE_GENERATED', 'CODE_DELIVERED') AND NEW.state = 'CODE_GENERATED') THEN
    RAISE EXCEPTION 'a new code is made only by the fallback, for a handshake whose code is live' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- The helper that ends a handshake, as 0070 made it, with the (least) length recorded for a handshake that is established with no code.
CREATE OR REPLACE FUNCTION melarc.handshake_settle(p_handshake uuid, p_stop uuid, p_new_id uuid, p_state text, p_channel text, p_note text, p_moment timestamp with time zone)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  kind text := melarc.principal_type();
  confirmer text := CASE melarc.principal_type() WHEN 'RIDER' THEN 'RIDER' WHEN 'VENDOR' THEN 'VENDOR_ACCOUNT' WHEN 'STAFF' THEN 'STAFF' END;
  officer uuid := CASE WHEN p_channel = 'OPS_OVERRIDE' THEN melarc.current_principal_id() END;
  h public.collection_handshake%ROWTYPE;
  record_row public.collection_record%ROWTYPE;
  stop_row public.pickup_stop%ROWTYPE;
  closing text;
BEGIN
  IF confirmer IS NULL THEN
    RAISE EXCEPTION 'a handshake is ended by a rider, a vendor or an officer' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO record_row FROM public.collection_record AS c WHERE c.pickup_stop_id = p_stop;
  SELECT * INTO stop_row FROM public.pickup_stop AS s WHERE s.id = p_stop;
  closing := CASE record_row.variance WHEN 'MATCH' THEN 'COLLECTED' ELSE 'PARTIALLY_COLLECTED' END;
  IF p_handshake IS NULL THEN
    -- An officer establishes the collection of a counted stop whose handshake never began: the row is made at its end.
    -- It has no code (generation 0), so the length it records is the least one the table allows: the override is the way out of a handshake that cannot go on, and it
    -- must not depend on a setting that may be missing or out of range. (A code made later, by the fallback, states its own length with its own generation.)
    INSERT INTO public.collection_handshake (id, pickup_stop_id, pickup_request_id, responsible_hub_id, direction, state, code_generation, code_length, attempts, fallback_sends,
                                             channel, confirmed_at, confirmed_by_type, confirmed_by_id, authorised_by, note)
      VALUES (p_new_id, p_stop, stop_row.pickup_request_id, stop_row.responsible_hub_id, record_row.handshake_type, p_state, 0, 4, 0, 0,
              p_channel, p_moment, confirmer, melarc.current_principal_id(), officer, p_note);
  ELSE
    UPDATE public.collection_handshake
       SET state = p_state, channel = p_channel, confirmed_at = p_moment, confirmed_by_type = confirmer, confirmed_by_id = melarc.current_principal_id(),
           authorised_by = officer, note = p_note, code_digest = NULL
     WHERE id = p_handshake;
  END IF;
  SELECT * INTO h FROM public.collection_handshake WHERE pickup_stop_id = p_stop;
  UPDATE public.pickup_stop SET state = closing, resolved_at = p_moment WHERE id = p_stop;
  UPDATE public.collection_record SET handshake_channel = p_channel, handshake_confirmed_at = p_moment, handshake_override_by = officer WHERE id = record_row.id;
  PERFORM melarc.handshake_event(
    CASE closing WHEN 'COLLECTED' THEN 'pickup.stop.collected' ELSE 'pickup.stop.partially_collected' END,
    'PickupStop', p_stop, h.responsible_hub_id, 'ARRIVED', closing,
    pg_catalog.jsonb_build_object('pickup_manifest_id', stop_row.pickup_manifest_id::text, 'pickup_request_id', stop_row.pickup_request_id::text,
                                  'collection_record_id', record_row.id::text, 'collection_handshake_id', h.id::text),
    pg_catalog.jsonb_build_object('declared_count', record_row.declared_count, 'collected_count', record_row.collected_count, 'variance', record_row.variance,
                                  'channel', p_channel));
  RETURN closing;
END
$$;
--> statement-breakpoint
DROP FUNCTION melarc.handshake_issue(uuid, uuid, bytea, integer);
--> statement-breakpoint
CREATE FUNCTION melarc.handshake_issue(p_id uuid, p_stop uuid, p_digest bytea, p_key_version integer, p_code_length integer)
RETURNS TABLE (out_handshake_id uuid, out_direction text, out_state text, out_generation integer, out_key_version integer, out_expires_at timestamp with time zone,
               out_attempts integer, out_fallback_sends integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  rider uuid := melarc.current_rider_id();
  stop_row public.pickup_stop%ROWTYPE;
  manifest_state text;
  assigned uuid;
  record_row public.collection_record%ROWTYPE;
  vendor uuid;
  ttl integer;
  moment timestamp with time zone;
BEGIN
  IF melarc.principal_type() <> 'RIDER' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.collection.confirm' OR rider IS NULL THEN
    RAISE EXCEPTION 'a code is asked for by the rider that counted the stop, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_stop IS NULL OR p_digest IS NULL OR pg_catalog.octet_length(p_digest) <> 32 OR p_key_version IS NULL OR p_key_version < 1
     OR p_code_length IS NULL OR p_code_length < 4 OR p_code_length > 8 THEN
    RAISE EXCEPTION 'a handshake is made with an identifier, a stop, a digest of 32 bytes, a key version and a code length of four to eight digits' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO stop_row FROM public.pickup_stop AS s WHERE s.id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this is not a stop of the calling rider' USING ERRCODE = '42501';
  END IF;
  SELECT m.state, m.assigned_rider_id INTO manifest_state, assigned FROM public.pickup_manifest AS m WHERE m.id = stop_row.pickup_manifest_id;
  IF NOT FOUND OR assigned IS DISTINCT FROM rider THEN
    RAISE EXCEPTION 'this is not a stop of the calling rider' USING ERRCODE = '42501';
  END IF;
  IF manifest_state = 'DISPATCHED' THEN
    RAISE EXCEPTION 'the run has not been started' USING ERRCODE = '23514', DETAIL = 'reason=MANIFEST_NOT_STARTED';
  END IF;
  IF manifest_state <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'the run is over' USING ERRCODE = '23514', DETAIL = 'reason=RUN_NOT_IN_PROGRESS';
  END IF;
  IF stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a code is asked for at a stop that has been arrived at and not closed' USING ERRCODE = '23514', DETAIL = 'reason=STOP_NOT_ARRIVED';
  END IF;
  SELECT * INTO record_row FROM public.collection_record AS c WHERE c.pickup_stop_id = p_stop;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a code is asked for after the count is recorded' USING ERRCODE = '23514', DETAIL = 'reason=COLLECTION_NOT_RECORDED';
  END IF;
  -- The counted-stop authority (the Product Owner, 4 November 2026): the rider that recorded the count, while it is the run's assigned rider (checked above).
  IF record_row.recorded_by <> rider THEN
    RAISE EXCEPTION 'the handshake of a counted stop is the recording rider''s' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.collection_handshake AS h WHERE h.pickup_stop_id = p_stop) THEN
    RAISE EXCEPTION 'this stop already has its handshake' USING ERRCODE = '23514', DETAIL = 'reason=HANDSHAKE_EXISTS';
  END IF;
  ttl := melarc.handshake_setting('handshake_code_ttl_minutes');
  -- The digest was made from a code of the length the application read; it is kept only if that is the platform's length now (the setting changed between the two reads otherwise).
  IF p_code_length <> melarc.handshake_setting('handshake_code_length') THEN
    RAISE EXCEPTION 'the length of the code is not the length the platform holds now' USING ERRCODE = '23514', DETAIL = 'reason=CODE_LENGTH_CHANGED';
  END IF;
  moment := pg_catalog.clock_timestamp();
  INSERT INTO public.collection_handshake (id, pickup_stop_id, pickup_request_id, responsible_hub_id, direction, state, code_generation, code_digest, code_key_version, code_length,
                                           code_generated_at, expires_at, attempts, fallback_sends)
    VALUES (p_id, p_stop, stop_row.pickup_request_id, stop_row.responsible_hub_id, record_row.handshake_type, 'CODE_GENERATED', 1, p_digest, p_key_version, p_code_length,
            moment, moment + pg_catalog.make_interval(mins => ttl), 0, 0);
  IF record_row.handshake_type = 'SENDER_SMS_RIDER_ENTERED' THEN
    SELECT r.vendor_organization_id INTO vendor FROM public.pickup_request AS r WHERE r.id = stop_row.pickup_request_id;
    PERFORM melarc.handshake_envelope(stop_row.pickup_request_id, stop_row.responsible_hub_id, vendor, 1, 'initiateHandshake');
  END IF;
  PERFORM melarc.handshake_event('pickup.handshake.generated', 'CollectionHandshake', p_id, stop_row.responsible_hub_id, NULL, 'CODE_GENERATED',
    pg_catalog.jsonb_build_object('pickup_stop_id', p_stop::text, 'pickup_manifest_id', stop_row.pickup_manifest_id::text, 'pickup_request_id', stop_row.pickup_request_id::text,
                                  'collection_record_id', record_row.id::text, 'rider_id', rider::text),
    pg_catalog.jsonb_build_object('direction', record_row.handshake_type, 'generation', 1));
  RETURN QUERY SELECT h.id, h.direction, h.state, h.code_generation, h.code_key_version, h.expires_at, h.attempts, h.fallback_sends
                 FROM public.collection_handshake AS h WHERE h.id = p_id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.handshake_issue(uuid, uuid, bytea, integer, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_issue(uuid, uuid, bytea, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.handshake_issue(uuid, uuid, bytea, integer, integer) TO melarc_api_runtime;
--> statement-breakpoint
DROP FUNCTION melarc.handshake_sms_fallback(uuid, uuid, integer, bytea, integer, text);
--> statement-breakpoint
CREATE FUNCTION melarc.handshake_sms_fallback(p_new_id uuid, p_stop uuid, p_expected_generation integer, p_digest bytea, p_key_version integer, p_trigger text, p_code_length integer)
RETURNS TABLE (out_outcome text, out_handshake_id uuid, out_state text, out_direction text, out_generation integer, out_key_version integer, out_attempts integer,
               out_fallback_sends integer, out_expires_at timestamp with time zone)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  rider uuid := melarc.current_rider_id();
  stop_row public.pickup_stop%ROWTYPE;
  manifest_state text;
  assigned uuid;
  record_row public.collection_record%ROWTYPE;
  h public.collection_handshake%ROWTYPE;
  vendor uuid;
  number_held text;
  ttl integer;
  cap integer;
  cooldown integer;
  moment timestamp with time zone;
  handshake_id uuid;
  previous_state text;
  outcome text := 'SENT';
BEGIN
  IF melarc.principal_type() <> 'RIDER' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.collection.confirm' OR rider IS NULL THEN
    RAISE EXCEPTION 'the fallback is asked for by the rider that counted the stop, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_new_id IS NULL OR p_stop IS NULL OR p_expected_generation IS NULL OR p_expected_generation < 0 OR p_digest IS NULL OR pg_catalog.octet_length(p_digest) <> 32
     OR p_key_version IS NULL OR p_key_version < 1 OR p_trigger IS NULL OR p_trigger NOT IN ('NO_DATA', 'PORTAL_DOWN')
     OR p_code_length IS NULL OR p_code_length < 4 OR p_code_length > 8 THEN
    RAISE EXCEPTION 'a fallback is asked for with its reason (the portal has no data or is down), a digest and the generation it follows' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO stop_row FROM public.pickup_stop AS s WHERE s.id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this is not a stop of the calling rider' USING ERRCODE = '42501';
  END IF;
  SELECT m.state, m.assigned_rider_id INTO manifest_state, assigned FROM public.pickup_manifest AS m WHERE m.id = stop_row.pickup_manifest_id;
  IF NOT FOUND OR assigned IS DISTINCT FROM rider THEN
    RAISE EXCEPTION 'this is not a stop of the calling rider' USING ERRCODE = '42501';
  END IF;
  IF manifest_state = 'DISPATCHED' THEN
    RAISE EXCEPTION 'the run has not been started' USING ERRCODE = '23514', DETAIL = 'reason=MANIFEST_NOT_STARTED';
  END IF;
  IF manifest_state <> 'IN_PROGRESS' OR stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'the fallback is asked for at a stop that has been arrived at and not closed' USING ERRCODE = '23514', DETAIL = 'reason=STOP_NOT_ARRIVED';
  END IF;
  SELECT * INTO record_row FROM public.collection_record AS c WHERE c.pickup_stop_id = p_stop;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the fallback is asked for after the count is recorded' USING ERRCODE = '23514', DETAIL = 'reason=COLLECTION_NOT_RECORDED';
  END IF;
  IF record_row.recorded_by <> rider THEN
    RAISE EXCEPTION 'the handshake of a counted stop is the recording rider''s' USING ERRCODE = '42501';
  END IF;
  IF record_row.handshake_type <> 'VENDOR_ENTERED_RIDER_DISPLAYED' THEN
    RAISE EXCEPTION 'an individual sender is texted the code in the first place: there is no fallback' USING ERRCODE = '23514', DETAIL = 'reason=FALLBACK_NOT_APPLICABLE';
  END IF;
  SELECT r.vendor_organization_id INTO vendor FROM public.pickup_request AS r WHERE r.id = stop_row.pickup_request_id;
  -- The registered number is the vendor's credential's (migration 0073; F-23): the number its own setup and recovery messages are delivered to, and no business contact.
  number_held := melarc.vendor_registered_number(vendor);
  IF number_held IS NULL OR pg_catalog.btrim(number_held) = '' THEN
    RAISE EXCEPTION 'this vendor has no registered number' USING ERRCODE = '23514', DETAIL = 'reason=NO_REGISTERED_NUMBER';
  END IF;
  ttl := melarc.handshake_setting('handshake_code_ttl_minutes');
  cap := melarc.handshake_setting('sms_fallback_max_per_pickup');
  cooldown := melarc.handshake_setting('sms_fallback_cooldown_seconds');
  -- The digest was made from a code of the length the application read; it is kept only if that is the platform's length now.
  IF p_code_length <> melarc.handshake_setting('handshake_code_length') THEN
    RAISE EXCEPTION 'the length of the code is not the length the platform holds now' USING ERRCODE = '23514', DETAIL = 'reason=CODE_LENGTH_CHANGED';
  END IF;
  moment := pg_catalog.clock_timestamp();
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.pickup_stop_id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_generation <> 0 THEN
      RAISE EXCEPTION 'the handshake changed since it was read' USING ERRCODE = '23514', DETAIL = 'reason=GENERATION_CHANGED';
    END IF;
    handshake_id := p_new_id;
    previous_state := NULL;
    INSERT INTO public.collection_handshake (id, pickup_stop_id, pickup_request_id, responsible_hub_id, direction, state, code_generation, code_digest, code_key_version, code_length,
                                             code_generated_at, expires_at, attempts, fallback_sends, last_fallback_at)
      VALUES (p_new_id, p_stop, stop_row.pickup_request_id, stop_row.responsible_hub_id, record_row.handshake_type, 'CODE_GENERATED', 1, p_digest, p_key_version, p_code_length,
              moment, moment + pg_catalog.make_interval(mins => ttl), 0, 1, moment);
  ELSE
    IF h.code_generation <> p_expected_generation THEN
      RAISE EXCEPTION 'the handshake changed since it was read' USING ERRCODE = '23514', DETAIL = 'reason=GENERATION_CHANGED';
    END IF;
    IF h.state NOT IN ('CODE_GENERATED', 'CODE_DELIVERED', 'EXPIRED') THEN
      RAISE EXCEPTION 'the handshake of this stop has ended or is exhausted' USING ERRCODE = '23514', DETAIL = 'reason=HANDSHAKE_CLOSED';
    END IF;
    IF h.state = 'EXPIRED' OR moment >= h.expires_at THEN
      -- A code that has run out routes to Ops: it is marked so, and the caller is told, with the mark kept (an outcome, not a refusal).
      IF h.state <> 'EXPIRED' THEN
        UPDATE public.collection_handshake SET state = 'EXPIRED', code_digest = NULL WHERE id = h.id;
      END IF;
      SELECT * INTO h FROM public.collection_handshake AS x WHERE x.id = h.id;
      RETURN QUERY SELECT 'CODE_EXPIRED'::text, h.id, h.state, h.direction, h.code_generation, h.code_key_version, h.attempts, h.fallback_sends, h.expires_at;
      RETURN;
    END IF;
    IF h.fallback_sends >= cap OR (h.last_fallback_at IS NOT NULL AND moment < h.last_fallback_at + pg_catalog.make_interval(secs => cooldown)) THEN
      RAISE EXCEPTION 'the SMS fallback is used up or too soon after the last' USING ERRCODE = '23514', DETAIL = 'reason=SMS_FALLBACK_LIMIT_REACHED';
    END IF;
    handshake_id := h.id;
    previous_state := h.state;
    UPDATE public.collection_handshake
       SET state = 'CODE_GENERATED', code_generation = code_generation + 1, code_digest = p_digest, code_key_version = p_key_version, code_length = p_code_length, code_generated_at = moment,
           expires_at = moment + pg_catalog.make_interval(mins => ttl), fallback_sends = fallback_sends + 1, last_fallback_at = moment
     WHERE id = h.id;
  END IF;
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.id = handshake_id;
  PERFORM melarc.handshake_envelope(stop_row.pickup_request_id, stop_row.responsible_hub_id, vendor, h.code_generation, 'requestSmsHandshakeFallback');
  PERFORM melarc.handshake_event('pickup.handshake.fallback_sms', 'CollectionHandshake', h.id, h.responsible_hub_id, previous_state, 'CODE_GENERATED',
    pg_catalog.jsonb_build_object('pickup_stop_id', p_stop::text, 'pickup_manifest_id', stop_row.pickup_manifest_id::text, 'pickup_request_id', stop_row.pickup_request_id::text,
                                  'collection_record_id', record_row.id::text, 'rider_id', rider::text),
    pg_catalog.jsonb_build_object('direction', h.direction, 'generation', h.code_generation, 'fallback_sends', h.fallback_sends, 'trigger', p_trigger));
  RETURN QUERY SELECT outcome, h.id, h.state, h.direction, h.code_generation, h.code_key_version, h.attempts, h.fallback_sends, h.expires_at;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.handshake_sms_fallback(uuid, uuid, integer, bytea, integer, text, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_sms_fallback(uuid, uuid, integer, bytea, integer, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.handshake_sms_fallback(uuid, uuid, integer, bytea, integer, text, integer) TO melarc_api_runtime;
--> statement-breakpoint
-- The notification lane reads the length of the code from the handshake it carries it for, and no longer the setting.
GRANT SELECT ("code_length") ON "collection_handshake" TO melarc_worker_cap_notification;
--> statement-breakpoint
-- What each reader needs of the settings, as 0070 left it, without the lane: it no longer makes a code from the setting.
ALTER POLICY "setting_handshake_read" ON "setting" USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND key = 'handshake_code_length')
      OR (current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
          AND key IN ('handshake_code_ttl_minutes', 'handshake_max_wrong_attempts', 'sms_fallback_max_per_pickup', 'sms_fallback_cooldown_seconds'))
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND key = 'handshake_max_wrong_attempts'
    ELSE false
  END
);
--> statement-breakpoint
-- The vendor's registered number (F-23): the number of the vendor credential's delivery channel. The business contact of the organisation is not an authentication channel.
-- Both functions answer the owner's own reads: the first is the helper the fallback calls, which nobody else executes; the second is the one the notification lane executes,
-- and it answers only that lane, for the request its envelope names, and only while a fallback code is live for it.
CREATE FUNCTION melarc.vendor_registered_number(p_vendor uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.recovery_phone
    FROM public.vendor_account AS a
    JOIN public.vendor_credential AS c ON c.vendor_account_id = a.id
   WHERE a.vendor_organization_id = p_vendor AND c.delivery_channel = 'PHONE' AND c.recovery_phone IS NOT NULL
     -- Proved by possession: the vendor set its secret from the grant that was delivered to this channel. A credential whose secret was never set has a number an
     -- officer typed and nobody has used, and no code is texted to it.
     AND c.credential_established_at IS NOT NULL
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.vendor_registered_number(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.vendor_registered_number(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.notification_handshake_number() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  request uuid := melarc.outbox_aggregate_id();
  vendor uuid;
BEGIN
  IF melarc.principal_type() <> 'SYSTEM' OR melarc.task_capability() IS DISTINCT FROM 'notification' THEN
    RAISE EXCEPTION 'the number a code is texted to is read by the notification lane, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF request IS NULL THEN
    RAISE EXCEPTION 'the number is read for the request the envelope names' USING ERRCODE = '42501';
  END IF;
  SELECT r.vendor_organization_id INTO vendor
    FROM public.pickup_request AS r
    JOIN public.collection_handshake AS h ON h.pickup_request_id = r.id
   WHERE r.id = request AND h.direction = 'VENDOR_ENTERED_RIDER_DISPLAYED' AND h.state IN ('CODE_GENERATED', 'CODE_DELIVERED') AND h.fallback_sends >= 1
     AND h.expires_at > pg_catalog.clock_timestamp();
  IF NOT FOUND OR vendor IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN melarc.vendor_registered_number(vendor);
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.notification_handshake_number() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.notification_handshake_number() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.notification_handshake_number() TO melarc_worker_cap_notification;
--> statement-breakpoint
-- The owner-run reads of the two tables, for the fallback (the rider's key) and for the lane's function (the notification capability); a statement of any login is refused.
-- They are bound to the rows each context may reach: the organisation of a request whose stop the calling rider counted, and the organisation of the request the lane's
-- envelope names, so that the two functions are not the only thing between those contexts and every vendor's credential.
CREATE POLICY "vendor_account_registered_number_read" ON "vendor_account" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND EXISTS (SELECT 1 FROM "collection_record" c JOIN "pickup_stop" s ON s.id = c.pickup_stop_id JOIN "pickup_request" r ON r.id = s.pickup_request_id
                   WHERE c.recorded_by = melarc.current_rider_id() AND r.vendor_organization_id = "vendor_account"."vendor_organization_id")
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND current_user = 'melarc_owner'
      AND EXISTS (SELECT 1 FROM "pickup_request" r WHERE r.id = melarc.outbox_aggregate_id() AND r.vendor_organization_id = "vendor_account"."vendor_organization_id")
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "vendor_credential_registered_number_read" ON "vendor_credential" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND EXISTS (SELECT 1 FROM "vendor_account" a JOIN "pickup_request" r ON r.vendor_organization_id = a.vendor_organization_id
                    JOIN "pickup_stop" s ON s.pickup_request_id = r.id JOIN "collection_record" c ON c.pickup_stop_id = s.id
                   WHERE a.id = "vendor_credential"."vendor_account_id" AND c.recorded_by = melarc.current_rider_id())
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND current_user = 'melarc_owner'
      AND EXISTS (SELECT 1 FROM "vendor_account" a JOIN "pickup_request" r ON r.vendor_organization_id = a.vendor_organization_id
                   WHERE a.id = "vendor_credential"."vendor_account_id" AND r.id = melarc.outbox_aggregate_id())
    ELSE false
  END
);
--> statement-breakpoint
-- The business contact of the organisation is read by nobody for the handshake any more.
DROP POLICY "vendor_organization_handshake_read" ON "vendor_organization";
--> statement-breakpoint
REVOKE SELECT ("id", "contact_phone") ON "vendor_organization" FROM melarc_worker_cap_notification;
--> statement-breakpoint
-- The limiter reads the six bucket limits and the limit of the sub-ceiling inside the authenticated-API bucket, and no other setting.
ALTER POLICY "setting_rate_limit_read" ON "setting" USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'rate_limit' AND key IN ('rate_limit_staff_signin', 'rate_limit_privileged_mfa', 'rate_limit_vendor_signin', 'rate_limit_rider_challenge', 'rate_limit_recovery', 'rate_limit_authenticated_api', 'provider_initiating_operation_ceiling_per_minute')
    ELSE false
  END
);
--> statement-breakpoint
-- The door wait of a hub, for the rider's failure key: the value in force of rider_door_wait_minutes for the hub, from one minute to a day. A missing or invalid value is
-- reason=SETTING_MISSING and the application answers it as a defect (no status is decided for it): nothing is invented in its place.
CREATE FUNCTION melarc.rider_door_wait_minutes(p_hub uuid) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held jsonb;
  minutes integer;
BEGIN
  IF melarc.principal_type() <> 'RIDER' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.failure.report' THEN
    RAISE EXCEPTION 'the door wait is read for the rider that reports a failure, and for nobody else' USING ERRCODE = '42501';
  END IF;
  SELECT s.value INTO held
    FROM public.hub_setting AS s
   WHERE s.hub_id = p_hub AND s.setting_key = 'rider_door_wait_minutes' AND s.scope_ref = '' AND s.effective_from <= pg_catalog.clock_timestamp()
   ORDER BY s.effective_from DESC, s.version DESC
   LIMIT 1;
  IF held IS NULL OR pg_catalog.jsonb_typeof(held) <> 'number' OR (held #>> '{}') !~ '^[0-9]{1,4}$' THEN
    RAISE EXCEPTION 'the door wait of the hub is missing or not a whole number of minutes' USING ERRCODE = '23514', DETAIL = 'reason=SETTING_MISSING';
  END IF;
  minutes := (held #>> '{}')::integer;
  IF minutes < 1 OR minutes > 1440 THEN
    RAISE EXCEPTION 'the door wait of the hub is not between one minute and a day' USING ERRCODE = '23514', DETAIL = 'reason=SETTING_MISSING';
  END IF;
  RETURN minutes;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.rider_door_wait_minutes(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.rider_door_wait_minutes(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.rider_door_wait_minutes(uuid) TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "hub_setting_door_wait_read" ON "hub_setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND setting_key = 'rider_door_wait_minutes'
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a stop as 0072 made it, with the door wait and the shape of a contact attempt (a method, a moment, an outcome and an optional note).
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
    -- The moment of the arrival is the database's own, taken now that the stop's lock is held, as the moment of a failure is: a writer under this key does not choose it. It is the
    -- moment the door wait is measured from (a vendor-unavailable failure is accepted once the wait has passed since it), so a moment given by the writer would be a wait given by the writer.
    NEW.arrived_at := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
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
                  OR NOT jsonb_exists_all(e.attempt, ARRAY['method', 'attempted_at', 'outcome'])
                  OR (e.attempt - ARRAY['method', 'attempted_at', 'outcome', 'note']) <> '{}'::jsonb
                  OR jsonb_typeof(e.attempt -> 'attempted_at') IS DISTINCT FROM 'string'
                  OR jsonb_typeof(e.attempt -> 'outcome') IS DISTINCT FROM 'string'
                  OR (e.attempt ->> 'attempted_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
                  OR (e.attempt ->> 'outcome') ~ '^[[:space:]]*$'
                  OR char_length(e.attempt ->> 'outcome') > 1000
                  OR jsonb_typeof(e.attempt -> 'method') IS DISTINCT FROM 'string'
                  OR (e.attempt ->> 'method') NOT IN ('PHONE_CALL', 'SMS', 'IN_PERSON')
                  OR (pg_catalog.jsonb_exists(e.attempt, 'note')
                      AND (jsonb_typeof(e.attempt -> 'note') IS DISTINCT FROM 'string' OR (e.attempt ->> 'note') ~ '^[[:space:]]*$' OR char_length(e.attempt ->> 'note') > 1000)))) THEN
      RAISE EXCEPTION 'the contact attempts of a failure are kept as the application builds them' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
    END IF;
    SELECT * INTO catalogue FROM public.reason_code AS rc
     WHERE rc.code = (NEW.failure_reason_snapshot ->> 'reason_code') AND rc.domain = 'PICKUP_FAILURE';
    IF NOT FOUND OR NOT catalogue.active
       OR catalogue.label IS DISTINCT FROM (NEW.failure_reason_snapshot ->> 'label')
       OR catalogue.attribution IS DISTINCT FROM (NEW.failure_reason_snapshot ->> 'attribution') THEN
      RAISE EXCEPTION 'the reason of a failure is an active reason of the PICKUP_FAILURE catalogue, as the catalogue holds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
    END IF;
    IF catalogue.requires_note AND coalesce(NEW.failure_reason_snapshot ->> 'note', '') ~ '^[[:space:]]*$' THEN
      RAISE EXCEPTION 'the reason of this failure asks for a note' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    IF catalogue.requires_contact_attempt AND coalesce(jsonb_array_length(NEW.failure_reason_snapshot -> 'contact_attempts'), 0) = 0 THEN
      RAISE EXCEPTION 'the reason of this failure asks for a contact attempt' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    IF catalogue.requires_photo THEN
      RAISE EXCEPTION 'the reason of this failure asks for a photo, and no evidence can be stored yet' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    instant := date_trunc('milliseconds', clock_timestamp());
    -- The door wait (review of 5 November 2026; pickup-collection.md, "Vendor simply busy"): the category VENDOR_UNAVAILABLE is accepted once the hub's door wait has passed since
    -- the rider arrived, on the database's clock and the arrival the database recorded. The other categories carry no wait.
    IF NEW.failure_category = 'VENDOR_UNAVAILABLE'
       AND (OLD.arrived_at IS NULL OR instant < OLD.arrived_at + pg_catalog.make_interval(mins => melarc.rider_door_wait_minutes(NEW.responsible_hub_id))) THEN
      RAISE EXCEPTION 'the rider has not waited at the door as long as the hub requires' USING ERRCODE = '23514', DETAIL = 'reason=PICKUP_DOOR_WAIT_NOT_ELAPSED';
    END IF;
    NEW.resolved_at := instant;
    NEW.failure_reason_snapshot := NEW.failure_reason_snapshot || jsonb_build_object('reported_at', to_char(instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
GRANT INSERT ("releases_refused_collection") ON "pickup_attempt_extension" TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.dispute_collection as 0071 made it, locking only a stop of the calling vendor (the owner, the grant and the revocation are kept by the replacement).
CREATE OR REPLACE FUNCTION melarc.dispute_collection(p_id uuid, p_stop uuid, p_note text)
RETURNS TABLE (out_id uuid, out_pickup_stop_id uuid, out_state text, out_raised_by uuid, out_note text, out_created_at timestamp with time zone)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  vendor uuid := melarc.current_vendor_organization_id();
  account uuid := melarc.current_principal_id();
  stop_row public.pickup_stop%ROWTYPE;
  h public.collection_handshake%ROWTYPE;
  made public.collection_dispute%ROWTYPE;
  previous text;
BEGIN
  IF melarc.principal_type() <> 'VENDOR' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.collection.confirm'
     OR vendor IS NULL OR account IS NULL THEN
    RAISE EXCEPTION 'a collection is disputed by the vendor whose pickup it is, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_stop IS NULL THEN
    RAISE EXCEPTION 'a dispute names a stop' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NULL OR pg_catalog.btrim(p_note) = '' THEN
    RAISE EXCEPTION 'a dispute says what the vendor disputes' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  -- Only a stop of the calling vendor is locked: the request is joined in the locking select, so the stop of another vendor, or one that does not exist, is refused the same way
  -- without a row lock having been asked for on it.
  SELECT s.* INTO stop_row FROM public.pickup_stop AS s JOIN public.pickup_request AS r ON r.id = s.pickup_request_id
   WHERE s.id = p_stop AND r.vendor_organization_id = vendor FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this is not a stop of the calling vendor' USING ERRCODE = '42501';
  END IF;
  IF stop_row.state NOT IN ('COLLECTED', 'PARTIALLY_COLLECTED') THEN
    RAISE EXCEPTION 'only a collection that has closed is disputed' USING ERRCODE = '23514', DETAIL = 'reason=STOP_NOT_CLOSED';
  END IF;
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.pickup_stop_id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a closed collection has its handshake' USING ERRCODE = '23514', DETAIL = 'reason=STOP_NOT_CLOSED';
  END IF;
  IF h.state = 'DISPUTED' THEN
    RAISE EXCEPTION 'this collection has been disputed' USING ERRCODE = '23514', DETAIL = 'reason=DISPUTE_OPEN';
  END IF;
  IF h.state NOT IN ('VERIFIED', 'MANUALLY_RESOLVED') THEN
    RAISE EXCEPTION 'only a collection whose handshake ended well is disputed' USING ERRCODE = '23514', DETAIL = 'reason=STOP_NOT_CLOSED';
  END IF;
  previous := h.state;
  UPDATE public.collection_handshake SET state = 'DISPUTED' WHERE id = h.id;
  INSERT INTO public.collection_dispute (id, pickup_stop_id, responsible_hub_id, vendor_organization_id, raised_by, note, state)
    VALUES (p_id, p_stop, stop_row.responsible_hub_id, vendor, account, pg_catalog.btrim(p_note), 'OPEN')
    RETURNING * INTO made;
  INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, vendor_organization_id, responsible_hub_id, object_type, object_id,
                                  correlation_id, previous_state, resulting_state, note, related_ids, detail, outcome, enhanced, serialisation_version)
    VALUES (pg_catalog.uuidv7(), 'pickup.handshake.disputed', pg_catalog.clock_timestamp(), 'VENDOR_ACCOUNT', account, 'VENDOR_PWA', vendor, stop_row.responsible_hub_id,
            'CollectionHandshake', h.id, pg_catalog.current_setting('melarc.correlation_id', true), previous, 'DISPUTED', made.note,
            pg_catalog.jsonb_build_object('pickup_stop_id', p_stop::text, 'pickup_request_id', stop_row.pickup_request_id::text, 'pickup_manifest_id', stop_row.pickup_manifest_id::text,
                                          'collection_dispute_id', made.id::text),
            pg_catalog.jsonb_build_object('stop_state', stop_row.state, 'physical_completion_reversed', false), 'SUCCEEDED', false, 1);
  RETURN QUERY SELECT made.id, made.pickup_stop_id, made.state, made.raised_by, made.note, made.created_at;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.dispute_collection(uuid, uuid, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.dispute_collection(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.dispute_collection(uuid, uuid, text) TO melarc_api_runtime;
