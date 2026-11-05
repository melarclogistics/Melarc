CREATE TABLE "run_custody_handover" (
	"id" uuid PRIMARY KEY NOT NULL,
	"manifest_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"from_rider_id" uuid NOT NULL,
	"to_rider_id" uuid,
	"to_hub_id" uuid,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"parcel_count_taken" integer,
	"initiation_note" text NOT NULL,
	"failure_note" text,
	"initiated_by" uuid NOT NULL,
	"accepted_by" uuid,
	"failed_by" uuid,
	"initiated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "run_custody_handover_state_closed" CHECK ("run_custody_handover"."state" IN ('PENDING', 'COMPLETED', 'FAILED')),
	CONSTRAINT "run_custody_handover_one_destination" CHECK (("run_custody_handover"."to_rider_id" IS NULL) <> ("run_custody_handover"."to_hub_id" IS NULL)),
	CONSTRAINT "run_custody_handover_hub_is_the_runs" CHECK ("run_custody_handover"."to_hub_id" IS NULL OR "run_custody_handover"."to_hub_id" = "run_custody_handover"."responsible_hub_id"),
	CONSTRAINT "run_custody_handover_not_to_itself" CHECK ("run_custody_handover"."to_rider_id" IS NULL OR "run_custody_handover"."to_rider_id" <> "run_custody_handover"."from_rider_id"),
	CONSTRAINT "run_custody_handover_accepted_facts" CHECK (("run_custody_handover"."state" = 'COMPLETED') = ("run_custody_handover"."parcel_count_taken" IS NOT NULL) AND ("run_custody_handover"."state" = 'COMPLETED') = ("run_custody_handover"."accepted_by" IS NOT NULL)),
	CONSTRAINT "run_custody_handover_failed_facts" CHECK (("run_custody_handover"."state" = 'FAILED') = ("run_custody_handover"."failure_note" IS NOT NULL) AND ("run_custody_handover"."state" = 'FAILED') = ("run_custody_handover"."failed_by" IS NOT NULL)),
	CONSTRAINT "run_custody_handover_resolved_facts" CHECK (("run_custody_handover"."state" = 'PENDING') = ("run_custody_handover"."resolved_at" IS NULL)),
	CONSTRAINT "run_custody_handover_count_nonnegative" CHECK ("run_custody_handover"."parcel_count_taken" IS NULL OR "run_custody_handover"."parcel_count_taken" >= 0),
	CONSTRAINT "run_custody_handover_notes_bounded" CHECK (char_length("run_custody_handover"."initiation_note") BETWEEN 1 AND 1000 AND btrim("run_custody_handover"."initiation_note") <> '' AND ("run_custody_handover"."failure_note" IS NULL OR (char_length("run_custody_handover"."failure_note") BETWEEN 1 AND 1000 AND btrim("run_custody_handover"."failure_note") <> '')))
);
--> statement-breakpoint
ALTER TABLE "run_custody_handover" ADD CONSTRAINT "run_custody_handover_manifest_fkey" FOREIGN KEY ("manifest_id","responsible_hub_id") REFERENCES "public"."pickup_manifest"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_custody_handover" ADD CONSTRAINT "run_custody_handover_from_fkey" FOREIGN KEY ("from_rider_id") REFERENCES "public"."rider_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_custody_handover" ADD CONSTRAINT "run_custody_handover_to_rider_fkey" FOREIGN KEY ("to_rider_id") REFERENCES "public"."rider_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_custody_handover" ADD CONSTRAINT "run_custody_handover_to_hub_fkey" FOREIGN KEY ("to_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_custody_handover" ADD CONSTRAINT "run_custody_handover_hub_fkey" FOREIGN KEY ("responsible_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_custody_handover_one_open" ON "run_custody_handover" USING btree ("manifest_id") WHERE "run_custody_handover"."state" = 'PENDING';--> statement-breakpoint
CREATE INDEX "run_custody_handover_manifest_idx" ON "run_custody_handover" USING btree ("manifest_id","initiated_at");--> statement-breakpoint
CREATE INDEX "run_custody_handover_receiver_idx" ON "run_custody_handover" USING btree ("to_rider_id","initiated_at") WHERE "run_custody_handover"."to_rider_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "run_custody_handover_sender_idx" ON "run_custody_handover" USING btree ("from_rider_id","initiated_at");--> statement-breakpoint
CREATE INDEX "run_custody_handover_hub_idx" ON "run_custody_handover" USING btree ("responsible_hub_id","initiated_at");
--> statement-breakpoint
-- THE HAND-WRITTEN PART (S1.24). Everything above is generated (drizzle-kit, from src/fleet/run-custody-handover.schema.ts): the table, its keys,
-- its indexes (one open handover per run) and the checks that hold what each state implies. This migration is applied as melarc_migration_elevated,
-- a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
-- S1.24 (SLICE-001): the custody of a started run's parcels moves from the rider who holds them to another rider or to the hub
-- (initiateRunCustodyHandover, acceptRunCustodyHandover, failRunCustodyHandover, listRunCustodyHandovers, getRunCustodyHandover;
-- delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.24; contracts/state-machines.md section 4.1; domain-model.md section 6.8.1;
-- AC-SLICE-001-67 and -68; MSC-DEC-246). What this part does:
--
--   * The table is owned by the owner with row-level security enabled and forced. Staff read the handovers of the hubs of the grant under the
--     custody keys; a rider reads the handovers it is a party to (the one that hands over and the one named to receive), and nothing of the run
--     they are about. A vendor reads none. The scope probe lets a staff member's miss be told from a record that does not exist.
--   * Who writes. Staff open one under fleet.custody.initiate and mark one failed under the same key. The named receiving rider accepts under
--     fleet.custody.accept, and staff accept under that key only where the destination is the hub (named in the policy's check and held by the
--     guard, and not in the lock's USING, so that an officer who meets a handover to a rider finds it and is refused by the application and
--     not told there is none). The policies name the key, the party and the result state; the guard says what each key writes and nothing
--     more. No policy lets a lock hide a handover that has moved on: the application finds it and refuses it as STATE_CONFLICT.
--   * The custody chain. The guard refuses, for every writer, a handover opened on a run that is not in progress, from a rider who does not
--     hold the custody (melarc.run_custody_holder: the assigned rider, or the receiver of the latest completed handover; none once the hub holds
--     it), to a rider who is not active and of the run's hub, or in the name of someone other than the officer who opens it. It freezes a
--     resolved handover and every column but the ones the resolution writes.
--   * The completion of a run by the system now also happens when a handover resolves (state-machines.md section 4), so the keys of the two
--     custody acts are added to the keys that complete a run (0066), and the manifest's guard refuses the completion of a run that has a handover
--     pending. **It reads the custody table through the writer's own row-level security, so it holds for the writers whose context can read it**:
--     the five keys of this task and of 0066 are given that read below, and the key of the hub handover (S1.31), which completes a run where
--     something was collected, must be given it by the migration that adds that key's policy on the manifest, with a test (the plan's S1.31 block
--     says so). The receiving rider, who is not the run's rider and reads no run by any other key, is shown the run and its stops only under the
--     accepting key and only while it is the receiver now (melarc.receiver_stands: a handover to it is pending, or its handover is the latest
--     completed one of the run), so that the completion can be judged and written in the transaction of its acceptance; a rider who received custody
--     once and has handed it on, or whose run is over, stands for nothing. The same reads are given to staff under the two custody keys. Nothing here
--     lets a receiver read a run through a read operation: the keys of those are not these, and the accepting operation reads the rows to count them
--     and returns none of them.
--   * The ledger. The rider arm of the audit ledger takes two more events of the rider's own act: fleet.custody.accepted, an ENHANCED event about
--     the handover it was named on, and pickup.manifest.completed for the run its acceptance completed, each carrying the facts of its act.
--     The other arms and the other events of the rider arm are restated word for word.

ALTER TABLE "run_custody_handover" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "run_custody_handover" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "run_custody_handover" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "run_custody_handover_read" ON "run_custody_handover" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('fleet.custody.read', 'fleet.custody.initiate', 'fleet.custody.accept', 'pickup.stop.skip', 'pickup.request.cancel') AND (melarc.hub_scope_mode() = 'ALL' OR "run_custody_handover"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('fleet.custody.read', 'fleet.custody.accept') AND ("run_custody_handover"."from_rider_id" = melarc.current_rider_id() OR "run_custody_handover"."to_rider_id" = melarc.current_rider_id())
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "run_custody_handover_probe" ON "run_custody_handover" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
--> statement-breakpoint
CREATE POLICY "run_custody_handover_insert" ON "run_custody_handover" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.initiate' AND "run_custody_handover"."state" = 'PENDING' AND (melarc.hub_scope_mode() = 'ALL' OR "run_custody_handover"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "run_custody_handover_accept" ON "run_custody_handover" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept' AND "run_custody_handover"."to_rider_id" = melarc.current_rider_id()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept' AND (melarc.hub_scope_mode() = 'ALL' OR "run_custody_handover"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept' AND "run_custody_handover"."to_rider_id" = melarc.current_rider_id() AND "run_custody_handover"."state" = 'COMPLETED'
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept' AND "run_custody_handover"."to_hub_id" IS NOT NULL AND "run_custody_handover"."state" = 'COMPLETED' AND (melarc.hub_scope_mode() = 'ALL' OR "run_custody_handover"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "run_custody_handover_fail" ON "run_custody_handover" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.initiate' AND (melarc.hub_scope_mode() = 'ALL' OR "run_custody_handover"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.initiate' AND "run_custody_handover"."state" = 'FAILED' AND (melarc.hub_scope_mode() = 'ALL' OR "run_custody_handover"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT, INSERT ON "run_custody_handover" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("state", "parcel_count_taken", "accepted_by", "failure_note", "failed_by", "resolved_at") ON "run_custody_handover" TO melarc_api_runtime;
--> statement-breakpoint
-- Whether the calling rider is the receiver of this run now: a handover to it is pending, or its handover is the latest completed one of the run (it
-- holds the custody). Not "has ever received": a rider who took custody and then handed it on, or whose run has long been over, stands for nothing.
-- It is the one thing the receiving rider's policies on the run and its stops name, so that the rule is written once and tested alone. It reads the
-- custody table through the caller's own row-level security (a rider sees the handovers it is a party to), it is not inlined (a SET clause stops
-- that), and it is called by policies of tables other roles read: a policy's functions need EXECUTE for every role that reads the table, whether or
-- not the policy's branch is the one that runs, so the notification worker (which reads the run, 0062) is granted EXECUTE and no privilege on the
-- custody table at all.
CREATE FUNCTION melarc.receiver_stands(p_manifest uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.run_custody_handover h
     WHERE h.manifest_id = p_manifest AND h.to_rider_id = melarc.current_rider_id()
       AND (h.state = 'PENDING'
            OR (h.state = 'COMPLETED' AND NOT EXISTS (
                  SELECT 1 FROM public.run_custody_handover later
                   WHERE later.manifest_id = h.manifest_id AND later.state = 'COMPLETED'
                     AND (later.resolved_at, later.id) > (h.resolved_at, h.id))))
  )
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.receiver_stands(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.receiver_stands(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.receiver_stands(uuid) TO melarc_api_runtime, melarc_worker_cap_notification;
--> statement-breakpoint
-- Who holds the custody of a run now: the receiver of its latest completed handover (none, if that handover was to the hub), or, if no handover
-- of it has been completed, its assigned rider. Read through the row-level security of whoever asks, as the guards that call it are.
CREATE FUNCTION melarc.run_custody_holder(p_manifest uuid) RETURNS uuid LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.run_custody_handover h WHERE h.manifest_id = p_manifest AND h.state = 'COMPLETED')
    THEN (SELECT h.to_rider_id FROM public.run_custody_handover h WHERE h.manifest_id = p_manifest AND h.state = 'COMPLETED' ORDER BY h.resolved_at DESC, h.id DESC LIMIT 1)
    ELSE (SELECT m.assigned_rider_id FROM public.pickup_manifest m WHERE m.id = p_manifest)
  END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.run_custody_holder(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.run_custody_holder(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.run_custody_holder(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- The guard of a custody handover: what no login may change whatever the policy admits.
CREATE FUNCTION melarc.run_custody_handover_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acting text := coalesce(current_setting('melarc.authorization_key', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING' THEN
      RAISE EXCEPTION 'a custody handover is opened pending' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pickup_manifest m
       WHERE m.id = NEW.manifest_id AND m.responsible_hub_id = NEW.responsible_hub_id AND m.state = 'IN_PROGRESS'
    ) THEN
      RAISE EXCEPTION 'a custody handover is opened on a run in progress' USING ERRCODE = '23514';
    END IF;
    IF NEW.from_rider_id IS DISTINCT FROM melarc.run_custody_holder(NEW.manifest_id) THEN
      RAISE EXCEPTION 'a custody handover starts from the rider who holds the custody now' USING ERRCODE = '23514';
    END IF;
    IF NEW.to_rider_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM rider_identity r WHERE r.id = NEW.to_rider_id AND r.status = 'ACTIVE' AND r.primary_hub_id = NEW.responsible_hub_id) THEN
      RAISE EXCEPTION 'custody is handed to an active rider of the run''s own hub' USING ERRCODE = '23514';
    END IF;
    IF acting = 'fleet.custody.initiate' AND NEW.initiated_by IS DISTINCT FROM melarc.current_principal_id() THEN
      RAISE EXCEPTION 'a custody handover is opened in the name of the officer who opens it' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.manifest_id IS DISTINCT FROM OLD.manifest_id
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.from_rider_id IS DISTINCT FROM OLD.from_rider_id
     OR NEW.to_rider_id IS DISTINCT FROM OLD.to_rider_id
     OR NEW.to_hub_id IS DISTINCT FROM OLD.to_hub_id
     OR NEW.initiation_note IS DISTINCT FROM OLD.initiation_note
     OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by
     OR NEW.initiated_at IS DISTINCT FROM OLD.initiated_at THEN
    RAISE EXCEPTION 'a custody handover keeps its run, its hub, its two parties, its destination, its note and its opening' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'a resolved custody handover is frozen' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'PENDING' THEN
    RAISE EXCEPTION 'a pending custody handover changes only by being resolved' USING ERRCODE = '23514';
  END IF;
  IF acting = 'fleet.custody.accept' THEN
    IF NEW.state <> 'COMPLETED' THEN
      RAISE EXCEPTION 'the acceptance of a custody handover completes it and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'state' - 'parcel_count_taken' - 'accepted_by' - 'resolved_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'parcel_count_taken' - 'accepted_by' - 'resolved_at' - 'version') THEN
      RAISE EXCEPTION 'the acceptance of a custody handover writes the state, the count taken, the receiver and the moment and nothing else' USING ERRCODE = '23514';
    END IF;
    IF NEW.accepted_by IS DISTINCT FROM melarc.current_principal_id() THEN
      RAISE EXCEPTION 'a custody handover is accepted in the name of the one who accepts it' USING ERRCODE = '23514';
    END IF;
    IF melarc.principal_type() = 'RIDER' AND NEW.to_rider_id IS DISTINCT FROM melarc.current_rider_id() THEN
      RAISE EXCEPTION 'a custody handover to a rider is accepted by that rider' USING ERRCODE = '23514';
    END IF;
    IF melarc.principal_type() = 'STAFF' AND NEW.to_hub_id IS NULL THEN
      RAISE EXCEPTION 'the office accepts a custody handover only where the hub is the destination' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pickup_manifest m WHERE m.id = NEW.manifest_id AND m.state = 'IN_PROGRESS') THEN
      RAISE EXCEPTION 'a custody handover is accepted while its run is in progress' USING ERRCODE = '23514';
    END IF;
  ELSIF acting = 'fleet.custody.initiate' THEN
    IF NEW.state <> 'FAILED' THEN
      RAISE EXCEPTION 'marking a custody handover failed fails it and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'state' - 'failure_note' - 'failed_by' - 'resolved_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'failure_note' - 'failed_by' - 'resolved_at' - 'version') THEN
      RAISE EXCEPTION 'failing a custody handover writes the state, the note, the officer and the moment and nothing else' USING ERRCODE = '23514';
    END IF;
    IF NEW.failed_by IS DISTINCT FROM melarc.current_principal_id() THEN
      RAISE EXCEPTION 'a custody handover is failed in the name of the officer who fails it' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.run_custody_handover_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.run_custody_handover_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.run_custody_handover_version() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER FUNCTION melarc.run_custody_handover_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.run_custody_handover_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "run_custody_handover_guard" BEFORE INSERT OR UPDATE ON "run_custody_handover"
  FOR EACH ROW EXECUTE FUNCTION melarc.run_custody_handover_guard();
--> statement-breakpoint
CREATE TRIGGER "run_custody_handover_version" BEFORE UPDATE ON "run_custody_handover"
  FOR EACH ROW EXECUTE FUNCTION melarc.run_custody_handover_version();
--> statement-breakpoint
-- The run and its stops, read by the custody keys. Staff read them in the hubs of the grant under the keys that open, fail and accept; the receiving
-- rider reads them under the accepting key alone and only while it is the receiver now (melarc.receiver_stands), so that the run's completion can be
-- judged and written in the transaction of the acceptance. Neither policy is reached by any read operation's key.
CREATE POLICY "pickup_manifest_custody_staff_read" ON "pickup_manifest" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('fleet.custody.initiate', 'fleet.custody.accept') AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_manifest_custody_rider_read" ON "pickup_manifest" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept' AND melarc.receiver_stands("pickup_manifest"."id")
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_custody_staff_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('fleet.custody.initiate', 'fleet.custody.accept') AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_custody_rider_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept' AND melarc.receiver_stands("pickup_stop"."pickup_manifest_id")
    ELSE false
  END
);
--> statement-breakpoint
-- The completion by the system (0066) for the officers' two custody keys, and for the receiving rider under the accepting key.
ALTER POLICY "pickup_manifest_settle" ON "pickup_manifest" USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.stop.skip', 'pickup.request.cancel', 'fleet.custody.initiate', 'fleet.custody.accept') AND "pickup_manifest"."state" = 'IN_PROGRESS' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.stop.skip', 'pickup.request.cancel', 'fleet.custody.initiate', 'fleet.custody.accept') AND "pickup_manifest"."state" = 'COMPLETED' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_manifest_custody_rider_settle" ON "pickup_manifest" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept' AND "pickup_manifest"."state" = 'IN_PROGRESS' AND melarc.receiver_stands("pickup_manifest"."id")
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept' AND "pickup_manifest"."state" = 'COMPLETED' AND melarc.receiver_stands("pickup_manifest"."id")
    ELSE false
  END
);
--> statement-breakpoint
-- The rider's record as 0063 let staff read it, and one key more: opening a handover reads the status and the hub of the rider it names.
DROP POLICY "rider_identity_staff_read" ON "rider_identity";
--> statement-breakpoint
CREATE POLICY "rider_identity_staff_read" ON "rider_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) IN ('dispatch.read', 'staff.device.register', 'staff.device.reregister', 'staff.device.revoke', 'pickup.manifest.assign', 'pickup.manifest.dispatch', 'fleet.custody.initiate')
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a manifest as 0066 made it, with two things added: a run that has a custody handover pending is not completed by a writer who can see it
-- (a closed run never leaves a custody record open; the key of any later completion is given the read of the custody table with its policy), and
-- the two custody keys complete a run as the system does when their act leaves nothing to work.
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
  -- Whoever completes a run: none of its stops is still to be worked, and no custody handover of it is pending. The arrival at a stop reads its
  -- run without locking it and is correct only because a run in progress cannot leave that state while one of its stops is still to be worked.
  IF NEW.state = 'COMPLETED' AND OLD.state IS DISTINCT FROM 'COMPLETED' THEN
    IF EXISTS (SELECT 1 FROM pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('PENDING', 'ARRIVED')) THEN
      RAISE EXCEPTION 'a pickup manifest is completed only when none of its stops is still to be worked' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM run_custody_handover h WHERE h.manifest_id = NEW.id AND h.state = 'PENDING') THEN
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
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.stop.skip', 'pickup.request.cancel', 'fleet.custody.initiate', 'fleet.custody.accept') THEN
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
    IF EXISTS (SELECT 1 FROM pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('COLLECTED', 'PARTIALLY_COLLECTED')) THEN
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
-- The audit ledger's insert policy as 0065 left it, with the Rider arm taking two events of the receiving rider's acceptance beside the ones it
-- took: fleet.custody.accepted (ENHANCED: custody movement is a chain-of-custody event), about the handover it was named on, and
-- pickup.manifest.completed, for the run its acceptance completed. Each carries the facts of its act, equal to what the rows themselves say. The
-- Staff, Vendor and SYSTEM arms and the closed ELSE are restated word for word.
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
