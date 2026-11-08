-- The rate limiter's two forward changes of the Gate 2 corrections. Forward-only: it adds to migration 0008's table and to the policies
-- of migration 0003's setting table. Applied as melarc_migration_elevated (MIGRATION_AND_SEEDING.md section 5.1).
--
--   * rate_limit_admission_version_idx (G2-04): the limiter checks, in every admission, that no live row is under a key version it
--     does not hold (a rotation whose new key was not given to every instance, or a version retired while rows under it still count).
--     The check is one range probe for each stretch of version numbers the instance does not hold; this index makes each probe a
--     descent of a btree and not a scan of the live rows.
--   * setting_rate_limit_read (section 11.B; OB-102): the rate_limit capability may SELECT the six rate_limit_* settings and no other
--     row of setting, so that the limiter reads its limits in its own admission transaction and not in a second one. The policy is
--     the only grant of this change: the runtime login already holds SELECT on setting (migration 0003), and holds no INSERT, UPDATE
--     or DELETE on it, so the capability can write nothing. The six names are the buckets' (settings.md section 7.7;
--     RATE_LIMIT_BUCKETS in src/platform/auth/ports/rate-limiter.port.ts); a test pins the two together.
--     This amends data-scope-registry.md section 5.2 (the rate_limit row). It applies the amendment that plan obligation OB-102
--     recommended, narrowed to the six rows, as section 11.B of the Gate 2 correction brief asked ("prepare or apply"); the owner
--     confirms or reverses it, and reversing it is one DROP POLICY and the limiter reading its limits in a second transaction again.

CREATE INDEX "rate_limit_admission_version_idx" ON "rate_limit_admission" USING btree ("digest_version","admitted_at");
--> statement-breakpoint
CREATE POLICY "setting_rate_limit_read" ON "setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'rate_limit' AND key IN ('rate_limit_staff_signin', 'rate_limit_privileged_mfa', 'rate_limit_vendor_signin', 'rate_limit_rider_challenge', 'rate_limit_recovery', 'rate_limit_authenticated_api')
    ELSE false
  END
);
