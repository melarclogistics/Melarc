CREATE TABLE "pickup_intake_finding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pickup_intake_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"condition" text,
	"outcome" text,
	"note" text,
	"evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "pickup_intake_finding_kind_closed" CHECK ("pickup_intake_finding"."kind" IN ('CONDITION', 'ADJUDICATION')),
	CONSTRAINT "pickup_intake_finding_condition_closed" CHECK ("pickup_intake_finding"."condition" IS NULL OR "pickup_intake_finding"."condition" IN ('OK', 'DAMAGED', 'TAMPERED', 'OTHER')),
	CONSTRAINT "pickup_intake_finding_outcome_closed" CHECK ("pickup_intake_finding"."outcome" IS NULL OR "pickup_intake_finding"."outcome" IN ('ACCEPTED', 'ESCALATED', 'WRITTEN_OFF', 'VENDOR_NOTIFIED')),
	CONSTRAINT "pickup_intake_finding_kind_facts" CHECK (("pickup_intake_finding"."kind" = 'CONDITION' AND "pickup_intake_finding"."condition" IS NOT NULL AND "pickup_intake_finding"."outcome" IS NULL) OR ("pickup_intake_finding"."kind" = 'ADJUDICATION' AND "pickup_intake_finding"."outcome" IS NOT NULL AND "pickup_intake_finding"."note" IS NOT NULL AND btrim("pickup_intake_finding"."note") <> '')),
	CONSTRAINT "pickup_intake_finding_evidence_required" CHECK ("pickup_intake_finding"."condition" IS NULL OR "pickup_intake_finding"."condition" NOT IN ('DAMAGED', 'TAMPERED') OR cardinality("pickup_intake_finding"."evidence_ids") >= 1)
);
--> statement-breakpoint
ALTER TABLE "pickup_intake_finding" ADD CONSTRAINT "pickup_intake_finding_intake_fkey" FOREIGN KEY ("pickup_intake_id") REFERENCES "public"."pickup_intake"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_intake_finding" ADD CONSTRAINT "pickup_intake_finding_hub_fkey" FOREIGN KEY ("responsible_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pickup_intake_finding_intake_idx" ON "pickup_intake_finding" USING btree ("pickup_intake_id","recorded_at");

--> statement-breakpoint
-- THE HAND-WRITTEN PART (S1.34). Everything above is generated (drizzle-kit, from src/hub/pickup-intake-finding.schema.ts): the table, its keys, its index and the checks that hold what each kind of finding
-- is. This migration is applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
-- S1.34 (SLICE-001): the condition, OS&D and adjudication (recordIntakeCondition, adjudicateDiscrepancy; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.34; features/hub/hub-intake.md sections 5.1 and
-- 5.2; contracts/state-machines.md section 7; AC-SLICE-001-41, -42 and -76; D-05, D-07, D-14). Forward of 0095; nothing earlier is edited. What this part does:
--
--   * THE FINDINGS ARE APPENDED AND NEVER CHANGED, for every writer (the guard below): the receiver's recording of a condition and Senior Ops's adjudication, each with the evidence it cites. The guard gives
--     the hub (the intake's) and the moment (the database's), and holds that the evidence is the intake's own, STORED, of the right purpose: "attached evidence" is never satisfiable by a record with no bytes
--     behind it. The application's login can read them and write none.
--   * TWO OPERATIONS OF THE DATABASE write them and move the intake, in the one change, as the owner: melarc.record_intake_condition (the receiver, under hub.intake.count) and
--     melarc.adjudicate_discrepancy (Senior Ops and the Platform Admin, under hub.osd.adjudicate; Ops Staff do not hold the key). Neither can change a count: the declared count, the hub count and the
--     variance survive every finding unchanged, and the guard of the intake holds it for every writer already (0092, 0094).
--   * THE ONE EDGE A CONDITION NEEDS. A clean count is cleared for itemization in its own change (0094), and the condition is recorded only after the count: a finding on a count that matched arrives when the
--     intake is READY_FOR_ITEMIZATION, and "the case routes to senior review" (AC-SLICE-001-41, -42) is READY_FOR_ITEMIZATION -> RECONCILIATION_REQUIRED, which the machine did not have. The guard (restated from
--     0094, the last definition, with only the edge and the rules of the condition added) holds it: only with a condition that is not OK, and a condition is found after the count and before itemization starts.
--   * WHO READS. The staff of the intake's hubs read findings under hub.read, hub.intake.count and hub.osd.adjudicate (a finding exists only after the count, so none carries what the blind count withholds).
--     The key of the adjudication reads the evidence of the intakes of its hubs that is stored, and its own; the others the declarer's own (0095).

ALTER TABLE "pickup_intake_finding" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "pickup_intake_finding" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pickup_intake_finding" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pickup_intake_finding_read" ON "pickup_intake_finding" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake_finding"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- Written by the two operations below as the owner and by nobody else: each key writes its own kind of finding, in the name of the staff member who acts, in the hubs of its grant.
CREATE POLICY "pickup_intake_finding_insert" ON "pickup_intake_finding" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner'
      AND (
        (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND "pickup_intake_finding"."kind" = 'CONDITION')
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate' AND "pickup_intake_finding"."kind" = 'ADJUDICATION')
      )
      AND "pickup_intake_finding"."recorded_by" = melarc.current_principal_id()
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake_finding"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ON "pickup_intake_finding" TO melarc_api_runtime;
--> statement-breakpoint
-- The key of the adjudication writes the intake as the owner, as the key of the count does (0094): the operation below moves it and sets its condition.
CREATE POLICY "pickup_intake_adjudicate" ON "pickup_intake" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The adjudication judges an intake under its lock (`select ... for update`, as the count does under the key of the count: 0093), so the key sees the row as one it may lock. The check is false: the key
-- writes nothing through this policy, and the login holds no column of the count or of the condition whatever a policy admits.
CREATE POLICY "pickup_intake_adjudicate_lock" ON "pickup_intake" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN false
    ELSE false
  END
);
--> statement-breakpoint
-- The evidence of an intake as the key of the adjudication reads it (0095 restated): every stored record of the hubs of its grant (it judges the receiver's photos as well as its own), and its own pending ones.
DROP POLICY "evidence_read_intake" ON "evidence";
--> statement-breakpoint
CREATE POLICY "evidence_read_intake" ON "evidence" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN "evidence"."owner_type" = 'PICKUP_INTAKE' AND "evidence"."responsible_hub_id" IS NOT NULL
      AND (melarc.hub_scope_mode() = 'ALL' OR "evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
      AND (
        coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.read'
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND "evidence"."captured_by_actor" = melarc.current_principal_id())
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate' AND ("evidence"."captured_by_actor" = melarc.current_principal_id() OR "evidence"."state" = 'STORED'))
      )
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a finding: appended and never changed or removed, and what the database holds of it for every writer.
CREATE FUNCTION melarc.pickup_intake_finding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  intake_hub uuid;
  intake_state text;
  cited integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'a finding is kept as it was and is never removed' USING ERRCODE = '23514';
  END IF;
  SELECT i.responsible_hub_id, i.state INTO intake_hub, intake_state FROM public.pickup_intake AS i WHERE i.id = NEW.pickup_intake_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a finding is about an intake' USING ERRCODE = '23514';
  END IF;
  IF intake_state = 'AWAITING_COUNT' THEN
    RAISE EXCEPTION 'a finding is made after the blind count has committed' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  -- The evidence is the intake's own and is stored, each once, of the purpose the finding's act has: the receiver's photos of a condition, and for an adjudication either kind (it judges the receiver's too).
  IF (SELECT pg_catalog.count(DISTINCT e) FROM pg_catalog.unnest(NEW.evidence_ids) AS e) <> pg_catalog.cardinality(NEW.evidence_ids) THEN
    RAISE EXCEPTION 'a finding cites each piece of evidence once' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
  END IF;
  SELECT pg_catalog.count(*) INTO cited FROM public.evidence AS v
   WHERE v.id = ANY (NEW.evidence_ids) AND v.state = 'STORED' AND v.owner_type = 'PICKUP_INTAKE' AND v.owner_id = NEW.pickup_intake_id
     AND v.responsible_hub_id = intake_hub
     AND v.purpose = ANY (CASE WHEN NEW.kind = 'CONDITION' THEN ARRAY['CONDITION'] ELSE ARRAY['CONDITION', 'OSD'] END);
  IF cited <> pg_catalog.cardinality(NEW.evidence_ids) THEN
    RAISE EXCEPTION 'a finding cites evidence that is stored and is the intake''s own' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
  END IF;
  -- The hub is the intake's and the moment is the database's, whatever the writer gave.
  NEW.responsible_hub_id := intake_hub;
  NEW.recorded_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_intake_finding_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_intake_finding_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pickup_intake_finding_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pickup_intake_finding"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_intake_finding_guard();
--> statement-breakpoint
-- The guard of an intake as 0094 made it (the last definition), with the edge a condition needs and the rules of the condition added (S1.34). Nothing else of the function changes.
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
       OR (OLD.state = 'READY_FOR_ITEMIZATION' AND NEW.state = 'RECONCILIATION_REQUIRED')
       OR (OLD.state = 'READY_FOR_ITEMIZATION' AND NEW.state = 'ITEMIZING')
       OR (OLD.state = 'ITEMIZING' AND NEW.state = 'CLOSED')
       OR (OLD.state = 'CLOSED' AND NEW.state = 'ITEMIZING')
     ) THEN
    RAISE EXCEPTION 'an intake moves from AWAITING_COUNT to COUNTED, from COUNTED to READY_FOR_ITEMIZATION or RECONCILIATION_REQUIRED, from RECONCILIATION_REQUIRED to READY_FOR_ITEMIZATION and back when a condition is found, then to ITEMIZING and CLOSED, and a closed one is reopened to ITEMIZING, and no other way' USING ERRCODE = '23514';
  END IF;

  -- The count (S1.33; state-machines.md section 7). The comparison is the database's, for every writer: the difference is the physical count minus the declaration, the variance says which side
  -- of it the count is on, and the moment is the database's, whatever the writer gave. A count that has no comparison, or one that is not this one, is refused.
  IF OLD.physical_count IS NULL AND NEW.physical_count IS NOT NULL THEN
    IF NEW.count_difference IS DISTINCT FROM NEW.physical_count - OLD.rider_declared_count
       OR NEW.count_variance IS DISTINCT FROM (
         CASE WHEN NEW.physical_count = OLD.rider_declared_count THEN 'MATCH'
              WHEN NEW.physical_count < OLD.rider_declared_count THEN 'SHORT'
              ELSE 'OVER' END) THEN
      RAISE EXCEPTION 'a count is compared with the declaration by the database: its difference and its variance are that comparison' USING ERRCODE = '23514';
    END IF;
    NEW.counted_at := pg_catalog.clock_timestamp();
  END IF;
  -- The System's move out of COUNTED: a count with a variance, a zero declaration or a finding of condition goes to reconciliation and is not cleared for itemization; a clean one is cleared and is
  -- not sent to reconciliation.
  IF OLD.state = 'COUNTED' AND NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.count_variance IS DISTINCT FROM 'MATCH' OR OLD.rider_declared_count = 0 OR OLD.condition <> 'OK' THEN
      IF NEW.state = 'READY_FOR_ITEMIZATION' THEN
        RAISE EXCEPTION 'a count with a variance, a zero declaration or a finding is not cleared for itemization' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.state = 'RECONCILIATION_REQUIRED' THEN
      RAISE EXCEPTION 'a clean count is not sent to reconciliation' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- The condition (S1.34; state-machines.md section 7). It is found after the count and before itemization starts, for every writer: an intake that is waiting for its count, or that is being itemized or
  -- is closed, keeps the condition it has. An intake cleared for itemization goes back to reconciliation only with a condition that is not OK (the finding that sends it): the case then routes to Senior Ops.
  IF NEW.condition IS DISTINCT FROM OLD.condition AND OLD.state NOT IN ('READY_FOR_ITEMIZATION', 'RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'a condition is found after the count and before itemization starts' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'READY_FOR_ITEMIZATION' AND NEW.state = 'RECONCILIATION_REQUIRED' AND NEW.condition = 'OK' THEN
    RAISE EXCEPTION 'an intake cleared for itemization goes back to reconciliation for a condition that is not OK' USING ERRCODE = '23514';
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
-- melarc.record_intake_condition: `recordIntakeCondition`. The receiver of the intake's hub, under the key of the count, records a condition after the count and before itemization starts, once: an intake that
-- is waiting for its count, that is being itemized or is closed, and one whose condition is recorded already, are refused. DAMAGED and TAMPERED carry stored evidence of the intake (REASON_REQUIRED when none,
-- EVIDENCE_NOT_STORED by the guard of the finding). A condition that is not OK sets the intake's condition and, for an intake cleared for itemization, sends it back to reconciliation (the case routes to Senior Ops);
-- OK is a finding and changes nothing. It answers the state the intake was in and the state it is in.
CREATE FUNCTION melarc.record_intake_condition(p_intake uuid, p_finding uuid, p_condition text, p_note text, p_evidence uuid[])
RETURNS TABLE (previous_state text, resulting_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  next_state text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.count' THEN
    RAISE EXCEPTION 'a condition is recorded by a receiver of the hub holding the key of the count, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake IS NULL OR p_finding IS NULL OR p_condition IS NULL OR p_condition NOT IN ('OK', 'DAMAGED', 'TAMPERED', 'OTHER') THEN
    RAISE EXCEPTION 'a condition names an intake and is one of OK, DAMAGED, TAMPERED and OTHER' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the receiver''s hubs' USING ERRCODE = '42501';
  END IF;
  IF held.state NOT IN ('READY_FOR_ITEMIZATION', 'RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'a condition is recorded after the count and before itemization starts' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  IF held.condition <> 'OK' THEN
    RAISE EXCEPTION 'a condition is recorded once: the one that was found stands until it is adjudicated' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  IF p_condition IN ('DAMAGED', 'TAMPERED') AND coalesce(pg_catalog.cardinality(p_evidence), 0) = 0 THEN
    RAISE EXCEPTION 'a condition of damage or tampering carries supporting evidence' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  INSERT INTO public.pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, kind, condition, note, evidence_ids, recorded_by)
  VALUES (p_finding, p_intake, held.responsible_hub_id, 'CONDITION', p_condition, nullif(pg_catalog.btrim(p_note), ''), coalesce(p_evidence, ARRAY[]::uuid[]), melarc.current_principal_id());
  next_state := CASE WHEN p_condition <> 'OK' AND held.state = 'READY_FOR_ITEMIZATION' THEN 'RECONCILIATION_REQUIRED' ELSE held.state END;
  IF p_condition <> 'OK' THEN
    UPDATE public.pickup_intake SET condition = p_condition, state = next_state WHERE id = p_intake;
  END IF;
  RETURN QUERY SELECT held.state, next_state;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.record_intake_condition(uuid, uuid, text, text, uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.record_intake_condition(uuid, uuid, text, text, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.record_intake_condition(uuid, uuid, text, text, uuid[]) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.adjudicate_discrepancy: `adjudicateDiscrepancy`. Senior Ops (and the Platform Admin), under the key of the adjudication, adjudicates an intake that is in reconciliation, with a reason in words (there is no
-- reason catalogue for it, D-05; REASON_REQUIRED when blank): ACCEPTED, WRITTEN_OFF and VENDOR_NOTIFIED resolve the case and clear the intake for itemization, ESCALATED records the act and leaves the case open.
-- A condition given sets the intake's condition (DAMAGED and TAMPERED carry stored evidence of the intake). It changes no count: the declared count, the hub count and the variance survive it unchanged.
CREATE FUNCTION melarc.adjudicate_discrepancy(p_intake uuid, p_finding uuid, p_outcome text, p_condition text, p_note text, p_evidence uuid[])
RETURNS TABLE (previous_state text, resulting_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  next_state text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.osd.adjudicate' THEN
    RAISE EXCEPTION 'a discrepancy is adjudicated by Senior Ops holding the key of the adjudication, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake IS NULL OR p_finding IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('ACCEPTED', 'ESCALATED', 'WRITTEN_OFF', 'VENDOR_NOTIFIED')
     OR (p_condition IS NOT NULL AND p_condition NOT IN ('OK', 'DAMAGED', 'TAMPERED', 'OTHER')) THEN
    RAISE EXCEPTION 'an adjudication names an intake and an outcome, and a condition that is one of OK, DAMAGED, TAMPERED and OTHER' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NULL OR pg_catalog.btrim(p_note) = '' THEN
    RAISE EXCEPTION 'an adjudication says why' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the adjudicator''s hubs' USING ERRCODE = '42501';
  END IF;
  IF held.state <> 'RECONCILIATION_REQUIRED' THEN
    RAISE EXCEPTION 'only an intake in reconciliation is adjudicated' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  IF p_condition IN ('DAMAGED', 'TAMPERED') AND coalesce(pg_catalog.cardinality(p_evidence), 0) = 0 THEN
    RAISE EXCEPTION 'a condition of damage or tampering carries supporting evidence' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  INSERT INTO public.pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, kind, condition, outcome, note, evidence_ids, recorded_by)
  VALUES (p_finding, p_intake, held.responsible_hub_id, 'ADJUDICATION', p_condition, p_outcome, pg_catalog.btrim(p_note), coalesce(p_evidence, ARRAY[]::uuid[]), melarc.current_principal_id());
  next_state := CASE WHEN p_outcome = 'ESCALATED' THEN held.state ELSE 'READY_FOR_ITEMIZATION' END;
  IF p_condition IS NOT NULL OR next_state <> held.state THEN
    UPDATE public.pickup_intake SET condition = coalesce(p_condition, condition), state = next_state WHERE id = p_intake;
  END IF;
  RETURN QUERY SELECT held.state, next_state;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.adjudicate_discrepancy(uuid, uuid, text, text, text, uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.adjudicate_discrepancy(uuid, uuid, text, text, text, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.adjudicate_discrepancy(uuid, uuid, text, text, text, uuid[]) TO melarc_api_runtime;
--> statement-breakpoint
-- What a counted intake carries beyond the columns the login can read (0094), for the key of the adjudication as well: Senior Ops adjudicates an intake it reads as it is (its ETag is the digest of the representation
-- the read returned, the declaration and the photos included). The function of 0094 restated with the one key added, and the two policies it reads through, the stop's and the photo links', restated with it.
CREATE OR REPLACE FUNCTION melarc.hub_intake_after_count(p_intake_ids uuid[]) RETURNS TABLE (intake_id uuid, rider_declared_count integer, parcel_photo_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate') THEN
    RAISE EXCEPTION 'the declaration of a counted intake is read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT i.id, i.rider_declared_count,
           coalesce(
             (SELECT pg_catalog.array_agg(p.evidence_id ORDER BY p.attached_at, p.evidence_id)
                FROM public.pickup_stop AS s
                JOIN public.collection_parcel_photo AS p ON p.pickup_stop_id = s.id
               WHERE s.pickup_manifest_id = i.pickup_manifest_id AND s.pickup_request_id = i.pickup_request_id),
             ARRAY[]::uuid[])
      FROM public.pickup_intake AS i
     WHERE i.id = ANY (p_intake_ids) AND i.state <> 'AWAITING_COUNT' AND i.physical_count IS NOT NULL
     ORDER BY i.id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.hub_intake_after_count(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.hub_intake_after_count(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.hub_intake_after_count(uuid[]) TO melarc_api_runtime;
--> statement-breakpoint
DROP POLICY "pickup_stop_intake_read" ON "pickup_stop";
--> statement-breakpoint
CREATE POLICY "pickup_stop_intake_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
DROP POLICY "collection_parcel_photo_intake_read" ON "collection_parcel_photo";
--> statement-breakpoint
CREATE POLICY "collection_parcel_photo_intake_read" ON "collection_parcel_photo" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "collection_parcel_photo"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
