-- S0.34 (`signOut`), forward-only. A principal that is signed in ends its own session, and writes the event that says so, in one transaction
-- under its own context. Two policies change; no table, column, grant, trigger or row does. It is a new migration and not an edit of an
-- earlier one because a database may already hold those: a migration that a database has applied is never amended.
--
--   * session_update admits a STAFF, a VENDOR and a RIDER context to end **the session it is acting in** and nothing else: the row is the
--     one whose id is the context's session (`melarc.session_id`, which the request pipeline sets from the authenticated session and
--     nothing the client sends), of the context's own principal and type, and still live; the row it leaves is ended, with
--     `SIGNED_OUT`. So a principal cannot end another session of its own (a sign-out ends the one that signs out), cannot end one with
--     a reason that only the system or an administrator records, cannot record activity (the system's write), and cannot touch an
--     ended session. The three columns the runtime may update (`last_activity_at`, `terminated_at`, `termination_reason`) and the guard
--     trigger are unchanged. The `authentication` capability keeps its arm: the request-time expiry of AC-SLICE-000-35 ends a session
--     with `EXPIRED` under it.
--   * audit_event_insert admits a VENDOR and a RIDER context to write **its own `auth.session.terminated`**: the actor is the principal
--     (`VENDOR_ACCOUNT`, `RIDER`) and the surface the principal's own. This is the narrow direction the owner approved on 11 October 2026
--     (plan 7.15, P-1), built by its first consumer; only that one code is admitted now, and the vendor's device operations (S0.49) add
--     their codes in their own migration. No SELECT arm is added: neither principal reads a row of the ledger, and the runtime holds no
--     UPDATE or DELETE on it. The staff arm and the `authentication` arm are as they were.
-- Applied as melarc_migration_elevated.

-- The id of the acting session is read from the transaction's own setting, as the accessors of 0000 and 0001 read theirs: a missing or
-- empty setting is NULL, which no row's id equals, so a context that names no session ends none. (A function of its own would need an
-- EXECUTE grant for every login that touches the table, the technical logins among them.)
ALTER POLICY "session_update" ON "session" USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN principal_type = 'STAFF' AND principal_id = melarc.current_principal_id() AND id = nullif(current_setting('melarc.session_id', true), '')::uuid AND terminated_at IS NULL
    WHEN 'VENDOR' THEN principal_type = 'VENDOR' AND principal_id = melarc.current_principal_id() AND id = nullif(current_setting('melarc.session_id', true), '')::uuid AND terminated_at IS NULL
    WHEN 'RIDER' THEN principal_type = 'RIDER' AND principal_id = melarc.current_principal_id() AND id = nullif(current_setting('melarc.session_id', true), '')::uuid AND terminated_at IS NULL
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN principal_type = 'STAFF' AND principal_id = melarc.current_principal_id() AND id = nullif(current_setting('melarc.session_id', true), '')::uuid AND terminated_at IS NOT NULL AND termination_reason = 'SIGNED_OUT'
    WHEN 'VENDOR' THEN principal_type = 'VENDOR' AND principal_id = melarc.current_principal_id() AND id = nullif(current_setting('melarc.session_id', true), '')::uuid AND terminated_at IS NOT NULL AND termination_reason = 'SIGNED_OUT'
    WHEN 'RIDER' THEN principal_type = 'RIDER' AND principal_id = melarc.current_principal_id() AND id = nullif(current_setting('melarc.session_id', true), '')::uuid AND terminated_at IS NOT NULL AND termination_reason = 'SIGNED_OUT'
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
ALTER POLICY "audit_event_insert" ON "audit_event" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN actor_type = 'STAFF' AND actor_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN actor_type = 'VENDOR_ACCOUNT' AND actor_id = melarc.current_principal_id() AND surface_context = 'VENDOR_PWA' AND event_code = 'auth.session.terminated'
    WHEN 'RIDER' THEN actor_type = 'RIDER' AND actor_id = melarc.current_principal_id() AND surface_context = 'RIDER_ANDROID' AND event_code = 'auth.session.terminated'
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
