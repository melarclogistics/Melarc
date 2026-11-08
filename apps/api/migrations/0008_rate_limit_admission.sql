-- The rate limiter's admitted requests (S0.14). Applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). Everything created here is owned by melarc_owner; no runtime role owns anything.
--
-- One table, rate_limit_admission, class SYSTEM in data-scope-registry.md section 4 (RateLimitAdmission): one row per admitted
-- request, keyed by a keyed digest of the bucket's key (never an identifier, an address or a token). The CREATE TABLE and the
-- indexes below are the generated part (drizzle-kit, from src/platform/database/schema/rate-limit.ts); the rest of this file is
-- written by hand and is in this migration so that the table never exists for a moment without its owner, row-level security,
-- policies and grants.
--
-- Row-level security: only a SYSTEM context under the rate_limit capability reaches the table, as the registry says ("SYSTEM only,
-- under the rate_limit capability (section 5.2) - no business principal branch"). It reads and inserts. It deletes only a row
-- that has left the 60-second window, and that is how "never evict a live penalty" (SECURITY_DESIGN.md section 14.12) holds at
-- the database and not only in the limiter's code: the policy of DELETE admits nothing that still counts. The window is the
-- contract's, written here and in WINDOW_SECONDS of src/platform/limiter/limiter-parameters.ts; a test pins the two together.
-- Every other principal, and a request with no context, reads and writes nothing (the closed ELSE).
--
-- Grants: SELECT, INSERT and DELETE to the API runtime and nothing else. No UPDATE: a row is written once. The worker and the
-- provisioning login hold nothing.

CREATE TABLE "rate_limit_admission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" text NOT NULL,
	"key_digest" "bytea" NOT NULL,
	"digest_version" integer NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "rate_limit_admission_bucket_closed" CHECK ("rate_limit_admission"."bucket" IN ('rate_limit_staff_signin', 'rate_limit_privileged_mfa', 'rate_limit_vendor_signin', 'rate_limit_rider_challenge', 'rate_limit_recovery', 'rate_limit_authenticated_api')),
	CONSTRAINT "rate_limit_admission_digest_length" CHECK (length("rate_limit_admission"."key_digest") = 32),
	CONSTRAINT "rate_limit_admission_digest_version_positive" CHECK ("rate_limit_admission"."digest_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "rate_limit_admission_key_idx" ON "rate_limit_admission" USING btree ("bucket","key_digest","admitted_at");--> statement-breakpoint
CREATE INDEX "rate_limit_admission_age_idx" ON "rate_limit_admission" USING btree ("admitted_at");
--> statement-breakpoint
ALTER TABLE "rate_limit_admission" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "rate_limit_admission" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rate_limit_admission" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rate_limit_admission_select" ON "rate_limit_admission" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'rate_limit'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "rate_limit_admission_insert" ON "rate_limit_admission" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'rate_limit'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "rate_limit_admission_delete" ON "rate_limit_admission" FOR DELETE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'rate_limit' AND admitted_at <= clock_timestamp() - interval '60 seconds'
    ELSE false
  END
);
--> statement-breakpoint
-- allow-delete: the limiter removes the rows that have left its 60-second window, and the policy of DELETE admits no other row
GRANT SELECT, INSERT, DELETE ON "rate_limit_admission" TO melarc_api_runtime;
