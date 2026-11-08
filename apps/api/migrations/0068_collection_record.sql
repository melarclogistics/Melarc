-- S1.26: the collection record, made at the count (see the comment before the owner statement below).
CREATE TABLE "collection_record" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pickup_stop_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"declared_count" integer NOT NULL,
	"collected_count" integer NOT NULL,
	"variance" text NOT NULL,
	"variance_reason_snapshot" jsonb,
	"office_notified_at" timestamp with time zone,
	"handshake_type" text NOT NULL,
	"handshake_channel" text,
	"handshake_override_by" uuid,
	"handshake_confirmed_at" timestamp with time zone,
	"recorded_by" uuid NOT NULL,
	"captured_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "collection_record_variance_closed" CHECK ("collection_record"."variance" IN ('MATCH', 'SHORT')),
	CONSTRAINT "collection_record_handshake_type_closed" CHECK ("collection_record"."handshake_type" IN ('VENDOR_ENTERED_RIDER_DISPLAYED', 'SENDER_SMS_RIDER_ENTERED')),
	CONSTRAINT "collection_record_handshake_channel_closed" CHECK ("collection_record"."handshake_channel" IS NULL OR "collection_record"."handshake_channel" IN ('PORTAL', 'SMS_FALLBACK', 'OPS_OVERRIDE')),
	CONSTRAINT "collection_record_counts" CHECK ("collection_record"."collected_count" >= 1 AND "collection_record"."declared_count" >= 1),
	CONSTRAINT "collection_record_variance_follows_counts" CHECK (("collection_record"."variance" = 'MATCH' AND "collection_record"."collected_count" = "collection_record"."declared_count")
          OR ("collection_record"."variance" = 'SHORT' AND "collection_record"."collected_count" < "collection_record"."declared_count")),
	CONSTRAINT "collection_record_shortfall_facts" CHECK (("collection_record"."variance" = 'SHORT' AND "collection_record"."variance_reason_snapshot" IS NOT NULL AND "collection_record"."office_notified_at" IS NOT NULL)
          OR ("collection_record"."variance" = 'MATCH' AND "collection_record"."variance_reason_snapshot" IS NULL AND "collection_record"."office_notified_at" IS NULL)),
	CONSTRAINT "collection_record_reason_snapshot_object" CHECK ("collection_record"."variance_reason_snapshot" IS NULL OR jsonb_typeof("collection_record"."variance_reason_snapshot") = 'object'),
	CONSTRAINT "collection_record_handshake_facts" CHECK (("collection_record"."handshake_channel" IS NULL AND "collection_record"."handshake_confirmed_at" IS NULL AND "collection_record"."handshake_override_by" IS NULL)
          OR ("collection_record"."handshake_channel" IS NOT NULL AND "collection_record"."handshake_confirmed_at" IS NOT NULL
              AND (("collection_record"."handshake_channel" = 'OPS_OVERRIDE') = ("collection_record"."handshake_override_by" IS NOT NULL))))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_stop_id_hub_key" ON "pickup_stop" USING btree ("id","responsible_hub_id");
--> statement-breakpoint
ALTER TABLE "collection_record" ADD CONSTRAINT "collection_record_stop_fkey" FOREIGN KEY ("pickup_stop_id","responsible_hub_id") REFERENCES "public"."pickup_stop"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_record" ADD CONSTRAINT "collection_record_hub_fkey" FOREIGN KEY ("responsible_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_record" ADD CONSTRAINT "collection_record_rider_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."rider_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_record_stop_key" ON "collection_record" USING btree ("pickup_stop_id");--> statement-breakpoint
CREATE INDEX "collection_record_hub_idx" ON "collection_record" USING btree ("responsible_hub_id","recorded_at");--> statement-breakpoint
CREATE INDEX "collection_record_rider_idx" ON "collection_record" USING btree ("recorded_by","recorded_at");
--> statement-breakpoint
-- S1.26, the collection record (D-04 option 1, "count, then confirm"; domain-model.md 6.5; AC-SLICE-001-20, -21, -28, -29).
--
-- What is added by hand, in this change: the owner, ENABLE and FORCE ROW LEVEL SECURITY and the policies; the grants (select and insert, and no update:
-- the handshake task grants its own columns); the guard that holds a record's identity, its counts, the direction of its handshake and its immutability,
-- and that **takes the stop's lock before it judges the stop**; the version trigger; the stop that is kept while a record stands; the rider's read of the
-- short-count reasons; two narrow operations for the two facts of the request that a count needs (the direction of the handshake, and the promotion of
-- an individual sender); and the ledger's rider arm for the two events of a count and the one arm that admits the promotion's event to the operation.
--
-- **A rider's context reads no request and no sender, and still needs two facts of them**: the declared count is the stop's own summary (what the rider
-- was shown), but the kind of sender (which fixes the handshake's direction) and the individual sender to promote are the request's. They are not
-- given to the rider's key as rows. `melarc.collection_handshake_type` returns one word (the direction) and `melarc.promote_collected_sender` makes the
-- one change (the promotion) **and writes its event in the same change**, returning the identifier of the sender it promoted; both are SECURITY DEFINER
-- functions of the owner that answer only the key `pickup.collection.confirm` of a rider, for a stop the rider has arrived at (the direction) or has
-- counted (the promotion). The policies of the request and of the sender admit that key only while the statement runs as the owner (`current_user`),
-- which is true inside those two functions and nowhere a statement of the runtime login can reach: any other query under the same key finds no request and
-- no sender, before and after the count, and the runtime login holds no privilege to update a sender at all.
--
-- **The promotion's event is the operation's, never a statement of the key's**: the ledger admits it only while the statement runs as the owner, so no
-- marker a statement can set, no count a rider really made and no fact it names lets the runtime login write that event for a sender it did not
-- promote, for another counted stop, or a second time; and a promotion cannot be made without it, because the change and the event are one operation.
-- **The direction is the guard's too**: whoever inserts a record under the counting key must give the direction the request's sender fixes, which the guard
-- asks of the same operation the service asks, or the insert is refused.
ALTER TABLE "collection_record" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "collection_record" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "collection_record" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "collection_record_read" ON "collection_record" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'fleet')
      AND (melarc.hub_scope_mode() = 'ALL' OR "collection_record"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.collection.confirm', 'pickup.run.execute')
      AND "collection_record"."recorded_by" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "collection_record_insert" ON "collection_record" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND "collection_record"."recorded_by" = melarc.current_rider_id()
      AND EXISTS (SELECT 1 FROM "pickup_stop" s WHERE s.id = "collection_record"."pickup_stop_id" AND s.state = 'ARRIVED' AND s.released_at IS NULL
                    AND s.responsible_hub_id = "collection_record"."responsible_hub_id")
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT, INSERT ON "collection_record" TO melarc_api_runtime;
--> statement-breakpoint
-- The guard. A record is made once, for a stop the rider has arrived at on a run in progress, with the count the stop's summary declared and the
-- direction the request's sender fixes; it is then frozen but for the three columns the handshake sets (and the version the database keeps). The
-- declared count is read from the stop's own summary because that is what the rider was shown and the only request fact its context can read as itself.
-- The direction is asked of `melarc.collection_handshake_type`, the operation the service asks (the guard reads no request): a writer under the counting
-- key that gives the other direction is refused, so a direct insert cannot store the individual-sender flow for a vendor's pickup, or the reverse, and
-- have the record freeze it. Only that key can insert at all (the policy); a statement with no principal is an administrator's, which the policies do not
-- bind and this does not judge.
CREATE FUNCTION melarc.collection_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stop_row pickup_stop%ROWTYPE;
  run_state text;
  declared integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The stop's lock first, and then the judgement: a foreign-key check takes only a share lock on the stop that an update of its state does not
    -- conflict with, so without this a skip or a failure that began after the stop was read as arrived could commit beside the record. With the lock,
    -- the writer that comes second waits for the first and judges what the first left (the skip's trigger looks for a record after it holds the lock,
    -- and this looks at the state after it holds it). A writer the policies do not allow to lock the stop falls back to a plain read: it is refused by
    -- the insert policy, and makes no record.
    SELECT * INTO stop_row FROM pickup_stop WHERE id = NEW.pickup_stop_id FOR UPDATE;
    IF NOT FOUND THEN
      SELECT * INTO stop_row FROM pickup_stop WHERE id = NEW.pickup_stop_id;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a collection record names a pickup stop that is not there' USING ERRCODE = '23514';
    END IF;
    IF stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a collection is recorded for a stop that has been arrived at and not resolved' USING ERRCODE = '23514';
    END IF;
    SELECT state INTO run_state FROM pickup_manifest WHERE id = stop_row.pickup_manifest_id;
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
ALTER FUNCTION melarc.collection_record_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_record_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.collection_record_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version') THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.collection_record_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_record_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "collection_record_guard" BEFORE INSERT OR UPDATE ON "collection_record"
  FOR EACH ROW EXECUTE FUNCTION melarc.collection_record_guard();
--> statement-breakpoint
CREATE TRIGGER "collection_record_version" BEFORE UPDATE ON "collection_record"
  FOR EACH ROW EXECUTE FUNCTION melarc.collection_record_version();
--> statement-breakpoint
-- A stop that has a collection record is never skipped or failed: the parcels were counted at the door, so the stop is closed by the handshake (the
-- next task) and by nothing else. The cancellation of its request and Ops's skip answer `STATE_CONFLICT` before this (they lock the stop and look); this
-- is what holds for every other writer. It reads the table as the caller, and the read policy admits every key of the pickup and fleet domains in the
-- hub, so the check cannot pass because it could not see (the failure report of a rider is added to the policy by the task that builds it).
CREATE FUNCTION melarc.pickup_stop_collection_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('SKIPPED', 'FAILED') AND OLD.state IS DISTINCT FROM NEW.state
     AND EXISTS (SELECT 1 FROM collection_record WHERE pickup_stop_id = OLD.id) THEN
    RAISE EXCEPTION 'a pickup stop with a collection record is not skipped or failed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_stop_collection_kept() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_collection_kept() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pickup_stop_collection_kept" BEFORE UPDATE ON "pickup_stop"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_stop_collection_kept();
--> statement-breakpoint
-- The rider's key that records a count may take the lock of its own dispatched stop (`select ... for update` needs an update policy to find the row)
-- and may change nothing of it: the check refuses every write, so the lock is all this policy gives. The count is written to its own table.
CREATE POLICY "pickup_stop_collection_lock" ON "pickup_stop" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND EXISTS (SELECT 1 FROM "pickup_manifest" AS m WHERE m.id = "pickup_stop"."pickup_manifest_id" AND m.assigned_rider_id = melarc.current_rider_id() AND m.dispatched_at IS NOT NULL)
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN false
    ELSE false
  END
);
--> statement-breakpoint
-- The reasons of a short count, read by the rider's key that records one (the catalogue is readable by staff alone otherwise).
CREATE POLICY "reason_code_rider_short_count_read" ON "reason_code" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND domain = 'PICKUP_SHORT_COUNT'
    ELSE false
  END
);
--> statement-breakpoint
-- The direction of the handshake, read for the stop the calling rider has arrived at: the one word the request's sender fixes, and nothing else of the
-- request. A vendor's request is entered by the vendor and displayed by the rider, an individual sender's is sent by SMS and entered by the rider. It
-- answers only a rider under the key that records a count, for a stop of that rider's own dispatched run (the stop's own policies decide that) that is
-- `ARRIVED` and not released; a stop that is not that is a refusal, not an empty answer.
CREATE FUNCTION melarc.collection_handshake_type(p_stop uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  request_id uuid;
  by_vendor boolean;
BEGIN
  IF melarc.principal_type() <> 'RIDER'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.collection.confirm' THEN
    RAISE EXCEPTION 'the direction of a handshake is read by the rider that records a count, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_stop IS NULL THEN
    RAISE EXCEPTION 'the direction of a handshake is asked for one stop' USING ERRCODE = '22023';
  END IF;
  SELECT s.pickup_request_id INTO request_id FROM public.pickup_stop AS s
   WHERE s.id = p_stop AND s.state = 'ARRIVED' AND s.released_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the direction of a handshake is read for a stop the calling rider has arrived at' USING ERRCODE = '42501';
  END IF;
  SELECT (r.vendor_organization_id IS NOT NULL) INTO by_vendor FROM public.pickup_request AS r WHERE r.id = request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the request of a stop is not there' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN by_vendor THEN 'VENDOR_ENTERED_RIDER_DISPLAYED' ELSE 'SENDER_SMS_RIDER_ENTERED' END;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.collection_handshake_type(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_handshake_type(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.collection_handshake_type(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- The promotion (AC-SLICE-001-28): a provisional individual sender becomes reusable when a count has been recorded for it, by the rider that recorded
-- it, and never the other way. It makes the one change **and writes its event in the same change**, from the rows it changed, and returns the identifier
-- of the sender it promoted (null for a vendor's request or a sender that is already reusable, which write nothing). A count that was not recorded is a
-- refusal: arrival alone promotes nobody. The event is written here and nowhere else: the stop it cites is the stop it was asked about, the sender is the
-- one that stop's request names, and the sender changes once, so the event is written once; an event that cannot be written undoes the promotion with it.
-- The ledger admits that event to a statement that runs as the owner (see the end of this migration), so no statement of the runtime login writes it.
CREATE FUNCTION melarc.promote_collected_sender(p_stop uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  request_id uuid;
  hub_id uuid;
  sender_id uuid;
  promoted uuid;
BEGIN
  IF melarc.principal_type() <> 'RIDER'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.collection.confirm' THEN
    RAISE EXCEPTION 'an individual sender is promoted by the rider that records a count, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_stop IS NULL THEN
    RAISE EXCEPTION 'a promotion is asked for one stop' USING ERRCODE = '22023';
  END IF;
  SELECT s.pickup_request_id, s.responsible_hub_id INTO request_id, hub_id FROM public.pickup_stop AS s WHERE s.id = p_stop;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a sender is promoted for a stop of the calling rider''s own run' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.collection_record AS c WHERE c.pickup_stop_id = p_stop AND c.recorded_by = melarc.current_rider_id()) THEN
    RAISE EXCEPTION 'a sender is promoted by a count that the calling rider has recorded for the stop' USING ERRCODE = '23514';
  END IF;
  SELECT r.ad_hoc_sender_id INTO sender_id FROM public.pickup_request AS r WHERE r.id = request_id;
  IF sender_id IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.ad_hoc_sender SET state = 'REUSABLE' WHERE id = sender_id AND state = 'PROVISIONAL' RETURNING id INTO promoted;
  IF promoted IS NULL THEN
    RETURN NULL;
  END IF;
  -- The event of the change, in the facts of the rows: the actor, the transaction's correlation id and the hub are the context's and the stop's; nothing of
  -- it is given by the caller. It is the event the application's writer made for the same change (`buildAuditRecord`, compared by a test).
  INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, responsible_hub_id, object_type, object_id,
                                  correlation_id, previous_state, resulting_state, related_ids, detail, outcome, enhanced, serialisation_version)
    VALUES (pg_catalog.uuidv7(), 'pickup.sender.promoted', pg_catalog.clock_timestamp(), 'RIDER', melarc.current_principal_id(), 'RIDER_ANDROID', hub_id,
            'AdHocSender', promoted, pg_catalog.current_setting('melarc.correlation_id', true), 'PROVISIONAL', 'REUSABLE',
            pg_catalog.jsonb_build_object('pickup_stop_id', p_stop::text, 'pickup_request_id', request_id::text), '{}'::pg_catalog.jsonb,
            'SUCCEEDED', false, 1);
  RETURN promoted;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.promote_collected_sender(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.promote_collected_sender(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.promote_collected_sender(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- The two rows those functions read and write, admitted to the one key and to a statement that runs as the owner, which is a statement inside them:
-- the runtime login cannot become the owner, so no query of its own reaches the request or the sender through these policies. The row each function
-- reads is chosen by its own text (the stop's request, that request's sender); the policies bound who may, not which row.
CREATE POLICY "pickup_request_collection_rider_read" ON "pickup_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "ad_hoc_sender_collection_rider_read" ON "ad_hoc_sender" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "ad_hoc_sender_collection_promote" ON "ad_hoc_sender" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND current_user = 'melarc_owner' AND "ad_hoc_sender"."state" = 'PROVISIONAL'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND current_user = 'melarc_owner' AND "ad_hoc_sender"."state" = 'REUSABLE'
    ELSE false
  END
);
--> statement-breakpoint
-- A sender is promoted and never demoted, whoever writes it.
CREATE FUNCTION melarc.ad_hoc_sender_state_forward() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'REUSABLE' AND NEW.state <> 'REUSABLE' THEN
    RAISE EXCEPTION 'an individual sender that has been promoted is not made provisional again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.ad_hoc_sender_state_forward() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.ad_hoc_sender_state_forward() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "ad_hoc_sender_state_forward" BEFORE UPDATE ON "ad_hoc_sender"
  FOR EACH ROW EXECUTE FUNCTION melarc.ad_hoc_sender_state_forward();
--> statement-breakpoint
ALTER POLICY "audit_event_insert" ON "audit_event" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN actor_type = 'STAFF' AND actor_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN actor_type = 'VENDOR_ACCOUNT' AND actor_id = melarc.current_principal_id() AND surface_context = 'VENDOR_PWA' AND (
      (event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT' AND outcome = 'SUCCEEDED' AND enhanced = false)
      OR (event_code IN ('pickup.request.created', 'pickup.request.cancelled') AND object_type = 'PickupRequest' AND vendor_organization_id = melarc.current_vendor_organization_id() AND outcome = 'SUCCEEDED' AND enhanced = false)
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
        -- S1.26: the two events of a count, in the name of the rider that recorded it, for the stop it is a record of, and the event the variance names
        -- (a clean count is `collected`, a short one `partially_collected`). The stop stays `ARRIVED`: the handshake closes it.
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
            AND event_code IN ('pickup.stop.collected', 'pickup.stop.partially_collected') AND object_type = 'PickupStop'
            AND previous_state = 'ARRIVED' AND resulting_state = 'ARRIVED'
            AND EXISTS (
              SELECT 1 FROM collection_record c
               WHERE c.pickup_stop_id = "audit_event"."object_id" AND c.recorded_by = melarc.current_rider_id()
                 AND c.responsible_hub_id = "audit_event"."responsible_hub_id"
                 AND (c.variance = 'MATCH') = ("audit_event"."event_code" = 'pickup.stop.collected')))
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
