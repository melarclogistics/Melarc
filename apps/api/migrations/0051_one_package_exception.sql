CREATE TABLE "one_package_exception" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pickup_request_id" uuid NOT NULL,
	"state" text DEFAULT 'REQUESTED' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_phone" text NOT NULL,
	"recipient_location" jsonb NOT NULL,
	"single_package_fee_snapshot" jsonb,
	CONSTRAINT "one_package_exception_state_closed" CHECK ("one_package_exception"."state" IN ('REQUESTED', 'APPROVED', 'REJECTED')),
	CONSTRAINT "one_package_exception_decision_facts" CHECK (("one_package_exception"."state" = 'REQUESTED') = ("one_package_exception"."approved_by" IS NULL) AND ("one_package_exception"."state" = 'REQUESTED') = ("one_package_exception"."decided_at" IS NULL)),
	CONSTRAINT "one_package_exception_fee_only_when_approved" CHECK ("one_package_exception"."single_package_fee_snapshot" IS NULL OR "one_package_exception"."state" = 'APPROVED'),
	CONSTRAINT "one_package_exception_note_not_blank" CHECK (length(btrim("one_package_exception"."note")) > 0),
	CONSTRAINT "one_package_exception_recipient_not_blank" CHECK (length(btrim("one_package_exception"."recipient_name")) > 0),
	CONSTRAINT "one_package_exception_phone_e164" CHECK ("one_package_exception"."recipient_phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "one_package_exception_location_has_address" CHECK (jsonb_typeof("one_package_exception"."recipient_location") = 'object' AND coalesce(length(btrim("one_package_exception"."recipient_location"->>'address')), 0) > 0)
);
--> statement-breakpoint
ALTER TABLE "one_package_exception" ADD CONSTRAINT "one_package_exception_request_fkey" FOREIGN KEY ("pickup_request_id") REFERENCES "public"."pickup_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_package_exception_one_live" ON "one_package_exception" USING btree ("pickup_request_id") WHERE "one_package_exception"."state" IN ('REQUESTED', 'APPROVED');--> statement-breakpoint
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_exception_fkey" FOREIGN KEY ("one_package_exception_id") REFERENCES "public"."one_package_exception"("id") ON DELETE restrict ON UPDATE no action;

--> statement-breakpoint
-- S1.16 (SLICE-001): the one-package exception. Applied as melarc_migration_elevated, a member of melarc_owner. Forward-only; the generated
-- statements above are the table, its checks, its two keys and the key from the request; what follows is by hand, as 0045 is.
--
--   * THE APPROVAL TRAVELS WITH THE BOOKING. A clone of a request (the reschedule of a late booking, 0050; of a failed attempt, S1.18) is
--     the same booking, so it carries the exception its source carries and needs no second approval or second fee. The key from the request
--     to its exception is therefore a plain key, and the trigger at the end of this file keeps the integrity a composite key would have
--     given: a request names only an exception raised for it, or the one the request it replaces carries, so one booking's approval can
--     never confirm another.
--
--   * WHO READS. The exception is read through its request: a STAFF context reads the exceptions of the requests it can read (the hubs of
--     the grant, under a key of the domains that read requests), a VENDOR context the exception of its own organisation's request (the
--     representation of a request carries it), and nobody else. The visibility is the request's own row-level security, evaluated for the
--     reader, so the two cannot drift apart: a request a reader cannot see has no exception it can see.
--   * WHO REQUESTS. Only `pickup.exception.request`, for a request the caller can read (so within the hubs of the grant), in the caller's
--     own name, and as `REQUESTED`. A vendor holds no such key and no policy admits it (AC-SLICE-001-03; section 35.2.4).
--   * WHO DECIDES. Only `pickup.exception.approve`, on an exception whose request the caller can read, in the caller's own name, and to
--     `APPROVED` or `REJECTED`. A policy names the key and not the column, so the column grants hold the rest: the maker writes the request
--     and nothing of the decision (no state, no checker, no fee), and the checker writes the decision and nothing of the request (no note,
--     no recipient). Nothing is ever deleted.
--   * THE GUARD (every writer): a request for an exception keeps its request, its maker, its note and its recipient; it is decided once,
--     and a decided one is frozen.
--   * THE BACKSTOP of the rule that the checker is not the maker (permissions.md section 6; the Product Owner's decision of 25 October
--     2026, as 0032 does for the staff identity): the application states it first, from the tier of the grant that authorizes the decision;
--     this trigger refuses it for every other writer. It reads the maker's bundle and its grants as the writer, under the writer's own
--     row-level security (the approving staff member is the maker, and reads their own row). A maker the table cannot find is no Platform
--     Admin, so the rule fails closed.
ALTER TABLE "one_package_exception" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "one_package_exception" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "one_package_exception" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "one_package_exception_read" ON "one_package_exception" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'hub', 'pricing', 'fleet')
      AND EXISTS (SELECT 1 FROM pickup_request r WHERE r.id = pickup_request_id)
    WHEN 'VENDOR' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) IN ('pickup', 'pricing')
      AND EXISTS (SELECT 1 FROM pickup_request r WHERE r.id = pickup_request_id)
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "one_package_exception_insert" ON "one_package_exception" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.exception.request'
      AND state = 'REQUESTED'
      AND requested_by = melarc.current_principal_id()
      AND EXISTS (SELECT 1 FROM pickup_request r WHERE r.id = pickup_request_id)
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "one_package_exception_update" ON "one_package_exception" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.exception.approve'
      AND EXISTS (SELECT 1 FROM pickup_request r WHERE r.id = pickup_request_id)
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.exception.approve'
      AND state IN ('APPROVED', 'REJECTED')
      AND approved_by = melarc.current_principal_id()
      AND EXISTS (SELECT 1 FROM pickup_request r WHERE r.id = pickup_request_id)
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ON "one_package_exception" TO melarc_api_runtime;
--> statement-breakpoint
GRANT INSERT ("id", "pickup_request_id", "requested_by", "note", "recipient_name", "recipient_phone", "recipient_location") ON "one_package_exception" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("state", "approved_by", "decided_at", "single_package_fee_snapshot") ON "one_package_exception" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.one_package_exception_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.pickup_request_id IS DISTINCT FROM OLD.pickup_request_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.recipient_name IS DISTINCT FROM OLD.recipient_name
     OR NEW.recipient_phone IS DISTINCT FROM OLD.recipient_phone
     OR NEW.recipient_location IS DISTINCT FROM OLD.recipient_location THEN
    RAISE EXCEPTION 'a one-package exception keeps its request, its maker, its note and its recipient' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'REQUESTED' THEN
    RAISE EXCEPTION 'a decided one-package exception is frozen' USING ERRCODE = '23514';
  END IF;
  IF NEW.state NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'a requested one-package exception changes only by being approved or rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.one_package_exception_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.one_package_exception_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "one_package_exception_guard" BEFORE UPDATE ON "one_package_exception"
  FOR EACH ROW EXECUTE FUNCTION melarc.one_package_exception_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.one_package_exception_checker_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.approved_by IS NULL OR NEW.approved_by <> NEW.requested_by THEN
    RETURN NEW;
  END IF;
  -- A checker that is already the recorded one is not written again.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT EXISTS (
       SELECT 1
         FROM public.staff_identity AS maker
         JOIN public.role_bundle_grant AS g ON g.bundle_id = maker.role_bundle_id
        WHERE maker.id = NEW.requested_by
          AND g.permission_key = 'pickup.exception.approve'
          AND g.tier = 'P') THEN
    RAISE EXCEPTION 'a one-package exception is decided by someone other than its maker, unless the maker holds the approval at the Platform Admin tier'
      USING ERRCODE = '23514', CONSTRAINT = 'one_package_exception_approver_is_not_requester';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.one_package_exception_checker_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.one_package_exception_checker_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "one_package_exception_checker" AFTER INSERT OR UPDATE ON "one_package_exception"
  FOR EACH ROW EXECUTE FUNCTION melarc.one_package_exception_checker_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.pickup_request_exception_chain() RETURNS trigger LANGUAGE plpgsql
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
  IF EXISTS (SELECT 1 FROM public.one_package_exception AS e WHERE e.id = NEW.one_package_exception_id AND e.pickup_request_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.pickup_request AS p WHERE p.id = NEW.replaces_request_id AND p.one_package_exception_id = NEW.one_package_exception_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a pickup request names only an exception raised for it, or the one the request it replaces carries'
    USING ERRCODE = '23514', CONSTRAINT = 'pickup_request_exception_chain';
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_request_exception_chain() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_request_exception_chain() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pickup_request_exception_chain" BEFORE INSERT OR UPDATE ON "pickup_request"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_request_exception_chain();
--> statement-breakpoint
-- THE LOCK OF A REQUEST BEING ASKED ABOUT. Raising an exception reads the request under its lock (`for update`), so that two operations on one
-- request, and the confirmation that holds an ETag of it, are put in a line. A row lock must also pass the UPDATE policy of its table, and
-- the key that raises an exception is not one that changes a request, so the request would not be found. This policy admits the lock for
-- that key and for no other, in the hubs of the grant, and its check is false: the key can lock a request and can never change one. (The
-- pattern of the vendor account's lock, 0034.)
CREATE POLICY "pickup_request_exception_lock" ON "pickup_request" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.exception.request'
      AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN false
    ELSE false
  END
);
