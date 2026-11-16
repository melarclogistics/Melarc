ALTER TABLE "reason_code" DROP CONSTRAINT "reason_code_domain_closed";--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_parameters_closed";--> statement-breakpoint
ALTER TABLE "collection_record" DROP CONSTRAINT "collection_record_variance_closed";--> statement-breakpoint
ALTER TABLE "collection_record" DROP CONSTRAINT "collection_record_variance_follows_counts";--> statement-breakpoint
ALTER TABLE "collection_record" DROP CONSTRAINT "collection_record_shortfall_facts";--> statement-breakpoint
ALTER TABLE "reason_code" ADD CONSTRAINT "reason_code_domain_closed" CHECK ("reason_code"."domain" IN ('DELIVERY_FAILURE', 'RECIPIENT_CONTACT', 'PICKUP_STOP_SKIP', 'HANDOFF_FAILURE', 'PICKUP_CANCELLATION', 'PICKUP_FAILURE', 'PICKUP_SHORT_COUNT', 'PICKUP_CARRYOVER', 'PICKUP_OVER_COUNT', 'SESSION_REVOCATION', 'STAFF_PROFILE_REJECTION', 'STAFF_MFA_RESET', 'CREDENTIAL_ADMINISTRATION', 'RIDER_DEVICE_REPLACEMENT', 'RIDER_DEVICE_REVOCATION'));--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_parameters_closed" CHECK (jsonb_typeof("notification"."parameters") = 'object' AND jsonb_array_length(jsonb_path_query_array("notification"."parameters", 'strict $.keyvalue()')) <= 4 AND NOT jsonb_path_exists("notification"."parameters", 'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][a-z0-9_]{0,31}$"))') AND NOT jsonb_path_exists("notification"."parameters", 'strict $.keyvalue() ? (@.value.type() != "string" || !((@.key != "n" && @.value like_regex "^[A-Z][A-Z0-9_]{0,63}$") || (@.key == "n" && @.value like_regex "^[1-9][0-9]{0,8}$")))'));--> statement-breakpoint
ALTER TABLE "collection_record" ADD CONSTRAINT "collection_record_variance_closed" CHECK ("collection_record"."variance" IN ('MATCH', 'SHORT', 'OVER'));--> statement-breakpoint
ALTER TABLE "collection_record" ADD CONSTRAINT "collection_record_variance_follows_counts" CHECK (("collection_record"."variance" = 'MATCH' AND "collection_record"."collected_count" = "collection_record"."declared_count")
          OR ("collection_record"."variance" = 'SHORT' AND "collection_record"."collected_count" < "collection_record"."declared_count")
          OR ("collection_record"."variance" = 'OVER' AND "collection_record"."collected_count" > "collection_record"."declared_count"));--> statement-breakpoint
ALTER TABLE "collection_record" ADD CONSTRAINT "collection_record_shortfall_facts" CHECK (("collection_record"."variance" IN ('SHORT', 'OVER') AND "collection_record"."variance_reason_snapshot" IS NOT NULL AND "collection_record"."office_notified_at" IS NOT NULL)
          OR ("collection_record"."variance" = 'MATCH' AND "collection_record"."variance_reason_snapshot" IS NULL AND "collection_record"."office_notified_at" IS NULL));
--> statement-breakpoint
-- THE HAND-WRITTEN PART. Everything above is generated (drizzle-kit, from the schema files). This migration is applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). Forward of 0098; nothing earlier is edited.
--
-- D-D5 (the Product Owner, 15 and 16 November 2026): THE RIDER MAY COUNT MORE PARCELS THAN WERE BOOKED. Until now a count above the booking was refused (OB-S1-50); it is an OVER count, the mirror of
-- a short one. Each rule below is held for every writer, by the database, and is restated from the LAST migration that defines it (the guard of the record 0089, the helper that ends a handshake
-- 0073, the guard of the stop 0083), so that only the OVER change differs from what is live:
--   * The reason domain PICKUP_OVER_COUNT (above; its three codes are migration 0100's for a database seeded before them, a file of its own that may be repeated as 0061 is, and a new database gets them from the seed) and the record's three checks (above): the variance
--     is closed to MATCH, SHORT and OVER, OVER is the counts compared (more collected than declared), and a count that is not the booking has its reason and the office flag.
--   * The guard of the record reads the reason of an OVER count from PICKUP_OVER_COUNT and of a SHORT one from PICKUP_SHORT_COUNT, each active, as the catalogue holds it, with the note where it asks
--     for one; the office flag is the database's own instant for both. The rider's key reads the over-count reasons as it reads the short-count reasons (the policy below).
--   * A stop whose count is OVER closes COLLECTED (the helper that ends a handshake, and the guard of the stop that holds the close to the count): a count above the booking leaves nothing behind.
--   * The office is told in the system, in the transaction of the count, as it is for a short count: melarc.over_count_envelope and its narrow policy (the pattern of 0082). The notification's
--     parameters are closed tokens, and the entry the Product Owner approved says HOW MANY parcels over the booking were counted, so ONE member, n, may be a whole number above zero (above, the table's
--     check): every other member stays a token, and n may not be a token.
-- 1. The guard of a collection record, as 0089 made it, with the reason of an OVER count read from its own catalogue and the office flag raised for it.
CREATE OR REPLACE FUNCTION melarc.collection_record_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  stop_row public.pickup_stop%ROWTYPE;
  run_state text;
  declared integer;
  catalogue public.reason_code%ROWTYPE;
  instant timestamp with time zone;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The stop's lock first, and then the judgement: a foreign-key check takes only a share lock on the stop that an update of its state does not
    -- conflict with, so without this a skip or a failure that began after the stop was read as arrived could commit beside the record. With the lock,
    -- the writer that comes second waits for the first and judges what the first left (the skip's trigger looks for a record after it holds the lock,
    -- and this looks at the state after it holds it). A writer the policies do not allow to lock the stop falls back to a plain read: it is refused by
    -- the insert policy, and makes no record.
    SELECT * INTO stop_row FROM public.pickup_stop WHERE id = NEW.pickup_stop_id FOR UPDATE;
    IF NOT FOUND THEN
      SELECT * INTO stop_row FROM public.pickup_stop WHERE id = NEW.pickup_stop_id;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a collection record names a pickup stop that is not there' USING ERRCODE = '23514';
    END IF;
    IF stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a collection is recorded for a stop that has been arrived at and not resolved' USING ERRCODE = '23514';
    END IF;
    SELECT state INTO run_state FROM public.pickup_manifest WHERE id = stop_row.pickup_manifest_id;
    IF run_state IS DISTINCT FROM 'IN_PROGRESS' THEN
      RAISE EXCEPTION 'a collection is recorded on a run in progress' USING ERRCODE = '23514';
    END IF;
    declared := nullif(stop_row.pickup_summary ->> 'declared_package_count', '')::integer;
    IF declared IS NULL OR NEW.declared_count <> declared THEN
      RAISE EXCEPTION 'the declared count of a collection record is the one the stop declared' USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> 1 OR NEW.handshake_channel IS NOT NULL OR NEW.handshake_override_by IS NOT NULL OR NEW.handshake_confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a collection record begins with no handshake outcome' USING ERRCODE = '23514';
    END IF;
    IF melarc.principal_type() = 'RIDER' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
       AND NEW.handshake_type IS DISTINCT FROM melarc.collection_handshake_type(NEW.pickup_stop_id) THEN
      RAISE EXCEPTION 'the direction of a collection record is the one the request''s sender fixes' USING ERRCODE = '23514';
    END IF;
    -- The facts of the record that are the catalogue's and the clock's (OB-S1-60), judged for every writer, with the stop's lock held. A direct insert
    -- by the permitted writer (the rider's key, its own arrived stop) used to keep a reason the catalogue does not hold, with a label and an attribution
    -- of its own, and any instant it chose for the recording and the flag: nothing judged what they said.
    --
    -- (D-D5: a count above the booking is an OVER count, and its reason is read from the PICKUP_OVER_COUNT catalogue as a short one's is from PICKUP_SHORT_COUNT.)
    -- The reason of a short count is a reason of the PICKUP_SHORT_COUNT catalogue that is active, with the label and the attribution the catalogue holds
    -- now, in the shape the application builds (its code, its label, its attribution and the rider's note, and no member of a writer's own), and it
    -- satisfies the rules of its metadata: a note where it asks for one. The photo it may ask for is not judged here: it is attached to the stop after the record is made, in the same
    -- transaction, so the insert cannot see it, and the rule is the one of the end of the transaction (melarc.collection_photos_check, 0089). A snapshot read before the catalogue
    -- changed no longer agrees with it and is refused, with the reasons the
    -- application answers as what they are (the DETAIL, read by guardReasonIn): it is the application's to say that the reason it read is not the reason
    -- there is, and the same key and body then make the record from the catalogue as it stands. The snapshot is the reason as it was at the count and is
    -- never read again, so a later edit of the catalogue leaves it as it was (the update branch below freezes it).
    IF NEW.variance IN ('SHORT', 'OVER') THEN
      IF NEW.variance_reason_snapshot IS NULL THEN
        RAISE EXCEPTION 'a count that is not the booking gives the reason of the catalogue' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
      END IF;
      IF jsonb_typeof(NEW.variance_reason_snapshot) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'the reason of a count that is not the booking is kept as the application builds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.variance_reason_snapshot) AS k(key) WHERE k.key NOT IN ('reason_code', 'label', 'attribution', 'note'))
         OR jsonb_typeof(NEW.variance_reason_snapshot -> 'label') IS DISTINCT FROM 'string'
         OR ((NEW.variance_reason_snapshot -> 'note') IS NOT NULL
             AND (jsonb_typeof(NEW.variance_reason_snapshot -> 'note') <> 'string' OR char_length(NEW.variance_reason_snapshot ->> 'note') > 1000)) THEN
        RAISE EXCEPTION 'the reason of a count that is not the booking is kept as the application builds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
      END IF;
      SELECT * INTO catalogue FROM public.reason_code AS rc
       WHERE rc.code = (NEW.variance_reason_snapshot ->> 'reason_code')
         AND rc.domain = CASE NEW.variance WHEN 'SHORT' THEN 'PICKUP_SHORT_COUNT' ELSE 'PICKUP_OVER_COUNT' END;
      IF NOT FOUND OR NOT catalogue.active
         OR catalogue.label IS DISTINCT FROM (NEW.variance_reason_snapshot ->> 'label')
         OR catalogue.attribution IS DISTINCT FROM (NEW.variance_reason_snapshot ->> 'attribution') THEN
        RAISE EXCEPTION 'the reason of a short count is an active reason of the PICKUP_SHORT_COUNT catalogue, and the reason of a count above the booking one of the PICKUP_OVER_COUNT catalogue, as the catalogue holds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
      END IF;
      IF catalogue.requires_note AND btrim(coalesce(NEW.variance_reason_snapshot ->> 'note', '')) = '' THEN
        RAISE EXCEPTION 'the reason of this count asks for a note' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
      END IF;
    END IF;
    -- The recording and the office flag are the database's own instants, taken now that the stop's lock is held: a writer that waited for the lock is
    -- stamped no earlier than the moment the writer before it let go, which a default of now() (the beginning of the transaction) does not give. A short
    -- count has its flag raised at the recording, whatever the writer gave; a count that matches has no flag to raise, and one given is refused by the table's
    -- own check (collection_record_shortfall_facts), for every writer. The device's own moment (captured_at) is another fact and is kept as the writer gave it.
    instant := clock_timestamp();
    NEW.recorded_at := instant;
    IF NEW.variance IN ('SHORT', 'OVER') THEN
      NEW.office_notified_at := instant;
    END IF;
    RETURN NEW;
  END IF;
  -- An update: what the count says never changes, and what the handshake sets is set once (null to a value, never back).
  IF (to_jsonb(NEW) - 'version' - 'handshake_channel' - 'handshake_override_by' - 'handshake_confirmed_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'version' - 'handshake_channel' - 'handshake_override_by' - 'handshake_confirmed_at') THEN
    RAISE EXCEPTION 'a collection record is not changed once it is made' USING ERRCODE = '23514';
  END IF;
  IF OLD.handshake_channel IS NOT NULL AND (NEW.handshake_channel IS DISTINCT FROM OLD.handshake_channel
     OR NEW.handshake_override_by IS DISTINCT FROM OLD.handshake_override_by OR NEW.handshake_confirmed_at IS DISTINCT FROM OLD.handshake_confirmed_at) THEN
    RAISE EXCEPTION 'the outcome of a handshake is not changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- 2. The helper that ends a handshake, as 0073 made it, closing an OVER stop collected.
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
  -- (D-D5: a count above the booking closes the stop collected, as a count that matches does: nothing the booking promised was left behind.)
  closing := CASE record_row.variance WHEN 'SHORT' THEN 'PARTIALLY_COLLECTED' ELSE 'COLLECTED' END;
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
-- 3. The guard of a stop, as 0083 made it, holding the close of an OVER stop to COLLECTED.
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
    -- variance names the state (equal counts and more than were booked close it collected, fewer partially collected) and the handshake must already have ended well, so a stop is never closed
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
            WHERE c.pickup_stop_id = NEW.id AND ((c.variance IN ('MATCH', 'OVER') AND NEW.state = 'COLLECTED') OR (c.variance = 'SHORT' AND NEW.state = 'PARTIALLY_COLLECTED')))
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
    -- where it asks for one, and a photo, meaning evidence attached to the stop in pickup_stop_evidence, where it asks for one) and belongs to the category the failure is reported under
    -- (D-A4: the catalogue binds each reason to one category, so the door wait and the escalation-only rule cannot be stepped around by pairing). The moment is the
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
    IF catalogue.failure_category IS DISTINCT FROM NEW.failure_category THEN
      RAISE EXCEPTION 'the reason of a failure belongs to the category the catalogue gives it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_CATEGORY_MISMATCH';
    END IF;
    IF catalogue.requires_note AND coalesce(NEW.failure_reason_snapshot ->> 'note', '') ~ '^[[:space:]]*$' THEN
      RAISE EXCEPTION 'the reason of this failure asks for a note' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    IF catalogue.requires_contact_attempt AND coalesce(jsonb_array_length(NEW.failure_reason_snapshot -> 'contact_attempts'), 0) = 0 THEN
      RAISE EXCEPTION 'the reason of this failure asks for a contact attempt' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    IF catalogue.requires_photo AND NOT EXISTS (SELECT 1 FROM public.pickup_stop_evidence AS photo WHERE photo.pickup_stop_id = NEW.id) THEN
      RAISE EXCEPTION 'the reason of this failure asks for a photo' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
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
ALTER FUNCTION melarc.pickup_stop_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_guard() FROM PUBLIC;
--> statement-breakpoint
-- The rider's key reads the reasons of a count that is not the booking: the short count's (as 0068 gave it) and the over count's (D-D5).
ALTER POLICY "reason_code_rider_short_count_read" ON "reason_code" USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND domain IN ('PICKUP_SHORT_COUNT', 'PICKUP_OVER_COUNT')
    ELSE false
  END
);
--> statement-breakpoint
-- 4. The envelope of an over count.
CREATE FUNCTION melarc.over_count_envelope(p_stop uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  counted record;
BEGIN
  IF melarc.principal_type() <> 'RIDER'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.collection.confirm' THEN
    RAISE EXCEPTION 'the envelope of an over count is written for the rider that records it, and for nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_stop IS NULL THEN
    RAISE EXCEPTION 'the envelope of an over count is written for one stop' USING ERRCODE = '22023';
  END IF;
  SELECT s.id AS stop_id, s.pickup_request_id, s.responsible_hub_id, r.vendor_organization_id,
         c.variance_reason_snapshot ->> 'reason_code' AS reason,
         (c.collected_count - c.declared_count)::text AS over
    INTO counted
    FROM public.collection_record AS c
    JOIN public.pickup_stop AS s ON s.id = c.pickup_stop_id
    JOIN public.pickup_request AS r ON r.id = s.pickup_request_id
   WHERE c.pickup_stop_id = p_stop AND c.variance = 'OVER' AND c.office_notified_at IS NOT NULL
     AND c.recorded_by = melarc.current_rider_id()
     AND c.recorded_at >= pg_catalog.transaction_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the envelope of an over count is written for a stop the calling rider has counted over in this transaction' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, vendor_organization_id, originating_principal_type,
                             originating_principal_id, operation_id, correlation_id, payload)
    VALUES (pg_catalog.uuidv7(), 'pickup.collection.over_count_flagged', 'PICKUP_REQUEST', counted.pickup_request_id, counted.responsible_hub_id, counted.vendor_organization_id, 'RIDER',
            melarc.current_principal_id(), 'recordCollection', pg_catalog.current_setting('melarc.correlation_id', true),
            pg_catalog.jsonb_build_object('stop', counted.stop_id, 'reason', counted.reason, 'n', counted.over));
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.over_count_envelope(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.over_count_envelope(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.over_count_envelope(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- The arm of the outbox for it: one narrow policy beside the outbox's own, as the short count's is (0082): one event, from the owner's own statement (current_user, which only this function runs as), under
-- the counting key, for the calling rider as the origin, with no rider scope, for a request that has a stop of that rider's whose record is OVER, flagged and made in this transaction.
CREATE POLICY "outbox_insert_over_count" ON "outbox" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND event_type = 'pickup.collection.over_count_flagged' AND aggregate_type = 'PICKUP_REQUEST' AND operation_id = 'recordCollection'
      AND originating_principal_type = 'RIDER' AND originating_principal_id = melarc.current_principal_id() AND rider_id IS NULL
      AND EXISTS (SELECT 1 FROM "collection_record" c JOIN "pickup_stop" s ON s.id = c.pickup_stop_id
                   WHERE s.pickup_request_id = "outbox"."aggregate_id" AND c.responsible_hub_id = "outbox"."responsible_hub_id"
                     AND c.variance = 'OVER' AND c.office_notified_at IS NOT NULL AND c.recorded_at >= transaction_timestamp()
                     AND c.recorded_by = melarc.current_rider_id())
    ELSE false
  END
);
