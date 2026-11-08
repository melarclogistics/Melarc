-- F04 and F05 of the audit of 22 October 2026, forward-only. Migration 0023 (`signOut`) admitted a principal to end its own session and
-- to write the event that says so; it left two edges too wide. Nothing an earlier migration created is amended: one policy is replaced
-- and one trigger is added. Applied as melarc_migration_elevated.
--
--   * F04. The Vendor and Rider arms of audit_event_insert named the actor, the surface and the code, and not **what the event is
--     about**: a principal in its own context could write "session X was signed out" for any X, and with any reason or outcome. The arms
--     now admit the one row `signOut` writes and no other: the object is a `Session`, **and it is the session the context is acting in**
--     (`melarc.session_id`, set by the request pipeline from the authenticated session and from nothing the client sends), the reason is
--     `SIGNED_OUT`, the outcome `SUCCEEDED` and the tier ordinary (`enhanced = false`). A context that names no session reads as NULL,
--     which no object id equals, so it writes nothing, and an event that names no object is refused for the same reason. There is no
--     subquery on `session`: the table's own policy would answer a runtime that may read its own sessions, but a policy that reads a
--     table other roles cannot read breaks those roles' inserts (the worker, the provisioning login), and the setting is already the
--     authenticated session. The staff arm and the `authentication` arm are as they were.
--   * F05. The session_update policy of 0023 asks that the row an own-context update leaves is ended with `SIGNED_OUT`; a policy sees
--     the new row and not the old one, so the same UPDATE could also move `last_activity_at` (the system's write). A principal that
--     signs out records no activity: this trigger sees both rows and refuses an update of the activity by a STAFF, VENDOR or RIDER
--     context. The SYSTEM `authentication` capability, which is the one writer of activity, is not judged by it; `session_guard`
--     (0016) still holds an ended session as it ended, the activity that never moves back and the activity that is not in the future.
--     An update that writes the activity back as it was is not a change and is not refused.

ALTER POLICY "audit_event_insert" ON "audit_event" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN actor_type = 'STAFF' AND actor_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN actor_type = 'VENDOR_ACCOUNT' AND actor_id = melarc.current_principal_id() AND surface_context = 'VENDOR_PWA' AND event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT' AND outcome = 'SUCCEEDED' AND enhanced = false
    WHEN 'RIDER' THEN actor_type = 'RIDER' AND actor_id = melarc.current_principal_id() AND surface_context = 'RIDER_ANDROID' AND event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT' AND outcome = 'SUCCEEDED' AND enhanced = false
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE FUNCTION melarc.session_self_end_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IN ('STAFF', 'VENDOR', 'RIDER')
     AND NEW.last_activity_at IS DISTINCT FROM OLD.last_activity_at THEN
    RAISE EXCEPTION 'a principal ending its own session records no activity with it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.session_self_end_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.session_self_end_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "session_self_end_guard" BEFORE UPDATE ON "session"
  FOR EACH ROW EXECUTE FUNCTION melarc.session_self_end_guard();
