-- S0.50 (`requestCredentialRecovery`), forward-only: nothing an earlier migration created is amended. Applied as
-- melarc_migration_elevated. The first statements are the generated part (drizzle-kit, from src/platform/database/schema/recovery-request.ts,
-- whose header explains every column); the rest is written by hand and is in this migration so that the table never exists for a moment
-- without its owner, row-level security, policies, grants and guards.
--
-- ROW-LEVEL SECURITY. The authentication capability alone reaches the rows of the pre-authentication paths (a request is made, and a link
-- redeemed, by someone with no session), as a SYSTEM context; the delivery worker's capability, credential_delivery, reads state and expiry
-- only (data-scope-registry.md section 5.2), by a three-column privilege, so it cannot read the hash, the principal or the channel. A staff,
-- vendor or rider principal reads and writes nothing here (the closed ELSE): an administrator's request (S0.51) comes with arms of its own.
--
-- GRANTS. The API runtime SELECTs and INSERTs and UPDATEs the two columns a request's life changes (state, consumed_at). The table-wide
-- SELECT is what lets a token be looked up by its hash (a column named in a condition needs the privilege); the store selects no hash back,
-- as the setup grant's does not. No identity holds DELETE or TRUNCATE: a request ends, and is never removed.
--
-- GUARDS (each message names a rule and never a value):
--   * before insert: a request is issued PENDING and unconsumed, **for an eligible principal** (credential-recovery.md section 5.7: a staff
--     identity ACTIVE or SUSPENDED with an established password; a vendor account ACTIVE or SUSPENDED with an established secret, the address
--     of its delivery channel registered and travelling by that channel, and an organisation ACTIVE or SUSPENDED), and **never as a third
--     live link** of the credential (a PENDING, unexpired request whose message did not end FAILED or CANCELLED). The operation decides both
--     under the identity's lock; the guard holds them for any writer. It reads the identity tables as the authentication capability reads
--     them and puts the caller's context back at once, as `setup_grant_vendor_guard` (0035) does.
--   * before update: nothing but state and consumed_at ever changes; only a PENDING request changes state; a request is consumed only while
--     it has not expired and expires only once its expiry has passed, both on the database's clock.

CREATE TABLE "recovery_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"initiated_by" uuid,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "recovery_request_principal_closed" CHECK ("recovery_request"."principal_type" IN ('STAFF', 'VENDOR')),
	CONSTRAINT "recovery_request_channel_closed" CHECK ("recovery_request"."channel" IN ('EMAIL', 'SMS')),
	CONSTRAINT "recovery_request_channel_by_principal" CHECK (("recovery_request"."principal_type" = 'STAFF' AND "recovery_request"."channel" IN ('EMAIL'))
        OR ("recovery_request"."principal_type" = 'VENDOR' AND "recovery_request"."channel" IN ('EMAIL', 'SMS'))),
	CONSTRAINT "recovery_request_state_closed" CHECK ("recovery_request"."state" IN ('PENDING', 'CONSUMED', 'EXPIRED', 'SUPERSEDED')),
	CONSTRAINT "recovery_request_token_hash_is_sha256" CHECK (octet_length("recovery_request"."token_hash") = 32),
	CONSTRAINT "recovery_request_expiry_after_issue" CHECK ("recovery_request"."expires_at" > "recovery_request"."issued_at"),
	CONSTRAINT "recovery_request_consumed_whole" CHECK (("recovery_request"."state" = 'CONSUMED') = ("recovery_request"."consumed_at" IS NOT NULL)
        AND ("recovery_request"."consumed_at" IS NULL OR "recovery_request"."consumed_at" >= "recovery_request"."issued_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_request_token_hash_key" ON "recovery_request" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "recovery_request_pending_idx" ON "recovery_request" USING btree ("principal_type","principal_id","issued_at") WHERE "recovery_request"."state" = 'PENDING';
--> statement-breakpoint
ALTER TABLE "recovery_request" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "recovery_request" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "recovery_request" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "recovery_request_select_issuer" ON "recovery_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "recovery_request_select_worker" ON "recovery_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'credential_delivery'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "recovery_request_insert" ON "recovery_request" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND state = 'PENDING' AND initiated_by IS NULL
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "recovery_request_update" ON "recovery_request" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT, INSERT ON "recovery_request" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("state", "consumed_at") ON "recovery_request" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ("id", "state", "expires_at") ON "recovery_request" TO melarc_worker_cap_credential_delivery;
--> statement-breakpoint
CREATE FUNCTION melarc.recovery_request_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  eligible boolean;
  live integer;
BEGIN
  IF NEW.state IS DISTINCT FROM 'PENDING' OR NEW.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a recovery request is issued PENDING and unconsumed' USING ERRCODE = '23514';
  END IF;
  -- The identity, its credential and the live links are read as the authentication capability reads them, and the caller's context is put
  -- back at once.
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
  IF NEW.principal_type = 'STAFF' THEN
    SELECT EXISTS (SELECT 1 FROM public.staff_identity AS i
                    WHERE i.id = NEW.principal_id AND i.status IN ('ACTIVE', 'SUSPENDED')
                      AND i.credential_generation > 0 AND i.credential_established_at IS NOT NULL)
      INTO eligible;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.vendor_account AS a
                     JOIN public.vendor_organization AS o ON o.id = a.vendor_organization_id
                     JOIN public.vendor_credential AS c ON c.vendor_account_id = a.id
                    WHERE a.id = NEW.principal_id AND a.status IN ('ACTIVE', 'SUSPENDED')
                      AND o.operational_status IN ('ACTIVE', 'SUSPENDED')
                      AND c.credential_generation > 0 AND c.credential_established_at IS NOT NULL
                      AND ((c.delivery_channel = 'EMAIL' AND c.recovery_email IS NOT NULL AND NEW.channel = 'EMAIL')
                           OR (c.delivery_channel = 'PHONE' AND c.recovery_phone IS NOT NULL AND NEW.channel = 'SMS')))
      INTO eligible;
  END IF;
  SELECT count(*) INTO live
    FROM public.recovery_request AS r
   WHERE r.principal_type = NEW.principal_type AND r.principal_id = NEW.principal_id
     AND r.state = 'PENDING' AND r.expires_at > pg_catalog.clock_timestamp()
     AND NOT EXISTS (SELECT 1 FROM public.credential_delivery_job AS j
                      WHERE j.redemption_record_type = 'RECOVERY_REQUEST' AND j.redemption_record_id = r.id
                        AND j.state IN ('FAILED', 'CANCELLED'));
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);

  IF NOT eligible THEN
    RAISE EXCEPTION 'a recovery request is issued to an eligible principal, by its registered channel' USING ERRCODE = '23514';
  END IF;
  IF live >= 2 THEN
    RAISE EXCEPTION 'a credential has at most two live recovery links' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.recovery_request_insert_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.recovery_request_insert_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "recovery_request_insert_guard" BEFORE INSERT ON "recovery_request"
  FOR EACH ROW EXECUTE FUNCTION melarc.recovery_request_insert_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.recovery_request_update_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.principal_type IS DISTINCT FROM OLD.principal_type
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by THEN
    RAISE EXCEPTION 'a recovery request keeps everything but its state and the moment it was consumed' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    IF OLD.state IS DISTINCT FROM 'PENDING' THEN
      -- Consumed, expired and superseded are terminal: a later recovery is a new request, never this one brought back.
      RAISE EXCEPTION 'only a PENDING recovery request changes state' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'CONSUMED' AND OLD.expires_at <= pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION 'a recovery request is consumed only while it has not expired' USING ERRCODE = '23514', DETAIL = 'reason=RECOVERY_EXPIRED';
    END IF;
    IF NEW.state = 'EXPIRED' AND OLD.expires_at > pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION 'a recovery request expires only when its expiry has passed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.recovery_request_update_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.recovery_request_update_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "recovery_request_update_guard" BEFORE UPDATE ON "recovery_request"
  FOR EACH ROW EXECUTE FUNCTION melarc.recovery_request_update_guard();
