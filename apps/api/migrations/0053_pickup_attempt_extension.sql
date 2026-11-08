CREATE TABLE "pickup_attempt_extension" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pickup_request_id" uuid NOT NULL,
	"ceiling_before" integer NOT NULL,
	"ceiling_after" integer NOT NULL,
	"extended_by" uuid NOT NULL,
	"extended_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "pickup_attempt_extension_ceiling_positive" CHECK ("pickup_attempt_extension"."ceiling_before" >= 1),
	CONSTRAINT "pickup_attempt_extension_ceiling_rises" CHECK ("pickup_attempt_extension"."ceiling_after" > "pickup_attempt_extension"."ceiling_before"),
	CONSTRAINT "pickup_attempt_extension_reason_not_blank" CHECK (length(btrim("pickup_attempt_extension"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "pickup_request" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pickup_attempt_extension" ADD CONSTRAINT "pickup_attempt_extension_request_fkey" FOREIGN KEY ("pickup_request_id") REFERENCES "public"."pickup_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_attempt_extension_one_per_request" ON "pickup_attempt_extension" USING btree ("pickup_request_id");--> statement-breakpoint
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_extension_fkey" FOREIGN KEY ("attempt_extension_id") REFERENCES "public"."pickup_attempt_extension"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_escalation_facts" CHECK ("pickup_request"."escalated_at" IS NULL OR "pickup_request"."confirmed_at" IS NOT NULL);

--> statement-breakpoint
-- S1.18 (SLICE-001): the attempt extension, the moment of an escalation and the rule that a replacement and its source are never active
-- together. Applied as melarc_migration_elevated, a member of melarc_owner. Forward-only; the generated statements above are the table, its
-- checks, its keys and the moment of an escalation; what follows is by hand, as 0045 and 0051 are.
--
--   * THE EXTENSION IS A RECORD, NEVER AN EDIT. A hub Senior Ops member's authority for one further attempt (section 21.6, MSC-DEC-116) is
--     an immutable audit record that the cap also reads: actor, reason, moment, and the ceiling before and after. Only the runtime's insert
--     is granted, and the trigger below refuses an UPDATE or a DELETE by anyone, the owner included. (TRUNCATE is not row-level and is not
--     refused by the trigger; no application login holds it, which the registry test proves, and emptying the table is the cluster
--     administrator's act and not the application's.)
--   * WHO READS. The extension is read through its request: a STAFF context reads the extensions of the requests it can read (the hubs of
--     the grant), under a key of the pickup domain (confirming, cancelling, extending and failing a request all read the ceiling), and
--     nobody else: a vendor's own request does not show it, and a rider and a SYSTEM context never read it.
--   * WHO WRITES. Only `pickup.attempt.extend`, for a request the caller can read (so within the hubs of the grant) and in the caller's own
--     name. A vendor holds no such key and no policy admits it.
--
--   * THE EXTENSION A REQUEST NAMES. A booking carries its extension into its clone, so that the one further attempt it allows can be
--     confirmed (as the exception travels, 0051): the key is a plain key, and the trigger keeps the integrity a composite key would have
--     given: a request names only an extension raised for it, or the one the request it replaces carries.
--   * THE ESCALATION. Its moment is recorded once and is never taken back or moved; the guard of a request (0045, restated with that one
--     rule added) refuses it for every writer. Only a request that was confirmed has one (the check above).
--   * NEVER ACTIVE TOGETHER (AC-SLICE-001-06, section 35.4.4). A reschedule inserts the clone and then cancels its source in one transaction,
--     so the rule can only be judged where the transaction ends: a deferred constraint trigger refuses, at commit, an active request whose
--     source is not cancelled. It reads the clone as it ends the transaction, so a clone cancelled in the same transaction is no longer active.
--     It reads the source under the writer's own row-level security and FAILS CLOSED: a context that cannot see the source cannot commit an
--     active replacement of it. Today that cannot arise (a replacement is made from a source its maker reads, and a request never changes
--     hub); a future operation that moves a request between hubs (reassignPickupRequestHub, SLICE-014) must adjust this rule on purpose.
ALTER TABLE "pickup_attempt_extension" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "pickup_attempt_extension" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pickup_attempt_extension" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pickup_attempt_extension_read" ON "pickup_attempt_extension" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) = 'pickup'
      AND EXISTS (SELECT 1 FROM pickup_request r WHERE r.id = pickup_request_id)
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_attempt_extension_insert" ON "pickup_attempt_extension" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.attempt.extend'
      AND extended_by = melarc.current_principal_id()
      AND EXISTS (SELECT 1 FROM pickup_request r WHERE r.id = pickup_request_id)
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ON "pickup_attempt_extension" TO melarc_api_runtime;
--> statement-breakpoint
GRANT INSERT ("id", "pickup_request_id", "ceiling_before", "ceiling_after", "extended_by", "reason") ON "pickup_attempt_extension" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.pickup_attempt_extension_frozen() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'an attempt extension is a record: it is never changed or removed' USING ERRCODE = '23514';
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_attempt_extension_frozen() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_attempt_extension_frozen() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pickup_attempt_extension_frozen" BEFORE UPDATE OR DELETE ON "pickup_attempt_extension"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_attempt_extension_frozen();
--> statement-breakpoint
CREATE FUNCTION melarc.pickup_request_extension_chain() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.attempt_extension_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- A link that is already the recorded one is not judged again.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.attempt_extension_id IS NOT DISTINCT FROM OLD.attempt_extension_id THEN
      RETURN NEW;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pickup_attempt_extension AS e WHERE e.id = NEW.attempt_extension_id AND e.pickup_request_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.pickup_request AS p WHERE p.id = NEW.replaces_request_id AND p.attempt_extension_id = NEW.attempt_extension_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a pickup request names only an extension raised for it, or the one the request it replaces carries'
    USING ERRCODE = '23514', CONSTRAINT = 'pickup_request_extension_chain';
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_request_extension_chain() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_request_extension_chain() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pickup_request_extension_chain" BEFORE INSERT OR UPDATE ON "pickup_request"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_request_extension_chain();
--> statement-breakpoint
-- The guard of a pickup request as 0045 made it, with one rule added: an escalation, once recorded, is neither taken back nor moved.
CREATE OR REPLACE FUNCTION melarc.pickup_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.vendor_organization_id IS DISTINCT FROM OLD.vendor_organization_id
     OR NEW.ad_hoc_sender_id IS DISTINCT FROM OLD.ad_hoc_sender_id
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.pickup_intent IS DISTINCT FROM OLD.pickup_intent
     OR NEW.declared_package_count IS DISTINCT FROM OLD.declared_package_count
     OR NEW.replaces_request_id IS DISTINCT FROM OLD.replaces_request_id
     OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a pickup request keeps its identity, its sender, its hub, its intent, its package count and its place in the chain' USING ERRCODE = '23514';
  END IF;
  IF OLD.escalated_at IS NOT NULL AND NEW.escalated_at IS DISTINCT FROM OLD.escalated_at THEN
    RAISE EXCEPTION 'an escalation is recorded once and is never taken back or moved' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'PENDING' AND NEW.state IN ('CONFIRMED', 'CANCELLED'))
       OR (OLD.state = 'CONFIRMED' AND NEW.state = 'CANCELLED')
     ) THEN
    RAISE EXCEPTION 'a pickup request moves from PENDING to CONFIRMED or CANCELLED and from CONFIRMED to CANCELLED, and no other way' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'CANCELLED' THEN
    IF NOT (
      OLD.cancellation_charge_outcome = 'APPLIED'
      AND NEW.cancellation_charge_outcome = 'WAIVED'
      AND NEW.cancellation_charge_waived_by IS NOT NULL
      AND (to_jsonb(NEW) - 'cancellation_charge_outcome' - 'cancellation_charge_waived_by' - 'cancellation_charge_waiver_note' - 'version')
          = (to_jsonb(OLD) - 'cancellation_charge_outcome' - 'cancellation_charge_waived_by' - 'cancellation_charge_waiver_note' - 'version')
    ) THEN
      RAISE EXCEPTION 'a cancelled pickup request is frozen but for the waiver of its applied charge' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- The link from a request to its one-package exception (0051), with one rule added: the exception a request is raised for must be APPROVED. The
-- maker-checker rule was held by the application alone (the confirmation asks for an approved exception); any writer that can update a request
-- (seven keys, the approval's among them) could otherwise name an exception that is only asked for or was refused. The exception a clone
-- inherits from its source is judged as before: the source carries only what was approved.
CREATE OR REPLACE FUNCTION melarc.pickup_request_exception_chain() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.one_package_exception_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- A link that is already the recorded one is not judged again.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.one_package_exception_id IS NOT DISTINCT FROM OLD.one_package_exception_id THEN
      RETURN NEW;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.one_package_exception AS e WHERE e.id = NEW.one_package_exception_id AND e.pickup_request_id = NEW.id AND e.state = 'APPROVED')
     OR EXISTS (SELECT 1 FROM public.pickup_request AS p WHERE p.id = NEW.replaces_request_id AND p.one_package_exception_id = NEW.one_package_exception_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a pickup request names only an approved exception raised for it, or the one the request it replaces carries'
    USING ERRCODE = '23514', CONSTRAINT = 'pickup_request_exception_chain';
END
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.pickup_request_source_cancelled() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.replaces_request_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- The request as the transaction leaves it, and not as this event saw it: one cancelled since is no longer active.
  IF NOT EXISTS (SELECT 1 FROM public.pickup_request AS c WHERE c.id = NEW.id AND c.state IN ('PENDING', 'CONFIRMED')) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pickup_request AS s WHERE s.id = NEW.replaces_request_id AND s.state = 'CANCELLED') THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'a replacement and the request it replaces are never active together'
    USING ERRCODE = '23514', CONSTRAINT = 'pickup_request_source_cancelled';
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_request_source_cancelled() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_request_source_cancelled() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pickup_request_source_cancelled" AFTER INSERT OR UPDATE ON "pickup_request"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION melarc.pickup_request_source_cancelled();
