CREATE TABLE "pickup_intake" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"pickup_request_id" uuid NOT NULL,
	"pickup_manifest_id" uuid NOT NULL,
	"handed_over_by" uuid NOT NULL,
	"handed_over_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"declaration_captured_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'AWAITING_COUNT' NOT NULL,
	"rider_declared_count" integer NOT NULL,
	"prefilled_count" integer NOT NULL,
	"physical_count" integer,
	"counted_at" timestamp with time zone,
	"counted_by" uuid,
	"count_variance" text,
	"count_difference" integer,
	"condition" text DEFAULT 'OK' NOT NULL,
	"active_receiver_id" uuid,
	"lock_acquired_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pickup_intake_state_closed" CHECK ("pickup_intake"."state" IN ('AWAITING_COUNT', 'COUNTED', 'RECONCILIATION_REQUIRED', 'READY_FOR_ITEMIZATION', 'ITEMIZING', 'CLOSED')),
	CONSTRAINT "pickup_intake_variance_closed" CHECK ("pickup_intake"."count_variance" IS NULL OR "pickup_intake"."count_variance" IN ('MATCH', 'SHORT', 'OVER')),
	CONSTRAINT "pickup_intake_condition_closed" CHECK ("pickup_intake"."condition" IN ('OK', 'DAMAGED', 'TAMPERED', 'OTHER')),
	CONSTRAINT "pickup_intake_counts_nonnegative" CHECK ("pickup_intake"."rider_declared_count" >= 0 AND "pickup_intake"."prefilled_count" >= 0 AND ("pickup_intake"."physical_count" IS NULL OR "pickup_intake"."physical_count" >= 0)),
	CONSTRAINT "pickup_intake_count_facts" CHECK (("pickup_intake"."state" = 'AWAITING_COUNT') = ("pickup_intake"."physical_count" IS NULL) AND ("pickup_intake"."physical_count" IS NULL) = ("pickup_intake"."counted_at" IS NULL) AND ("pickup_intake"."physical_count" IS NULL) = ("pickup_intake"."counted_by" IS NULL) AND ("pickup_intake"."physical_count" IS NULL) = ("pickup_intake"."count_variance" IS NULL) AND ("pickup_intake"."physical_count" IS NULL) = ("pickup_intake"."count_difference" IS NULL)),
	CONSTRAINT "pickup_intake_lock_facts" CHECK (("pickup_intake"."active_receiver_id" IS NULL) = ("pickup_intake"."lock_acquired_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "pickup_intake" ADD CONSTRAINT "pickup_intake_manifest_fkey" FOREIGN KEY ("pickup_manifest_id","responsible_hub_id") REFERENCES "public"."pickup_manifest"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_intake" ADD CONSTRAINT "pickup_intake_request_fkey" FOREIGN KEY ("pickup_request_id") REFERENCES "public"."pickup_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_intake" ADD CONSTRAINT "pickup_intake_hub_fkey" FOREIGN KEY ("responsible_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_intake" ADD CONSTRAINT "pickup_intake_handed_over_by_fkey" FOREIGN KEY ("handed_over_by") REFERENCES "public"."rider_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_intake_code_key" ON "pickup_intake" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_intake_one_per_request" ON "pickup_intake" USING btree ("pickup_manifest_id","pickup_request_id");--> statement-breakpoint
CREATE INDEX "pickup_intake_hub_idx" ON "pickup_intake" USING btree ("responsible_hub_id","state","handed_over_at");--> statement-breakpoint
CREATE INDEX "pickup_intake_request_idx" ON "pickup_intake" USING btree ("pickup_request_id");

--> statement-breakpoint
-- THE HAND-WRITTEN PART (S1.31). Everything above is generated (drizzle-kit, from src/hub/pickup-intake.schema.ts): the table, its keys, its indexes (one intake for each collected request of a run) and the
-- checks that hold what each state implies. This migration is applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
-- S1.31 (SLICE-001): the hub handover (submitHubHandover; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.31; features/hub/hub-intake.md section 5.1; contracts/state-machines.md sections 4 and 7;
-- domain-model.md section 6.6; AC-SLICE-001-17, -18, -39, -44, -45, -75, -78; MSC-DEC-416). The custody holder hands the run's collected parcels to the hub: the run moves IN_PROGRESS to COMPLETED
-- and one intake opens at AWAITING_COUNT for each collected request. What this part does:
--
--   * THE DECLARATION IS WITHHELD BY THE GRANTS. rider_declared_count (the rider's number, never derived from the collected count, zero legal) and prefilled_count (what the rider's form was pre-filled
--     with, so that a correction is a fact) are inserted by the handover and read by NO grant of the application's login: it holds SELECT on the other columns by name, so no read model, join, whole-row
--     reference or `select *` can carry either, whoever asks and whatever a policy admits, and `hub.read` does not lift it (permissions.md: the count is withheld by schema, not by permission). The
--     count the receiver commits (S1.33) is compared with the declaration inside the database, by an operation of its own that the same grants do not need (a definer function that reads what the login
--     cannot), and the declaration is first served in the answer to the committed count. S1.32's reads build on these grants and select the columns they name.
--   * WHO READS AND WRITES. Staff read the intakes of the hubs of their grant under hub.read; the scope probe lets a staff member's miss on another hub's intake be told from an id that matches nothing
--     (S1.32 reads by id). The rider who handed over reads its own intakes under the key of the handover alone (the operation reads back what it made; no read operation of a rider exists for them) and
--     inserts them under the same key, in its own name, at AWAITING_COUNT. A vendor reads none. Nobody holds UPDATE or DELETE yet: the lock, the count and the condition are later tasks'.
--   * WHAT THE DATABASE JUDGES FOR EVERY WRITER (the guard below). An intake is opened for a request that is collected on a COMPLETED run, in the name of the custody holder of that run
--     (melarc.run_custody_holder: the assigned rider, or whoever accepted a RunCustodyHandover; none once the hub holds the custody), at AWAITING_COUNT, with the receipt time of the completion of the run
--     (a time the writer gives is not kept: handed_over_at is the database's, and it is the moment the handover completed the run). It keeps for ever its identity, its run, its request, its hub,
--     the handover's facts and the declaration; its states move one way (state-machines.md section 7); a count, once made, is kept as it was.
--   * THE SET OF A RUN'S INTAKES IS EXACTLY ITS COLLECTED REQUESTS, held at the end of the transaction (two deferred constraint triggers: on the intake that opens and on the run that is completed), for
--     every writer: a handover with a row too few, a completion that opens none, an intake on a run that is not completed are refused at the commit. The check reads as the writer's own context and
--     FAILS CLOSED: it raises when it cannot find the intake or the run it was asked to judge, so a writer that changes its context before the commit cannot make it read nothing and pass (the lesson of 0090).
--   * THE KEY OF THE HANDOVER COMPLETES A RUN. hub.handover.submit is given, for the custody holder's own run: the read of the run, its stops and their collection records (the assigned rider, or the
--     receiver whose handover stands: melarc.receiver_stands, 0067), the read of the custody table (OB-S1-44: the manifest's guard refuses the completion of a run that has a custody handover pending
--     only for a writer whose context can read the table, so the key is given that read here, and tested), and the completion itself, which the guard of the manifest (restated below) holds to: a run in
--     progress, every stop terminal (above), none pending (above), something collected, the holder the rider, and the state and its moment written and nothing else.
--   * THE LEDGER. A new permissive policy (the pattern of 0091) admits the two events of the handover to the rider under the key, bound to what the rows say: hub.handover.submitted (one for the handover,
--     naming the intakes it opened, and the number of them, and never a count of parcels: before the blind count no event carries a declaration) and pickup.manifest.completed for the run it completed.

ALTER TABLE "pickup_intake" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "pickup_intake" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pickup_intake" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pickup_intake_staff_read" ON "pickup_intake" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.read' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_intake_handover_read" ON "pickup_intake" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit' AND "pickup_intake"."handed_over_by" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_intake_probe" ON "pickup_intake" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
--> statement-breakpoint
CREATE POLICY "pickup_intake_handover_insert" ON "pickup_intake" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit' AND "pickup_intake"."handed_over_by" = melarc.current_rider_id() AND "pickup_intake"."state" = 'AWAITING_COUNT'
    ELSE false
  END
);
--> statement-breakpoint
-- The columns the application's login reads: every column but the declaration and what the form was pre-filled with. It inserts the columns of a handover and none of a later act's.
GRANT SELECT ("id", "code", "responsible_hub_id", "pickup_request_id", "pickup_manifest_id", "handed_over_by", "handed_over_at", "declaration_captured_at", "state", "physical_count", "counted_at", "counted_by", "count_variance", "count_difference", "condition", "active_receiver_id", "lock_acquired_at", "version") ON "pickup_intake" TO melarc_api_runtime;
--> statement-breakpoint
GRANT INSERT ("id", "code", "responsible_hub_id", "pickup_request_id", "pickup_manifest_id", "handed_over_by", "declaration_captured_at", "rider_declared_count", "prefilled_count") ON "pickup_intake" TO melarc_api_runtime;
--> statement-breakpoint
-- The guard of an intake: what no login may change whatever the policy admits, and what an intake is opened with.
CREATE FUNCTION melarc.pickup_intake_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  run_state text;
  run_completed_at timestamp with time zone;
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
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_intake_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_intake_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.pickup_intake_version() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER FUNCTION melarc.pickup_intake_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_intake_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pickup_intake_guard" BEFORE INSERT OR UPDATE ON "pickup_intake"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_intake_guard();
--> statement-breakpoint
CREATE TRIGGER "pickup_intake_version" BEFORE UPDATE ON "pickup_intake"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_intake_version();
--> statement-breakpoint
-- The set of a run's intakes, judged at the end of the transaction on both sides: the intake that opens and the run that is completed. It reads as the writer's own context (the writer that opens the
-- intakes of its handover reads the stops of its run and its own intakes under the key of the handover, and the administrator reads everything) and FAILS CLOSED: a statement that cannot find the
-- intake or the run it is asked to judge raises, so that a writer that changes its context before the commit cannot make the check read nothing and pass.
CREATE FUNCTION melarc.pickup_intake_set_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  run_id uuid;
  run_state text;
  collected bigint;
  opened bigint;
  uncovered bigint;
BEGIN
  IF TG_TABLE_NAME = 'pickup_intake' THEN
    run_id := NEW.pickup_manifest_id;
    IF NOT EXISTS (SELECT 1 FROM public.pickup_intake AS i WHERE i.id = NEW.id) THEN
      RAISE EXCEPTION 'the intake that was opened is not there to be judged' USING ERRCODE = '23514', CONSTRAINT = 'pickup_intake_set';
    END IF;
  ELSE
    run_id := NEW.id;
  END IF;
  SELECT m.state INTO run_state FROM public.pickup_manifest AS m WHERE m.id = run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the run of the intakes is not there to be judged' USING ERRCODE = '23514', CONSTRAINT = 'pickup_intake_set';
  END IF;
  IF run_state <> 'COMPLETED' THEN
    RAISE EXCEPTION 'the intakes of a handover belong to a run that the handover completed' USING ERRCODE = '23514', CONSTRAINT = 'pickup_intake_set';
  END IF;
  SELECT pg_catalog.count(*) INTO collected FROM public.pickup_stop AS s
   WHERE s.pickup_manifest_id = run_id AND s.state IN ('COLLECTED', 'PARTIALLY_COLLECTED');
  SELECT pg_catalog.count(*) INTO opened FROM public.pickup_intake AS i WHERE i.pickup_manifest_id = run_id;
  SELECT pg_catalog.count(*) INTO uncovered FROM public.pickup_stop AS s
   WHERE s.pickup_manifest_id = run_id AND s.state IN ('COLLECTED', 'PARTIALLY_COLLECTED')
     AND NOT EXISTS (SELECT 1 FROM public.pickup_intake AS i WHERE i.pickup_manifest_id = s.pickup_manifest_id AND i.pickup_request_id = s.pickup_request_id);
  IF opened <> collected OR uncovered <> 0 THEN
    RAISE EXCEPTION 'the intakes of a handover are exactly the collected requests of its run, one for each' USING ERRCODE = '23514', CONSTRAINT = 'pickup_intake_set';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_intake_set_check() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_intake_set_check() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pickup_intake_set" AFTER INSERT ON "pickup_intake"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION melarc.pickup_intake_set_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pickup_manifest_intake_set" AFTER UPDATE OF state ON "pickup_manifest"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'COMPLETED' AND OLD.state IS DISTINCT FROM 'COMPLETED') EXECUTE FUNCTION melarc.pickup_intake_set_check();
--> statement-breakpoint
-- What the key of the handover reads and writes of the run it completes. The assigned rider reads its own dispatched run; the receiver of a custody handover that stands reads it too (melarc.receiver_stands,
-- 0067), so that the receiver who holds the parcels can hand them over. Nothing here is reached by any read operation: the keys of those are not this one.
CREATE POLICY "pickup_manifest_handover_read" ON "pickup_manifest" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit' AND (("pickup_manifest"."assigned_rider_id" = melarc.current_rider_id() AND "pickup_manifest"."dispatched_at" IS NOT NULL) OR melarc.receiver_stands("pickup_manifest"."id"))
    ELSE false
  END
);
--> statement-breakpoint
-- The lock of the run (select ... for update) is judged by the USING of this policy as well as by the read's, so it names the relation to the run and not its state: the run in any state is locked
-- and answered as it is (a run the system completed is a STATE_CONFLICT, not an absent run), as the rider's start is (0065). What the update may leave is the WITH CHECK's, and the guard holds the move.
CREATE POLICY "pickup_manifest_handover_settle" ON "pickup_manifest" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit' AND ("pickup_manifest"."assigned_rider_id" = melarc.current_rider_id() OR melarc.receiver_stands("pickup_manifest"."id"))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit' AND "pickup_manifest"."state" = 'COMPLETED' AND ("pickup_manifest"."assigned_rider_id" = melarc.current_rider_id() OR melarc.receiver_stands("pickup_manifest"."id"))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_handover_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit' AND EXISTS (SELECT 1 FROM "pickup_manifest" AS m WHERE m.id = "pickup_stop"."pickup_manifest_id")
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "collection_record_handover_read" ON "collection_record" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit' AND EXISTS (SELECT 1 FROM "pickup_stop" AS s WHERE s.id = "collection_record"."pickup_stop_id")
    ELSE false
  END
);
--> statement-breakpoint
-- OB-S1-44: the manifest's guard refuses the completion of a run over a custody handover that is pending only for a writer whose context can read the custody table, so the key of the hub handover is
-- given that read: the handovers the rider is a party to (the one that hands over, the one named to receive), as the other keys of a rider are.
CREATE POLICY "run_custody_handover_handover_read" ON "run_custody_handover" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit' AND ("run_custody_handover"."from_rider_id" = melarc.current_rider_id() OR "run_custody_handover"."to_rider_id" = melarc.current_rider_id())
    ELSE false
  END
);
--> statement-breakpoint
-- The hub's name, read by the key of the handover for the hub of a run it reads (the operational code of an intake begins with it: HUB-IN-XXXXXX, domain-model.md section 2). Reference data a rider reads for
-- this one purpose and no other.
CREATE POLICY "hub_handover_read" ON "hub" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit' AND EXISTS (SELECT 1 FROM "pickup_manifest" AS m WHERE m.responsible_hub_id = "hub"."id")
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a manifest as 0072 made it (the last definition), with one branch added: the key of the hub handover completes a run that collected something, by the custody holder (S1.31).
-- Nothing else of the function changes.
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
    -- handover, whose own key is the next branch's (S1.31): these keys do not complete it.
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
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit' THEN
    -- The completion by the hub handover (S1.31; state-machines.md section 4): the custody holder's own act. A run in progress, every stop terminal (above) and no custody handover pending (above:
    -- this key is given the read of the custody table, so the writer sees what is pending, OB-S1-44), something collected, the rider the one who holds the run's parcels (the assigned rider,
    -- or whoever accepted a custody handover: melarc.run_custody_holder), and the state and its moment written and nothing else. The intakes it opens are judged at the end of the transaction.
    IF OLD.state <> 'IN_PROGRESS' OR NEW.state <> 'COMPLETED' THEN
      RAISE EXCEPTION 'the hub handover completes a run in progress and does nothing else to a manifest' USING ERRCODE = '23514';
    END IF;
    IF NEW.completed_at IS NULL
       OR (to_jsonb(NEW) - 'state' - 'completed_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'completed_at' - 'version') THEN
      RAISE EXCEPTION 'the completion of a run changes its state and the moment of completion and nothing else' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pickup_stop s WHERE s.pickup_manifest_id = NEW.id AND s.state IN ('COLLECTED', 'PARTIALLY_COLLECTED')) THEN
      RAISE EXCEPTION 'a run with nothing collected is completed by the system, and never by a hub handover' USING ERRCODE = '23514';
    END IF;
    IF melarc.run_custody_holder(NEW.id) IS DISTINCT FROM melarc.current_rider_id() THEN
      RAISE EXCEPTION 'a run is completed by the one who holds its parcels' USING ERRCODE = '23514';
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
-- The ledger: a policy of its own, so that the arms of the ledger's insert policy (0072) are not restated for it (the policies of a table are alternatives, 0091). It admits two events to the rider under the key
-- of the handover and to no other writer, each bound to what the rows say: the handover (the run's completion and the intakes it opened, which the event names, in the order of their identifiers, and
-- the number of them) and the completion of the run by the custody holder's handover. Neither carries a count of parcels.
CREATE POLICY "audit_event_insert_hub_handover" ON "audit_event" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit'
      AND actor_type = 'RIDER' AND actor_id = melarc.current_principal_id() AND surface_context = 'RIDER_ANDROID' AND outcome = 'SUCCEEDED' AND enhanced = false
      AND object_type = 'PickupManifest'
      AND EXISTS (SELECT 1 FROM pickup_manifest AS m WHERE m.id = "audit_event"."object_id" AND m.state = 'COMPLETED' AND m.responsible_hub_id = "audit_event"."responsible_hub_id")
      AND (
        (event_code = 'hub.handover.submitted' AND previous_state IS NULL AND resulting_state IS NULL
          AND "audit_event"."related_ids" = jsonb_build_object(
                'pickup_manifest_id', "audit_event"."object_id"::text,
                'rider_id', melarc.current_rider_id()::text,
                'intake_ids', (SELECT coalesce(jsonb_agg(i.id::text ORDER BY i.id), '[]'::jsonb) FROM pickup_intake AS i WHERE i.pickup_manifest_id = "audit_event"."object_id" AND i.handed_over_by = melarc.current_rider_id()))
          AND "audit_event"."detail" = jsonb_build_object(
                'intakes_opened', (SELECT count(*) FROM pickup_intake AS i WHERE i.pickup_manifest_id = "audit_event"."object_id" AND i.handed_over_by = melarc.current_rider_id()))
          AND EXISTS (SELECT 1 FROM pickup_intake AS i WHERE i.pickup_manifest_id = "audit_event"."object_id" AND i.handed_over_by = melarc.current_rider_id()))
        OR (event_code = 'pickup.manifest.completed' AND previous_state = 'IN_PROGRESS' AND resulting_state = 'COMPLETED'
          AND "audit_event"."related_ids" = jsonb_build_object('rider_id', melarc.current_rider_id()::text)
          AND "audit_event"."detail" = jsonb_build_object('completed_by', 'CUSTODY_HOLDER', 'cause', 'HUB_HANDOVER')
          AND EXISTS (SELECT 1 FROM pickup_intake AS i WHERE i.pickup_manifest_id = "audit_event"."object_id" AND i.handed_over_by = melarc.current_rider_id()))
      )
    ELSE false
  END
);
