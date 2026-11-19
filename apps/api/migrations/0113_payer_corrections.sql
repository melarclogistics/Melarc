-- S1.39: THE PAYER CORRECTION AFTER THE PRICE FROZE, AND THE PAYER EDIT BEFORE IT (itemization.md section 5.1 step 6; state-machines.md section 8; AC-SLICE-001-55).
--
--   * payer_correction IS THE MAKER-CHECKER RECORD. One open request for an order (a partial unique index); previous allocation, proposed intent and, once approved, the resulting allocation and commercial state, so that the
--     before and after are complete; a decided row is never changed. It is written only by melarc.request_payer_correction (key pricing.correction.create) and melarc.decide_payer_correction (key
--     pricing.correction.approve), and its guard holds the rules for every writer: the maker is the officer who acts and the order is frozen; the approver is the officer who acts and is not the maker, unless the
--     approver is a Platform Admin (a setting of the transaction that the service sets from the tier of the grant, as the repository's other transaction-scoped facts are).
--   * THE LOCKED PRICE IS NEVER REWRITTEN; ITS PORTIONS MOVE ONLY BY AN APPROVED CORRECTION. The guard of the order (restated from 0111) lets the payer allocation change only to the allocation that a correction decided
--     in this very transaction wrote, for the same order, with the commercial gate re-run from the new portions (zero tested first: NO_VENDOR_CHARGE, else PAYMENT_REQUIRED; D-12 builds no reservation to adjust).
--   * THE PAYER EDIT BEFORE THE FREEZE (amendPickupRequest) is melarc.amend_request_payer: the request's default arrangement, for a vendor's own PENDING request and for Ops's PENDING or CONFIRMED request whose run has
--     not started, and never once any order of the request's intake is frozen (STATE_CONFLICT, rule price_frozen: after the freeze the same edit is a correction).

CREATE TABLE "payer_correction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"state" text DEFAULT 'REQUESTED' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"previous_allocation" jsonb NOT NULL,
	"proposed" jsonb NOT NULL,
	"resulting_allocation" jsonb,
	"resulting_commercial_state" text,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payer_correction_state_closed" CHECK ("payer_correction"."state" IN ('REQUESTED', 'APPROVED', 'REJECTED')),
	CONSTRAINT "payer_correction_decision_facts" CHECK (("payer_correction"."state" = 'REQUESTED' AND "payer_correction"."decided_by" IS NULL AND "payer_correction"."decided_at" IS NULL AND "payer_correction"."resulting_allocation" IS NULL AND "payer_correction"."resulting_commercial_state" IS NULL)
       OR ("payer_correction"."state" = 'APPROVED' AND "payer_correction"."decided_by" IS NOT NULL AND "payer_correction"."decided_at" IS NOT NULL AND "payer_correction"."resulting_allocation" IS NOT NULL AND "payer_correction"."resulting_commercial_state" IS NOT NULL)
       OR ("payer_correction"."state" = 'REJECTED' AND "payer_correction"."decided_by" IS NOT NULL AND "payer_correction"."decided_at" IS NOT NULL AND "payer_correction"."resulting_allocation" IS NULL AND "payer_correction"."resulting_commercial_state" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "payer_correction" ADD CONSTRAINT "payer_correction_order_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payer_correction_open_key" ON "payer_correction" USING btree ("order_id") WHERE "payer_correction"."state" = 'REQUESTED';--> statement-breakpoint
CREATE INDEX "payer_correction_order_idx" ON "payer_correction" USING btree ("order_id","created_at");
--> statement-breakpoint
ALTER TABLE "payer_correction" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "payer_correction" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payer_correction" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "payer_correction" TO melarc_api_runtime;
--> statement-breakpoint
-- The reads and writes of the correction: staff of the hub under the keys of the maker and of the checker; the owner writes under the key of the act.
CREATE POLICY "payer_correction_read" ON "payer_correction" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pricing.correction.create', 'pricing.correction.approve')
      AND (melarc.hub_scope_mode() = 'ALL' OR "payer_correction"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "payer_correction_probe" ON "payer_correction" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
--> statement-breakpoint
CREATE POLICY "payer_correction_insert" ON "payer_correction" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pricing.correction.create'
      AND (melarc.hub_scope_mode() = 'ALL' OR "payer_correction"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "payer_correction_decide" ON "payer_correction" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pricing.correction.approve'
      AND (melarc.hub_scope_mode() = 'ALL' OR "payer_correction"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pricing.correction.approve'
      AND (melarc.hub_scope_mode() = 'ALL' OR "payer_correction"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- What the keys of the correction read of an order and of its parcel, so that the order's ETag is recomputed as getOrder gives it, and the one write of the checker: the allocation and the state of the order. The maker's
-- key may lock the order (a lock is an UPDATE for a row-level policy) and changes nothing of it: the guard of the order lets the allocation move only by an approved correction.
CREATE POLICY "order_correction_read" ON "order" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pricing.correction.create', 'pricing.correction.approve')
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "intake_parcel_correction_read" ON "intake_parcel" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pricing.correction.create', 'pricing.correction.approve')
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "order_correction_update" ON "order" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('pricing.correction.create', 'pricing.correction.approve')
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('pricing.correction.create', 'pricing.correction.approve')
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The edit before the freeze reads, as the owner, the request, what holds it on a run and the intake's orders, and writes the request, under the key that creates one: a vendor's own, Ops's in the hubs of the grant.
CREATE POLICY "pickup_request_amend_read" ON "pickup_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_request"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND "pickup_request"."vendor_organization_id" = melarc.current_vendor_organization_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_request_amend" ON "pickup_request" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_request"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND "pickup_request"."vendor_organization_id" = melarc.current_vendor_organization_id()
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_request"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND "pickup_request"."vendor_organization_id" = melarc.current_vendor_organization_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_intake_amend_read" ON "pickup_intake" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND EXISTS (SELECT 1 FROM "pickup_request" AS r WHERE r.id = "pickup_intake"."pickup_request_id" AND r.vendor_organization_id = melarc.current_vendor_organization_id())
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "order_amend_read" ON "order" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND "order"."vendor_organization_id" = melarc.current_vendor_organization_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_amend_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_manifest_amend_read" ON "pickup_manifest" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The ledger: a policy of its own beside the arms of the insert policy (the policies of a table are alternatives), so that the arms are not restated for it. It admits the event of the edit to the vendor that made it, under
-- the key that creates a request, for its own organisation's request, and to no other writer.
CREATE POLICY "audit_event_insert_payer_edit" ON "audit_event" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'VENDOR' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.create'
      AND actor_type = 'VENDOR_ACCOUNT' AND actor_id = melarc.current_principal_id() AND surface_context = 'VENDOR_PWA'
      AND event_code = 'pickup.request.amended' AND object_type = 'PickupRequest' AND vendor_organization_id = melarc.current_vendor_organization_id()
      AND outcome = 'SUCCEEDED' AND enhanced = false
    ELSE false
  END
);
--> statement-breakpoint
-- THE GUARD OF THE ORDER, restated from 0111: the payer allocation moves only to the allocation that a payer correction decided in this transaction wrote, with the commercial gate re-run from it.
CREATE OR REPLACE FUNCTION melarc.order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  intake public.pickup_intake%ROWTYPE;
  parcel public.intake_parcel%ROWTYPE;
  request public.pickup_request%ROWTYPE;
  first_origin jsonb;
  cited uuid[];
  stored integer;
  summed bigint;
  components jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an order is never removed' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO intake FROM public.pickup_intake AS i WHERE i.id = NEW.pickup_intake_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an order is made for an intake' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO request FROM public.pickup_request AS r WHERE r.id = intake.pickup_request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an order is made for the request its intake was opened for' USING ERRCODE = '23514';
    END IF;
    -- The hub, the sender and the moment are the intake's, the request's and the database's, whatever the writer gave.
    NEW.responsible_hub_id := intake.responsible_hub_id;
    NEW.vendor_organization_id := request.vendor_organization_id;
    NEW.ad_hoc_sender_id := request.ad_hoc_sender_id;
    NEW.created_at := pg_catalog.clock_timestamp();
    NEW.version := 1;
    IF NEW.commercial_state IS NOT NULL OR NEW.locked_price_minor IS NOT NULL OR NEW.locked_at IS NOT NULL OR NEW.payer_allocation IS NOT NULL THEN
      RAISE EXCEPTION 'an order is made unfrozen: its price is frozen by a later act of the database, when its parcel has arrived' USING ERRCODE = '23514';
    END IF;
    IF NEW.fulfilment_state <> 'AWAITING_RECIPIENT_CONFIRMATION' OR NEW.delivery_attempt_count <> 0 OR NEW.delivery_date_override IS NOT NULL THEN
      RAISE EXCEPTION 'an order begins at the beginning of its life' USING ERRCODE = '23514';
    END IF;

    -- The parcel and the intake. A checked-in intake's order is made for one of its parcels; a blind-count intake has none.
    IF intake.receiving_mode = 'PHOTO_CHECK_IN' THEN
      IF NEW.intake_parcel_id IS NULL THEN
        RAISE EXCEPTION 'an order of an intake that is checked in against door photos is made for one of its parcels' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=parcel_required';
      END IF;
      SELECT * INTO parcel FROM public.intake_parcel AS p WHERE p.id = NEW.intake_parcel_id AND p.pickup_intake_id = NEW.pickup_intake_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'an order is made for a parcel of its own intake' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=unknown_parcel';
      END IF;
      IF parcel.state = 'VOID' THEN
        RAISE EXCEPTION 'a parcel taken back has no order' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_void';
      END IF;
      IF parcel.state = 'MISSING' THEN
        RAISE EXCEPTION 'a parcel that is missing is never priced or dispatched' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_missing';
      END IF;
      IF EXISTS (SELECT 1 FROM public."order" AS o WHERE o.intake_parcel_id = NEW.intake_parcel_id) THEN
        RAISE EXCEPTION 'a parcel has one order' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_ordered';
      END IF;
      IF parcel.state = 'EXPECTED' AND intake.state <> 'AWAITING_COUNT' THEN
        RAISE EXCEPTION 'an order for a parcel that has not been checked in waits for it while the vendor''s check-in is open' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_finished';
      END IF;
      IF parcel.state = 'ARRIVED' AND intake.state NOT IN ('READY_FOR_ITEMIZATION', 'ITEMIZING') THEN
        RAISE EXCEPTION 'an order for a parcel that has arrived is made once the vendor''s check-in is finished and cleared' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT',
          HINT = CASE intake.state WHEN 'AWAITING_COUNT' THEN 'rule=check_in_open' WHEN 'RECONCILIATION_REQUIRED' THEN 'rule=reconciliation_open' ELSE 'rule=intake_not_ready' END;
      END IF;
    ELSE
      IF NEW.intake_parcel_id IS NOT NULL THEN
        RAISE EXCEPTION 'an intake that is counted blind has no parcel to make an order for' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=parcel_not_allowed';
      END IF;
      IF intake.state NOT IN ('READY_FOR_ITEMIZATION', 'ITEMIZING') THEN
        RAISE EXCEPTION 'an order is made once the intake is counted and cleared for itemization' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT',
          HINT = CASE intake.state WHEN 'AWAITING_COUNT' THEN 'rule=intake_not_counted' WHEN 'RECONCILIATION_REQUIRED' THEN 'rule=reconciliation_open' ELSE 'rule=intake_not_ready' END;
      END IF;
    END IF;

    -- The evidence: each piece cited once, stored, the intake's own and of the purpose of an itemization, in the intake's hub: "attached evidence" is never satisfied by a record with no bytes behind it.
    cited := NEW.high_value_evidence_ids || CASE WHEN NEW.carrier_waybill_evidence_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[NEW.carrier_waybill_evidence_id] END;
    IF pg_catalog.cardinality(cited) > 0 THEN
      IF (SELECT pg_catalog.count(DISTINCT e) FROM pg_catalog.unnest(cited) AS e) <> pg_catalog.cardinality(cited) THEN
        RAISE EXCEPTION 'an order cites each piece of evidence once' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=evidence_once';
      END IF;
      SELECT pg_catalog.count(*) INTO stored FROM public.evidence AS v
       WHERE v.id = ANY (cited) AND v.state = 'STORED' AND v.owner_type = 'PICKUP_INTAKE' AND v.owner_id = NEW.pickup_intake_id
         AND v.responsible_hub_id = intake.responsible_hub_id AND v.purpose = 'ITEMIZATION';
      IF stored <> pg_catalog.cardinality(cited) THEN
        RAISE EXCEPTION 'an order cites evidence that is stored and is the intake''s own' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
      END IF;
    END IF;

    -- The origin zone is the request's, resolved once: every order of an intake carries the same (AC-SLICE-001-57).
    SELECT o.origin_zone_snapshot INTO first_origin FROM public."order" AS o WHERE o.pickup_intake_id = NEW.pickup_intake_id ORDER BY o.created_at, o.id LIMIT 1;
    IF FOUND AND first_origin IS DISTINCT FROM NEW.origin_zone_snapshot THEN
      RAISE EXCEPTION 'the origin zone is the request''s, resolved once: every order of an intake carries the same' USING ERRCODE = '23514';
    END IF;

    -- The price as calculated: its components name the hub of the order and add up to its total.
    components := NEW.price_components_snapshot -> 'components';
    IF pg_catalog.jsonb_typeof(components) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(components) = 0
       OR (NEW.price_components_snapshot ->> 'total_minor') IS NULL OR (NEW.price_components_snapshot ->> 'total_minor') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'a price is a total and the components it is made of' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(components) AS c
       WHERE (c ->> 'amount_minor') IS NULL OR (c ->> 'amount_minor') !~ '^[0-9]+$' OR (c ->> 'hub_id') IS DISTINCT FROM intake.responsible_hub_id::text
    ) THEN
      RAISE EXCEPTION 'every component of a price names its amount and the hub of the order' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(pg_catalog.sum((c ->> 'amount_minor')::bigint), 0) INTO summed FROM pg_catalog.jsonb_array_elements(components) AS c;
    IF summed <> (NEW.price_components_snapshot ->> 'total_minor')::bigint THEN
      RAISE EXCEPTION 'the components of a price add up to its total' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- An update. So far an order takes one change: the freeze of its price. Nothing else about it is moved.
  IF (pg_catalog.to_jsonb(NEW) - 'version' - 'locked_price_minor' - 'locked_at' - 'payer_allocation' - 'commercial_state')
     IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'version' - 'locked_price_minor' - 'locked_at' - 'payer_allocation' - 'commercial_state') THEN
    RAISE EXCEPTION 'an order is kept as it was: the freeze of its price is the one change it takes so far' USING ERRCODE = '23514';
  END IF;
  IF OLD.locked_at IS NOT NULL THEN
    IF NEW.locked_price_minor IS DISTINCT FROM OLD.locked_price_minor OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
      RAISE EXCEPTION 'a locked price is never rewritten: a correction is a linked adjustment' USING ERRCODE = '23514';
    END IF;
    IF NEW.payer_allocation IS DISTINCT FROM OLD.payer_allocation THEN
      -- The portions of a locked price move only to what a payer correction decided in this very transaction wrote, for this order, with the commercial gate re-run from the new portions: the zero branch first.
      IF NOT EXISTS (
        SELECT 1 FROM public.payer_correction AS c
         WHERE c.order_id = NEW.id AND c.state = 'APPROVED' AND c.decided_at = pg_catalog.transaction_timestamp()
           AND c.resulting_allocation = NEW.payer_allocation AND c.resulting_commercial_state IS NOT DISTINCT FROM NEW.commercial_state
      ) THEN
        RAISE EXCEPTION 'the portions of a locked price change only by a payer correction that was approved' USING ERRCODE = '23514';
      END IF;
      IF OLD.commercial_state IS NULL OR OLD.commercial_state NOT IN ('NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED') THEN
        RAISE EXCEPTION 'the portions of a price that has been paid for or reserved are not corrected here' USING ERRCODE = '23514';
      END IF;
      IF (NEW.payer_allocation ->> 'sender_minor') IS NULL OR (NEW.payer_allocation ->> 'sender_minor') !~ '^[0-9]+$'
         OR (NEW.payer_allocation ->> 'recipient_minor') IS NULL OR (NEW.payer_allocation ->> 'recipient_minor') !~ '^[0-9]+$'
         OR (NEW.payer_allocation ->> 'sender_minor')::bigint + (NEW.payer_allocation ->> 'recipient_minor')::bigint <> NEW.locked_price_minor THEN
        RAISE EXCEPTION 'the portions of the locked price add up to it' USING ERRCODE = '23514';
      END IF;
      IF NEW.commercial_state IS DISTINCT FROM (CASE WHEN (NEW.payer_allocation ->> 'sender_minor')::bigint = 0 THEN 'NO_VENDOR_CHARGE' ELSE 'PAYMENT_REQUIRED' END) THEN
        RAISE EXCEPTION 'the commercial gate is re-run from the new portions: zero is NO_VENDOR_CHARGE, above zero is PAYMENT_REQUIRED' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.commercial_state IS DISTINCT FROM OLD.commercial_state THEN
      -- The commercial gate: made once, from PRICED, by the resolved vendor portion alone (zero is tested first and reads nothing of the account), to one of the two outcomes D-12 leaves.
      IF OLD.commercial_state IS DISTINCT FROM 'PRICED' THEN
        RAISE EXCEPTION 'the commercial gate is run once, from PRICED' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=gate_already_run';
      END IF;
      IF (OLD.payer_allocation ->> 'sender_minor')::bigint = 0 THEN
        IF NEW.commercial_state IS DISTINCT FROM 'NO_VENDOR_CHARGE' THEN
          RAISE EXCEPTION 'a resolved vendor portion of zero is NO_VENDOR_CHARGE' USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.commercial_state IS DISTINCT FROM 'PAYMENT_REQUIRED' THEN
        RAISE EXCEPTION 'a vendor portion above zero, with no allowance to reserve it against, is PAYMENT_REQUIRED' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.locked_price_minor IS NULL THEN
    RETURN NEW;
  END IF;

  -- The freeze.
  SELECT * INTO intake FROM public.pickup_intake AS i WHERE i.id = OLD.pickup_intake_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an order is frozen for an intake the officer''s hubs show' USING ERRCODE = '23514';
  END IF;
  IF OLD.intake_parcel_id IS NOT NULL THEN
    SELECT * INTO parcel FROM public.intake_parcel AS p WHERE p.id = OLD.intake_parcel_id;
    IF NOT FOUND OR parcel.state <> 'ARRIVED' THEN
      RAISE EXCEPTION 'an order is frozen once its parcel has arrived' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_not_arrived';
    END IF;
  END IF;
  IF intake.state = 'AWAITING_COUNT' THEN
    RAISE EXCEPTION 'an order is frozen once the vendor''s check-in is finished: a parcel tapped while it is open can still be taken back' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_open';
  END IF;
  IF NEW.commercial_state IS DISTINCT FROM 'PRICED' THEN
    RAISE EXCEPTION 'a frozen order enters its commercial machine at PRICED' USING ERRCODE = '23514';
  END IF;
  IF NEW.locked_price_minor IS DISTINCT FROM (OLD.price_components_snapshot ->> 'total_minor')::integer THEN
    RAISE EXCEPTION 'the locked price is the price that was calculated' USING ERRCODE = '23514';
  END IF;
  IF (NEW.payer_allocation ->> 'sender_minor') IS NULL OR (NEW.payer_allocation ->> 'sender_minor') !~ '^[0-9]+$'
     OR (NEW.payer_allocation ->> 'recipient_minor') IS NULL OR (NEW.payer_allocation ->> 'recipient_minor') !~ '^[0-9]+$'
     OR (NEW.payer_allocation ->> 'sender_minor')::bigint + (NEW.payer_allocation ->> 'recipient_minor')::bigint <> NEW.locked_price_minor THEN
    RAISE EXCEPTION 'the portions of the locked price add up to it' USING ERRCODE = '23514';
  END IF;
  NEW.locked_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_guard() FROM PUBLIC;
--> statement-breakpoint
-- The portion of a locked price the sender pays, for an intent and the numbers that go with it (the arithmetic of the freeze: a percentage rounds to the pesewa, half up, on the sender's side; a fixed amount is never
-- more than the price).
CREATE FUNCTION melarc.payer_portion(p_total integer, p_proposed jsonb) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_proposed ->> 'payer_intent'
    WHEN 'RECIPIENT_PAYS' THEN 0
    WHEN 'SENDER_PAYS_FULL' THEN p_total
    WHEN 'SPLIT' THEN CASE p_proposed ->> 'split_basis'
      WHEN 'FIXED_AMOUNT' THEN LEAST((p_proposed ->> 'split_sender_amount_minor')::integer, p_total)
      WHEN 'PERCENTAGE' THEN LEAST(p_total, GREATEST(0, pg_catalog.round(p_total::numeric * (p_proposed ->> 'split_sender_percentage')::numeric / 100)::integer))
    END
  END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.payer_portion(integer, jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.payer_portion(integer, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.payer_portion(integer, jsonb) TO melarc_api_runtime;
--> statement-breakpoint
-- THE GUARD OF A CORRECTION, for every writer.
CREATE FUNCTION melarc.payer_correction_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  act_key text := coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '');
  ord public."order"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payer correction is never removed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF act_key <> 'pricing.correction.create' THEN
      RAISE EXCEPTION 'a payer correction is requested by the officer who holds the key of the maker' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO ord FROM public."order" AS o WHERE o.id = NEW.order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a payer correction is for an order of the officer''s hubs' USING ERRCODE = '23514';
    END IF;
    IF ord.locked_at IS NULL THEN
      RAISE EXCEPTION 'a payer correction is for an order whose price is frozen: before it, the arrangement of the request is edited' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_not_frozen';
    END IF;
    IF ord.commercial_state NOT IN ('NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED') THEN
      RAISE EXCEPTION 'a payer correction is for an order that has not been paid for or reserved' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_not_correctable';
    END IF;
    IF NEW.state <> 'REQUESTED' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a payer correction begins as a request' USING ERRCODE = '23514';
    END IF;
    IF NEW.requested_by IS DISTINCT FROM melarc.current_principal_id() THEN
      RAISE EXCEPTION 'a payer correction is requested in the name of the officer who asks' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.payer_correction AS c WHERE c.order_id = NEW.order_id AND c.state = 'REQUESTED') THEN
      RAISE EXCEPTION 'an order has one open payer correction at a time' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=correction_open';
    END IF;
    NEW.responsible_hub_id := ord.responsible_hub_id;
    NEW.previous_allocation := ord.payer_allocation;
    NEW.created_at := pg_catalog.clock_timestamp();
    NEW.version := 1;
    RETURN NEW;
  END IF;
  -- A decision: from REQUESTED to APPROVED or REJECTED, by the checker, once; nothing else of the row moves.
  IF OLD.state <> 'REQUESTED' THEN
    RAISE EXCEPTION 'a decided payer correction is kept as it was' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=already_decided';
  END IF;
  IF NEW.state NOT IN ('APPROVED', 'REJECTED') OR act_key <> 'pricing.correction.approve' THEN
    RAISE EXCEPTION 'a payer correction is decided by the officer who holds the key of the checker' USING ERRCODE = '23514';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - 'state' - 'decided_by' - 'decided_at' - 'resulting_allocation' - 'resulting_commercial_state' - 'version')
     IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'state' - 'decided_by' - 'decided_at' - 'resulting_allocation' - 'resulting_commercial_state' - 'version') THEN
    RAISE EXCEPTION 'a decision changes the state, the decider, the moment and what it wrote, and nothing else' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_by IS DISTINCT FROM melarc.current_principal_id() THEN
    RAISE EXCEPTION 'a payer correction is decided in the name of the officer who decides' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_by = OLD.requested_by AND coalesce(pg_catalog.current_setting('melarc.platform_admin_decision', true), '') <> 'on' THEN
    RAISE EXCEPTION 'the approver of a payer correction is not its requester, unless a Platform Admin' USING ERRCODE = '23514', DETAIL = 'reason=SELF_APPROVAL_FORBIDDEN', HINT = 'rule=self_approval';
  END IF;
  NEW.decided_at := pg_catalog.transaction_timestamp();
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.payer_correction_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.payer_correction_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "payer_correction_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payer_correction"
  FOR EACH ROW EXECUTE FUNCTION melarc.payer_correction_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.payer_correction_version() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (pg_catalog.to_jsonb(NEW) - 'version') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'version') THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.payer_correction_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.payer_correction_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "payer_correction_version" BEFORE UPDATE ON "payer_correction"
  FOR EACH ROW EXECUTE FUNCTION melarc.payer_correction_version();
--> statement-breakpoint
-- REQUESTING A CORRECTION: as the owner, for a frozen order of the hubs of the grant, under the key of the maker, the order locked first. The guard of the table repeats every rule.
CREATE FUNCTION melarc.request_payer_correction(p_id uuid, p_order uuid, p_proposed jsonb, p_note text, p_version integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ord public."order"%ROWTYPE;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pricing.correction.create' THEN
    RAISE EXCEPTION 'a payer correction is requested by the officer who holds the key of the maker' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO ord FROM public."order" AS o WHERE o.id = p_order FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such order in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF ord.version <> p_version THEN
    RAISE EXCEPTION 'the order has changed since it was read' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=stale';
  END IF;
  INSERT INTO public.payer_correction (id, order_id, responsible_hub_id, requested_by, previous_allocation, proposed, note)
  VALUES (p_id, p_order, ord.responsible_hub_id, melarc.current_principal_id(), coalesce(ord.payer_allocation, '{}'::jsonb), p_proposed, p_note);
  RETURN p_id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.request_payer_correction(uuid, uuid, jsonb, text, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.request_payer_correction(uuid, uuid, jsonb, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.request_payer_correction(uuid, uuid, jsonb, text, integer) TO melarc_api_runtime;
--> statement-breakpoint
-- DECIDING A CORRECTION: the correction and its order locked (the correction first), a rejection recorded, or an approval that writes the new portions of the locked price and re-runs the gate from them in the same
-- change. The locked price is the order's and is not touched.
CREATE FUNCTION melarc.decide_payer_correction(p_correction uuid, p_decision text, p_version integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  corr public.payer_correction%ROWTYPE;
  ord public."order"%ROWTYPE;
  sender integer;
  allocation jsonb;
  outcome text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pricing.correction.approve' THEN
    RAISE EXCEPTION 'a payer correction is decided by the officer who holds the key of the checker' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('APPROVE', 'REJECT') THEN
    RAISE EXCEPTION 'a payer correction is approved or rejected' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO corr FROM public.payer_correction AS c WHERE c.id = p_correction FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such correction in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF corr.version <> p_version THEN
    RAISE EXCEPTION 'the correction has changed since it was read' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=stale';
  END IF;
  SELECT * INTO ord FROM public."order" AS o WHERE o.id = corr.order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such order in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF p_decision = 'REJECT' THEN
    UPDATE public.payer_correction SET state = 'REJECTED', decided_by = melarc.current_principal_id(), decided_at = pg_catalog.transaction_timestamp() WHERE id = p_correction;
    RETURN;
  END IF;
  sender := melarc.payer_portion(ord.locked_price_minor, corr.proposed);
  IF sender IS NULL OR sender < 0 THEN
    RAISE EXCEPTION 'the proposed arrangement cannot be resolved into portions of the locked price' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=unresolvable';
  END IF;
  allocation := pg_catalog.jsonb_build_object('payer_intent', corr.proposed ->> 'payer_intent', 'split_basis', corr.proposed ->> 'split_basis', 'sender_minor', sender, 'recipient_minor', ord.locked_price_minor - sender);
  outcome := CASE WHEN sender = 0 THEN 'NO_VENDOR_CHARGE' ELSE 'PAYMENT_REQUIRED' END;
  UPDATE public.payer_correction
     SET state = 'APPROVED', decided_by = melarc.current_principal_id(), decided_at = pg_catalog.transaction_timestamp(),
         resulting_allocation = allocation, resulting_commercial_state = outcome
   WHERE id = p_correction;
  UPDATE public."order" SET payer_allocation = allocation, commercial_state = outcome WHERE id = ord.id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.decide_payer_correction(uuid, text, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.decide_payer_correction(uuid, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.decide_payer_correction(uuid, text, integer) TO melarc_api_runtime;
--> statement-breakpoint
-- THE PAYER EDIT BEFORE THE FREEZE: the default arrangement of a request, for a vendor's own PENDING request and for Ops's PENDING or CONFIRMED request whose run has not started, until an order of its intake is frozen.
CREATE FUNCTION melarc.amend_request_payer(p_request uuid, p_payer jsonb, p_version integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  req public.pickup_request%ROWTYPE;
BEGIN
  IF melarc.principal_type() NOT IN ('STAFF', 'VENDOR')
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.request.create' THEN
    RAISE EXCEPTION 'a request is amended by the vendor that owns it or by the staff of its hub' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO req FROM public.pickup_request AS r WHERE r.id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such request for the caller' USING ERRCODE = '42501';
  END IF;
  IF req.version <> p_version THEN
    RAISE EXCEPTION 'the request has changed since it was read' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=stale';
  END IF;
  IF melarc.principal_type() = 'VENDOR' AND req.state <> 'PENDING' THEN
    RAISE EXCEPTION 'a vendor amends only a pending request of its own' USING ERRCODE = '23514', DETAIL = 'reason=PERMISSION_DENIED';
  END IF;
  IF req.state NOT IN ('PENDING', 'CONFIRMED') THEN
    RAISE EXCEPTION 'only a pending or a confirmed request is amended' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=request_closed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."order" AS o JOIN public.pickup_intake AS i ON i.id = o.pickup_intake_id
     WHERE i.pickup_request_id = p_request AND o.locked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'the price is frozen: the same edit is now a correction of the order' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=price_frozen';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pickup_stop AS s JOIN public.pickup_manifest AS m ON m.id = s.pickup_manifest_id
     WHERE s.pickup_request_id = p_request AND s.released_at IS NULL AND m.state IN ('IN_PROGRESS', 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'a request whose run has started is no longer amended' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=run_started';
  END IF;
  UPDATE public.pickup_request
     SET default_payer_intent = p_payer ->> 'payer_intent',
         split_basis = p_payer ->> 'split_basis',
         split_sender_amount_minor = (p_payer ->> 'split_sender_amount_minor')::integer,
         split_sender_percentage = (p_payer ->> 'split_sender_percentage')::numeric
   WHERE id = p_request;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.amend_request_payer(uuid, jsonb, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.amend_request_payer(uuid, jsonb, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.amend_request_payer(uuid, jsonb, integer) TO melarc_api_runtime;
