CREATE TABLE "order" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"pickup_intake_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"intake_parcel_id" uuid,
	"vendor_organization_id" uuid,
	"ad_hoc_sender_id" uuid,
	"commercial_state" text,
	"fulfilment_state" text DEFAULT 'AWAITING_RECIPIENT_CONFIRMATION' NOT NULL,
	"recipient" jsonb NOT NULL,
	"origin_zone_snapshot" jsonb NOT NULL,
	"destination_zone_snapshot" jsonb NOT NULL,
	"destination_zone_resolution" text NOT NULL,
	"declared_value_minor" integer,
	"is_serialized_goods" boolean DEFAULT false NOT NULL,
	"serial_imei" text,
	"service_level" text DEFAULT 'STANDARD' NOT NULL,
	"requested_delivery_date" date,
	"derived_delivery_date" date NOT NULL,
	"delivery_date_override" jsonb,
	"size_class" text NOT NULL,
	"size_class_selected_by" uuid NOT NULL,
	"carrier_cost_minor" integer,
	"carrier_waybill_evidence_id" uuid,
	"is_high_value" boolean NOT NULL,
	"high_value_evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"lane" text NOT NULL,
	"commercial_mode" text,
	"payer_override" jsonb,
	"payer_override_applied" boolean DEFAULT false NOT NULL,
	"payer_allocation" jsonb,
	"price_components_snapshot" jsonb NOT NULL,
	"locked_price_minor" integer,
	"locked_at" timestamp with time zone,
	"initial_commitment_id" uuid NOT NULL,
	"initial_sequence" integer DEFAULT 1 NOT NULL,
	"delivery_attempt_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "order_commercial_state_closed" CHECK ("order"."commercial_state" IS NULL OR "order"."commercial_state" IN ('PRICED', 'PAYMENT_REQUIRED', 'CREDIT_RESERVED', 'NO_VENDOR_CHARGE', 'PREPAID', 'CLOSED', 'REVERSED')),
	CONSTRAINT "order_fulfilment_state_closed" CHECK ("order"."fulfilment_state" IN ('AWAITING_RECIPIENT_CONFIRMATION', 'READY_FOR_DISPATCH', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'ATTEMPT_FAILED', 'AT_HUB_AFTER_FAILURE', 'READY_FOR_REATTEMPT', 'HANDED_TO_CARRIER', 'RETURN_TO_VENDOR_IN_PROGRESS', 'RETURNED_TO_VENDOR')),
	CONSTRAINT "order_lane_closed" CHECK ("order"."lane" IN ('DOORSTEP', 'THIRD_PARTY_HANDOFF')),
	CONSTRAINT "order_commercial_mode_closed" CHECK ("order"."commercial_mode" IS NULL OR "order"."commercial_mode" IN ('STATION_DROP', 'MELARC_COVERED_THIRD_PARTY_DELIVERY')),
	CONSTRAINT "order_size_class_closed" CHECK ("order"."size_class" IN ('SMALL', 'MEDIUM', 'LARGE')),
	CONSTRAINT "order_zone_resolution_closed" CHECK ("order"."destination_zone_resolution" IN ('SERVER_RESOLVED', 'EXPLICITLY_AUTHORIZED')),
	CONSTRAINT "order_service_level_closed" CHECK ("order"."service_level" = 'STANDARD'),
	CONSTRAINT "order_initial_sequence" CHECK ("order"."initial_sequence" = 1),
	CONSTRAINT "order_lane_mode" CHECK (("order"."lane" = 'DOORSTEP' AND "order"."commercial_mode" IS NULL) OR ("order"."lane" = 'THIRD_PARTY_HANDOFF' AND "order"."commercial_mode" IS NOT NULL)),
	CONSTRAINT "order_carrier_cost_facts" CHECK ((("order"."commercial_mode" IS NOT DISTINCT FROM 'MELARC_COVERED_THIRD_PARTY_DELIVERY') = ("order"."carrier_cost_minor" IS NOT NULL)) AND (("order"."carrier_cost_minor" IS NOT NULL) = ("order"."carrier_waybill_evidence_id" IS NOT NULL)) AND ("order"."carrier_cost_minor" IS NULL OR "order"."carrier_cost_minor" > 0)),
	CONSTRAINT "order_serial_required" CHECK (NOT "order"."is_serialized_goods" OR ("order"."serial_imei" IS NOT NULL AND btrim("order"."serial_imei") <> '')),
	CONSTRAINT "order_high_value_evidence" CHECK (NOT "order"."is_high_value" OR cardinality("order"."high_value_evidence_ids") >= 1),
	CONSTRAINT "order_declared_value_nonnegative" CHECK ("order"."declared_value_minor" IS NULL OR "order"."declared_value_minor" >= 0),
	CONSTRAINT "order_one_sender" CHECK (("order"."vendor_organization_id" IS NULL) <> ("order"."ad_hoc_sender_id" IS NULL)),
	CONSTRAINT "order_attempts_nonnegative" CHECK ("order"."delivery_attempt_count" >= 0),
	CONSTRAINT "order_freeze_facts" CHECK ((("order"."locked_price_minor" IS NULL) = ("order"."locked_at" IS NULL)) AND (("order"."locked_price_minor" IS NULL) = ("order"."payer_allocation" IS NULL)) AND (("order"."locked_price_minor" IS NULL) = ("order"."commercial_state" IS NULL)) AND ("order"."locked_price_minor" IS NULL OR "order"."locked_price_minor" >= 0)),
	CONSTRAINT "order_snapshots_are_objects" CHECK (jsonb_typeof("order"."recipient") = 'object' AND jsonb_typeof("order"."origin_zone_snapshot") = 'object' AND jsonb_typeof("order"."destination_zone_snapshot") = 'object' AND jsonb_typeof("order"."price_components_snapshot") = 'object')
);
--> statement-breakpoint
CREATE TABLE "delivery_commitment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"default_date" date NOT NULL,
	"requested_date" date,
	"committed_date" date NOT NULL,
	"committed_window_start" time,
	"committed_window_end" time,
	"change_reason_code" text,
	"requested_by_party" text,
	"approved_by_staff_id" uuid,
	"sla_start_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "delivery_commitment_sequence_positive" CHECK ("delivery_commitment"."sequence" >= 1),
	CONSTRAINT "delivery_commitment_requester_closed" CHECK ("delivery_commitment"."requested_by_party" IS NULL OR "delivery_commitment"."requested_by_party" IN ('SENDER', 'RECIPIENT', 'MELARC', 'SYSTEM')),
	CONSTRAINT "delivery_commitment_change_facts" CHECK (("delivery_commitment"."sequence" = 1 AND "delivery_commitment"."change_reason_code" IS NULL) OR ("delivery_commitment"."sequence" > 1 AND "delivery_commitment"."change_reason_code" IS NOT NULL)),
	CONSTRAINT "delivery_commitment_window_facts" CHECK (("delivery_commitment"."committed_window_start" IS NULL) = ("delivery_commitment"."committed_window_end" IS NULL) AND ("delivery_commitment"."committed_window_start" IS NULL OR "delivery_commitment"."committed_window_start" < "delivery_commitment"."committed_window_end"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_code_key" ON "order" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "order_id_hub_key" ON "order" USING btree ("id","responsible_hub_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_parcel_key" ON "order" USING btree ("intake_parcel_id");--> statement-breakpoint
CREATE INDEX "order_intake_idx" ON "order" USING btree ("pickup_intake_id","created_at");--> statement-breakpoint
CREATE INDEX "order_hub_idx" ON "order" USING btree ("responsible_hub_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_commitment_order_sequence_key" ON "delivery_commitment" USING btree ("order_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_commitment_order_id_sequence_key" ON "delivery_commitment" USING btree ("order_id","id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_commitment_current_key" ON "delivery_commitment" USING btree ("order_id") WHERE "delivery_commitment"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "delivery_commitment_hub_idx" ON "delivery_commitment" USING btree ("responsible_hub_id","committed_date");--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_intake_fkey" FOREIGN KEY ("pickup_intake_id","responsible_hub_id") REFERENCES "public"."pickup_intake"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_parcel_fkey" FOREIGN KEY ("intake_parcel_id","pickup_intake_id") REFERENCES "public"."intake_parcel"("id","pickup_intake_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_waybill_evidence_fkey" FOREIGN KEY ("carrier_waybill_evidence_id") REFERENCES "public"."evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_commitment" ADD CONSTRAINT "delivery_commitment_order_fkey" FOREIGN KEY ("order_id","responsible_hub_id") REFERENCES "public"."order"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- THE HAND-WRITTEN PART (S1.36). Everything above is generated (drizzle-kit, from src/hub/order.schema.ts and src/hub/delivery-commitment.schema.ts): the two tables, their keys, their indexes and the checks that hold
-- what an order and a commitment are. This migration is applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). Forward of 0109; nothing earlier is edited.
--
-- S1.36 (SLICE-001): itemizeOrder (delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.36; features/hub/itemization.md sections 5.1, 5.2 and 5.4; contracts/domain-model.md sections 6.7 and DeliveryCommitment;
-- state-machines.md sections 7 and 8; AC-SLICE-001-47 to -50, -53, -54, -56, -58, -59, -90 and -104; D-06, D-12, D-D6). What this part does:
--
--   * TWO TABLES, WRITTEN BY OPERATIONS OF THE DATABASE AND BY NOBODY ELSE. The application's login holds SELECT on "order" and delivery_commitment and no write. melarc.itemize_order makes an order for a parcel with its
--     initial commitment and, for a parcel that has arrived, freezes its price in the same change and moves the intake from READY_FOR_ITEMIZATION to ITEMIZING; melarc.freeze_orders confirms the orders that waited for a
--     parcel once that parcel's arrival can no longer be taken back. The table is named "order", a reserved word, and is quoted wherever it is named in SQL.
--   * WHAT AN ORDER IS, FOR EVERY WRITER (the guards): made for a parcel of its own intake (one order for a parcel, one parcel for an order), in the states of the machine of the intake and of the parcel; its hub, its sender
--     and its moment are the intake's, the request's and the database's, whatever the writer gave; its price components name the hub and add up to the total; its evidence is stored, the intake's own and of the purpose
--     ITEMIZATION; every order of an intake carries the same origin zone; and once frozen its price, its portions and its state are never rewritten (a correction is a linked adjustment).
--   * ITS FIRST PROMISE IS WRITTEN WITH IT. A deferred foreign key from the order to its initial commitment (sequence 1) makes an order without one impossible to commit. The commitment's moment of custody is read from the
--     stop's collection record by the guard and is never the writer's (COMMITMENT_SOURCE_UNRESOLVED when it cannot be read).
--   * A PARCEL WHOSE ORDER IS PRICED IS NOT TAKEN BACK (a trigger of the parcel: it cannot leave ARRIVED while a frozen order stands on it).
--   * READ ACCESS FOR THE KEY OF THE ACT. itemizeOrder takes the ETag of the intake as read as its If-Match, and recomputes it as the reads do; so the key hub.intake.itemize reads what those reads read (the intake, its
--     parcels and findings, the stop, the photos and the manifest as the owner), and the three functions that gate on the keys that read intakes name it too. Every policy added is additive and names the key.
--   * THE PHOTOGRAPH OF A WAYBILL AND THE VERIFICATION OF A HIGH-VALUE PARCEL ARE EVIDENCE OF THE INTAKE, purpose ITEMIZATION, declared and completed by the officer who itemizes under hub.intake.itemize and read under
--     hub.read. The contract's list of purposes names none of them and an order does not exist when its evidence is declared: this is a reading, surfaced for the Product Owner.

ALTER TABLE "order" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "delivery_commitment" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "delivery_commitment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "delivery_commitment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- An order has its initial commitment, or it is not committed: the key is checked at the end of the transaction (it is made after the order, which the commitment's own key names), and it names the row of sequence 1.
ALTER TABLE "order" ADD CONSTRAINT "order_initial_commitment_fkey" FOREIGN KEY ("id","initial_commitment_id","initial_sequence") REFERENCES "public"."delivery_commitment"("order_id","id","sequence") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- The reads of an order: the officer's own key reads what it made (the answer of the operation), and the owner reads it for the guards and the operations that run under the keys of the check-in and of the correction.
CREATE POLICY "order_read" ON "order" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "order_owner_read" ON "order" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "order_insert" ON "order" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND "order"."created_by" = melarc.current_principal_id()
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The freeze is the one change an order takes: made under the key of the officer who itemizes (an order for a parcel that has arrived), of the receiver whose check-in commits the arrival of a parcel and of the senior
-- whose correction does (the guard holds that nothing else changes).
CREATE POLICY "order_freeze" ON "order" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.itemize', 'hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.itemize', 'hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ON "order" TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "delivery_commitment_read" ON "delivery_commitment" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "delivery_commitment"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "delivery_commitment_insert" ON "delivery_commitment" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "delivery_commitment"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ON "delivery_commitment" TO melarc_api_runtime;
--> statement-breakpoint
-- THE KEY OF THE ACT READS WHAT THE INTAKE'S READS READ. The intake as the officer read it (the one ETag is computed from the intake, its parcels, its findings, the names and the declaration the photo intake shows):
-- additive policies for hub.intake.itemize, in the hubs of the grant, of the shape the other keys' have. The intake is locked by the runtime login to compare the token, as the count and the adjudication do (0093, 0096).
CREATE POLICY "pickup_intake_itemize_read" ON "pickup_intake" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_intake_itemize_lock" ON "pickup_intake" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
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
-- The one write of the key: the first order for a parcel that has arrived moves the intake to ITEMIZING, as the owner and nobody else (the login holds no UPDATE on the state either way).
CREATE POLICY "pickup_intake_itemize" ON "pickup_intake" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "intake_parcel_itemize_read" ON "intake_parcel" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_intake_finding_itemize_read" ON "pickup_intake_finding" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake_finding"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- What the functions read as the owner for the intake's reads (the stop that carries the request on its run, the links of the stop's photos) and for the order (the stop's collection record, whose handshake is the
-- moment of custody, and the request, whose sender and payer arrangement the order inherits): the owner under the keys that need them, in the hubs of the grant.
CREATE POLICY "pickup_stop_itemize_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "collection_parcel_photo_itemize_read" ON "collection_parcel_photo" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "collection_parcel_photo"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "collection_record_itemize_read" ON "collection_record" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "collection_record"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_request_order_read" ON "pickup_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.itemize', 'hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_request"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_manifest_itemize_read" ON "pickup_manifest" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
      AND melarc.run_has_intake("pickup_manifest"."id")
    ELSE false
  END
);
--> statement-breakpoint
-- THE EVIDENCE OF AN ITEMIZATION. The purpose joins the closed list; the officer who itemizes declares and completes it under hub.intake.itemize for an intake that is open to itemizing (a photo intake whose vendor is
-- being checked in, for an order that waits for its parcel; an intake cleared for itemization or being itemized), and reads the stored records of the intake and its own. 0104's two policies are restated with the arm added.
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_purpose_closed";
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_purpose_closed" CHECK ("evidence"."purpose" IN ('COLLECTION_PROOF', 'PARCEL_PHOTO', 'CONDITION', 'OSD', 'ITEMIZATION', 'HANDOFF_RECEIPT', 'DELIVERY_PROOF', 'RETURN_PROOF', 'MAINTENANCE', 'FUEL', 'COMPLIANCE_DOCUMENT'));
--> statement-breakpoint
DROP POLICY "evidence_declare_intake" ON "evidence";
--> statement-breakpoint
CREATE POLICY "evidence_declare_intake" ON "evidence" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN (
        (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND "evidence"."purpose" IN ('CONDITION', 'OSD'))
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate' AND "evidence"."purpose" = 'OSD')
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize' AND "evidence"."purpose" = 'ITEMIZATION')
      )
      AND "evidence"."owner_type" = 'PICKUP_INTAKE'
      AND "evidence"."captured_by_principal_type" = 'STAFF' AND "evidence"."captured_by_actor" = melarc.current_principal_id()
      AND "evidence"."state" = 'PENDING_UPLOAD' AND "evidence"."access_rule" = 'SUBJECT_READERS' AND "evidence"."retention_policy" = 'PICKUP_INTAKE_EVIDENCE'
      AND "evidence"."responsible_hub_id" IS NOT NULL AND "evidence"."vendor_organization_id" IS NULL
      AND (melarc.hub_scope_mode() = 'ALL' OR "evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
      AND EXISTS (
        SELECT 1 FROM "pickup_intake" AS i
         WHERE i.id = "evidence"."owner_id" AND i.responsible_hub_id = "evidence"."responsible_hub_id"
           AND CASE
                 WHEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND "evidence"."purpose" = 'CONDITION' THEN i.state <> 'AWAITING_COUNT' OR i.receiving_mode = 'PHOTO_CHECK_IN'
                 WHEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' THEN i.receiving_mode = 'PHOTO_CHECK_IN' AND i.state IN ('AWAITING_COUNT', 'RECONCILIATION_REQUIRED')
                 WHEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize' THEN i.state IN ('READY_FOR_ITEMIZATION', 'ITEMIZING') OR (i.state = 'AWAITING_COUNT' AND i.receiving_mode = 'PHOTO_CHECK_IN')
                 ELSE i.state <> 'AWAITING_COUNT'
               END
      )
    ELSE false
  END
);
--> statement-breakpoint
DROP POLICY "evidence_store_intake" ON "evidence";
--> statement-breakpoint
CREATE POLICY "evidence_store_intake" ON "evidence" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN (
        (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND "evidence"."purpose" IN ('CONDITION', 'OSD'))
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate' AND "evidence"."purpose" = 'OSD')
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize' AND "evidence"."purpose" = 'ITEMIZATION')
      )
      AND "evidence"."owner_type" = 'PICKUP_INTAKE'
      AND "evidence"."captured_by_principal_type" = 'STAFF' AND "evidence"."captured_by_actor" = melarc.current_principal_id()
      AND "evidence"."state" = 'PENDING_UPLOAD'
      AND (melarc.hub_scope_mode() = 'ALL' OR "evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN "evidence"."state" = 'STORED'
    ELSE false
  END
);
--> statement-breakpoint
-- What the officer who itemizes reads of the evidence of an intake: its own records (declared, pending or stored) and the stored ones of its colleagues, of the purpose of an itemization and in the hubs of the grant. The
-- operation judges the evidence it is given by reading it, and a record of another purpose or of another intake is one it does not see.
CREATE POLICY "evidence_itemize_read" ON "evidence" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND "evidence"."owner_type" = 'PICKUP_INTAKE' AND "evidence"."purpose" = 'ITEMIZATION' AND "evidence"."responsible_hub_id" IS NOT NULL
      AND ("evidence"."captured_by_actor" = melarc.current_principal_id() OR "evidence"."state" = 'STORED')
      AND (melarc.hub_scope_mode() = 'ALL' OR "evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);

--> statement-breakpoint
-- THE MOMENT CUSTODY PASSED. The successful pickup-custody moment of an intake's request, read from the lineage the contract names: the stop of the intake's run that carries the request, and the collection record
-- of that stop, whose handshake is what made the collection a success (`handshake_confirmed_at`, set together with the channel). A stop that was not confirmed has none, and an order cannot be promised from nothing.
-- Not granted to any login: the functions below call it as the owner.
CREATE FUNCTION melarc.pickup_custody_at(p_intake uuid) RETURNS timestamp with time zone
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.handshake_confirmed_at
    FROM public.pickup_intake AS i
    JOIN public.pickup_stop AS s ON s.pickup_manifest_id = i.pickup_manifest_id AND s.pickup_request_id = i.pickup_request_id
    JOIN public.collection_record AS c ON c.pickup_stop_id = s.id
   WHERE i.id = p_intake
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_custody_at(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_custody_at(uuid) FROM PUBLIC;
--> statement-breakpoint
-- WHAT AN ORDER IS MADE FROM, for the officer who itemizes: the intake's hub, the place the parcel was collected at (the request's resolved pickup location, from which the origin zone is resolved once), whether the booking
-- recorded the sender's acknowledgement of the liability cap (so that a declared value above the threshold was declared at booking) and the moment custody passed. The hub names none of the tables it reads (the
-- request, the stop and the collection are the pickup domain's), so it asks here. The caller is the key of the act and the intake the policies show it.
CREATE FUNCTION melarc.itemization_source(p_intake uuid)
RETURNS TABLE (responsible_hub_id uuid, origin_location jsonb, acknowledged_at_booking boolean, custody_at timestamp with time zone)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.itemize' THEN
    RAISE EXCEPTION 'what an order is made from is read by an officer who itemizes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT i.responsible_hub_id, r.resolved_pickup_location, r.liability_cap_acknowledged_at IS NOT NULL, melarc.pickup_custody_at(i.id)
      FROM public.pickup_intake AS i
      JOIN public.pickup_request AS r ON r.id = i.pickup_request_id
     WHERE i.id = p_intake;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.itemization_source(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.itemization_source(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.itemization_source(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- THE THREE FUNCTIONS THAT GATE ON THE KEYS THAT READ INTAKES, restated from their last definitions (0106, 0107 and 0104) with the key of the act added to the list, so that the intake can be read, and its ETag
-- recomputed, by the officer who itemizes. Nothing else of any of them changes.
CREATE OR REPLACE FUNCTION melarc.receiving_names(p_intake_ids uuid[])
RETURNS TABLE (party text, party_id uuid, intake_id uuid, display_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  rider_ids uuid[];
  staff_ids uuid[];
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate', 'hub.intake.itemize') THEN
    RAISE EXCEPTION 'the names of the receiving side are read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake_ids IS NULL OR pg_catalog.cardinality(p_intake_ids) > 1000 THEN
    RAISE EXCEPTION 'the names are asked for at most a thousand intakes at a time' USING ERRCODE = '22023';
  END IF;
  -- As the caller: the vendors, from the stops' snapshots, and the ids of the riders and of the officers that appear on the intakes the caller may see.
  RETURN QUERY
    SELECT 'VENDOR'::text, NULL::uuid, i.id, s.pickup_summary ->> 'sender_display_name'
      FROM public.pickup_intake AS i
      JOIN public.pickup_stop AS s ON s.pickup_manifest_id = i.pickup_manifest_id AND s.pickup_request_id = i.pickup_request_id
     WHERE i.id = ANY (p_intake_ids) AND pg_catalog.btrim(coalesce(s.pickup_summary ->> 'sender_display_name', '')) <> ''
     ORDER BY i.id;
  SELECT coalesce(pg_catalog.array_agg(DISTINCT i.handed_over_by), ARRAY[]::uuid[]) INTO rider_ids
    FROM public.pickup_intake AS i WHERE i.id = ANY (p_intake_ids);
  SELECT coalesce(pg_catalog.array_agg(DISTINCT x.actor), ARRAY[]::uuid[]) INTO staff_ids FROM (
    SELECT i.counted_by AS actor FROM public.pickup_intake AS i WHERE i.id = ANY (p_intake_ids)
    UNION
    SELECT i.active_receiver_id FROM public.pickup_intake AS i WHERE i.id = ANY (p_intake_ids)
    UNION
    SELECT p.arrived_by FROM public.intake_parcel AS p WHERE p.pickup_intake_id = ANY (p_intake_ids)
    UNION
    SELECT f.recorded_by FROM public.pickup_intake_finding AS f WHERE f.pickup_intake_id = ANY (p_intake_ids)
  ) AS x WHERE x.actor IS NOT NULL;
  -- As the system, for the one statement of each kind that reads the names of those ids and no other column.
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'receiving_names', true);
  RETURN QUERY SELECT 'RIDER'::text, r.id, NULL::uuid, r.full_name FROM public.rider_identity AS r WHERE r.id = ANY (rider_ids) ORDER BY r.id;
  RETURN QUERY SELECT 'STAFF'::text, t.id, NULL::uuid, t.full_name FROM public.staff_identity AS t WHERE t.id = ANY (staff_ids) ORDER BY t.id;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.receiving_names(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.receiving_names(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.receiving_names(uuid[]) TO melarc_api_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.receiving_run_codes(p_manifest_ids uuid[])
RETURNS TABLE (manifest_id uuid, run_code text, service_date date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate', 'hub.intake.itemize') THEN
    RAISE EXCEPTION 'the codes of runs are read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_manifest_ids IS NULL OR pg_catalog.cardinality(p_manifest_ids) > 1000 THEN
    RAISE EXCEPTION 'the codes are asked for at most a thousand runs at a time' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT m.id, m.code, m.service_date FROM public.pickup_manifest AS m WHERE m.id = ANY (p_manifest_ids) ORDER BY m.id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.receiving_run_codes(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.receiving_run_codes(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.receiving_run_codes(uuid[]) TO melarc_api_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.hub_intake_after_count(p_intake_ids uuid[]) RETURNS TABLE (intake_id uuid, rider_declared_count integer, parcel_photo_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate', 'hub.intake.itemize') THEN
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
     WHERE i.id = ANY (p_intake_ids) AND ((i.state <> 'AWAITING_COUNT' AND i.physical_count IS NOT NULL) OR i.receiving_mode = 'PHOTO_CHECK_IN')
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
-- THE GUARD OF AN ORDER, for every writer. At its making: for an intake and a parcel of it, in the states of their machines (an order for a parcel that has arrived once the vendor's check-in is finished and cleared; an order
-- for a parcel not yet checked in, which waits for it, while the vendor's check-in is open; never for a missing or void one, never a second one for a parcel); with its hub, its sender and its moment the intake's, the
-- request's and the database's; unfrozen; with evidence that is stored, the intake's own and of the purpose of an itemization, each piece cited once; with every order of an intake carrying the one origin zone; and with a
-- price whose components name the hub of the order and add up to its total. At its freeze: only for a parcel that has arrived and a vendor whose check-in is no longer open, to the price that was calculated, with portions that
-- add up to it, at the database's moment. Once frozen, its price, its portions and its state are never rewritten (S1.37 and the corrections restate this guard when they move the state). Every refusal names its reason.
CREATE FUNCTION melarc.order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
    IF NEW.locked_price_minor IS DISTINCT FROM OLD.locked_price_minor OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
       OR NEW.payer_allocation IS DISTINCT FROM OLD.payer_allocation OR NEW.commercial_state IS DISTINCT FROM OLD.commercial_state THEN
      RAISE EXCEPTION 'a locked price is never rewritten: a correction is a linked adjustment' USING ERRCODE = '23514';
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
CREATE TRIGGER "order_guard" BEFORE INSERT OR UPDATE OR DELETE ON "order"
  FOR EACH ROW EXECUTE FUNCTION melarc.order_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.order_version() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
ALTER FUNCTION melarc.order_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "order_version" BEFORE UPDATE ON "order"
  FOR EACH ROW EXECUTE FUNCTION melarc.order_version();
--> statement-breakpoint
-- THE GUARD OF A COMMITMENT, for every writer: appended and never edited or removed (only its supersession, once). The first row is the order's own dates (its default date, what was asked, and what Melarc promised), with
-- its hub the order's and its moment the database's, and **its SLA clock is the moment custody passed, read here from the stop's collection record and never the writer's**: the order is made hours after the custody that
-- started its promise, and the hub's arrival and the time of itemization move nothing. A commitment whose custody cannot be read is refused. Only the first commitment is made so far.
CREATE FUNCTION melarc.delivery_commitment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public."order"%ROWTYPE;
  custody timestamp with time zone;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a commitment is never removed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (pg_catalog.to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'superseded_at')
       OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
      RAISE EXCEPTION 'a commitment is kept as it was: only its supersession is written, once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO held FROM public."order" AS o WHERE o.id = NEW.order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a commitment is of an order' USING ERRCODE = '23514';
  END IF;
  IF NEW.sequence <> 1 OR NEW.superseded_at IS NOT NULL OR NEW.change_reason_code IS NOT NULL OR NEW.approved_by_staff_id IS NOT NULL THEN
    RAISE EXCEPTION 'only the initial commitment of an order is made so far: the revision of a promise is a task of its own' USING ERRCODE = '23514';
  END IF;
  IF NEW.default_date IS DISTINCT FROM held.derived_delivery_date OR NEW.requested_date IS DISTINCT FROM held.requested_delivery_date
     OR NEW.committed_date IS DISTINCT FROM coalesce(held.requested_delivery_date, held.derived_delivery_date) THEN
    RAISE EXCEPTION 'the initial commitment is the order''s own dates: the default, what was asked, and what is promised' USING ERRCODE = '23514';
  END IF;
  custody := melarc.pickup_custody_at(held.pickup_intake_id);
  IF custody IS NULL THEN
    RAISE EXCEPTION 'the moment custody passed cannot be read from the stop''s collection' USING ERRCODE = '23514', DETAIL = 'reason=COMMITMENT_SOURCE_UNRESOLVED';
  END IF;
  NEW.responsible_hub_id := held.responsible_hub_id;
  NEW.sla_start_at := custody;
  NEW.created_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.delivery_commitment_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.delivery_commitment_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "delivery_commitment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "delivery_commitment"
  FOR EACH ROW EXECUTE FUNCTION melarc.delivery_commitment_guard();
--> statement-breakpoint
-- A PARCEL WHOSE ORDER IS PRICED IS NOT TAKEN BACK: it cannot leave ARRIVED (an untap, a senior's correction to missing or void) while a frozen order stands on it. An order that still waits does not hold it: the officer may
-- take the tap back until the vendor is finished. A separate trigger, so that the guard of the parcel (0109) is not restated for it.
CREATE FUNCTION melarc.intake_parcel_order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.state = 'ARRIVED' AND NEW.state IS DISTINCT FROM OLD.state
     AND EXISTS (SELECT 1 FROM public."order" AS o WHERE o.intake_parcel_id = OLD.id AND o.locked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a parcel whose order is priced is not taken back' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_has_order';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_parcel_order_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_parcel_order_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "intake_parcel_order_guard" BEFORE UPDATE ON "intake_parcel"
  FOR EACH ROW EXECUTE FUNCTION melarc.intake_parcel_order_guard();
--> statement-breakpoint
-- THE FREEZE OF ONE ORDER (not granted to any login: the operations below call it as the owner). The price that was calculated when the order was made is locked, and the portions of it are resolved from the sender's
-- payer arrangement **as it stands now** (the vendor may edit it until the freeze, §23.5): the order's own override when it has one, else the request's. The sender pays all, none, a fixed amount (never more than the
-- price) or a percentage of it (rounded to the pesewa, half up), and the recipient pays the rest, so that the two always add up. Returns the locked price.
CREATE FUNCTION melarc.freeze_order_row(p_order uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ord public."order"%ROWTYPE;
  req public.pickup_request%ROWTYPE;
  total integer;
  intent text;
  basis text;
  amount integer;
  pct numeric;
  sender integer;
BEGIN
  SELECT * INTO ord FROM public."order" AS o WHERE o.id = p_order FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such order in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF ord.locked_at IS NOT NULL THEN
    RETURN ord.locked_price_minor;
  END IF;
  SELECT r.* INTO req FROM public.pickup_request AS r JOIN public.pickup_intake AS i ON i.pickup_request_id = r.id WHERE i.id = ord.pickup_intake_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an order is frozen against the request of its intake' USING ERRCODE = '23514';
  END IF;
  total := (ord.price_components_snapshot ->> 'total_minor')::integer;
  IF ord.payer_override IS NOT NULL THEN
    intent := ord.payer_override ->> 'payer_intent';
    basis := ord.payer_override ->> 'split_basis';
    amount := (ord.payer_override ->> 'split_sender_amount_minor')::integer;
    pct := (ord.payer_override ->> 'split_sender_percentage')::numeric;
  ELSE
    intent := req.default_payer_intent;
    basis := req.split_basis;
    amount := req.split_sender_amount_minor;
    pct := req.split_sender_percentage;
  END IF;
  sender := CASE intent
    WHEN 'RECIPIENT_PAYS' THEN 0
    WHEN 'SENDER_PAYS_FULL' THEN total
    WHEN 'SPLIT' THEN CASE basis
      WHEN 'FIXED_AMOUNT' THEN LEAST(amount, total)
      WHEN 'PERCENTAGE' THEN LEAST(total, GREATEST(0, pg_catalog.round(total::numeric * pct / 100)::integer))
    END
  END;
  IF sender IS NULL OR sender < 0 THEN
    RAISE EXCEPTION 'the payer arrangement of the order cannot be resolved into portions of its price' USING ERRCODE = '23514';
  END IF;
  UPDATE public."order"
     SET commercial_state = 'PRICED', locked_price_minor = total, locked_at = pg_catalog.clock_timestamp(),
         payer_allocation = pg_catalog.jsonb_build_object('payer_intent', intent, 'split_basis', basis, 'sender_minor', sender, 'recipient_minor', total - sender)
   WHERE id = p_order;
  RETURN total;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.freeze_order_row(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.freeze_order_row(uuid) FROM PUBLIC;
--> statement-breakpoint
-- THE CONFIRMATION OF THE ORDERS THAT WAITED. Checking a parcel in confirms its order (D-D6), and a check-in is committed when the vendor is finished (a tap can be taken back until then): so every order of the intake
-- whose parcel has arrived is frozen, in the same change as the act that committed the arrival (the vendor finished, a missing parcel found, a senior's correction). An intake whose vendor is still being checked in
-- freezes nothing. Called under the key of the receiver or of the senior, in the hubs of the grant, by the service that has just made the act; it returns the orders it froze and their prices, for the ledger.
CREATE FUNCTION melarc.freeze_orders(p_intake uuid) RETURNS TABLE (order_id uuid, locked_price_minor integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  each_order record;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.intake.count', 'hub.osd.adjudicate') THEN
    RAISE EXCEPTION 'the orders that waited are confirmed by the receiver or the senior whose act committed the arrival, and by nobody else' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF held.state = 'AWAITING_COUNT' THEN
    RETURN;
  END IF;
  FOR each_order IN
    SELECT o.id FROM public."order" AS o
     WHERE o.pickup_intake_id = p_intake AND o.locked_at IS NULL
       AND (o.intake_parcel_id IS NULL OR EXISTS (SELECT 1 FROM public.intake_parcel AS p WHERE p.id = o.intake_parcel_id AND p.state = 'ARRIVED'))
     ORDER BY o.created_at, o.id
  LOOP
    order_id := each_order.id;
    locked_price_minor := melarc.freeze_order_row(each_order.id);
    RETURN NEXT;
  END LOOP;
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.freeze_orders(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.freeze_orders(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.freeze_orders(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- ITEMIZING ONE PARCEL. The order and its first commitment are made in one change, as the owner, for an intake of the hubs of the grant, under the key of the act, with what the service has calculated (the price, the
-- zones, the dates) and what the guards check (the states, the evidence, the origin, the components, the custody). The intake is locked first, so that two officers ordering one parcel meet one after the other and the second
-- is refused for what the first made. An order for a parcel that has arrived, or for an intake counted blind, is frozen at once and the first of them moves the intake from READY_FOR_ITEMIZATION to ITEMIZING; an order for
-- a parcel that has not been checked in waits, calculated and not locked, and moves nothing of the intake.
CREATE FUNCTION melarc.itemize_order(p_intake uuid, p_facts jsonb)
RETURNS TABLE (order_id uuid, previous_state text, resulting_state text, frozen boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  new_order uuid;
  new_commitment uuid;
  parcel_id uuid;
  parcel_state text;
  confirmable boolean;
  commitment jsonb;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.itemize' THEN
    RAISE EXCEPTION 'an order is made by an officer of the hub holding the key to itemize, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake IS NULL OR p_facts IS NULL OR pg_catalog.jsonb_typeof(p_facts) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'an order is made for an intake from the facts of its parcel' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  new_order := (p_facts ->> 'order_id')::uuid;
  new_commitment := (p_facts ->> 'initial_commitment_id')::uuid;
  parcel_id := (p_facts ->> 'parcel_id')::uuid;
  commitment := p_facts -> 'commitment';

  INSERT INTO public."order" (
    id, code, pickup_intake_id, responsible_hub_id, intake_parcel_id, vendor_organization_id, ad_hoc_sender_id,
    recipient, origin_zone_snapshot, destination_zone_snapshot, destination_zone_resolution,
    declared_value_minor, is_serialized_goods, serial_imei, service_level, requested_delivery_date, derived_delivery_date,
    size_class, size_class_selected_by, carrier_cost_minor, carrier_waybill_evidence_id, is_high_value, high_value_evidence_ids,
    lane, commercial_mode, payer_override, payer_override_applied, price_components_snapshot, initial_commitment_id, created_by
  ) VALUES (
    new_order, p_facts ->> 'code', p_intake, held.responsible_hub_id, parcel_id, NULL, NULL,
    p_facts -> 'recipient', p_facts -> 'origin_zone_snapshot', p_facts -> 'destination_zone_snapshot', p_facts ->> 'destination_zone_resolution',
    (p_facts ->> 'declared_value_minor')::integer, coalesce((p_facts ->> 'is_serialized_goods')::boolean, false), p_facts ->> 'serial_imei', 'STANDARD',
    (p_facts ->> 'requested_delivery_date')::date, (p_facts ->> 'derived_delivery_date')::date,
    p_facts ->> 'size_class', melarc.current_principal_id(), (p_facts ->> 'carrier_cost_minor')::integer, (p_facts ->> 'carrier_waybill_evidence_id')::uuid,
    coalesce((p_facts ->> 'is_high_value')::boolean, false), ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p_facts -> 'high_value_evidence_ids'))::uuid[],
    p_facts ->> 'lane', p_facts ->> 'commercial_mode', NULLIF(p_facts -> 'payer_override', 'null'::jsonb), (NULLIF(p_facts -> 'payer_override', 'null'::jsonb) IS NOT NULL),
    p_facts -> 'price_components_snapshot', new_commitment, melarc.current_principal_id()
  );
  INSERT INTO public.delivery_commitment (
    id, order_id, responsible_hub_id, sequence, default_date, requested_date, committed_date, committed_window_start, committed_window_end, sla_start_at
  ) VALUES (
    new_commitment, new_order, held.responsible_hub_id, 1, (commitment ->> 'default_date')::date, (commitment ->> 'requested_date')::date, (commitment ->> 'committed_date')::date,
    (commitment ->> 'window_start')::time, (commitment ->> 'window_end')::time, pg_catalog.clock_timestamp()
  );

  IF parcel_id IS NOT NULL THEN
    SELECT p.state INTO parcel_state FROM public.intake_parcel AS p WHERE p.id = parcel_id;
  END IF;
  confirmable := parcel_id IS NULL OR parcel_state = 'ARRIVED';
  IF confirmable THEN
    IF held.state = 'READY_FOR_ITEMIZATION' THEN
      UPDATE public.pickup_intake SET state = 'ITEMIZING' WHERE id = p_intake;
    END IF;
    PERFORM melarc.freeze_order_row(new_order);
  END IF;
  RETURN QUERY SELECT new_order, held.state, (SELECT i.state FROM public.pickup_intake AS i WHERE i.id = p_intake), confirmable;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.itemize_order(uuid, jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.itemize_order(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.itemize_order(uuid, jsonb) TO melarc_api_runtime;
