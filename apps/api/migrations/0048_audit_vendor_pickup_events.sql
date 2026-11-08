-- S1.14 (SLICE-001): what a vendor's context may write to the audit ledger. Applied as melarc_migration_elevated, a member of melarc_owner.
--
-- Until `createPickupRequest`, a Vendor (and a Rider) wrote one event, its own `auth.session.terminated` (migrations 0023 and 0026), and the
-- policy named the actor, the surface, the code, the object and the outcome so that a principal could not write a fact about anyone else's.
-- A vendor books for itself, the act is audited in its own transaction (an event and the act commit together or not at all), and a vendor
-- cancels its own PENDING request (S1.17), so the Vendor arm gains the same shape of exception for those two events and for nothing else:
--
--   * the actor is the vendor's own account and the surface its own, as before;
--   * the event is `pickup.request.created` or `pickup.request.cancelled` (both ordinary, so `enhanced = false`, and `SUCCEEDED`);
--   * the object is a `PickupRequest`, and the event names the vendor's own organisation (`melarc.current_vendor_organization_id()`, set
--     by the request pipeline from the authenticated session), so it cannot be a fact about another organisation's request.
--
-- The existing arms are restated word for word: the Staff arm, the sign-out exception of the Vendor, the Rider arm, the `authentication`
-- capability of SYSTEM and the closed ELSE. The Rider arm is unchanged: a Rider books and cancels nothing (the registry gives it no pickup
-- request), and the Rider app has no request-creation role.
--
-- test/database/audit-vendor-pickup.db.test.ts holds the arm to these edges: each edge has a case that the ledger refuses.

ALTER POLICY "audit_event_insert" ON "audit_event" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN actor_type = 'STAFF' AND actor_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN actor_type = 'VENDOR_ACCOUNT' AND actor_id = melarc.current_principal_id() AND surface_context = 'VENDOR_PWA' AND (
      (event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT' AND outcome = 'SUCCEEDED' AND enhanced = false)
      OR (event_code IN ('pickup.request.created', 'pickup.request.cancelled') AND object_type = 'PickupRequest' AND vendor_organization_id = melarc.current_vendor_organization_id() AND outcome = 'SUCCEEDED' AND enhanced = false)
    )
    WHEN 'RIDER' THEN actor_type = 'RIDER' AND actor_id = melarc.current_principal_id() AND surface_context = 'RIDER_ANDROID' AND event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT' AND outcome = 'SUCCEEDED' AND enhanced = false
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
