-- The session and the minimal staff identity (S0.24). Applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). Everything created here is owned by melarc_owner; no runtime role owns anything.
--
-- Two tables, both classified in data-scope-registry.md section 4 (Session, StaffIdentity). The CREATE TABLE, foreign key and index
-- statements are the generated part (drizzle-kit, from src/platform/database/schema/session.ts and src/staff/staff-identity.schema.ts);
-- the rest of this file is written by hand and is in this migration so that neither table ever exists for a moment without its owner,
-- row-level security, policies, grants and guard.
--
-- Row-level security, on both tables:
--   * a SYSTEM context under the authentication capability alone reaches the rows of the pre-authentication paths (session lookup,
--     session issue, ending sessions, the identity lock of the issue protocol). Nothing else is SYSTEM here;
--   * STAFF reads its own staff_identity row and its own sessions; VENDOR and RIDER read their own sessions. Reading or ending
--     another principal's session (staff.session.revoke, staff.read) and the hub-scoped reads of other staff come with the
--     operations that need them (S0.35 and the session operations), as policies of their own;
--   * nothing is written by a human principal here: a session is inserted and ended by the authentication capability, and no
--     operation of this task inserts a staff identity (the bootstrap seed, S0.30, and createStaffIdentity do, and each brings its
--     own INSERT policy and grant: the API holds no INSERT on staff_identity, so it cannot insert origin BOOTSTRAP either);
--   * everything else, a request with no context included, reads and writes nothing (the closed ELSE).
--
-- Grants: to the API runtime, SELECT and INSERT on session and an UPDATE of the three columns a session's life changes
-- (last_activity_at, terminated_at, termination_reason): a column list, not the table, so that the token, the authority and the
-- expiry cannot be written by any request. On staff_identity, SELECT of every column but credential_hash, and an UPDATE of the three
-- credential columns only (the registry: "UPDATE of the credential record only"); that grant is also what lets the identity lock be
-- taken, because a row lock (FOR NO KEY UPDATE) needs UPDATE on at least one column. No DELETE for any identity on either table (a
-- session ends, an identity is offboarded; neither is removed).
--
-- The credential hash is not readable through the table by the API's runtime login, in any context: the runtime has no SELECT on that
-- column, so a staff member reading their own row (the policy admits it) cannot select it, and a statement that names it or says * is
-- refused. (The owner role and the migration login can read what they own; this is a boundary between application roles, not a claim
-- about administrators.) melarc.staff_credential_hash, a SECURITY DEFINER function that only the runtime may execute, returns it, and
-- only to a SYSTEM context under the authentication capability (sign-in verification, S0.32). The generation beside it says which
-- credential a sign-in verified: it rises by one when a credential is replaced and not when it is rehashed, and the moment of
-- establishment changes only with a new generation (and may repeat); the guard holds the generation to that.
--
-- The guard triggers keep the rest true whoever updates: a session's identity, token, authority and expiry never change, an ended
-- session stays as it ended, and its activity never moves back; a staff identity keeps its id, its origin, its maker and its creation
-- time (origin is immutable: a constraint refuses any change, domain-model.md section 6.8).

CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"bundle_snapshot" jsonb NOT NULL,
	"bundle_id" uuid NOT NULL,
	"bundle_revision" integer NOT NULL,
	"policy_revision" integer,
	"authorized_hub_ids" uuid[] NOT NULL,
	"registered_device_id" uuid,
	"client_root_signal" text,
	"token_hash" "bytea" NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"csrf_token_hash" "bytea",
	"terminated_at" timestamp with time zone,
	"termination_reason" text,
	CONSTRAINT "session_principal_closed" CHECK ("session"."principal_type" IN ('STAFF', 'RIDER', 'VENDOR')),
	CONSTRAINT "session_token_hash_is_sha256" CHECK (octet_length("session"."token_hash") = 32),
	CONSTRAINT "session_csrf_token_hash_is_sha256" CHECK ("session"."csrf_token_hash" IS NULL OR octet_length("session"."csrf_token_hash") = 32),
	CONSTRAINT "session_csrf_by_principal" CHECK (("session"."principal_type" = 'RIDER') = ("session"."csrf_token_hash" IS NULL)),
	CONSTRAINT "session_bundle_revision_positive" CHECK ("session"."bundle_revision" >= 1),
	CONSTRAINT "session_policy_revision_by_principal" CHECK (("session"."principal_type" = 'STAFF' AND "session"."policy_revision" IS NULL)
        OR ("session"."principal_type" IN ('VENDOR', 'RIDER') AND "session"."policy_revision" IS NOT NULL AND "session"."policy_revision" >= 1)),
	CONSTRAINT "session_device_by_principal" CHECK (("session"."principal_type" = 'STAFF') = ("session"."registered_device_id" IS NULL)),
	CONSTRAINT "session_root_signal_rider_only" CHECK ("session"."client_root_signal" IS NULL OR ("session"."principal_type" = 'RIDER' AND "session"."client_root_signal" IN ('NOT_DETECTED', 'DETECTED', 'UNKNOWN'))),
	CONSTRAINT "session_snapshot_is_object" CHECK (jsonb_typeof("session"."bundle_snapshot") = 'object'),
	CONSTRAINT "session_hub_ids_not_null" CHECK (array_position("session"."authorized_hub_ids", NULL) IS NULL),
	CONSTRAINT "session_expires_after_issue" CHECK ("session"."expires_at" > "session"."issued_at"),
	CONSTRAINT "session_activity_not_before_issue" CHECK ("session"."last_activity_at" >= "session"."issued_at"),
	CONSTRAINT "session_termination_whole" CHECK (("session"."terminated_at" IS NULL) = ("session"."termination_reason" IS NULL)),
	CONSTRAINT "session_termination_reason_closed" CHECK ("session"."termination_reason" IS NULL OR "session"."termination_reason" IN ('SIGNED_OUT', 'SUPERSEDED_BY_NEW_LOGIN', 'REPLACED_BY_NEW_SESSION', 'EXPIRED', 'CREDENTIAL_CHANGED', 'SUSPENDED', 'OFFBOARDED', 'ADMIN_REVOKED', 'AUTHORITY_CHANGED', 'HUB_SCOPE_CHANGED', 'DEVICE_REVOKED', 'DEVICE_REPLACED', 'MFA_RESET')),
	CONSTRAINT "session_terminated_not_before_issue" CHECK ("session"."terminated_at" IS NULL OR "session"."terminated_at" >= "session"."issued_at")
);
--> statement-breakpoint
ALTER TABLE "session" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "session" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "session_select" ON "session" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN principal_type = 'STAFF' AND principal_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN principal_type = 'VENDOR' AND principal_id = melarc.current_principal_id()
    WHEN 'RIDER' THEN principal_type = 'RIDER' AND principal_id = melarc.current_principal_id()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "session_insert" ON "session" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "session_update" ON "session" FOR UPDATE USING (
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
GRANT SELECT, INSERT ON "session" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("last_activity_at", "terminated_at", "termination_reason") ON "session" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.principal_type IS DISTINCT FROM OLD.principal_type
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.bundle_snapshot IS DISTINCT FROM OLD.bundle_snapshot
     OR NEW.bundle_id IS DISTINCT FROM OLD.bundle_id
     OR NEW.bundle_revision IS DISTINCT FROM OLD.bundle_revision
     OR NEW.policy_revision IS DISTINCT FROM OLD.policy_revision
     OR NEW.authorized_hub_ids IS DISTINCT FROM OLD.authorized_hub_ids
     OR NEW.registered_device_id IS DISTINCT FROM OLD.registered_device_id
     OR NEW.client_root_signal IS DISTINCT FROM OLD.client_root_signal
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.csrf_token_hash IS DISTINCT FROM OLD.csrf_token_hash
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a session keeps its identity, its token, its authority and its expiry' USING ERRCODE = '23514';
  END IF;
  IF OLD.terminated_at IS NOT NULL THEN
    -- An ended session stays as it ended: the time and the reason it was ended with are the record of why a request was refused.
    IF NEW.terminated_at IS DISTINCT FROM OLD.terminated_at
       OR NEW.termination_reason IS DISTINCT FROM OLD.termination_reason
       OR NEW.last_activity_at IS DISTINCT FROM OLD.last_activity_at THEN
      RAISE EXCEPTION 'an ended session stays as it ended' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.last_activity_at IS DISTINCT FROM OLD.last_activity_at THEN
    IF NEW.last_activity_at < OLD.last_activity_at THEN
      RAISE EXCEPTION 'the activity of a session never moves back' USING ERRCODE = '23514';
    END IF;
    -- A few minutes ahead of the database clock are tolerated (a clock that stepped); an instant hours away would read as "not idle"
    -- for as long as it lasts, which switches the idle rule off for the session. An update that leaves the activity alone is not judged.
    IF NEW.last_activity_at > clock_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'the activity of a session is not recorded in the future' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.session_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.session_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "session_guard" BEFORE UPDATE ON "session"
  FOR EACH ROW EXECUTE FUNCTION melarc.session_guard();
--> statement-breakpoint
CREATE TABLE "staff_identity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"work_email" text NOT NULL,
	"work_email_canonical" text NOT NULL,
	"full_name" text NOT NULL,
	"status" text NOT NULL,
	"role_bundle_id" uuid NOT NULL,
	"primary_hub_id" uuid,
	"credential_hash" text,
	"credential_established_at" timestamp with time zone,
	"credential_generation" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_identity_status_closed" CHECK ("staff_identity"."status" IN ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'OFFBOARDED')),
	CONSTRAINT "staff_identity_origin_closed" CHECK ("staff_identity"."origin" IN ('BOOTSTRAP', 'MAKER_CHECKER')),
	CONSTRAINT "staff_identity_email_shape" CHECK (length("staff_identity"."work_email") BETWEEN 3 AND 320
        AND length("staff_identity"."work_email_canonical") BETWEEN 3 AND 320
        AND "staff_identity"."work_email_canonical" = btrim("staff_identity"."work_email_canonical")),
	CONSTRAINT "staff_identity_name_not_empty" CHECK (length(btrim("staff_identity"."full_name")) > 0),
	CONSTRAINT "staff_identity_checker_by_status" CHECK (("staff_identity"."status" = 'PENDING_APPROVAL') = ("staff_identity"."approved_by" IS NULL)),
	CONSTRAINT "staff_identity_checker_is_not_maker" CHECK ("staff_identity"."origin" = 'BOOTSTRAP' OR "staff_identity"."approved_by" IS NULL OR "staff_identity"."approved_by" <> "staff_identity"."created_by"),
	CONSTRAINT "staff_identity_credential_whole" CHECK (("staff_identity"."credential_hash" IS NULL) = ("staff_identity"."credential_established_at" IS NULL)
        AND ("staff_identity"."credential_hash" IS NULL) = ("staff_identity"."credential_generation" = 0)),
	CONSTRAINT "staff_identity_credential_generation_non_negative" CHECK ("staff_identity"."credential_generation" >= 0),
	CONSTRAINT "staff_identity_credential_bounded" CHECK ("staff_identity"."credential_hash" IS NULL OR length("staff_identity"."credential_hash") BETWEEN 1 AND 1024)
);
--> statement-breakpoint
ALTER TABLE "staff_identity" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "staff_identity" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "staff_identity" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "staff_identity_select" ON "staff_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN id = melarc.current_principal_id()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "staff_identity_update" ON "staff_identity" FOR UPDATE USING (
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
GRANT SELECT ("id", "work_email", "work_email_canonical", "full_name", "status", "role_bundle_id", "primary_hub_id", "credential_established_at", "credential_generation", "created_by", "approved_by", "origin", "created_at") ON "staff_identity" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("credential_hash", "credential_established_at", "credential_generation") ON "staff_identity" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.staff_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a staff identity keeps its id, its origin, its maker and its creation time' USING ERRCODE = '23514';
  END IF;
  -- The generation says which credential a sign-in verified, and it alone does: it only ever goes up, by one, when a credential is
  -- replaced, so a replacement cannot pass as the credential it replaced. The moment of establishment is for reading the history by
  -- and may repeat (a replacement at the very instant of the one it replaced is a replacement all the same): it changes only with a
  -- new generation, never alone. A rehash (the same credential at a new cost) changes the hash and neither of the two. The database
  -- cannot tell a replacement from a rehash by the hash string, so the writers of the credential keep the two apart (OB-128).
  IF NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
     AND NEW.credential_generation <> OLD.credential_generation + 1 THEN
    RAISE EXCEPTION 'a credential is replaced with its generation raised by one, and the generation never moves back' USING ERRCODE = '23514';
  END IF;
  IF NEW.credential_established_at IS DISTINCT FROM OLD.credential_established_at
     AND NEW.credential_generation = OLD.credential_generation THEN
    RAISE EXCEPTION 'the moment a credential was established changes only with a new generation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.staff_identity_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.staff_identity_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "staff_identity_guard" BEFORE UPDATE ON "staff_identity"
  FOR EACH ROW EXECUTE FUNCTION melarc.staff_identity_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.staff_credential_hash(identity_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- The hash is read by the authentication capability alone, whoever executes the function. The tables are forced to row-level
  -- security, so the owner running this function is held to the SYSTEM and authentication branch of the policy as well.
  IF melarc.principal_type() IS DISTINCT FROM 'SYSTEM' OR melarc.task_capability() IS DISTINCT FROM 'authentication' THEN
    RAISE EXCEPTION 'the credential of a staff identity is read under the authentication capability alone' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT s.credential_hash FROM public.staff_identity s WHERE s.id = identity_id);
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.staff_credential_hash(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.staff_credential_hash(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.staff_credential_hash(uuid) TO melarc_api_runtime;
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_bundle_fkey" FOREIGN KEY ("bundle_id") REFERENCES "public"."role_bundle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_identity" ADD CONSTRAINT "staff_identity_bundle_fkey" FOREIGN KEY ("role_bundle_id") REFERENCES "public"."role_bundle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_identity" ADD CONSTRAINT "staff_identity_primary_hub_fkey" FOREIGN KEY ("primary_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_hash_key" ON "session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "session_principal_live_idx" ON "session" USING btree ("principal_type","principal_id","id") WHERE "session"."terminated_at" IS NULL;--> statement-breakpoint
CREATE INDEX "session_bundle_live_idx" ON "session" USING btree ("bundle_id","bundle_revision","id") WHERE "session"."terminated_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_one_live_vendor_or_rider_key" ON "session" USING btree ("principal_type","principal_id") WHERE "session"."terminated_at" IS NULL AND "session"."principal_type" IN ('VENDOR', 'RIDER');--> statement-breakpoint
CREATE UNIQUE INDEX "staff_identity_work_email_live_key" ON "staff_identity" USING btree ("work_email_canonical") WHERE "staff_identity"."status" <> 'REJECTED';