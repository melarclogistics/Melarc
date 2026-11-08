CREATE TABLE "collection_handshake" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pickup_stop_id" uuid NOT NULL,
	"pickup_request_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"state" text NOT NULL,
	"code_generation" integer NOT NULL,
	"code_digest" "bytea",
	"code_key_version" integer,
	"code_generated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"fallback_sends" integer DEFAULT 0 NOT NULL,
	"last_fallback_at" timestamp with time zone,
	"channel" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_type" text,
	"confirmed_by_id" uuid,
	"authorised_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "collection_handshake_state_closed" CHECK ("collection_handshake"."state" IN ('PENDING', 'CODE_GENERATED', 'CODE_DELIVERED', 'VERIFIED', 'EXPIRED', 'EXHAUSTED', 'DISPUTED', 'MANUALLY_RESOLVED')),
	CONSTRAINT "collection_handshake_direction_closed" CHECK ("collection_handshake"."direction" IN ('VENDOR_ENTERED_RIDER_DISPLAYED', 'SENDER_SMS_RIDER_ENTERED')),
	CONSTRAINT "collection_handshake_channel_closed" CHECK ("collection_handshake"."channel" IS NULL OR "collection_handshake"."channel" IN ('PORTAL', 'SMS_FALLBACK', 'OPS_OVERRIDE')),
	CONSTRAINT "collection_handshake_confirmer_closed" CHECK ("collection_handshake"."confirmed_by_type" IS NULL OR "collection_handshake"."confirmed_by_type" IN ('VENDOR_ACCOUNT', 'RIDER', 'STAFF')),
	CONSTRAINT "collection_handshake_counters" CHECK ("collection_handshake"."code_generation" >= 0 AND "collection_handshake"."attempts" >= 0 AND "collection_handshake"."fallback_sends" >= 0),
	CONSTRAINT "collection_handshake_code_facts" CHECK (("collection_handshake"."state" IN ('CODE_GENERATED', 'CODE_DELIVERED')
            AND "collection_handshake"."code_digest" IS NOT NULL AND octet_length("collection_handshake"."code_digest") = 32 AND "collection_handshake"."code_key_version" >= 1
            AND "collection_handshake"."code_generated_at" IS NOT NULL AND "collection_handshake"."expires_at" IS NOT NULL AND "collection_handshake"."code_generation" >= 1)
          OR ("collection_handshake"."state" NOT IN ('CODE_GENERATED', 'CODE_DELIVERED') AND "collection_handshake"."code_digest" IS NULL)),
	CONSTRAINT "collection_handshake_confirmed_facts" CHECK (("collection_handshake"."state" IN ('VERIFIED', 'MANUALLY_RESOLVED', 'DISPUTED')
            AND "collection_handshake"."channel" IS NOT NULL AND "collection_handshake"."confirmed_at" IS NOT NULL
            AND "collection_handshake"."confirmed_by_type" IS NOT NULL AND "collection_handshake"."confirmed_by_id" IS NOT NULL
            AND (("collection_handshake"."channel" = 'OPS_OVERRIDE') = ("collection_handshake"."authorised_by" IS NOT NULL)))
          OR ("collection_handshake"."state" NOT IN ('VERIFIED', 'MANUALLY_RESOLVED', 'DISPUTED')
            AND "collection_handshake"."channel" IS NULL AND "collection_handshake"."confirmed_at" IS NULL
            AND "collection_handshake"."confirmed_by_type" IS NULL AND "collection_handshake"."confirmed_by_id" IS NULL AND "collection_handshake"."authorised_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "collection_handshake" ADD CONSTRAINT "collection_handshake_stop_fkey" FOREIGN KEY ("pickup_stop_id","responsible_hub_id") REFERENCES "public"."pickup_stop"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_handshake" ADD CONSTRAINT "collection_handshake_request_fkey" FOREIGN KEY ("pickup_request_id") REFERENCES "public"."pickup_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_handshake_stop_key" ON "collection_handshake" USING btree ("pickup_stop_id");--> statement-breakpoint
CREATE INDEX "collection_handshake_hub_state_idx" ON "collection_handshake" USING btree ("responsible_hub_id","state");
--> statement-breakpoint
-- S1.27 (SLICE-001; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.27; features/pickup/pickup-collection.md; state-machines.md section 6; AC-SLICE-001-23, -24,
-- -26 and -73): the collection handshake, the two-party proof that closes a counted stop. Everything above this comment is generated (drizzle-kit, from
-- src/pickup/collection-handshake.schema.ts, whose header explains every column); everything below is in this migration so that the table never exists for a
-- moment without its owner, row-level security, policies, grants and guards.
--
-- What this adds, in the order it appears:
--
--   * The five handshake settings (settings.md section 7.4), which "the task that first reads them" seeds, as a platform value each (the Product Owner, 30
--     October 2026), to a database that was seeded before them (a database that has not been seeded gets them from the seed, which writes the same rows:
--     tools/seed/settings.ts), and the one policy that lets a rider, a vendor and the notification lane read what each needs of them.
--   * The table's access rules. A principal READS the handshake of its own work and WRITES nothing of it: the table is written only by the operations below,
--     which are SECURITY DEFINER functions of the owner that the API's runtime login alone executes, so each rule (who may ask for a code, who may enter it,
--     how many wrong codes, how long a code lives, how often the SMS may go, what closes a stop) is held in one place for every writer, and a wrong code is
--     counted by the database whatever the application does. Their policies admit a statement only while it runs as the owner (current_user), which is true
--     inside the operations and nowhere a statement of the runtime login can reach (the pattern of 0068).
--   * The table's guard, which holds the state machine, the monotonic counters and the immutable columns for every writer.
--
-- The code itself is never stored (src/platform/auth/crypto/handshake-codes.ts): the database keeps a keyed digest of the live code and the operations compare digests.
DO $handshake_settings$
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
        ('handshake_code_length', 'PLATFORM', 'integer', '4'::jsonb, 'digits', 'The number of digits of a collection handshake code. Confirmed by MSC-DEC-256; the direction of the handshake may not change.'),
        ('handshake_code_ttl_minutes', 'PLATFORM', 'integer', '15'::jsonb, 'minutes', 'How long a collection handshake code stays valid after it is made; past it the handshake is expired and routes to Ops.'),
        ('handshake_max_wrong_attempts', 'PLATFORM', 'integer', '5'::jsonb, 'attempts', 'How many wrong codes one collection handshake takes before it is exhausted and routes to Ops.'),
        ('sms_fallback_max_per_pickup', 'PLATFORM', 'integer', '3'::jsonb, 'sends', 'The most codes the SMS fallback sends to a vendor''s registered number for one stop.'),
        ('sms_fallback_cooldown_seconds', 'PLATFORM', 'integer', '60'::jsonb, 'seconds', 'The least time between two SMS fallback sends for the same stop.')
      ) AS v(key, scope, value_type, value, unit, description)
     WHERE NOT EXISTS (SELECT 1 FROM public.setting AS held WHERE held.key = v.key);
  END IF;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$handshake_settings$;
--> statement-breakpoint
-- What each reader needs of the settings. The rider's application reads the length of a code (to make the one it shows); the operations, running as the owner
-- for a rider or a vendor, read the lifetime, the limit of wrong codes and the fallback's cap and cooldown; the notification lane reads the length (to make the
-- one it texts). Staff read every setting already (setting_read).
CREATE POLICY "setting_handshake_read" ON "setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND key = 'handshake_code_length')
      OR (current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
          AND key IN ('handshake_code_ttl_minutes', 'handshake_max_wrong_attempts', 'sms_fallback_max_per_pickup', 'sms_fallback_cooldown_seconds'))
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND key = 'handshake_max_wrong_attempts'
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND key = 'handshake_code_length'
    ELSE false
  END
);
--> statement-breakpoint
ALTER TABLE "collection_handshake" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "collection_handshake" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "collection_handshake" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Whether the calling rider recorded the count of this stop. A sub-select of a policy needs the privileges of the tables it reads for every login that reads the
-- table, whether or not its branch is the one that runs, and the notification lane (which reads the handshake of its envelope) holds none on the record: the
-- rider's branch names this function, which the lane is granted EXECUTE on and never calls (the rule of `melarc.receiver_stands`, 0067). It reads the record
-- through the caller's own row-level security, as that function does.
CREATE FUNCTION melarc.counted_by_calling_rider(p_stop uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.collection_record c WHERE c.pickup_stop_id = p_stop AND c.recorded_by = melarc.current_rider_id())
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.counted_by_calling_rider(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.counted_by_calling_rider(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.counted_by_calling_rider(uuid) TO melarc_api_runtime, melarc_worker_cap_notification;
--> statement-breakpoint
-- Who reads a handshake: the rider that counted the stop, the vendor whose pickup it is, the staff of the hub under the keys of the pickup and fleet domains,
-- and the notification lane, which sees the one handshake of the request its envelope names. The digest and the officer's note are columns no login reads.
CREATE POLICY "collection_handshake_read" ON "collection_handshake" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'fleet')
      AND (melarc.hub_scope_mode() = 'ALL' OR "collection_handshake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.collection.confirm', 'pickup.run.execute')
      AND melarc.counted_by_calling_rider("collection_handshake"."pickup_stop_id")
    WHEN 'VENDOR' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND EXISTS (SELECT 1 FROM "pickup_request" r WHERE r.id = "collection_handshake"."pickup_request_id" AND r.vendor_organization_id = melarc.current_vendor_organization_id())
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND "collection_handshake"."pickup_request_id" = melarc.outbox_aggregate_id()
    ELSE false
  END
);
--> statement-breakpoint
-- Who writes one: nobody but the operations (a statement that runs as the owner), for the key of the act and the kind of principal that holds it.
CREATE POLICY "collection_handshake_operation_insert" ON "collection_handshake" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.handshake.override'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "collection_handshake_operation_update" ON "collection_handshake" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.handshake.override', 'pickup.handshake.resolve')
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND current_user = 'melarc_owner'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.handshake.override', 'pickup.handshake.resolve')
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
-- The API's runtime reads where a handshake stands and nothing that is a secret or is Ops's own: not the digest, not the key version, not the moment of the
-- last fallback, not the officer's note. The notification lane reads the five columns it makes a code from.
GRANT SELECT ("id", "pickup_stop_id", "pickup_request_id", "responsible_hub_id", "direction", "state", "code_generation", "expires_at", "attempts", "fallback_sends",
              "channel", "confirmed_at", "authorised_by", "created_at", "version") ON "collection_handshake" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ("id", "pickup_stop_id", "pickup_request_id", "responsible_hub_id", "direction", "state", "code_generation", "code_key_version", "expires_at")
  ON "collection_handshake" TO melarc_worker_cap_notification;
--> statement-breakpoint
-- The guard. The state machine of section 6, the counters that only grow, and the columns that never change, for every writer. A code ends when the state
-- leaves CODE_GENERATED and CODE_DELIVERED (the table's check holds that no other state has a digest). A closed handshake (VERIFIED, MANUALLY_RESOLVED) moves
-- only to DISPUTED (S1.29), and a DISPUTED one does not move.
CREATE FUNCTION melarc.collection_handshake_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
  IF NEW.code_generation = OLD.code_generation + 1 AND NOT (OLD.state IN ('CODE_GENERATED', 'CODE_DELIVERED') AND NEW.state = 'CODE_GENERATED') THEN
    RAISE EXCEPTION 'a new code is made only by the fallback, for a handshake whose code is live' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.collection_handshake_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_handshake_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.collection_handshake_version() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
ALTER FUNCTION melarc.collection_handshake_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_handshake_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "collection_handshake_guard" BEFORE INSERT OR UPDATE ON "collection_handshake"
  FOR EACH ROW EXECUTE FUNCTION melarc.collection_handshake_guard();
--> statement-breakpoint
CREATE TRIGGER "collection_handshake_version" BEFORE UPDATE ON "collection_handshake"
  FOR EACH ROW EXECUTE FUNCTION melarc.collection_handshake_version();
--> statement-breakpoint
-- The other tables the operations touch, each admitted to a statement that runs as the owner for the kind of principal and the key of the act. As in 0068,
-- these policies bound who and when; the operation chooses the row by its own text, and the queries of the application under the same keys find nothing by
-- them. The stop: a vendor reads the stop of its pickup (it reads none as itself) and the operations lock and close a stop under the rider's, the vendor's or the
-- officer's own key. A policy on the stop's update holds no condition on its state in USING, because a lock taken under it must find the row to wait for it.
CREATE POLICY "pickup_stop_handshake_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_handshake_close" ON "pickup_stop" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.handshake.override', 'pickup.handshake.resolve')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND "pickup_stop"."state" IN ('ARRIVED', 'COLLECTED', 'PARTIALLY_COLLECTED')
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND "pickup_stop"."state" IN ('ARRIVED', 'COLLECTED', 'PARTIALLY_COLLECTED')
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.handshake.override', 'pickup.handshake.resolve')
      AND "pickup_stop"."state" IN ('ARRIVED', 'COLLECTED', 'PARTIALLY_COLLECTED')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The collection record: a vendor reads the record of its pickup to the operations, and the operations set the three columns the handshake owns (the record's
-- guard holds that nothing else changes and that each is set once).
CREATE POLICY "collection_record_handshake_read" ON "collection_record" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "collection_record_handshake_close" ON "collection_record" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.handshake.override', 'pickup.handshake.resolve')
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.handshake.override', 'pickup.handshake.resolve')
    ELSE false
  END
);
--> statement-breakpoint
-- The vendor's registered number. PROVISIONAL (F-23; the plan's stop condition for S1.27): no document says which stored number is "the registered number" of
-- the SMS fallback, and the choice made here to keep going is the vendor organisation's business contact number (`contact_phone`), which the domain model
-- keeps apart from the authentication channel. The rider's operation asks whether there is one; the notification lane reads it for the one organisation of the
-- request its envelope names. Changing the field is one line of the operation and one of the lane.
CREATE POLICY "vendor_organization_handshake_read" ON "vendor_organization" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification'
      AND "vendor_organization"."id" IN (SELECT r.vendor_organization_id FROM "pickup_request" r WHERE r.id = melarc.outbox_aggregate_id())
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ("id", "contact_phone") ON "vendor_organization" TO melarc_worker_cap_notification;
--> statement-breakpoint
-- The helpers of the operations. They are plain functions that nobody but the owner executes: the operations call them, running as the owner, and a statement of
-- the runtime login that names one is refused for want of EXECUTE.
--
-- melarc.handshake_setting: an integer setting, or a refusal that says which one is missing (the application answers it as the platform's setting error).
CREATE FUNCTION melarc.handshake_setting(p_key text) RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  found_value integer;
BEGIN
  SELECT (s.value #>> '{}')::integer INTO found_value FROM public.setting AS s WHERE s.key = p_key;
  IF found_value IS NULL OR found_value < 1 THEN
    RAISE EXCEPTION 'the setting % is missing or not a positive whole number', p_key USING ERRCODE = '23514', DETAIL = 'reason=SETTING_MISSING';
  END IF;
  RETURN found_value;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.handshake_setting(text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_setting(text) FROM PUBLIC;
--> statement-breakpoint
-- melarc.handshake_event: the event of an act, in the facts of the rows and the context: the actor, the surface, the organisation of a vendor and the correlation
-- id are the transaction's, and nothing of it is given by the caller. It is the event the application's writer makes for the same act (`buildAuditRecord`).
CREATE FUNCTION melarc.handshake_event(p_code text, p_object_type text, p_object_id uuid, p_hub uuid, p_previous text, p_resulting text, p_related jsonb, p_detail jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  kind text := melarc.principal_type();
BEGIN
  INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, vendor_organization_id, responsible_hub_id, object_type, object_id,
                                  correlation_id, previous_state, resulting_state, related_ids, detail, outcome, enhanced, serialisation_version)
    VALUES (pg_catalog.uuidv7(), p_code, pg_catalog.clock_timestamp(),
            CASE kind WHEN 'RIDER' THEN 'RIDER' WHEN 'VENDOR' THEN 'VENDOR_ACCOUNT' WHEN 'STAFF' THEN 'STAFF' ELSE 'SYSTEM' END,
            CASE kind WHEN 'SYSTEM' THEN NULL ELSE melarc.current_principal_id() END,
            CASE kind WHEN 'RIDER' THEN 'RIDER_ANDROID' WHEN 'VENDOR' THEN 'VENDOR_PWA' WHEN 'STAFF' THEN 'OPS_PORTAL' ELSE 'SYSTEM' END,
            CASE kind WHEN 'VENDOR' THEN melarc.current_vendor_organization_id() ELSE NULL END,
            p_hub, p_object_type, p_object_id, pg_catalog.current_setting('melarc.correlation_id', true), p_previous, p_resulting, p_related, p_detail,
            'SUCCEEDED', false, 1);
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.handshake_event(text, text, uuid, uuid, text, text, jsonb, jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_event(text, text, uuid, uuid, text, text, jsonb, jsonb) FROM PUBLIC;
--> statement-breakpoint
-- melarc.handshake_envelope: the outbox envelope that asks the notification lane to text a code, written in the rider's own transaction as the owner (the
-- insert guard of the outbox then compares it with the request it names). It carries the number of the generation and nothing else: no code, no number. The
-- aggregate is the request, whose scope is its hub and its vendor and has no rider, so the envelope names the rider only as the origin of the act.
CREATE FUNCTION melarc.handshake_envelope(p_request uuid, p_hub uuid, p_vendor uuid, p_generation integer, p_operation text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, vendor_organization_id, originating_principal_type,
                             originating_principal_id, operation_id, correlation_id, payload)
    VALUES (pg_catalog.uuidv7(), 'pickup.handshake.requested', 'PICKUP_REQUEST', p_request, p_hub, p_vendor, 'RIDER',
            melarc.current_principal_id(), p_operation, pg_catalog.current_setting('melarc.correlation_id', true), pg_catalog.jsonb_build_object('generation', p_generation));
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.handshake_envelope(uuid, uuid, uuid, integer, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_envelope(uuid, uuid, uuid, integer, text) FROM PUBLIC;
--> statement-breakpoint
-- melarc.handshake_settle: a handshake ends well (verified, overridden or resolved by hand) and the stop it belongs to closes with it, in one change. It sets the
-- handshake's end (the state, the channel, the moment, who confirmed, the officer of an override, the note), closes the stop as the record's variance says
-- (`COLLECTED` for a clean count, `PARTIALLY_COLLECTED` for a short one), sets the three columns the handshake owns on the record, and writes the event of the
-- close (`pickup.stop.collected` or `pickup.stop.partially_collected`), which says that the stop closed and is written here and nowhere else. The code is spent:
-- the handshake keeps no digest once it has ended.
CREATE FUNCTION melarc.handshake_settle(p_handshake uuid, p_stop uuid, p_new_id uuid, p_state text, p_channel text, p_note text, p_moment timestamp with time zone)
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
    INSERT INTO public.collection_handshake (id, pickup_stop_id, pickup_request_id, responsible_hub_id, direction, state, code_generation, attempts, fallback_sends,
                                             channel, confirmed_at, confirmed_by_type, confirmed_by_id, authorised_by, note)
      VALUES (p_new_id, p_stop, stop_row.pickup_request_id, stop_row.responsible_hub_id, record_row.handshake_type, p_state, 0, 0, 0,
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
ALTER FUNCTION melarc.handshake_settle(uuid, uuid, uuid, text, text, text, timestamp with time zone) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_settle(uuid, uuid, uuid, text, text, text, timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint
-- THE OPERATIONS. Each is a SECURITY DEFINER function of the owner with a fixed search_path, executable by the API's runtime login alone (the notification lane's one
-- by its capability role), that judges who is asking from the context the runtime sets (the kind of principal and the key of the act, never an argument), takes the
-- stop's lock first (every act on a stop does, so a count, a skip, a cancellation and a handshake meet in one order), then the handshake's, reads the settings it
-- needs as the owner, compares digests, counts, and writes the change and the events of it in one change. A refusal that the application answers as what it is
-- carries `DETAIL reason=<WORD>` (read by `guardReasonIn`); a refusal of authority is 42501, which the application answers as it answers the same refusal of the
-- other acts of the rider (a stop that is not its own, a stop that does not exist and a stop of another vendor are one answer).
--
-- A wrong code, an expired one and an exhausted one are not raised but RETURNED as an outcome, because the change they make (a wrong attempt counted, a code
-- expired, a handshake exhausted) must be kept while the caller is told no: the application commits and then refuses.
--
-- melarc.handshake_issue: the rider that counted a stop asks for the first code (`initiateHandshake`). The code is made by the application from the stop and the
-- generation (1) and handed over as a digest; the operation keeps the digest, never the code. A handshake whose direction is the sender's SMS has its text asked of
-- the lane in the same change.
CREATE FUNCTION melarc.handshake_issue(p_id uuid, p_stop uuid, p_digest bytea, p_key_version integer)
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
  IF p_id IS NULL OR p_stop IS NULL OR p_digest IS NULL OR pg_catalog.octet_length(p_digest) <> 32 OR p_key_version IS NULL OR p_key_version < 1 THEN
    RAISE EXCEPTION 'a handshake is made with an identifier, a stop, a digest of 32 bytes and a key version' USING ERRCODE = '22023';
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
  moment := pg_catalog.clock_timestamp();
  INSERT INTO public.collection_handshake (id, pickup_stop_id, pickup_request_id, responsible_hub_id, direction, state, code_generation, code_digest, code_key_version,
                                           code_generated_at, expires_at, attempts, fallback_sends)
    VALUES (p_id, p_stop, stop_row.pickup_request_id, stop_row.responsible_hub_id, record_row.handshake_type, 'CODE_GENERATED', 1, p_digest, p_key_version,
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
ALTER FUNCTION melarc.handshake_issue(uuid, uuid, bytea, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_issue(uuid, uuid, bytea, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.handshake_issue(uuid, uuid, bytea, integer) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.handshake_verify: a code is entered (`verifyHandshake`). The vendor enters the code its rider displays, the rider the code the sender or the vendor read
-- out to it; the rider of a vendor's pickup may enter a code only after the SMS fallback has made one it could not have seen (it would otherwise prove its own
-- presence to itself). The outcomes are `VERIFIED` (the stop closes, in this change), `CODE_INVALID` (a wrong attempt counted), `ATTEMPTS_EXHAUSTED` (the last wrong
-- attempt, or a handshake already exhausted) and `CODE_EXPIRED` (past the code's life: late self-confirmation is blocked, the handshake is marked expired and routes to
-- Ops). The digests are those of the submitted code under every key version held; the stored digest is compared with each.
CREATE FUNCTION melarc.handshake_verify(p_stop uuid, p_digests bytea[])
RETURNS TABLE (out_outcome text, out_handshake_id uuid, out_state text, out_direction text, out_channel text, out_attempts integer, out_remaining integer,
               out_expires_at timestamp with time zone, out_fallback_sends integer, out_authorised_by uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  kind text := melarc.principal_type();
  rider uuid := melarc.current_rider_id();
  vendor uuid := melarc.current_vendor_organization_id();
  stop_row public.pickup_stop%ROWTYPE;
  record_row public.collection_record%ROWTYPE;
  h public.collection_handshake%ROWTYPE;
  manifest_state text;
  assigned uuid;
  moment timestamp with time zone;
  max_attempts integer;
  before_state text;
  chosen_channel text;
  outcome text;
BEGIN
  IF kind NOT IN ('RIDER', 'VENDOR') OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.collection.confirm' THEN
    RAISE EXCEPTION 'a code is entered by the rider of the stop or by the vendor whose pickup it is' USING ERRCODE = '42501';
  END IF;
  IF p_stop IS NULL OR p_digests IS NULL OR pg_catalog.cardinality(p_digests) < 1 OR pg_catalog.cardinality(p_digests) > 8 THEN
    RAISE EXCEPTION 'a code is checked with one to eight digests' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO stop_row FROM public.pickup_stop AS s WHERE s.id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this is not a stop of the caller' USING ERRCODE = '42501';
  END IF;
  IF kind = 'VENDOR' THEN
    IF vendor IS NULL OR NOT EXISTS (SELECT 1 FROM public.pickup_request AS r WHERE r.id = stop_row.pickup_request_id AND r.vendor_organization_id = vendor) THEN
      RAISE EXCEPTION 'this is not a stop of the caller' USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT m.state, m.assigned_rider_id INTO manifest_state, assigned FROM public.pickup_manifest AS m WHERE m.id = stop_row.pickup_manifest_id;
    IF NOT FOUND OR assigned IS DISTINCT FROM rider THEN
      RAISE EXCEPTION 'this is not a stop of the caller' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT * INTO record_row FROM public.collection_record AS c WHERE c.pickup_stop_id = p_stop;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the count is not recorded' USING ERRCODE = '23514', DETAIL = 'reason=COLLECTION_NOT_RECORDED';
  END IF;
  -- The counted-stop authority: the rider-side handshake of a counted stop belongs to the rider that recorded the count, while it is assigned (above).
  IF kind = 'RIDER' AND record_row.recorded_by <> rider THEN
    RAISE EXCEPTION 'the handshake of a counted stop is the recording rider''s' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.pickup_stop_id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no code has been asked for at this stop' USING ERRCODE = '23514', DETAIL = 'reason=HANDSHAKE_NOT_STARTED';
  END IF;
  IF stop_row.state <> 'ARRIVED' OR h.state IN ('VERIFIED', 'MANUALLY_RESOLVED', 'DISPUTED') THEN
    RAISE EXCEPTION 'the handshake of this stop has ended' USING ERRCODE = '23514', DETAIL = 'reason=HANDSHAKE_CLOSED';
  END IF;
  -- The rung: the sender's code is entered by the rider alone; a vendor's primary code by the vendor alone.
  IF (h.direction = 'SENDER_SMS_RIDER_ENTERED' AND kind <> 'RIDER') OR (h.direction = 'VENDOR_ENTERED_RIDER_DISPLAYED' AND kind = 'RIDER' AND h.fallback_sends = 0) THEN
    RAISE EXCEPTION 'this code is not entered by this caller' USING ERRCODE = '23514', DETAIL = 'reason=WRONG_ENTRANT';
  END IF;
  before_state := h.state;
  IF h.state IN ('EXPIRED', 'EXHAUSTED') THEN
    outcome := CASE h.state WHEN 'EXPIRED' THEN 'CODE_EXPIRED' ELSE 'ATTEMPTS_EXHAUSTED' END;
  ELSE
    moment := pg_catalog.clock_timestamp();
    IF moment >= h.expires_at THEN
      UPDATE public.collection_handshake SET state = 'EXPIRED', code_digest = NULL WHERE id = h.id;
      outcome := 'CODE_EXPIRED';
    ELSIF h.code_digest = ANY (p_digests) THEN
      chosen_channel := CASE WHEN h.fallback_sends > 0 THEN 'SMS_FALLBACK' ELSE 'PORTAL' END;
      PERFORM melarc.handshake_settle(h.id, p_stop, NULL, 'VERIFIED', chosen_channel, NULL, moment);
      PERFORM melarc.handshake_event('pickup.handshake.verified', 'CollectionHandshake', h.id, h.responsible_hub_id, before_state, 'VERIFIED',
        pg_catalog.jsonb_build_object('pickup_stop_id', p_stop::text, 'pickup_manifest_id', stop_row.pickup_manifest_id::text, 'pickup_request_id', stop_row.pickup_request_id::text,
                                      'collection_record_id', record_row.id::text),
        pg_catalog.jsonb_build_object('direction', h.direction, 'channel', chosen_channel, 'attempts', h.attempts));
      outcome := 'VERIFIED';
    ELSE
      max_attempts := melarc.handshake_setting('handshake_max_wrong_attempts');
      IF h.attempts + 1 >= max_attempts THEN
        UPDATE public.collection_handshake SET attempts = attempts + 1, state = 'EXHAUSTED', code_digest = NULL WHERE id = h.id;
        outcome := 'ATTEMPTS_EXHAUSTED';
      ELSE
        UPDATE public.collection_handshake SET attempts = attempts + 1 WHERE id = h.id;
        outcome := 'CODE_INVALID';
      END IF;
    END IF;
  END IF;
  max_attempts := coalesce(max_attempts, melarc.handshake_setting('handshake_max_wrong_attempts'));
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.id = h.id;
  RETURN QUERY SELECT outcome, h.id, h.state, h.direction, h.channel, h.attempts, GREATEST(max_attempts - h.attempts, 0), h.expires_at, h.fallback_sends, h.authorised_by;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.handshake_verify(uuid, bytea[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_verify(uuid, bytea[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.handshake_verify(uuid, bytea[]) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.handshake_sms_fallback: fallback 1 (`requestSmsHandshakeFallback`). The rider asks for a new code to be texted to the vendor's registered number, which the
-- vendor reads out to the rider. The code the rider was shown is superseded (the rider could not prove the vendor's presence with it) and the new one is a code the
-- rider has never seen. The cap and the cooldown are the database's: past `sms_fallback_max_per_pickup` sends, or inside `sms_fallback_cooldown_seconds` of the last, the
-- operation refuses (`SMS_FALLBACK_LIMIT_REACHED`) for every caller and every process, and a refusal sends nothing. The wrong attempts already counted stay counted. When
-- no handshake has begun the fallback makes it (a rider whose portal path was down from the start has nothing to display).
CREATE FUNCTION melarc.handshake_sms_fallback(p_new_id uuid, p_stop uuid, p_expected_generation integer, p_digest bytea, p_key_version integer, p_trigger text)
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
     OR p_key_version IS NULL OR p_key_version < 1 OR p_trigger IS NULL OR p_trigger NOT IN ('NO_DATA', 'PORTAL_DOWN') THEN
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
  -- PROVISIONAL (F-23): the vendor organisation's business contact number is the registered number. See the policy "vendor_organization_handshake_read".
  SELECT o.contact_phone INTO number_held FROM public.vendor_organization AS o WHERE o.id = vendor;
  IF number_held IS NULL OR pg_catalog.btrim(number_held) = '' THEN
    RAISE EXCEPTION 'this vendor has no registered number' USING ERRCODE = '23514', DETAIL = 'reason=NO_REGISTERED_NUMBER';
  END IF;
  ttl := melarc.handshake_setting('handshake_code_ttl_minutes');
  cap := melarc.handshake_setting('sms_fallback_max_per_pickup');
  cooldown := melarc.handshake_setting('sms_fallback_cooldown_seconds');
  moment := pg_catalog.clock_timestamp();
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.pickup_stop_id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_generation <> 0 THEN
      RAISE EXCEPTION 'the handshake changed since it was read' USING ERRCODE = '23514', DETAIL = 'reason=GENERATION_CHANGED';
    END IF;
    handshake_id := p_new_id;
    previous_state := NULL;
    INSERT INTO public.collection_handshake (id, pickup_stop_id, pickup_request_id, responsible_hub_id, direction, state, code_generation, code_digest, code_key_version,
                                             code_generated_at, expires_at, attempts, fallback_sends, last_fallback_at)
      VALUES (p_new_id, p_stop, stop_row.pickup_request_id, stop_row.responsible_hub_id, record_row.handshake_type, 'CODE_GENERATED', 1, p_digest, p_key_version,
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
       SET state = 'CODE_GENERATED', code_generation = code_generation + 1, code_digest = p_digest, code_key_version = p_key_version, code_generated_at = moment,
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
ALTER FUNCTION melarc.handshake_sms_fallback(uuid, uuid, integer, bytea, integer, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_sms_fallback(uuid, uuid, integer, bytea, integer, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.handshake_sms_fallback(uuid, uuid, integer, bytea, integer, text) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.handshake_override: fallback 2 (`authoriseHandshakeOverride`). An officer of the stop's hub, under the key `pickup.handshake.override`, verifies the vendor
-- (or the sender) by another means and establishes the collection as a recorded exception, with the note that says how. The handshake ends `VERIFIED` through channel
-- `OPS_OVERRIDE` naming the officer, and the stop closes with it. It is made from any handshake that has not ended well (a live code, an expired or an exhausted one) and,
-- when none has begun, it makes one at its end. The enhanced event of the override is the application's, written beside this change in the same transaction.
CREATE FUNCTION melarc.handshake_override(p_new_id uuid, p_stop uuid, p_note text)
RETURNS TABLE (out_handshake_id uuid, out_previous_state text, out_state text, out_direction text, out_channel text, out_attempts integer, out_fallback_sends integer,
               out_expires_at timestamp with time zone, out_authorised_by uuid, out_stop_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  stop_row public.pickup_stop%ROWTYPE;
  record_row public.collection_record%ROWTYPE;
  h public.collection_handshake%ROWTYPE;
  previous text;
  closed_as text;
BEGIN
  IF melarc.principal_type() <> 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.handshake.override' THEN
    RAISE EXCEPTION 'a handshake is overridden by an officer holding the key of the override' USING ERRCODE = '42501';
  END IF;
  IF p_new_id IS NULL OR p_stop IS NULL THEN
    RAISE EXCEPTION 'an override names a stop' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NULL OR pg_catalog.btrim(p_note) = '' THEN
    RAISE EXCEPTION 'an override says how the vendor was verified' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  SELECT * INTO stop_row FROM public.pickup_stop AS s WHERE s.id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such stop in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'only a stop that has been arrived at and not closed is overridden' USING ERRCODE = '23514', DETAIL = 'reason=STOP_NOT_ARRIVED';
  END IF;
  SELECT * INTO record_row FROM public.collection_record AS c WHERE c.pickup_stop_id = p_stop;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only a counted stop is overridden' USING ERRCODE = '23514', DETAIL = 'reason=COLLECTION_NOT_RECORDED';
  END IF;
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.pickup_stop_id = p_stop FOR UPDATE;
  IF FOUND AND h.state IN ('VERIFIED', 'MANUALLY_RESOLVED', 'DISPUTED') THEN
    RAISE EXCEPTION 'the handshake of this stop has ended' USING ERRCODE = '23514', DETAIL = 'reason=HANDSHAKE_CLOSED';
  END IF;
  previous := CASE WHEN FOUND THEN h.state END;
  closed_as := melarc.handshake_settle(CASE WHEN FOUND THEN h.id END, p_stop, p_new_id, 'VERIFIED', 'OPS_OVERRIDE', pg_catalog.btrim(p_note), pg_catalog.clock_timestamp());
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.pickup_stop_id = p_stop;
  RETURN QUERY SELECT h.id, previous, h.state, h.direction, h.channel, h.attempts, h.fallback_sends, h.expires_at, h.authorised_by, closed_as;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.handshake_override(uuid, uuid, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_override(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.handshake_override(uuid, uuid, text) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.handshake_resolve: `resolveHandshake`. A Senior Ops officer (key `pickup.handshake.resolve`) establishes by hand, with a note, a collection whose handshake
-- ran out: `EXPIRED` or `EXHAUSTED`, or a live code whose life has passed. The handshake ends `MANUALLY_RESOLVED` through channel `OPS_OVERRIDE` naming the officer, and
-- the stop closes as the recorded count says. A handshake that is still live is not resolved (the vendor can still enter the code); one that has ended is not resolved again.
CREATE FUNCTION melarc.handshake_resolve(p_stop uuid, p_note text)
RETURNS TABLE (out_handshake_id uuid, out_previous_state text, out_state text, out_direction text, out_channel text, out_attempts integer, out_fallback_sends integer,
               out_expires_at timestamp with time zone, out_authorised_by uuid, out_stop_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  stop_row public.pickup_stop%ROWTYPE;
  record_row public.collection_record%ROWTYPE;
  h public.collection_handshake%ROWTYPE;
  previous text;
  closed_as text;
  moment timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  IF melarc.principal_type() <> 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.handshake.resolve' THEN
    RAISE EXCEPTION 'a handshake is resolved by an officer holding the key of the resolution' USING ERRCODE = '42501';
  END IF;
  IF p_stop IS NULL THEN
    RAISE EXCEPTION 'a resolution names a stop' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NULL OR pg_catalog.btrim(p_note) = '' THEN
    RAISE EXCEPTION 'a resolution says how the collection was established' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  SELECT * INTO stop_row FROM public.pickup_stop AS s WHERE s.id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such stop in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'only a stop that has been arrived at and not closed is resolved' USING ERRCODE = '23514', DETAIL = 'reason=STOP_NOT_ARRIVED';
  END IF;
  SELECT * INTO record_row FROM public.collection_record AS c WHERE c.pickup_stop_id = p_stop;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only a counted stop is resolved' USING ERRCODE = '23514', DETAIL = 'reason=COLLECTION_NOT_RECORDED';
  END IF;
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.pickup_stop_id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no code has been asked for at this stop' USING ERRCODE = '23514', DETAIL = 'reason=HANDSHAKE_NOT_STARTED';
  END IF;
  IF h.state IN ('VERIFIED', 'MANUALLY_RESOLVED', 'DISPUTED') THEN
    RAISE EXCEPTION 'the handshake of this stop has ended' USING ERRCODE = '23514', DETAIL = 'reason=HANDSHAKE_CLOSED';
  END IF;
  IF h.state IN ('CODE_GENERATED', 'CODE_DELIVERED') THEN
    IF moment < h.expires_at THEN
      RAISE EXCEPTION 'the code of this handshake is still live' USING ERRCODE = '23514', DETAIL = 'reason=NOT_RESOLVABLE';
    END IF;
    -- A code whose life has passed is an expired one: the end is recorded here, in the same change, and the resolution follows it (the machine of section 6
    -- takes MANUALLY_RESOLVED from EXPIRED and EXHAUSTED only). The state the officer is told it resolved is the expired one.
    UPDATE public.collection_handshake SET state = 'EXPIRED', code_digest = NULL WHERE id = h.id;
    h.state := 'EXPIRED';
  END IF;
  previous := h.state;
  closed_as := melarc.handshake_settle(h.id, p_stop, NULL, 'MANUALLY_RESOLVED', 'OPS_OVERRIDE', pg_catalog.btrim(p_note), moment);
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.pickup_stop_id = p_stop;
  RETURN QUERY SELECT h.id, previous, h.state, h.direction, h.channel, h.attempts, h.fallback_sends, h.expires_at, h.authorised_by, closed_as;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.handshake_resolve(uuid, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_resolve(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.handshake_resolve(uuid, text) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.handshake_mark_delivered: the notification lane tells the handshake that the text carrying the code of a generation was accepted by the provider. The
-- handshake moves `CODE_GENERATED` to `CODE_DELIVERED` if it still stands at that generation (a later fallback, or the end of the handshake, has overtaken the text
-- otherwise, and nothing is written), and the event `pickup.handshake.delivered` is written for the system. It answers whether it changed anything.
CREATE FUNCTION melarc.handshake_mark_delivered(p_handshake uuid, p_generation integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  h public.collection_handshake%ROWTYPE;
BEGIN
  IF melarc.principal_type() <> 'SYSTEM' OR melarc.task_capability() <> 'notification' THEN
    RAISE EXCEPTION 'the delivery of a code is recorded by the notification lane, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_handshake IS NULL OR p_generation IS NULL OR p_generation < 1 THEN
    RAISE EXCEPTION 'a delivery names a handshake and the generation of its code' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.id = p_handshake FOR UPDATE;
  IF NOT FOUND OR h.state <> 'CODE_GENERATED' OR h.code_generation <> p_generation THEN
    RETURN false;
  END IF;
  UPDATE public.collection_handshake SET state = 'CODE_DELIVERED' WHERE id = p_handshake;
  PERFORM melarc.handshake_event('pickup.handshake.delivered', 'CollectionHandshake', h.id, h.responsible_hub_id, 'CODE_GENERATED', 'CODE_DELIVERED',
    pg_catalog.jsonb_build_object('pickup_stop_id', h.pickup_stop_id::text, 'pickup_request_id', h.pickup_request_id::text),
    pg_catalog.jsonb_build_object('direction', h.direction, 'generation', p_generation));
  RETURN true;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.handshake_mark_delivered(uuid, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_mark_delivered(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.handshake_mark_delivered(uuid, integer) TO melarc_worker_cap_notification;
--> statement-breakpoint
-- The outbox's insert policy as 0055 made it, with one arm added (S1.27): the envelope that asks the notification lane to text a code is written by the
-- operations of the handshake (`melarc.handshake_envelope`), which run as the owner under the rider's counting key. Its rider arm asks for an envelope that
-- names the rider (`rider_id`), which the insert guard refuses for the aggregates there are (a request and a manifest have no rider scope), so no rider could
-- write one; the added arm admits the one event of the handshake, for a request whose stop the calling rider counted, as the rider's own act and with no rider
-- scope. A statement of the runtime login (not the owner) meets the rider arm as before.
ALTER POLICY "outbox_insert" ON "outbox" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN originating_principal_type = 'STAFF' AND originating_principal_id = melarc.current_principal_id() AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN originating_principal_type = 'VENDOR' AND originating_principal_id = melarc.current_principal_id() AND vendor_organization_id = melarc.current_vendor_organization_id()
    WHEN 'RIDER' THEN (originating_principal_type = 'RIDER' AND originating_principal_id = melarc.current_principal_id() AND rider_id = melarc.current_rider_id())
      OR (current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
          AND event_type = 'pickup.handshake.requested' AND aggregate_type = 'PICKUP_REQUEST'
          AND originating_principal_type = 'RIDER' AND originating_principal_id = melarc.current_principal_id() AND rider_id IS NULL
          AND EXISTS (SELECT 1 FROM "collection_record" c JOIN "pickup_stop" s ON s.id = c.pickup_stop_id
                       WHERE s.pickup_request_id = "outbox"."aggregate_id" AND c.recorded_by = melarc.current_rider_id()
                         AND c.responsible_hub_id = "outbox"."responsible_hub_id"))
    ELSE false
  END
);
--> statement-breakpoint
-- The notification lane's one event (S1.27): it tells a handshake that the text carrying its code was accepted (`melarc.handshake_mark_delivered`, which runs as the
-- owner under the lane's capability) and the operation writes the event `pickup.handshake.delivered` for it. A policy of its own, beside the ledger's: the SYSTEM
-- arm of a policy names one capability and no other condition that can undo it (the policy lint), and the ledger's names the authentication capability.
CREATE POLICY "audit_event_insert_notification" ON "audit_event" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND current_user = 'melarc_owner' AND actor_id IS NULL
      AND event_code = 'pickup.handshake.delivered' AND object_type = 'CollectionHandshake' AND outcome = 'SUCCEEDED' AND enhanced = false
      AND vendor_organization_id IS NULL AND approval_id IS NULL AND note IS NULL AND before_after IS NULL AND device_context IS NULL AND actor_bundle IS NULL
      AND EXISTS (SELECT 1 FROM "collection_handshake" h WHERE h.id = "audit_event"."object_id" AND h.responsible_hub_id = "audit_event"."responsible_hub_id"
                    AND h.pickup_request_id = melarc.outbox_aggregate_id())
    ELSE false
  END
);
--> statement-breakpoint
-- The insert guard of the outbox as 0062 made it, with its relations named with their schema and a search path of its own (S1.27).
CREATE OR REPLACE FUNCTION melarc.outbox_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  aggregate_hub uuid;
  aggregate_vendor uuid;
BEGIN
  -- A new envelope starts untouched: the relay's bookkeeping is the relay's to move.
  IF NEW.relay_state <> 'PENDING' OR NEW.attempt_count <> 0 OR NEW.lease_version <> 0 OR NEW.lease_owner IS NOT NULL
     OR NEW.lease_expires_at IS NOT NULL OR NEW.relayed_at IS NOT NULL OR NEW.last_outcome IS NOT NULL THEN
    RAISE EXCEPTION 'an envelope is written untouched: pending, never leased, never relayed' USING ERRCODE = '23514';
  END IF;
  -- Every scope field is the authoritative row's, read in this transaction under the writer's own context (SECURITY_DESIGN.md
  -- section 14.7): an envelope that names an aggregate its writer cannot read, or a scope the aggregate does not have, is refused.
  IF NEW.aggregate_type = 'PICKUP_REQUEST' THEN
    SELECT p.responsible_hub_id, p.vendor_organization_id INTO aggregate_hub, aggregate_vendor
      FROM public.pickup_request p WHERE p.id = NEW.aggregate_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an envelope names an aggregate that its writer can read' USING ERRCODE = '23514';
    END IF;
    IF aggregate_hub IS DISTINCT FROM NEW.responsible_hub_id OR aggregate_vendor IS DISTINCT FROM NEW.vendor_organization_id OR NEW.rider_id IS NOT NULL THEN
      RAISE EXCEPTION 'an envelope carries the scope of its aggregate and no other' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.aggregate_type = 'PICKUP_MANIFEST' THEN
    SELECT m.responsible_hub_id INTO aggregate_hub FROM public.pickup_manifest m WHERE m.id = NEW.aggregate_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an envelope names an aggregate that its writer can read' USING ERRCODE = '23514';
    END IF;
    IF aggregate_hub IS DISTINCT FROM NEW.responsible_hub_id OR NEW.vendor_organization_id IS NOT NULL OR NEW.rider_id IS NOT NULL THEN
      RAISE EXCEPTION 'an envelope carries the scope of its aggregate and no other' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- The guard of a collection record as 0069 made it, with its relations and row types named with their schema and a search path of its own (S1.27).
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
    -- The reason of a short count is a reason of the PICKUP_SHORT_COUNT catalogue that is active, with the label and the attribution the catalogue holds
    -- now, in the shape the application builds (its code, its label, its attribution and the rider's note, and no member of a writer's own), and it
    -- satisfies the rules of its metadata: a note where it asks for one, and no photo asked for (no evidence can be stored before S1.28, so a reason
    -- that asks for one cannot be satisfied). A snapshot read before the catalogue changed no longer agrees with it and is refused, with the reasons the
    -- application answers as what they are (the DETAIL, read by guardReasonIn): it is the application's to say that the reason it read is not the reason
    -- there is, and the same key and body then make the record from the catalogue as it stands. The snapshot is the reason as it was at the count and is
    -- never read again, so a later edit of the catalogue leaves it as it was (the update branch below freezes it).
    IF NEW.variance = 'SHORT' THEN
      IF NEW.variance_reason_snapshot IS NULL THEN
        RAISE EXCEPTION 'a short count gives the reason of the catalogue' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
      END IF;
      IF jsonb_typeof(NEW.variance_reason_snapshot) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'the reason of a short count is kept as the application builds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.variance_reason_snapshot) AS k(key) WHERE k.key NOT IN ('reason_code', 'label', 'attribution', 'note'))
         OR jsonb_typeof(NEW.variance_reason_snapshot -> 'label') IS DISTINCT FROM 'string'
         OR ((NEW.variance_reason_snapshot -> 'note') IS NOT NULL
             AND (jsonb_typeof(NEW.variance_reason_snapshot -> 'note') <> 'string' OR char_length(NEW.variance_reason_snapshot ->> 'note') > 1000)) THEN
        RAISE EXCEPTION 'the reason of a short count is kept as the application builds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
      END IF;
      SELECT * INTO catalogue FROM public.reason_code AS rc
       WHERE rc.code = (NEW.variance_reason_snapshot ->> 'reason_code') AND rc.domain = 'PICKUP_SHORT_COUNT';
      IF NOT FOUND OR NOT catalogue.active
         OR catalogue.label IS DISTINCT FROM (NEW.variance_reason_snapshot ->> 'label')
         OR catalogue.attribution IS DISTINCT FROM (NEW.variance_reason_snapshot ->> 'attribution') THEN
        RAISE EXCEPTION 'the reason of a short count is an active reason of the PICKUP_SHORT_COUNT catalogue, as the catalogue holds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
      END IF;
      IF catalogue.requires_note AND btrim(coalesce(NEW.variance_reason_snapshot ->> 'note', '')) = '' THEN
        RAISE EXCEPTION 'the reason of this short count asks for a note' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
      END IF;
      IF catalogue.requires_photo THEN
        RAISE EXCEPTION 'the reason of this short count asks for a photo, and no evidence can be stored yet' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
      END IF;
    END IF;
    -- The recording and the office flag are the database's own instants, taken now that the stop's lock is held: a writer that waited for the lock is
    -- stamped no earlier than the moment the writer before it let go, which a default of now() (the beginning of the transaction) does not give. A short
    -- count has its flag raised at the recording, whatever the writer gave; a count that matches has no flag to raise, and one given is refused by the table's
    -- own check (collection_record_shortfall_facts), for every writer. The device's own moment (captured_at) is another fact and is kept as the writer gave it.
    instant := clock_timestamp();
    NEW.recorded_at := instant;
    IF NEW.variance = 'SHORT' THEN
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
-- The guard that a stop with a collection record is not skipped or failed, as 0068 made it, with its relation named with its schema and a search path of its own (S1.27).
CREATE OR REPLACE FUNCTION melarc.pickup_stop_collection_kept() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.state IN ('SKIPPED', 'FAILED') AND OLD.state IS DISTINCT FROM NEW.state
     AND EXISTS (SELECT 1 FROM public.collection_record WHERE pickup_stop_id = OLD.id) THEN
    RAISE EXCEPTION 'a pickup stop with a collection record is not skipped or failed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- The guard of a stop as 0066 made it, with the branch of the handshake's close added (S1.27).
CREATE OR REPLACE FUNCTION melarc.pickup_stop_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_stop_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_guard() FROM PUBLIC;
--> statement-breakpoint
-- The ledger as 0069 left it, with the events of the handshake added (S1.27): the rider's and the vendor's, written by the operations as the owner, and the lane's delivered.
ALTER POLICY "audit_event_insert" ON "audit_event" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN actor_type = 'STAFF' AND actor_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN actor_type = 'VENDOR_ACCOUNT' AND actor_id = melarc.current_principal_id() AND surface_context = 'VENDOR_PWA' AND (
      (event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT' AND outcome = 'SUCCEEDED' AND enhanced = false)
      OR (event_code IN ('pickup.request.created', 'pickup.request.cancelled') AND object_type = 'PickupRequest' AND vendor_organization_id = melarc.current_vendor_organization_id() AND outcome = 'SUCCEEDED' AND enhanced = false)
      -- S1.27: the vendor's entry of a code, and the close of the stop it causes, written by the operation of migration 0070 as the owner for a request of the vendor's own.
      OR (current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
          AND event_code IN ('pickup.handshake.verified', 'pickup.stop.collected', 'pickup.stop.partially_collected') AND object_type IN ('CollectionHandshake', 'PickupStop')
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
