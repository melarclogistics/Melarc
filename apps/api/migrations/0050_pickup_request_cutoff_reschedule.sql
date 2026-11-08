-- S1.15 (SLICE-001): the clone of a rescheduled cutoff exception (`resolveCutoffException`, `RESCHEDULE_NEXT_DAY`). Applied as
-- melarc_migration_elevated, a member of melarc_owner. Forward-only: the policy of 0045 is as it was but for one key in its insert list.
--
-- The act is the cancel-plus-clone of pickup-request.md section 5.2, in one transaction: the late booking's source is cancelled and a new
-- PENDING request for the next operating day is inserted. The operation runs under the authorization key of its own permission,
-- `pickup.request.confirm` (state-machines.md section 3, "resolve cutoff exception"), and the insert policy of 0045 admitted only the keys
-- of the operations that make a request (`pickup.request.create`) or replace one after a cancellation or a failure. So the clone would be
-- refused by row-level security, correctly and for want of this key. Nothing else changes: the hub scope of the insert, the vendor arm
-- (a vendor books only for itself and only `PENDING`) and the table's guard (the clone's identity and its place in the chain are fixed at
-- the insert, and the source is frozen once cancelled) are as they were.
ALTER POLICY "pickup_request_insert" ON "pickup_request" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.request.create', 'pickup.request.confirm', 'pickup.request.cancel', 'pickup.request.cancel_chargeable', 'pickup.failure.resolve') AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.request.create') AND vendor_organization_id = melarc.current_vendor_organization_id() AND state = 'PENDING'
    ELSE false
  END
);
