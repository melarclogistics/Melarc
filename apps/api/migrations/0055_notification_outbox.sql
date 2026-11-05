CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outbox_id" uuid NOT NULL,
	"message_kind" text NOT NULL,
	"template_version" integer NOT NULL,
	"audience" text NOT NULL,
	"channel" text NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"vendor_organization_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"suppression_reason" text,
	"outcome_class" text,
	"provider_outcome_class" text,
	"destination_hint" text,
	"destination_digest" text,
	"reserved_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"provider_message_ref" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"receipt_checks" integer DEFAULT 0 NOT NULL,
	"next_receipt_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "notification_message_key" UNIQUE("outbox_id","message_kind","audience"),
	CONSTRAINT "notification_audience_closed" CHECK ("notification"."audience" IN ('AD_HOC_SENDER', 'VENDOR_NUMBER', 'RIDER', 'RECIPIENT', 'VENDOR_FEED', 'OPS_FEED')),
	CONSTRAINT "notification_channel_closed" CHECK ("notification"."channel" IN ('SMS', 'FEED')),
	CONSTRAINT "notification_state_closed" CHECK ("notification"."state" IN ('QUEUED', 'LEASED', 'RETRYABLE', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED', 'EXPIRED')),
	CONSTRAINT "notification_subject_closed" CHECK ("notification"."subject_type" IN ('PICKUP_REQUEST')),
	CONSTRAINT "notification_suppression_closed" CHECK ("notification"."suppression_reason" IS NULL OR "notification"."suppression_reason" IN ('KILL_SWITCH', 'NUMBER_LIMIT', 'DAY_LIMIT', 'WINDOW_LIMIT', 'DESTINATION_NOT_ALLOWED', 'DESTINATION_REFUSED', 'NO_DESTINATION', 'OVERTAKEN', 'WORDING_NOT_APPROVED')),
	CONSTRAINT "notification_outcome_closed" CHECK ("notification"."outcome_class" IS NULL OR "notification"."outcome_class" IN ('ACCEPTED', 'UNKNOWN', 'REJECTED', 'DELIVERY_FAILED', 'SCHEDULE_EXHAUSTED', 'EXPIRED', 'RELINQUISHED')),
	CONSTRAINT "notification_suppressed_has_its_reason" CHECK (("notification"."state" = 'SUPPRESSED') = ("notification"."suppression_reason" IS NOT NULL)),
	CONSTRAINT "notification_kind_and_version" CHECK ("notification"."message_kind" ~ '^[A-Z][A-Z0-9_]{2,63}$' AND "notification"."template_version" >= 1),
	CONSTRAINT "notification_counters_nonnegative" CHECK ("notification"."attempt_count" >= 0 AND "notification"."lease_version" >= 0 AND "notification"."receipt_checks" >= 0),
	CONSTRAINT "notification_lease_when_leased" CHECK ("notification"."state" <> 'LEASED' OR ("notification"."lease_owner" IS NOT NULL AND "notification"."lease_expires_at" IS NOT NULL AND "notification"."lease_version" >= 1 AND "notification"."attempt_count" >= 1)),
	CONSTRAINT "notification_lease_owner_bounded" CHECK ("notification"."lease_owner" IS NULL OR length("notification"."lease_owner") BETWEEN 1 AND 128),
	CONSTRAINT "notification_sent_follows_state" CHECK (CASE WHEN "notification"."channel" = 'SMS' THEN ("notification"."sent_at" IS NOT NULL) = ("notification"."state" IN ('SENT', 'DELIVERED') OR ("notification"."state" = 'FAILED' AND "notification"."outcome_class" = 'DELIVERY_FAILED')) ELSE "notification"."sent_at" IS NULL END),
	CONSTRAINT "notification_provider_fields_bounded" CHECK (("notification"."provider_message_ref" IS NULL OR length("notification"."provider_message_ref") BETWEEN 1 AND 256) AND ("notification"."provider_outcome_class" IS NULL OR "notification"."provider_outcome_class" ~ '^[A-Z][A-Z0-9_]{0,47}$') AND ("notification"."destination_hint" IS NULL OR length("notification"."destination_hint") <= 24) AND ("notification"."destination_digest" IS NULL OR "notification"."destination_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "notification_delivered_when_delivered" CHECK (CASE WHEN "notification"."channel" = 'SMS' THEN ("notification"."state" = 'DELIVERED') = ("notification"."delivered_at" IS NOT NULL) ELSE "notification"."delivered_at" IS NULL END),
	CONSTRAINT "notification_expires_after_created" CHECK ("notification"."expires_at" > "notification"."created_at"),
	CONSTRAINT "notification_reserved_has_its_digest" CHECK ("notification"."reserved_at" IS NULL OR "notification"."destination_digest" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"vendor_organization_id" uuid,
	"rider_id" uuid,
	"originating_principal_type" text NOT NULL,
	"originating_principal_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"relay_state" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"lease_owner" text,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"relayed_at" timestamp with time zone,
	"last_outcome" text,
	CONSTRAINT "outbox_event_key" UNIQUE("event_type","aggregate_id","correlation_id"),
	CONSTRAINT "outbox_aggregate_type_closed" CHECK ("outbox"."aggregate_type" IN ('PICKUP_REQUEST')),
	CONSTRAINT "outbox_event_type_shape" CHECK ("outbox"."event_type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length("outbox"."event_type") <= 64),
	CONSTRAINT "outbox_principal_closed" CHECK ("outbox"."originating_principal_type" IN ('STAFF', 'VENDOR', 'RIDER', 'SYSTEM')),
	CONSTRAINT "outbox_operation_and_correlation_bounded" CHECK (length("outbox"."operation_id") BETWEEN 1 AND 96 AND length("outbox"."correlation_id") BETWEEN 1 AND 128),
	CONSTRAINT "outbox_payload_is_a_small_object" CHECK (jsonb_typeof("outbox"."payload") = 'object' AND octet_length("outbox"."payload"::text) <= 2048),
	CONSTRAINT "outbox_state_closed" CHECK ("outbox"."relay_state" IN ('PENDING', 'LEASED', 'RELAYED', 'DEAD')),
	CONSTRAINT "outbox_outcome_closed" CHECK ("outbox"."last_outcome" IS NULL OR "outbox"."last_outcome" IN ('MATERIALISED', 'NOTHING_TO_SEND', 'SCOPE_MISMATCH', 'UNKNOWN_EVENT', 'SCHEDULE_EXHAUSTED', 'RETRY', 'RELINQUISHED')),
	CONSTRAINT "outbox_counters_nonnegative" CHECK ("outbox"."attempt_count" >= 0 AND "outbox"."lease_version" >= 0),
	CONSTRAINT "outbox_pending_holds_no_lease" CHECK ("outbox"."relay_state" <> 'PENDING' OR ("outbox"."lease_expires_at" IS NULL AND "outbox"."relayed_at" IS NULL)),
	CONSTRAINT "outbox_lease_when_leased" CHECK ("outbox"."relay_state" <> 'LEASED' OR ("outbox"."lease_owner" IS NOT NULL AND "outbox"."lease_expires_at" IS NOT NULL AND "outbox"."lease_version" >= 1 AND "outbox"."attempt_count" >= 1)),
	CONSTRAINT "outbox_lease_owner_bounded" CHECK ("outbox"."lease_owner" IS NULL OR length("outbox"."lease_owner") BETWEEN 1 AND 128),
	CONSTRAINT "outbox_relayed_when_relayed" CHECK (("outbox"."relay_state" = 'RELAYED') = ("outbox"."relayed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_outbox_id_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_responsible_hub_id_hub_id_fk" FOREIGN KEY ("responsible_hub_id") REFERENCES "public"."hub"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_responsible_hub_id_hub_id_fk" FOREIGN KEY ("responsible_hub_id") REFERENCES "public"."hub"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_due_idx" ON "notification" USING btree ("next_attempt_at") WHERE "notification"."state" IN ('QUEUED', 'RETRYABLE');--> statement-breakpoint
CREATE INDEX "notification_lease_idx" ON "notification" USING btree ("lease_expires_at") WHERE "notification"."state" = 'LEASED';--> statement-breakpoint
CREATE INDEX "notification_receipt_idx" ON "notification" USING btree ("next_receipt_check_at") WHERE "notification"."state" = 'SENT';--> statement-breakpoint
CREATE INDEX "notification_hub_recent_idx" ON "notification" USING btree ("responsible_hub_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_subject_idx" ON "notification" USING btree ("subject_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_number_day_idx" ON "notification" USING btree ("destination_digest","sent_at") WHERE "notification"."sent_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_sent_idx" ON "notification" USING btree ("sent_at") WHERE "notification"."sent_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_reserved_idx" ON "notification" USING btree ("destination_digest","reserved_at") WHERE "notification"."reserved_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "outbox" USING btree ("next_attempt_at") WHERE "outbox"."relay_state" = 'PENDING';--> statement-breakpoint
CREATE INDEX "outbox_lease_idx" ON "outbox" USING btree ("lease_expires_at") WHERE "outbox"."relay_state" = 'LEASED';--> statement-breakpoint
CREATE INDEX "outbox_aggregate_idx" ON "outbox" USING btree ("aggregate_type","aggregate_id");
--> statement-breakpoint
-- THE HAND-WRITTEN PART (S1.12a). Everything above is generated (drizzle-kit, from src/platform/database/schema/notifications.ts,
-- whose header explains every column); everything below is in this migration so that the two tables never exist for a moment without
-- their owner, row-level security, policies, grants and guards.
--
-- The outbox is the trusted security envelope of a business event (BACKGROUND_JOBS_AND_EVENTS.md section 3.7; SECURITY_DESIGN.md
-- section 14.7). A business act writes one row INSIDE ITS OWN TRANSACTION, as the principal that did the act; the lane of the delivery
-- worker (the SYSTEM capability `notification`, the grant set melarc_worker_cap_notification that provisioning puts in front of the
-- worker's login) leases it, reloads the aggregate under the envelope's scope and writes the notifications. A notification is the
-- record of one message: it holds no destination in clear, no text and no code.
--
-- Row-level security. The outbox: a staff, vendor or rider context inserts the envelope of its own act (the originating principal is
-- the context's own, and the scope it names is the context's scope); the `notification` capability reads and leases; nobody else reads
-- or writes a row. The notification: a staff context reads the rows of its hubs (the Ops log; the key notification.read is the
-- operation's); the `notification` capability reads, inserts and updates. Nobody deletes: no policy and no grant allows it (the
-- retention of a finished row is OQ-028).
--
-- Three more policies, on tables that already exist: the lane reads the ONE pickup request its envelope names, and the ONE ad-hoc
-- sender that request belongs to. The accessors melarc.outbox_id(), outbox_hub_id() and outbox_aggregate_id() carry the envelope the
-- lane read, which it set in its context; the insert guard of the notification then checks the stored envelope itself, so that a label
-- the lane asserts is a narrowing and never the authority.
--
-- Grants. The API runtime INSERTs envelopes (and SELECTs the columns of a notification that the Ops log shows: no digest, no provider
-- reference, no lease). The capability role SELECTs and UPDATEs the relay's bookkeeping columns of the outbox, SELECTs, INSERTs and
-- UPDATEs the notification, and SELECTs the columns of the pickup request and the ad-hoc sender that a message is made from.
-- Neither holds DELETE or TRUNCATE.

ALTER TABLE "outbox" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "notification" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION melarc.outbox_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('melarc.outbox_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.outbox_hub_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('melarc.outbox_hub_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.outbox_aggregate_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('melarc.outbox_aggregate_id', true), '')::uuid
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.outbox_id() OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.outbox_hub_id() OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.outbox_aggregate_id() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.outbox_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.outbox_hub_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.outbox_aggregate_id() FROM PUBLIC;
--> statement-breakpoint
-- Every login subject to a policy that calls an accessor needs EXECUTE on it, even for a principal whose arm never reaches it.
GRANT EXECUTE ON FUNCTION melarc.outbox_id() TO melarc_api_runtime, melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.outbox_hub_id() TO melarc_api_runtime, melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.outbox_aggregate_id() TO melarc_api_runtime, melarc_worker_runtime, melarc_provisioning;
--> statement-breakpoint
CREATE POLICY "outbox_insert" ON "outbox" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN originating_principal_type = 'STAFF' AND originating_principal_id = melarc.current_principal_id() AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN originating_principal_type = 'VENDOR' AND originating_principal_id = melarc.current_principal_id() AND vendor_organization_id = melarc.current_vendor_organization_id()
    WHEN 'RIDER' THEN originating_principal_type = 'RIDER' AND originating_principal_id = melarc.current_principal_id() AND rider_id = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "outbox_lane_read" ON "outbox" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "outbox_lane_work" ON "outbox" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND relay_state IN ('PENDING', 'LEASED')
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "notification_read" ON "notification" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'notification.read' AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "notification_lane_insert" ON "notification" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND state IN ('QUEUED', 'SUPPRESSED', 'DELIVERED') AND outbox_id = melarc.outbox_id() AND responsible_hub_id = melarc.outbox_hub_id() AND subject_id = melarc.outbox_aggregate_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "notification_lane_work" ON "notification" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND state IN ('QUEUED', 'LEASED', 'RETRYABLE', 'SENT')
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_request_notification_read" ON "pickup_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND id = melarc.outbox_aggregate_id() AND responsible_hub_id = melarc.outbox_hub_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "ad_hoc_sender_notification_read" ON "ad_hoc_sender" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND EXISTS (SELECT 1 FROM pickup_request r WHERE r.id = melarc.outbox_aggregate_id() AND r.ad_hoc_sender_id = ad_hoc_sender.id)
    ELSE false
  END
);
--> statement-breakpoint
GRANT INSERT ON "outbox" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ("id", "outbox_id", "message_kind", "template_version", "audience", "channel", "responsible_hub_id", "vendor_organization_id", "subject_type", "subject_id", "state", "suppression_reason", "outcome_class", "provider_outcome_class", "destination_hint", "attempt_count", "expires_at", "sent_at", "delivered_at", "created_at") ON "notification" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "outbox" TO melarc_worker_cap_notification;
--> statement-breakpoint
GRANT UPDATE ("relay_state", "attempt_count", "next_attempt_at", "lease_owner", "lease_version", "lease_expires_at", "relayed_at", "last_outcome") ON "outbox" TO melarc_worker_cap_notification;
--> statement-breakpoint
GRANT SELECT, INSERT ON "notification" TO melarc_worker_cap_notification;
--> statement-breakpoint
GRANT UPDATE ("state", "suppression_reason", "outcome_class", "provider_outcome_class", "destination_hint", "destination_digest", "reserved_at", "attempt_count", "next_attempt_at", "lease_owner", "lease_version", "lease_expires_at", "provider_message_ref", "sent_at", "delivered_at", "receipt_checks", "next_receipt_check_at") ON "notification" TO melarc_worker_cap_notification;
--> statement-breakpoint
GRANT SELECT ("id", "code", "state", "responsible_hub_id", "vendor_organization_id", "ad_hoc_sender_id", "scheduled_service_date", "attempt_number") ON "pickup_request" TO melarc_worker_cap_notification;
--> statement-breakpoint
GRANT SELECT ("id", "name", "phone") ON "ad_hoc_sender" TO melarc_worker_cap_notification;
--> statement-breakpoint
CREATE FUNCTION melarc.outbox_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
      FROM pickup_request p WHERE p.id = NEW.aggregate_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an envelope names an aggregate that its writer can read' USING ERRCODE = '23514';
    END IF;
    IF aggregate_hub IS DISTINCT FROM NEW.responsible_hub_id OR aggregate_vendor IS DISTINCT FROM NEW.vendor_organization_id OR NEW.rider_id IS NOT NULL THEN
      RAISE EXCEPTION 'an envelope carries the scope of its aggregate and no other' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.outbox_insert_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.outbox_insert_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "outbox_insert_guard" BEFORE INSERT ON "outbox"
  FOR EACH ROW EXECUTE FUNCTION melarc.outbox_insert_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moment timestamptz := clock_timestamp();
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
     OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.vendor_organization_id IS DISTINCT FROM OLD.vendor_organization_id
     OR NEW.rider_id IS DISTINCT FROM OLD.rider_id
     OR NEW.originating_principal_type IS DISTINCT FROM OLD.originating_principal_type
     OR NEW.originating_principal_id IS DISTINCT FROM OLD.originating_principal_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an envelope never changes: only the relay''s bookkeeping does' USING ERRCODE = '23514';
  END IF;
  IF OLD.relay_state IN ('RELAYED', 'DEAD') THEN
    RAISE EXCEPTION 'an envelope that has been relayed or dead-lettered does not change' USING ERRCODE = '23514';
  END IF;

  IF NEW.relay_state = 'LEASED' THEN
    -- A claim: the first lease of an envelope that is due, or the takeover of one whose lease ended with no outcome.
    IF OLD.relay_state = 'LEASED' AND OLD.lease_expires_at > moment THEN
      RAISE EXCEPTION 'an envelope whose lease has not ended is not claimed again' USING ERRCODE = '23514';
    END IF;
    IF OLD.relay_state = 'PENDING' AND OLD.next_attempt_at > moment THEN
      RAISE EXCEPTION 'an envelope is claimed when it is due' USING ERRCODE = '23514';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count + 1 OR NEW.lease_version <> OLD.lease_version + 1 THEN
      RAISE EXCEPTION 'a claim counts one attempt and raises the lease version by one' USING ERRCODE = '23514';
    END IF;
    IF NEW.lease_expires_at <= moment OR NEW.lease_expires_at > moment + interval '1 hour' THEN
      RAISE EXCEPTION 'a lease ends in the future and within an hour' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.relay_state = 'LEASED' AND NEW.relay_state IN ('PENDING', 'RELAYED', 'DEAD') THEN
    -- An outcome: the lease and the count stay as they were, which is what the writer's fence compared.
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_version <> OLD.lease_version
       OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner THEN
      RAISE EXCEPTION 'an outcome does not touch the lease owner, the lease version or the count of attempts' USING ERRCODE = '23514';
    END IF;
    IF NEW.relay_state = 'PENDING' AND NEW.next_attempt_at < OLD.next_attempt_at THEN
      RAISE EXCEPTION 'a retry waits: it is never due before it was' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'that change of state is not one an envelope makes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.outbox_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.outbox_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "outbox_guard" BEFORE UPDATE ON "outbox"
  FOR EACH ROW EXECUTE FUNCTION melarc.outbox_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.notification_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A notification is written once, untouched by any send, and either waiting (an SMS), held back (with its reason), or already in the
  -- feed it is written to (a feed entry is there to be read).
  IF NEW.attempt_count <> 0 OR NEW.lease_version <> 0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
     OR NEW.provider_message_ref IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.delivered_at IS NOT NULL
     OR NEW.receipt_checks <> 0 OR NEW.next_receipt_check_at IS NOT NULL OR NEW.provider_outcome_class IS NOT NULL
     OR NEW.reserved_at IS NOT NULL THEN
    RAISE EXCEPTION 'a notification is written untouched by any send' USING ERRCODE = '23514';
  END IF;
  IF (NEW.state = 'DELIVERED') <> (NEW.channel = 'FEED') AND NEW.state <> 'SUPPRESSED' THEN
    RAISE EXCEPTION 'a feed entry is written delivered, and a text message is queued or held back' USING ERRCODE = '23514';
  END IF;
  -- The stored envelope is the authority, not the context the lane asserted: the notification carries the scope of the envelope it
  -- came from, which the lane holds under a lease.
  IF NOT EXISTS (
    SELECT 1 FROM outbox o
     WHERE o.id = NEW.outbox_id
       AND o.relay_state = 'LEASED'
       AND o.lease_expires_at > clock_timestamp()
       AND o.responsible_hub_id = NEW.responsible_hub_id
       AND o.vendor_organization_id IS NOT DISTINCT FROM NEW.vendor_organization_id
       AND o.aggregate_type = NEW.subject_type
       AND o.aggregate_id = NEW.subject_id
  ) THEN
    RAISE EXCEPTION 'a notification carries the scope of the envelope that is leased to its writer' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.notification_insert_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.notification_insert_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "notification_insert_guard" BEFORE INSERT ON "notification"
  FOR EACH ROW EXECUTE FUNCTION melarc.notification_insert_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.notification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moment timestamptz := clock_timestamp();
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
     OR NEW.message_kind IS DISTINCT FROM OLD.message_kind
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.audience IS DISTINCT FROM OLD.audience
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.vendor_organization_id IS DISTINCT FROM OLD.vendor_organization_id
     OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a notification keeps its envelope, its message, its audience, its scope and its end' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('DELIVERED', 'FAILED', 'SUPPRESSED', 'EXPIRED') THEN
    RAISE EXCEPTION 'a notification that has ended does not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'LEASED' AND NEW.state = 'LEASED' AND NEW.lease_version = OLD.lease_version THEN
    -- The holder's bookkeeping under its own lease: what it keeps of the destination (a masked hint and a count digest) and the moment
    -- it reserved a place in the day's limits, which is written once; nothing else of a leased message moves. A takeover raises the
    -- lease version, so it is not this.
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
       OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
       OR NEW.suppression_reason IS DISTINCT FROM OLD.suppression_reason
       OR NEW.outcome_class IS DISTINCT FROM OLD.outcome_class
       OR NEW.provider_outcome_class IS DISTINCT FROM OLD.provider_outcome_class
       OR NEW.provider_message_ref IS DISTINCT FROM OLD.provider_message_ref
       OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
       OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
       OR NEW.receipt_checks <> OLD.receipt_checks
       OR NEW.next_receipt_check_at IS DISTINCT FROM OLD.next_receipt_check_at THEN
      RAISE EXCEPTION 'a holder keeps the hint and the digest of the destination under its lease and changes nothing else of a leased message' USING ERRCODE = '23514';
    END IF;
    IF OLD.reserved_at IS NOT NULL AND NEW.reserved_at IS DISTINCT FROM OLD.reserved_at THEN
      RAISE EXCEPTION 'the moment a place in the day''s limits was reserved is written once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.reserved_at IS DISTINCT FROM OLD.reserved_at THEN
    RAISE EXCEPTION 'a place in the day''s limits is reserved by the holder of the lease and by no other change' USING ERRCODE = '23514';
  END IF;
  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'the moment a message left is written once' USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'LEASED' THEN
    -- A claim: the first lease of a message that is due, or the takeover of one whose lease ended with no outcome.
    IF OLD.state NOT IN ('QUEUED', 'RETRYABLE', 'LEASED') THEN
      RAISE EXCEPTION 'only a waiting message is claimed' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'LEASED' AND OLD.lease_expires_at > moment THEN
      RAISE EXCEPTION 'a message whose lease has not ended is not claimed again' USING ERRCODE = '23514';
    END IF;
    IF OLD.state <> 'LEASED' AND OLD.next_attempt_at > moment THEN
      RAISE EXCEPTION 'a message is claimed when it is due' USING ERRCODE = '23514';
    END IF;
    IF OLD.expires_at <= moment THEN
      RAISE EXCEPTION 'a message is not leased past its end' USING ERRCODE = '23514';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count + 1 OR NEW.lease_version <> OLD.lease_version + 1 THEN
      RAISE EXCEPTION 'a claim counts one attempt and raises the lease version by one' USING ERRCODE = '23514';
    END IF;
    IF NEW.lease_expires_at <= moment OR NEW.lease_expires_at > moment + interval '1 hour' THEN
      RAISE EXCEPTION 'a lease ends in the future and within an hour' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.state = 'LEASED' AND NEW.state IN ('SENT', 'RETRYABLE', 'FAILED', 'SUPPRESSED', 'EXPIRED') THEN
    -- An outcome: the lease and the count stay as they were, which is what the writer's fence compared.
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_version <> OLD.lease_version
       OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner THEN
      RAISE EXCEPTION 'an outcome does not touch the lease owner, the lease version or the count of attempts' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'FAILED' AND NEW.outcome_class = 'DELIVERY_FAILED' THEN
      RAISE EXCEPTION 'the network''s no is a receipt, not the outcome of a send' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.state IN ('QUEUED', 'RETRYABLE') AND NEW.state IN ('SUPPRESSED', 'EXPIRED') THEN
    -- Held back or out of date before it was ever leased.
    IF NEW.state = 'EXPIRED' AND OLD.expires_at > moment THEN
      RAISE EXCEPTION 'a message expires when its end has passed' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.state = 'SENT' AND NEW.state IN ('SENT', 'DELIVERED', 'FAILED') THEN
    -- The network's word, polled: the lease and the count are not part of it.
    IF NEW.attempt_count <> OLD.attempt_count OR NEW.lease_version <> OLD.lease_version THEN
      RAISE EXCEPTION 'a receipt does not touch the lease or the count of attempts' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'FAILED' AND NEW.outcome_class IS DISTINCT FROM 'DELIVERY_FAILED' THEN
      RAISE EXCEPTION 'a message that failed after it left failed in delivery' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'that change of state is not one a notification makes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.notification_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.notification_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "notification_guard" BEFORE UPDATE ON "notification"
  FOR EACH ROW EXECUTE FUNCTION melarc.notification_guard();
