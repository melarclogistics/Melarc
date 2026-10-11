-- The idempotency record (S0.12). Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
-- Everything created here is owned by melarc_owner; no runtime role owns anything.
--
-- One table, idempotency_record, class SYSTEM in data-scope-registry.md section 4 and section 6 (IdempotencyRecord): a principal
-- reaches only its own records. The CREATE TABLE below is the generated part (drizzle-kit, from
-- src/platform/database/schema/idempotency.ts); the rest of this file is written by hand and is in this migration so that the
-- table never exists for a moment without its owner, row-level security, policies, grants and guard.
--
-- Row-level security:
--   * STAFF, VENDOR and RIDER read, insert and update the records whose principal is themselves, and no others. Another principal
--     with the same text key is a separate record, and is not even visible (SECURITY_DESIGN.md section 14.16);
--   * SYSTEM under the authentication capability reaches a record only to erase its sealed replay, and inserts none: it is the
--     context in which the transaction that consumes, supersedes or revokes a grant erases the sealed replay of the record that
--     grant belongs to (the registry: "erasing the sealed columns only"). So the policies admit it to the records that still hold
--     a sealed replay (to update, and to read), and to the update that leaves none and sets the tombstone (WITH CHECK): it
--     completes no command in progress, cannot lengthen the window of a replay, and reads no saved answer but those of records
--     that hold or held a sealed replay. A record that held one stays readable to it (the SELECT policy also admits the
--     tombstone) because PostgreSQL checks the row an UPDATE leaves behind against the SELECT policy: without that the erasure
--     itself would be refused. Only registerRiderDevice records ever hold one. The guard trigger below holds every updater,
--     this one included, to the same rules for a record that is completed;
--   * everything else, a request with no context included, reads and writes nothing (the closed ELSE).
--
-- Grants: SELECT, INSERT and UPDATE to the API runtime and nothing else. No DELETE, for any identity: no row of the registry gives
-- one, and who reclaims a record after idempotency_record_ttl_hours is the Product Owner's decision (plan section 7.14). The
-- worker's grant to erase sealed columns, for the retention cleanup, arrives with S0.19 (migration 0010); it erases and never deletes.
--
-- The guard trigger keeps three rules whoever updates: a record never changes who it belongs to, what it was asked or when it was
-- made; a completed record keeps its answer byte for byte (that is what makes a replay identical to the first answer); and the
-- sealed fields can only be erased, which leaves the tombstone that says they were there (SECURITY_DESIGN.md section 14.16).

CREATE TABLE "idempotency_record" (
	"id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"response_status" smallint,
	"response_body" "bytea",
	"sealed_ciphertext" "bytea",
	"sealed_nonce" "bytea",
	"sealed_key_version" integer,
	"sealed_envelope_version" smallint,
	"sealed_expires_at" timestamp with time zone,
	"replay_unavailable_at" timestamp with time zone,
	CONSTRAINT "idempotency_record_pkey" PRIMARY KEY("principal_type","principal_id","operation_id","idempotency_key"),
	CONSTRAINT "idempotency_record_id_key" UNIQUE("id"),
	CONSTRAINT "idempotency_record_principal_closed" CHECK ("idempotency_record"."principal_type" IN ('STAFF', 'RIDER', 'VENDOR')),
	CONSTRAINT "idempotency_record_operation_grammar" CHECK ("idempotency_record"."operation_id" ~ '^[A-Za-z][A-Za-z0-9]{0,63}$'),
	CONSTRAINT "idempotency_record_key_bounded" CHECK (length("idempotency_record"."idempotency_key") BETWEEN 1 AND 128),
	CONSTRAINT "idempotency_record_fingerprint_hex" CHECK ("idempotency_record"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_record_state_closed" CHECK ("idempotency_record"."state" IN ('IN_PROGRESS', 'COMPLETED')),
	CONSTRAINT "idempotency_record_answer_when_completed" CHECK (("idempotency_record"."state" = 'COMPLETED' AND "idempotency_record"."response_status" IS NOT NULL AND "idempotency_record"."response_body" IS NOT NULL AND "idempotency_record"."completed_at" IS NOT NULL)
        OR ("idempotency_record"."state" = 'IN_PROGRESS' AND "idempotency_record"."response_status" IS NULL AND "idempotency_record"."response_body" IS NULL AND "idempotency_record"."completed_at" IS NULL)),
	CONSTRAINT "idempotency_record_status_range" CHECK ("idempotency_record"."response_status" IS NULL OR "idempotency_record"."response_status" BETWEEN 100 AND 599),
	CONSTRAINT "idempotency_record_sealed_is_whole" CHECK (("idempotency_record"."sealed_ciphertext" IS NULL) = ("idempotency_record"."sealed_nonce" IS NULL)
        AND ("idempotency_record"."sealed_ciphertext" IS NULL) = ("idempotency_record"."sealed_key_version" IS NULL)
        AND ("idempotency_record"."sealed_ciphertext" IS NULL) = ("idempotency_record"."sealed_envelope_version" IS NULL)
        AND ("idempotency_record"."sealed_ciphertext" IS NULL) = ("idempotency_record"."sealed_expires_at" IS NULL)),
	CONSTRAINT "idempotency_record_sealed_xor_tombstone" CHECK ("idempotency_record"."sealed_ciphertext" IS NULL OR "idempotency_record"."replay_unavailable_at" IS NULL),
	CONSTRAINT "idempotency_record_sealed_only_when_completed" CHECK ("idempotency_record"."sealed_ciphertext" IS NULL OR "idempotency_record"."state" = 'COMPLETED')
);
--> statement-breakpoint
ALTER TABLE "idempotency_record" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "idempotency_record" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "idempotency_record" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "idempotency_record_select" ON "idempotency_record" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN principal_type = 'STAFF' AND principal_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN principal_type = 'VENDOR' AND principal_id = melarc.current_principal_id()
    WHEN 'RIDER' THEN principal_type = 'RIDER' AND principal_id = melarc.current_principal_id()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND (sealed_ciphertext IS NOT NULL OR replay_unavailable_at IS NOT NULL)
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "idempotency_record_insert" ON "idempotency_record" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN principal_type = 'STAFF' AND principal_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN principal_type = 'VENDOR' AND principal_id = melarc.current_principal_id()
    WHEN 'RIDER' THEN principal_type = 'RIDER' AND principal_id = melarc.current_principal_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "idempotency_record_update" ON "idempotency_record" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN principal_type = 'STAFF' AND principal_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN principal_type = 'VENDOR' AND principal_id = melarc.current_principal_id()
    WHEN 'RIDER' THEN principal_type = 'RIDER' AND principal_id = melarc.current_principal_id()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND sealed_ciphertext IS NOT NULL
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN principal_type = 'STAFF' AND principal_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN principal_type = 'VENDOR' AND principal_id = melarc.current_principal_id()
    WHEN 'RIDER' THEN principal_type = 'RIDER' AND principal_id = melarc.current_principal_id()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND sealed_ciphertext IS NULL AND replay_unavailable_at IS NOT NULL
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "idempotency_record" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.idempotency_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.principal_type IS DISTINCT FROM OLD.principal_type
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an idempotency record keeps its identity, its fingerprint and its creation time' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'COMPLETED' THEN
    -- A saved answer is never replaced: that is what makes a replay identical to the first answer.
    IF NEW.state IS DISTINCT FROM OLD.state
       OR NEW.response_status IS DISTINCT FROM OLD.response_status
       OR NEW.response_body IS DISTINCT FROM OLD.response_body
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'a completed idempotency record keeps its answer' USING ERRCODE = '23514';
    END IF;
    -- The sealed fields only ever go: erased together, with the tombstone set in the same update, and never put back.
    IF NEW.sealed_ciphertext IS DISTINCT FROM OLD.sealed_ciphertext
       OR NEW.sealed_nonce IS DISTINCT FROM OLD.sealed_nonce
       OR NEW.sealed_key_version IS DISTINCT FROM OLD.sealed_key_version
       OR NEW.sealed_envelope_version IS DISTINCT FROM OLD.sealed_envelope_version
       OR NEW.sealed_expires_at IS DISTINCT FROM OLD.sealed_expires_at THEN
      IF NOT (OLD.sealed_ciphertext IS NOT NULL AND NEW.sealed_ciphertext IS NULL AND NEW.replay_unavailable_at IS NOT NULL) THEN
        RAISE EXCEPTION 'the sealed replay of an idempotency record can only be erased' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.replay_unavailable_at IS DISTINCT FROM OLD.replay_unavailable_at
       AND NOT (OLD.replay_unavailable_at IS NULL AND NEW.replay_unavailable_at IS NOT NULL AND OLD.sealed_ciphertext IS NOT NULL AND NEW.sealed_ciphertext IS NULL) THEN
      RAISE EXCEPTION 'the tombstone of an idempotency record is set once, with the erasure' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- A record in progress has no tombstone yet; it completes, or it stays as it is.
    IF NEW.replay_unavailable_at IS NOT NULL THEN
      RAISE EXCEPTION 'only a completed idempotency record can have its sealed replay erased' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.idempotency_record_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.idempotency_record_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "idempotency_record_guard" BEFORE UPDATE ON "idempotency_record"
  FOR EACH ROW EXECUTE FUNCTION melarc.idempotency_record_guard();
