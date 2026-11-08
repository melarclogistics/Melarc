-- The setup grant and the MFA factor (S0.29). Applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). Everything created here is owned by melarc_owner; no runtime role owns anything.
--
-- Two tables, both classified in data-scope-registry.md section 4 (SetupGrant, MfaFactor). The CREATE TABLE, foreign key and index
-- statements are the generated part (drizzle-kit, from src/platform/database/schema/setup-grant.ts and src/staff/mfa-factor.schema.ts,
-- whose headers explain every column); the rest of this file is written by hand and is in this migration so that neither table ever
-- exists for a moment without its owner, row-level security, policies, grants and guards. No row is written here and no operation
-- issues a grant to a person yet: the bootstrap seed (S0.30) and the credential operations (S0.31, S0.36) do.
--
-- Row-level security, on both tables: the authentication capability alone reaches the rows of the pre-authentication paths (a grant is
-- presented by someone with no session, and a factor is read to prove a code), as a SYSTEM context. A staff, vendor or rider
-- principal reads and writes nothing here (the closed ELSE): the reads the registry lists for "self" and for the administrative keys
-- (listing a principal's grants, the derived mfa_enrolled boolean) come with the operations that need them, as policies of their own.
-- On setup_grant the delivery worker's capability, credential_delivery, also reads (registry section 5.2: "state and expiry only"):
-- its privilege is three columns, so it cannot read the hash, the principal, the purpose or the lineage.
--
-- Grants: the API runtime SELECTs and INSERTs setup_grant and UPDATEs the two columns a grant's life changes (state and the moment of
-- consumption); on mfa_factor it SELECTs, INSERTs and UPDATEs the seven columns a factor's life changes (status, enrolled_at,
-- revoked_at, last_verified_counter, revoked_by, revocation_reason_code, revocation_episode_id), never table-wide. The lineage
-- (episode_id, supersedes_grant_id, continued_from_grant_id; staff_identity_id, created_by_purpose, created_episode_id) is written at
-- insert and no login holds UPDATE on it. No identity holds DELETE or TRUNCATE on either table: a grant ends, a factor is revoked,
-- and neither is removed (the history stays readable).
--
-- The guard triggers keep the rest true whoever writes (each message names a rule and never a value):
--   * setup_grant, before insert: a grant is issued PENDING and unconsumed; a reissue names a SUPERSEDED grant of the same purpose and
--     episode; a continuation names the CONSUMED grant of the same episode that produced it, of one of the three purposes that create a
--     factor. The principal is the composite foreign key's: a trigger that checked it would answer before the key does;
--   * setup_grant, before update: nothing but state and consumed_at ever changes; only a PENDING grant changes state; a grant is
--     consumed only while it has not expired and expires only once its expiry has passed, both on the database's clock;
--   * mfa_factor, before insert: a factor is created PENDING;
--   * mfa_factor, before update: the identity, the type, the purpose and the creating episode never change; a REVOKED factor stays as it
--     ended; a proven factor never returns to PENDING; the enrolment moment is written once; the step of the last accepted code only
--     moves forward; and revocation_episode_id has exactly one legal write, from null to an episode, in the statement that revokes the
--     factor with an administrator named (domain-model.md section 6.8);
--   * mfa_factor, deferred to commit: an episode a factor carries (the one it was created in, the one it was revoked into) is carried
--     by a grant of the same identity, so that "another principal's episode" is refused whatever order the reset's own statements ran in.

CREATE TABLE "setup_grant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"state" text NOT NULL,
	"issued_by" uuid,
	"episode_id" uuid,
	"supersedes_grant_id" uuid,
	"continued_from_grant_id" uuid,
	"attestation_challenge_hash" "bytea",
	"consumed_at" timestamp with time zone,
	CONSTRAINT "setup_grant_principal_key" UNIQUE("id","principal_type","principal_id"),
	CONSTRAINT "setup_grant_principal_closed" CHECK ("setup_grant"."principal_type" IN ('STAFF', 'RIDER', 'VENDOR')),
	CONSTRAINT "setup_grant_purpose_closed" CHECK ("setup_grant"."purpose" IN ('STAFF_CREDENTIAL_SETUP', 'MFA_ENROLMENT', 'MFA_REENROLMENT', 'BOOTSTRAP_SETUP', 'RIDER_DEVICE_ENROLMENT', 'RIDER_DEVICE_REREGISTRATION', 'VENDOR_CREDENTIAL_SETUP', 'VENDOR_DEVICE_ENROLMENT')),
	CONSTRAINT "setup_grant_state_closed" CHECK ("setup_grant"."state" IN ('PENDING', 'CONSUMED', 'EXPIRED', 'SUPERSEDED')),
	CONSTRAINT "setup_grant_purpose_by_principal" CHECK (("setup_grant"."principal_type" = 'STAFF' AND "setup_grant"."purpose" IN ('STAFF_CREDENTIAL_SETUP', 'MFA_ENROLMENT', 'MFA_REENROLMENT', 'BOOTSTRAP_SETUP'))
        OR ("setup_grant"."principal_type" = 'RIDER' AND "setup_grant"."purpose" IN ('RIDER_DEVICE_ENROLMENT', 'RIDER_DEVICE_REREGISTRATION'))
        OR ("setup_grant"."principal_type" = 'VENDOR' AND "setup_grant"."purpose" IN ('VENDOR_CREDENTIAL_SETUP', 'VENDOR_DEVICE_ENROLMENT'))),
	CONSTRAINT "setup_grant_token_hash_is_sha256" CHECK (octet_length("setup_grant"."token_hash") = 32),
	CONSTRAINT "setup_grant_expiry_by_purpose" CHECK (("setup_grant"."expires_at" IS NULL) = ("setup_grant"."purpose" = 'BOOTSTRAP_SETUP')
        AND ("setup_grant"."expires_at" IS NULL OR "setup_grant"."expires_at" > "setup_grant"."issued_at")),
	CONSTRAINT "setup_grant_consumed_whole" CHECK (("setup_grant"."state" = 'CONSUMED') = ("setup_grant"."consumed_at" IS NOT NULL)
        AND ("setup_grant"."consumed_at" IS NULL OR "setup_grant"."consumed_at" >= "setup_grant"."issued_at")),
	CONSTRAINT "setup_grant_episode_by_purpose" CHECK ("setup_grant"."episode_id" IS NULL OR "setup_grant"."purpose" IN ('MFA_REENROLMENT', 'MFA_ENROLMENT')),
	CONSTRAINT "setup_grant_attestation_by_purpose" CHECK (("setup_grant"."purpose" IN ('RIDER_DEVICE_ENROLMENT', 'RIDER_DEVICE_REREGISTRATION')) = ("setup_grant"."attestation_challenge_hash" IS NOT NULL)
        AND ("setup_grant"."attestation_challenge_hash" IS NULL OR octet_length("setup_grant"."attestation_challenge_hash") = 32)),
	CONSTRAINT "setup_grant_one_lineage" CHECK (NOT ("setup_grant"."supersedes_grant_id" IS NOT NULL AND "setup_grant"."continued_from_grant_id" IS NOT NULL)),
	CONSTRAINT "setup_grant_no_self_lineage" CHECK ("setup_grant"."supersedes_grant_id" IS DISTINCT FROM "setup_grant"."id" AND "setup_grant"."continued_from_grant_id" IS DISTINCT FROM "setup_grant"."id"),
	CONSTRAINT "setup_grant_continuation_is_enrolment" CHECK ("setup_grant"."continued_from_grant_id" IS NULL OR "setup_grant"."purpose" = 'MFA_ENROLMENT')
);
--> statement-breakpoint
ALTER TABLE "setup_grant" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "setup_grant" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "setup_grant" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "setup_grant_select_issuer" ON "setup_grant" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_select_worker" ON "setup_grant" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'credential_delivery'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_insert" ON "setup_grant" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND state = 'PENDING'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_update" ON "setup_grant" FOR UPDATE USING (
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
GRANT SELECT, INSERT ON "setup_grant" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("state", "consumed_at") ON "setup_grant" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ("id", "state", "expires_at") ON "setup_grant" TO melarc_worker_cap_credential_delivery;
--> statement-breakpoint
CREATE FUNCTION melarc.setup_grant_insert_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target record;
BEGIN
  IF NEW.state IS DISTINCT FROM 'PENDING' OR NEW.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a setup grant is issued PENDING and unconsumed' USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_grant_id IS NOT NULL THEN
    SELECT g.state, g.purpose, g.episode_id INTO target FROM public.setup_grant g WHERE g.id = NEW.supersedes_grant_id;
    -- A target that is not there is the foreign key's to refuse; one that is there, of another principal, is refused by the composite key
    -- as well, and by this rule too when it is of another purpose.
    IF FOUND AND (target.state IS DISTINCT FROM 'SUPERSEDED'
                  OR target.purpose IS DISTINCT FROM NEW.purpose
                  OR target.episode_id IS DISTINCT FROM NEW.episode_id) THEN
      RAISE EXCEPTION 'a reissue supersedes a SUPERSEDED grant of the same purpose and episode' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.continued_from_grant_id IS NOT NULL THEN
    SELECT g.state, g.purpose, g.episode_id INTO target FROM public.setup_grant g WHERE g.id = NEW.continued_from_grant_id;
    IF FOUND AND (target.state IS DISTINCT FROM 'CONSUMED'
                  OR target.episode_id IS DISTINCT FROM NEW.episode_id
                  OR target.purpose NOT IN ('STAFF_CREDENTIAL_SETUP', 'BOOTSTRAP_SETUP', 'MFA_REENROLMENT')) THEN
      RAISE EXCEPTION 'a continuation continues the CONSUMED grant of the same episode that produced it' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.setup_grant_insert_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.setup_grant_insert_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "setup_grant_insert_guard" BEFORE INSERT ON "setup_grant"
  FOR EACH ROW EXECUTE FUNCTION melarc.setup_grant_insert_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.setup_grant_update_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.principal_type IS DISTINCT FROM OLD.principal_type
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.episode_id IS DISTINCT FROM OLD.episode_id
     OR NEW.supersedes_grant_id IS DISTINCT FROM OLD.supersedes_grant_id
     OR NEW.continued_from_grant_id IS DISTINCT FROM OLD.continued_from_grant_id
     OR NEW.attestation_challenge_hash IS DISTINCT FROM OLD.attestation_challenge_hash THEN
    RAISE EXCEPTION 'a setup grant keeps everything but its state and the moment it was consumed' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    IF OLD.state IS DISTINCT FROM 'PENDING' THEN
      -- Consumed, expired and superseded are terminal: a later authorisation is a new grant, never this one brought back.
      RAISE EXCEPTION 'only a PENDING grant changes state' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'CONSUMED' AND OLD.expires_at IS NOT NULL AND OLD.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'a grant is consumed only while it has not expired' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'EXPIRED' AND (OLD.expires_at IS NULL OR OLD.expires_at > clock_timestamp()) THEN
      RAISE EXCEPTION 'a grant expires only when its expiry has passed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.setup_grant_update_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.setup_grant_update_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "setup_grant_update_guard" BEFORE UPDATE ON "setup_grant"
  FOR EACH ROW EXECUTE FUNCTION melarc.setup_grant_update_guard();
--> statement-breakpoint
CREATE TABLE "mfa_factor" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_identity_id" uuid NOT NULL,
	"factor_type" text NOT NULL,
	"status" text NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_nonce" "bytea" NOT NULL,
	"secret_key_version" integer NOT NULL,
	"secret_envelope_version" integer NOT NULL,
	"enrolled_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_verified_counter" text,
	"created_by_purpose" text NOT NULL,
	"revoked_by" uuid,
	"revocation_reason_code" text,
	"created_episode_id" uuid,
	"revocation_episode_id" uuid,
	CONSTRAINT "mfa_factor_type_closed" CHECK ("mfa_factor"."factor_type" IN ('TOTP')),
	CONSTRAINT "mfa_factor_status_closed" CHECK ("mfa_factor"."status" IN ('PENDING', 'ACTIVE', 'REVOKED')),
	CONSTRAINT "mfa_factor_purpose_closed" CHECK ("mfa_factor"."created_by_purpose" IN ('STAFF_CREDENTIAL_SETUP', 'BOOTSTRAP_SETUP', 'MFA_REENROLMENT')),
	CONSTRAINT "mfa_factor_secret_whole" CHECK (octet_length("mfa_factor"."secret_nonce") = 12
        AND octet_length("mfa_factor"."secret_ciphertext") > 16
        AND "mfa_factor"."secret_key_version" >= 1
        AND "mfa_factor"."secret_envelope_version" >= 1),
	CONSTRAINT "mfa_factor_enrolment_follows_status" CHECK (("mfa_factor"."status" <> 'PENDING' OR "mfa_factor"."enrolled_at" IS NULL)
        AND ("mfa_factor"."status" <> 'ACTIVE' OR "mfa_factor"."enrolled_at" IS NOT NULL)),
	CONSTRAINT "mfa_factor_revocation_follows_status" CHECK (("mfa_factor"."status" = 'REVOKED') = ("mfa_factor"."revoked_at" IS NOT NULL)),
	CONSTRAINT "mfa_factor_administrative_revocation_whole" CHECK (("mfa_factor"."revoked_by" IS NULL) = ("mfa_factor"."revocation_reason_code" IS NULL)
        AND ("mfa_factor"."revoked_by" IS NULL) = ("mfa_factor"."revocation_episode_id" IS NULL)
        AND ("mfa_factor"."revocation_reason_code" IS NULL OR length(btrim("mfa_factor"."revocation_reason_code")) > 0)
        AND ("mfa_factor"."revoked_by" IS NULL OR "mfa_factor"."status" = 'REVOKED')),
	CONSTRAINT "mfa_factor_actor_is_not_target" CHECK ("mfa_factor"."revoked_by" IS DISTINCT FROM "mfa_factor"."staff_identity_id"),
	CONSTRAINT "mfa_factor_episode_by_purpose" CHECK ("mfa_factor"."created_episode_id" IS NULL OR "mfa_factor"."created_by_purpose" = 'MFA_REENROLMENT'),
	CONSTRAINT "mfa_factor_counter_shape" CHECK ("mfa_factor"."last_verified_counter" IS NULL OR "mfa_factor"."last_verified_counter" ~ '^(0|[1-9][0-9]{0,18})$')
);
--> statement-breakpoint
ALTER TABLE "mfa_factor" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "mfa_factor" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mfa_factor" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "mfa_factor_select" ON "mfa_factor" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "mfa_factor_insert" ON "mfa_factor" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND status = 'PENDING'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "mfa_factor_update" ON "mfa_factor" FOR UPDATE USING (
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
GRANT SELECT, INSERT ON "mfa_factor" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("status", "enrolled_at", "revoked_at", "last_verified_counter", "revoked_by", "revocation_reason_code", "revocation_episode_id") ON "mfa_factor" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.mfa_factor_insert_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'a factor is created PENDING' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.mfa_factor_insert_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.mfa_factor_insert_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "mfa_factor_insert_guard" BEFORE INSERT ON "mfa_factor"
  FOR EACH ROW EXECUTE FUNCTION melarc.mfa_factor_insert_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.mfa_factor_update_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.staff_identity_id IS DISTINCT FROM OLD.staff_identity_id
     OR NEW.factor_type IS DISTINCT FROM OLD.factor_type
     OR NEW.created_by_purpose IS DISTINCT FROM OLD.created_by_purpose
     OR NEW.created_episode_id IS DISTINCT FROM OLD.created_episode_id THEN
    RAISE EXCEPTION 'a factor keeps its identity, its type, the purpose that created it and the episode it was created in' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'REVOKED' THEN
    -- Revoked is terminal: the record of why a factor ended, and by whom, is not rewritten, cleared or added to.
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'a REVOKED factor stays as it ended' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'PENDING' THEN
    RAISE EXCEPTION 'a factor is proven once and never returns to PENDING' USING ERRCODE = '23514';
  END IF;
  IF OLD.enrolled_at IS NOT NULL AND NEW.enrolled_at IS DISTINCT FROM OLD.enrolled_at THEN
    RAISE EXCEPTION 'the moment a factor was enrolled is set when it is proven and never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.last_verified_counter IS NOT NULL AND NEW.last_verified_counter IS DISTINCT FROM OLD.last_verified_counter THEN
    -- A code may not be accepted twice within its window: the step only moves forward. A value that is not a step is the CHECK's to refuse.
    IF NEW.last_verified_counter IS NULL
       OR (NEW.last_verified_counter ~ '^(0|[1-9][0-9]{0,18})$'
           AND NEW.last_verified_counter::numeric < OLD.last_verified_counter::numeric) THEN
      RAISE EXCEPTION 'the step of the last accepted code only moves forward' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.revocation_episode_id IS DISTINCT FROM OLD.revocation_episode_id THEN
    -- The one legal write: from null to an episode, in the statement that revokes the factor and names the administrator. Whether the
    -- episode is the same identity's is judged at commit (mfa_factor_episode_check), when the grant of the episode may have been written.
    IF OLD.revocation_episode_id IS NOT NULL
       OR NEW.revocation_episode_id IS NULL
       OR NEW.status IS DISTINCT FROM 'REVOKED'
       OR NEW.revoked_by IS NULL THEN
      RAISE EXCEPTION 'a revocation episode is written once, with an administrative revocation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.mfa_factor_update_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.mfa_factor_update_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "mfa_factor_update_guard" BEFORE UPDATE ON "mfa_factor"
  FOR EACH ROW EXECUTE FUNCTION melarc.mfa_factor_update_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.mfa_factor_episode_check() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Run at commit (the trigger is deferred), so a transaction that writes the revocation before the grant of its episode is judged
  -- on what it wrote, not on the order it wrote it in. The grant is read under the writer's own context.
  IF NEW.created_episode_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.setup_grant g
        WHERE g.principal_type = 'STAFF' AND g.principal_id = NEW.staff_identity_id AND g.episode_id = NEW.created_episode_id) THEN
    RAISE EXCEPTION 'an episode names a setup grant of the same identity' USING ERRCODE = '23503';
  END IF;
  IF NEW.revocation_episode_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.setup_grant g
        WHERE g.principal_type = 'STAFF' AND g.principal_id = NEW.staff_identity_id AND g.episode_id = NEW.revocation_episode_id) THEN
    RAISE EXCEPTION 'an episode names a setup grant of the same identity' USING ERRCODE = '23503';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.mfa_factor_episode_check() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.mfa_factor_episode_check() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "mfa_factor_episode_check" AFTER INSERT OR UPDATE OF "created_episode_id", "revocation_episode_id" ON "mfa_factor"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION melarc.mfa_factor_episode_check();
--> statement-breakpoint
ALTER TABLE "setup_grant" ADD CONSTRAINT "setup_grant_supersedes_fkey" FOREIGN KEY ("supersedes_grant_id","principal_type","principal_id") REFERENCES "public"."setup_grant"("id","principal_type","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_grant" ADD CONSTRAINT "setup_grant_continued_from_fkey" FOREIGN KEY ("continued_from_grant_id","principal_type","principal_id") REFERENCES "public"."setup_grant"("id","principal_type","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_factor" ADD CONSTRAINT "mfa_factor_staff_identity_fkey" FOREIGN KEY ("staff_identity_id") REFERENCES "public"."staff_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_factor" ADD CONSTRAINT "mfa_factor_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "public"."staff_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "setup_grant_token_hash_key" ON "setup_grant" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "setup_grant_one_pending_key" ON "setup_grant" USING btree ("principal_type","principal_id","purpose") WHERE "setup_grant"."state" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "setup_grant_supersedes_key" ON "setup_grant" USING btree ("supersedes_grant_id") WHERE "setup_grant"."supersedes_grant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "setup_grant_episode_idx" ON "setup_grant" USING btree ("principal_type","principal_id","episode_id") WHERE "setup_grant"."episode_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_factor_one_active_key" ON "mfa_factor" USING btree ("staff_identity_id") WHERE "mfa_factor"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "mfa_factor_identity_idx" ON "mfa_factor" USING btree ("staff_identity_id","id");
