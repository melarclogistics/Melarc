-- S1.14 (SLICE-001): the vendor organisation, for the read of its saved pickup locations (`listVendorPickupLocations`). Applied as
-- melarc_migration_elevated, a member of melarc_owner. Forward-only: the policies of 0034 and 0045 are as they were.
--
--   * `vendor_organization_location_manage_read`: a STAFF context reads the organisations of **the hubs of the operation it runs**, only
--     while the authorization key of the transaction is `vendor.pickup_location.manage` (the guard sets it from the grant that authorizes
--     the operation), or every organisation under the explicit all-hub scope. This is the visibility the existence rule asks of the record
--     the path names: an Ops member sees the vendors of its hubs, and the others are not visible to it, so they are told apart from an
--     id that matches nothing by the scope probe below. An empty set of hubs reaches no organisation. A vendor reads its own organisation
--     by the policy of 0034 and is told nothing of another's.
--   * `vendor_organization_probe`: the scope probe's policy (SECURITY_DESIGN.md section 14.4b), in a policy FOR SELECT only: while the
--     probe holds an id, a STAFF context reads that one row, so that `HUB_SCOPE_VIOLATION` can be told from `NOT_FOUND`. The probe reads
--     the hub of the record from `responsible_hub_id` (the entity names its hub column, `RECORD_ENTITIES`). A vendor and a rider have no
--     probe: they are answered `NOT_FOUND` at once, by the code path of an id that does not exist.
CREATE POLICY "vendor_organization_location_manage_read" ON "vendor_organization" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'vendor.pickup_location.manage' AND (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "vendor_organization_probe" ON "vendor_organization" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
