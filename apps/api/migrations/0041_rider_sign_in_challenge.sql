-- The rider's sign-in challenge (S0.59). Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section
-- 5.1). Everything created here is owned by melarc_owner; no runtime role owns anything. Forward-only: it adds one table and amends nothing
-- an earlier migration made.
--
-- The CREATE TABLE, foreign key and index statements are the generated part (drizzle-kit, from src/staff/rider-sign-in-challenge.schema.ts);
-- the rest of this file is written by hand and is in this migration so that the table never exists for a moment without its owner,
-- row-level security, policies, grants and guards. Classified in data-scope-registry.md section 4 (RiderSignInChallenge).
--
-- rider_sign_in_challenge: the single-use nonce a rider's handset signs with its registered key (SECURITY_DESIGN.md sections 13.4b and
-- 13.6). It grants nothing and carries no authority; it lives authentication_challenge_ttl_minutes (5) and ANY presentation of it ends it,
-- a failed signature as well as a successful one. Row-level security, forced: the authentication capability alone reads it, creates it
-- (PENDING) and updates it, and nothing else reaches a row (the closed ELSE). Grants to the API runtime: SELECT and INSERT, and an UPDATE of
-- the one column a challenge's life changes (state), never table-wide, so the rider it names, the number and device it is bound to, its
-- hash and its two instants cannot be written by any request. No DELETE for anyone: a challenge ends in a terminal state and stays as the
-- history of a sign-in (its retention is the retention cleanup's, which is not extended here: plan section 7.47).
-- The guards hold the rest whoever writes: an insert is a PENDING challenge; an update keeps everything but the state, only a PENDING
-- challenge changes, it is consumed only before its time has passed (and states that reason when it lost a race with the clock) and
-- expired only after, and the three other states are terminal and never rewritten.
-- A challenge issued to a number that matched no rider has no rider and no device context (a CHECK): issuance discloses neither.

CREATE TABLE "rider_sign_in_challenge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rider_identity_id" uuid,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"nonce_hash" "bytea" NOT NULL,
	"phone_hash" "bytea" NOT NULL,
	"purpose" text NOT NULL,
	"audience" text NOT NULL,
	"device_context_hash" "bytea",
	CONSTRAINT "rider_sign_in_challenge_state_closed" CHECK ("rider_sign_in_challenge"."state" IN ('PENDING', 'CONSUMED', 'EXPIRED', 'UNUSABLE')),
	CONSTRAINT "rider_sign_in_challenge_purpose_closed" CHECK ("rider_sign_in_challenge"."purpose" = 'RIDER_SIGN_IN'),
	CONSTRAINT "rider_sign_in_challenge_expiry_after_issue" CHECK ("rider_sign_in_challenge"."expires_at" > "rider_sign_in_challenge"."issued_at"),
	CONSTRAINT "rider_sign_in_challenge_hashes_whole" CHECK (octet_length("rider_sign_in_challenge"."nonce_hash") = 32 AND octet_length("rider_sign_in_challenge"."phone_hash") = 32
        AND ("rider_sign_in_challenge"."device_context_hash" IS NULL OR octet_length("rider_sign_in_challenge"."device_context_hash") = 32)),
	CONSTRAINT "rider_sign_in_challenge_audience_bounded" CHECK (length("rider_sign_in_challenge"."audience") BETWEEN 1 AND 128),
	CONSTRAINT "rider_sign_in_challenge_context_needs_rider" CHECK ("rider_sign_in_challenge"."device_context_hash" IS NULL OR "rider_sign_in_challenge"."rider_identity_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "rider_sign_in_challenge" ADD CONSTRAINT "rider_sign_in_challenge_rider_fkey" FOREIGN KEY ("rider_identity_id") REFERENCES "public"."rider_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rider_sign_in_challenge_nonce_key" ON "rider_sign_in_challenge" USING btree ("nonce_hash");--> statement-breakpoint
ALTER TABLE "rider_sign_in_challenge" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "rider_sign_in_challenge" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rider_sign_in_challenge" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rider_sign_in_challenge_select" ON "rider_sign_in_challenge" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "rider_sign_in_challenge_insert" ON "rider_sign_in_challenge" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND state = 'PENDING'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "rider_sign_in_challenge_update" ON "rider_sign_in_challenge" FOR UPDATE USING (
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
GRANT SELECT, INSERT ON "rider_sign_in_challenge" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("state") ON "rider_sign_in_challenge" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.rider_sign_in_challenge_insert_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'a rider sign-in challenge is issued PENDING' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.rider_sign_in_challenge_insert_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.rider_sign_in_challenge_insert_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "rider_sign_in_challenge_insert_guard" BEFORE INSERT ON "rider_sign_in_challenge"
  FOR EACH ROW EXECUTE FUNCTION melarc.rider_sign_in_challenge_insert_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.rider_sign_in_challenge_update_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.rider_identity_id IS DISTINCT FROM OLD.rider_identity_id
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.nonce_hash IS DISTINCT FROM OLD.nonce_hash
     OR NEW.phone_hash IS DISTINCT FROM OLD.phone_hash
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.audience IS DISTINCT FROM OLD.audience
     OR NEW.device_context_hash IS DISTINCT FROM OLD.device_context_hash THEN
    RAISE EXCEPTION 'a rider sign-in challenge keeps everything but its state' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state IS DISTINCT FROM 'PENDING' THEN
      -- Consumed, expired and unusable are terminal: another sign-in is a new challenge, never this one brought back.
      RAISE EXCEPTION 'only a PENDING challenge changes' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'CONSUMED' AND OLD.expires_at <= clock_timestamp() THEN
      -- The one refusal of this table that states a reason (migration 0021): the application answers it as an expired sign-in, and every
      -- other refusal of the guard stays a defect.
      RAISE EXCEPTION 'a challenge is consumed only while it has not expired'
        USING ERRCODE = '23514', DETAIL = 'reason=CHALLENGE_EXPIRED';
    END IF;
    IF NEW.state = 'EXPIRED' AND OLD.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'a challenge expires only when its time has passed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.rider_sign_in_challenge_update_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.rider_sign_in_challenge_update_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "rider_sign_in_challenge_update_guard" BEFORE UPDATE ON "rider_sign_in_challenge"
  FOR EACH ROW EXECUTE FUNCTION melarc.rider_sign_in_challenge_update_guard();
