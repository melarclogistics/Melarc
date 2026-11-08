-- S1.17 (SLICE-001): a vendor cancels its own pending request under a reason of the cancellation domain (`cancelPickupRequest`), and the reason is
-- read to be validated and snapshotted. The reason catalogue is the office's (`reason_code_read` of 0003 admits STAFF and the authentication
-- capability and no vendor), so a vendor's own cancellation would find no reason and fail as one that does not exist. Applied as
-- melarc_migration_elevated, a member of melarc_owner. Forward-only: the policies of 0003 and 0004 are as they were.
--
-- This policy admits a VENDOR context to read the reasons of **one domain, `PICKUP_CANCELLATION`, while the operation it runs is
-- `pickup.request.cancel`** (the authorization key the guard sets from the grant that authorizes it), and nothing else: not another domain, not
-- another operation, not a rider, not a SYSTEM context. The vendor learns the labels and the metadata of the reasons it may choose among, which
-- is what its own cancellation screen has to show. No privilege is added: the runtime already holds SELECT on the table.
CREATE POLICY "reason_code_vendor_cancellation_read" ON "reason_code" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'VENDOR' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.cancel'
      AND domain = 'PICKUP_CANCELLATION'
    ELSE false
  END
);
