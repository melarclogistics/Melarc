-- The durable credential-delivery job (S0.17). Applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). Everything created here is owned by melarc_owner; no runtime role owns anything.
--
-- One table, credential_delivery_job, class SYSTEM in data-scope-registry.md section 4 and section 6 (CredentialDeliveryJob): one
-- queued message per redemption record (SECURITY_DESIGN.md section 13.9a), holding the destination and the link only as a sealed
-- payload that is erased when the job ends. The CREATE TABLE and the indexes are the generated part (drizzle-kit, from
-- src/platform/database/schema/credential-delivery.ts, whose header explains every column); the rest of this file is written by
-- hand and is in this migration so that the table never exists for a moment without its owner, row-level security, policies,
-- grants and guard.
--
-- Row-level security: no business principal reaches the table (the closed ELSE: a staff member, a vendor and a rider read and
-- write nothing). Two SYSTEM capabilities do, each in policies of its own so that each names one capability:
--   * authentication (the API, in the transaction that issues or ends a credential) inserts a job that is QUEUED, reads the
--     key columns of any job (the privilege below limits it to those) and cancels a job that can still change;
--   * credential_delivery (the delivery worker) reads the whole row, which is how it decrypts a payload for the one send, and
--     updates a job that can still change: it leases, records an outcome, and erases the payload.
-- Nobody deletes: no policy and no grant allows it (the retention of a finished job's metadata is OQ-028, and no identity holds
-- DELETE in the registry).
--
-- Grants: the API runtime INSERTs, SELECTs the five columns that find a row to cancel it (never the payload, the destination, the
-- lease or even the job's own identifier, which nothing it does reads) and UPDATEs the seven a cancellation changes. The worker's capability role melarc_worker_cap_credential_delivery (a grant set no
-- one logs in as; provisioning puts it in front of the worker's login) SELECTs the row and UPDATEs the columns a lease and an
-- outcome change. Neither holds DELETE or TRUNCATE, and the worker holds no INSERT: only an issuing operation queues a message.
-- The columns the API may read are the ones PostgreSQL needs for an UPDATE ... WHERE to find its rows; it cannot read what it
-- inserted.
--
-- The guard trigger keeps three rules whoever writes: a job never changes who it is for, what it serves or when it ends; a job
-- that has ended never changes; and the only changes of state are those of state-machines.md section 22, with a claim that takes
-- a lease only when the job is due (or its earlier lease has ended) and the redemption record has not, and an outcome that
-- leaves the lease and the count as they were (the fence itself is in the writer's WHERE: it presents the lease version it was
-- given). The CHECK constraints below hold the rest: a live job holds its payload, a finished one holds none.

CREATE TABLE "credential_delivery_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"redemption_record_type" text NOT NULL,
	"redemption_record_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"lease_owner" text,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"provider_dedupe_id" text NOT NULL,
	"provider_message_ref" text,
	"outcome_class" text,
	"payload_ciphertext" "bytea",
	"payload_nonce" "bytea",
	"payload_key_version" integer,
	"payload_envelope_version" smallint,
	"payload_erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "credential_delivery_job_redemption_key" UNIQUE("redemption_record_type","redemption_record_id"),
	CONSTRAINT "credential_delivery_job_dedupe_key" UNIQUE("provider_dedupe_id"),
	CONSTRAINT "credential_delivery_job_kind_closed" CHECK ("credential_delivery_job"."kind" IN ('SETUP_GRANT', 'RECOVERY_LINK', 'DEVICE_GRANT', 'MFA_REENROLMENT')),
	CONSTRAINT "credential_delivery_job_redemption_type_closed" CHECK ("credential_delivery_job"."redemption_record_type" IN ('SETUP_GRANT', 'RECOVERY_REQUEST')),
	CONSTRAINT "credential_delivery_job_kind_serves_its_record" CHECK (("credential_delivery_job"."kind" = 'RECOVERY_LINK') = ("credential_delivery_job"."redemption_record_type" = 'RECOVERY_REQUEST')),
	CONSTRAINT "credential_delivery_job_principal_closed" CHECK ("credential_delivery_job"."principal_type" IN ('STAFF', 'VENDOR')),
	CONSTRAINT "credential_delivery_job_channel_closed" CHECK ("credential_delivery_job"."channel" IN ('EMAIL', 'SMS')),
	CONSTRAINT "credential_delivery_job_state_closed" CHECK ("credential_delivery_job"."state" IN ('QUEUED', 'LEASED', 'ACCEPTED', 'RETRYABLE', 'FAILED', 'EXPIRED', 'CANCELLED')),
	CONSTRAINT "credential_delivery_job_counters_nonnegative" CHECK ("credential_delivery_job"."attempt_count" >= 0 AND "credential_delivery_job"."lease_version" >= 0),
	CONSTRAINT "credential_delivery_job_queued_is_untouched" CHECK ("credential_delivery_job"."state" <> 'QUEUED' OR ("credential_delivery_job"."attempt_count" = 0 AND "credential_delivery_job"."lease_version" = 0 AND "credential_delivery_job"."lease_owner" IS NULL AND "credential_delivery_job"."lease_expires_at" IS NULL AND "credential_delivery_job"."outcome_class" IS NULL AND "credential_delivery_job"."accepted_at" IS NULL)),
	CONSTRAINT "credential_delivery_job_lease_when_leased" CHECK ("credential_delivery_job"."state" <> 'LEASED' OR ("credential_delivery_job"."lease_owner" IS NOT NULL AND "credential_delivery_job"."lease_expires_at" IS NOT NULL AND "credential_delivery_job"."lease_version" >= 1 AND "credential_delivery_job"."attempt_count" >= 1)),
	CONSTRAINT "credential_delivery_job_lease_owner_bounded" CHECK ("credential_delivery_job"."lease_owner" IS NULL OR length("credential_delivery_job"."lease_owner") BETWEEN 1 AND 128),
	CONSTRAINT "credential_delivery_job_accepted_when_accepted" CHECK (("credential_delivery_job"."state" = 'ACCEPTED') = ("credential_delivery_job"."accepted_at" IS NOT NULL) AND ("credential_delivery_job"."provider_message_ref" IS NULL OR "credential_delivery_job"."state" = 'ACCEPTED')),
	CONSTRAINT "credential_delivery_job_provider_fields_bounded" CHECK (length("credential_delivery_job"."provider_dedupe_id") BETWEEN 16 AND 128 AND ("credential_delivery_job"."provider_message_ref" IS NULL OR length("credential_delivery_job"."provider_message_ref") BETWEEN 1 AND 256)),
	CONSTRAINT "credential_delivery_job_payload_is_whole" CHECK (("credential_delivery_job"."payload_ciphertext" IS NULL) = ("credential_delivery_job"."payload_nonce" IS NULL) AND ("credential_delivery_job"."payload_ciphertext" IS NULL) = ("credential_delivery_job"."payload_key_version" IS NULL) AND ("credential_delivery_job"."payload_ciphertext" IS NULL) = ("credential_delivery_job"."payload_envelope_version" IS NULL)),
	CONSTRAINT "credential_delivery_job_payload_follows_state" CHECK (("credential_delivery_job"."state" IN ('QUEUED', 'LEASED', 'RETRYABLE') AND "credential_delivery_job"."payload_ciphertext" IS NOT NULL AND "credential_delivery_job"."payload_erased_at" IS NULL) OR ("credential_delivery_job"."state" IN ('ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED') AND "credential_delivery_job"."payload_ciphertext" IS NULL AND "credential_delivery_job"."payload_erased_at" IS NOT NULL)),
	CONSTRAINT "credential_delivery_job_outcome_class_closed" CHECK ("credential_delivery_job"."outcome_class" IS NULL OR "credential_delivery_job"."outcome_class" IN ('ACCEPTED', 'UNKNOWN', 'REJECTED', 'DESTINATION_NOT_ALLOWED', 'SCHEDULE_EXHAUSTED', 'PAYLOAD_UNREADABLE', 'EXPIRED', 'CANCELLED', 'RELINQUISHED', 'REDEMPTION_UNCONFIRMED')),
	CONSTRAINT "credential_delivery_job_outcome_follows_state" CHECK (("credential_delivery_job"."state" = 'QUEUED' AND "credential_delivery_job"."outcome_class" IS NULL)
        OR ("credential_delivery_job"."state" = 'LEASED')
        OR ("credential_delivery_job"."state" = 'RETRYABLE' AND "credential_delivery_job"."outcome_class" IN ('UNKNOWN', 'RELINQUISHED', 'REDEMPTION_UNCONFIRMED'))
        OR ("credential_delivery_job"."state" = 'ACCEPTED' AND "credential_delivery_job"."outcome_class" = 'ACCEPTED')
        OR ("credential_delivery_job"."state" = 'FAILED' AND "credential_delivery_job"."outcome_class" IN ('REJECTED', 'DESTINATION_NOT_ALLOWED', 'SCHEDULE_EXHAUSTED', 'PAYLOAD_UNREADABLE'))
        OR ("credential_delivery_job"."state" = 'EXPIRED' AND "credential_delivery_job"."outcome_class" = 'EXPIRED')
        OR ("credential_delivery_job"."state" = 'CANCELLED' AND "credential_delivery_job"."outcome_class" = 'CANCELLED')),
	CONSTRAINT "credential_delivery_job_expires_after_created" CHECK ("credential_delivery_job"."expires_at" > "credential_delivery_job"."created_at")
);
--> statement-breakpoint
CREATE INDEX "credential_delivery_job_due_idx" ON "credential_delivery_job" USING btree ("next_attempt_at") WHERE "credential_delivery_job"."state" IN ('QUEUED', 'RETRYABLE');--> statement-breakpoint
CREATE INDEX "credential_delivery_job_lease_idx" ON "credential_delivery_job" USING btree ("lease_expires_at") WHERE "credential_delivery_job"."state" = 'LEASED';--> statement-breakpoint
CREATE INDEX "credential_delivery_job_expiry_idx" ON "credential_delivery_job" USING btree ("expires_at") WHERE "credential_delivery_job"."state" IN ('QUEUED', 'LEASED', 'RETRYABLE');--> statement-breakpoint
CREATE INDEX "credential_delivery_job_principal_idx" ON "credential_delivery_job" USING btree ("principal_type","principal_id") WHERE "credential_delivery_job"."state" IN ('QUEUED', 'LEASED', 'RETRYABLE');

--> statement-breakpoint
ALTER TABLE "credential_delivery_job" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "credential_delivery_job" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credential_delivery_job" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_insert" ON "credential_delivery_job" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND state = 'QUEUED'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_select_issuer" ON "credential_delivery_job" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_select_worker" ON "credential_delivery_job" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'credential_delivery'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_cancel" ON "credential_delivery_job" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND state IN ('QUEUED', 'LEASED', 'RETRYABLE')
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND state = 'CANCELLED'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_work" ON "credential_delivery_job" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'credential_delivery' AND state IN ('QUEUED', 'LEASED', 'RETRYABLE')
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'credential_delivery'
    ELSE false
  END
);
--> statement-breakpoint
GRANT INSERT ON "credential_delivery_job" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ("redemption_record_type", "redemption_record_id", "principal_type", "principal_id", "state") ON "credential_delivery_job" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("state", "outcome_class", "payload_ciphertext", "payload_nonce", "payload_key_version", "payload_envelope_version", "payload_erased_at") ON "credential_delivery_job" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "credential_delivery_job" TO melarc_worker_cap_credential_delivery;
--> statement-breakpoint
GRANT UPDATE ("state", "attempt_count", "next_attempt_at", "accepted_at", "lease_owner", "lease_version", "lease_expires_at", "provider_message_ref", "outcome_class", "payload_ciphertext", "payload_nonce", "payload_key_version", "payload_envelope_version", "payload_erased_at") ON "credential_delivery_job" TO melarc_worker_cap_credential_delivery;
--> statement-breakpoint
CREATE FUNCTION melarc.credential_delivery_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moment timestamptz := clock_timestamp();
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.redemption_record_type IS DISTINCT FROM OLD.redemption_record_type
     OR NEW.redemption_record_id IS DISTINCT FROM OLD.redemption_record_id
     OR NEW.principal_type IS DISTINCT FROM OLD.principal_type
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.provider_dedupe_id IS DISTINCT FROM OLD.provider_dedupe_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a delivery job keeps its identity, its record, its principal, its channel, its expiry and its deduplication identity' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED') THEN
    RAISE EXCEPTION 'a delivery job that has ended does not change' USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'LEASED' THEN
    -- A claim: the first lease of a job that is due, or the takeover of one whose lease ended with no outcome.
    IF OLD.state = 'LEASED' AND OLD.lease_expires_at > moment THEN
      RAISE EXCEPTION 'a delivery job whose lease has not ended is not claimed again' USING ERRCODE = '23514';
    END IF;
    IF OLD.state <> 'LEASED' AND OLD.next_attempt_at > moment THEN
      RAISE EXCEPTION 'a delivery job is claimed when it is due' USING ERRCODE = '23514';
    END IF;
    IF OLD.expires_at <= moment THEN
      RAISE EXCEPTION 'a delivery job is not leased past the end of its redemption record' USING ERRCODE = '23514';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count + 1 OR NEW.lease_version <> OLD.lease_version + 1 THEN
      RAISE EXCEPTION 'a claim counts one attempt and raises the lease version by one' USING ERRCODE = '23514';
    END IF;
    IF NEW.lease_expires_at <= moment THEN
      RAISE EXCEPTION 'a lease ends in the future' USING ERRCODE = '23514';
    END IF;
    -- The most a claim may ask for is the application's (MAX_LEASE_MS): a lease that ran for years would strand its job.
    IF NEW.lease_expires_at > moment + interval '1 hour' THEN
      RAISE EXCEPTION 'a lease is at most an hour' USING ERRCODE = '23514';
    END IF;
    IF NEW.payload_ciphertext IS DISTINCT FROM OLD.payload_ciphertext
       OR NEW.payload_nonce IS DISTINCT FROM OLD.payload_nonce
       OR NEW.payload_key_version IS DISTINCT FROM OLD.payload_key_version
       OR NEW.payload_envelope_version IS DISTINCT FROM OLD.payload_envelope_version THEN
      RAISE EXCEPTION 'a claim does not touch the payload' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.state = 'LEASED' AND NEW.state IN ('ACCEPTED', 'RETRYABLE', 'FAILED') THEN
    -- An outcome: the lease and the count stay as they were, which is what the writer's fence compared.
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_version <> OLD.lease_version
       OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner THEN
      RAISE EXCEPTION 'an outcome does not touch the lease owner, the lease version or the count of attempts' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state = 'EXPIRED' THEN
    IF OLD.expires_at > moment THEN
      RAISE EXCEPTION 'a delivery job expires when its redemption record has ended' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state = 'CANCELLED' THEN
    -- The operation that consumed, superseded or invalidated the redemption record cancels (the authentication capability). The
    -- delivery worker ends a job it holds the lease of, when it finds the record closed, and no other: its policy admits any live
    -- job, so this is where a worker is kept from cancelling the queue.
    IF melarc.task_capability() = 'credential_delivery' AND OLD.state <> 'LEASED' THEN
      RAISE EXCEPTION 'the delivery worker ends only a job it holds the lease of' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'that change of state is not one a delivery job makes' USING ERRCODE = '23514';
  END IF;

  -- A payload is erased and never replaced, by whatever transition: the sealed fields only change to nothing.
  IF (NEW.payload_ciphertext IS NOT NULL AND NEW.payload_ciphertext IS DISTINCT FROM OLD.payload_ciphertext)
     OR (NEW.payload_nonce IS NOT NULL AND NEW.payload_nonce IS DISTINCT FROM OLD.payload_nonce)
     OR (NEW.payload_key_version IS NOT NULL AND NEW.payload_key_version IS DISTINCT FROM OLD.payload_key_version)
     OR (NEW.payload_envelope_version IS NOT NULL AND NEW.payload_envelope_version IS DISTINCT FROM OLD.payload_envelope_version) THEN
    RAISE EXCEPTION 'a payload is erased and never replaced' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.credential_delivery_job_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.credential_delivery_job_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "credential_delivery_job_guard" BEFORE UPDATE ON "credential_delivery_job"
  FOR EACH ROW EXECUTE FUNCTION melarc.credential_delivery_job_guard();
