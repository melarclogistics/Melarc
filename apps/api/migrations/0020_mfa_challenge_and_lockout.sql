-- The MFA challenge and the credential's failed-attempt count and lock time (S0.32). Applied as melarc_migration_elevated, a member of
-- melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). Everything created here is owned by melarc_owner; no runtime role owns anything.
--
-- Two changes, both classified in data-scope-registry.md section 4 (MfaChallenge, StaffIdentity). The CREATE TABLE, ADD COLUMN, foreign
-- key, index and check statements are the generated part (drizzle-kit, from src/staff/mfa-challenge.schema.ts and
-- src/staff/staff-identity.schema.ts); the rest of this file is written by hand and is in this migration so that the table never exists
-- for a moment without its owner, row-level security, policies, grants and guards, and the new columns are never writable by a login
-- that should not write them.
--
-- mfa_challenge: what a privileged sign-in returns instead of a session once the password is proved. Row-level security, forced: the
-- authentication capability alone reads it, creates it (PENDING, no wrong code yet) and updates it, and nothing else reaches a row (the
-- closed ELSE). Grants to the API runtime: SELECT and INSERT, and an UPDATE of the two columns a challenge's life changes (state,
-- attempt_count), never table-wide, so the identity, the credential it was issued on and its two instants cannot be written by any request.
-- No DELETE for anyone: a challenge ends in a terminal state and stays as the history of a sign-in (its retention is the retention
-- cleanup's, S0.19, which is not extended here: see the plan, section 7.25). The guards hold the rest whoever writes: an insert is a
-- PENDING challenge with no wrong code on the credential the identity holds now; an update keeps everything but the state and the count,
-- only a PENDING challenge changes, the count rises by one and never falls, a challenge expires only once its time has passed and is
-- consumed only before it, and the three other states are terminal and never rewritten.
--
-- staff_identity: failed_attempt_count and locked_until sit on the credential (SECURITY_DESIGN.md section 13.4b; domain-model.md section
-- 6.8, Failed attempts and lockout), so an identifier that does not exist has none, and neither is returned by any operation or part of the
-- record's version (the table has no version column that an update of them could move). The API runtime gets SELECT and UPDATE of exactly
-- these two columns: one atomic conditional statement adds a failure unless the credential is already locked, and another clears both.
-- The credential's own columns and their guard are unchanged.

CREATE TABLE "mfa_challenge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_identity_id" uuid NOT NULL,
	"credential_generation" bigint NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "mfa_challenge_state_closed" CHECK ("mfa_challenge"."state" IN ('PENDING', 'CONSUMED', 'EXPIRED', 'UNUSABLE')),
	CONSTRAINT "mfa_challenge_credential_generation_positive" CHECK ("mfa_challenge"."credential_generation" >= 1),
	CONSTRAINT "mfa_challenge_expiry_after_issue" CHECK ("mfa_challenge"."expires_at" > "mfa_challenge"."issued_at"),
	CONSTRAINT "mfa_challenge_attempts_non_negative" CHECK ("mfa_challenge"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "staff_identity" ADD COLUMN "failed_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_identity" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mfa_challenge" ADD CONSTRAINT "mfa_challenge_identity_fkey" FOREIGN KEY ("staff_identity_id") REFERENCES "public"."staff_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mfa_challenge_identity_idx" ON "mfa_challenge" USING btree ("staff_identity_id","id");--> statement-breakpoint
ALTER TABLE "staff_identity" ADD CONSTRAINT "staff_identity_failed_attempts_non_negative" CHECK ("staff_identity"."failed_attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "staff_identity" ADD CONSTRAINT "staff_identity_lock_has_failures" CHECK ("staff_identity"."locked_until" IS NULL OR ("staff_identity"."failed_attempt_count" > 0 AND "staff_identity"."credential_generation" > 0));--> statement-breakpoint
ALTER TABLE "mfa_challenge" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "mfa_challenge" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mfa_challenge" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "mfa_challenge_select" ON "mfa_challenge" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "mfa_challenge_insert" ON "mfa_challenge" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND state = 'PENDING' AND attempt_count = 0
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "mfa_challenge_update" ON "mfa_challenge" FOR UPDATE USING (
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
GRANT SELECT, INSERT ON "mfa_challenge" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("state", "attempt_count") ON "mfa_challenge" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ("failed_attempt_count", "locked_until") ON "staff_identity" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("failed_attempt_count", "locked_until") ON "staff_identity" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.mfa_challenge_insert_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM 'PENDING' OR NEW.attempt_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'an MFA challenge is issued PENDING and with no wrong code' USING ERRCODE = '23514';
  END IF;
  -- The challenge records the credential the password step proved: it must be the one the identity holds now, so that a challenge is
  -- never issued on a credential that is not the current one. (The foreign key refuses an identity that is not there.)
  IF NOT EXISTS (SELECT 1 FROM public.staff_identity s
                  WHERE s.id = NEW.staff_identity_id AND s.credential_generation = NEW.credential_generation) THEN
    RAISE EXCEPTION 'an MFA challenge is issued on the credential its identity holds now' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.mfa_challenge_insert_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.mfa_challenge_insert_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "mfa_challenge_insert_guard" BEFORE INSERT ON "mfa_challenge"
  FOR EACH ROW EXECUTE FUNCTION melarc.mfa_challenge_insert_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.mfa_challenge_update_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.staff_identity_id IS DISTINCT FROM OLD.staff_identity_id
     OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'an MFA challenge keeps everything but its state and its count of wrong codes' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count THEN
    IF OLD.state IS DISTINCT FROM 'PENDING' THEN
      -- Consumed, expired and unusable are terminal: another sign-in is a new challenge, never this one brought back.
      RAISE EXCEPTION 'only a PENDING challenge changes' USING ERRCODE = '23514';
    END IF;
    IF NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'the count of wrong codes of a challenge rises by one and never falls' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'CONSUMED' AND OLD.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'a challenge is consumed only while it has not expired' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'EXPIRED' AND OLD.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'a challenge expires only when its time has passed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.mfa_challenge_update_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.mfa_challenge_update_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "mfa_challenge_update_guard" BEFORE UPDATE ON "mfa_challenge"
  FOR EACH ROW EXECUTE FUNCTION melarc.mfa_challenge_update_guard();
