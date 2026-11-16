ALTER TABLE "evidence" DROP CONSTRAINT "evidence_retention_policy_closed";--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_retention_policy_closed" CHECK ("evidence"."retention_policy" IN ('PICKUP_STOP_EVIDENCE', 'PICKUP_INTAKE_EVIDENCE'));
--> statement-breakpoint
-- THE HAND-WRITTEN PART (S1.34). Everything above is generated (drizzle-kit, from the evidence schema): the retention category of an intake's evidence joins the closed list. This migration is applied as
-- melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
-- S1.34 (SLICE-001): the evidence of an intake (createEvidence, completeEvidenceUpload and createEvidenceRetrievalAuthorization for the owner PICKUP_INTAKE; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md
-- S1.34; features/hub/hub-intake.md section 5.2; state-machines.md section 17; AC-SLICE-001-41 and -42; D-14). The evidence of an intake is declared by STAFF, and so far the table's policies served the
-- rider and the system alone. What this part does, with the policies of the table that are not touched (the policies of a table are alternatives, 0091):
--
--   * THE RECEIVER DECLARES AND COMPLETES THE PHOTOS OF A CONDITION under hub.intake.count (purpose CONDITION), and SENIOR OPS (and the Platform Admin) the photos of an adjudication under hub.osd.adjudicate
--     (purpose OSD): each key with its own purpose, as the rider's two keys are paired with theirs (0088). The record is the declarer's own (captured by STAFF, in its name), pending its upload, of the
--     retention category of an intake's evidence, in the hub of the intake and of no vendor (a vendor reads no evidence of an intake, hub-intake.md section 5.3), and only for an intake that has been counted:
--     the condition is recorded after the blind count and not before. The scope is the intake's: the hub the record names must be the hub of the intake that the key reads.
--   * THE STAFF OF THE INTAKE'S HUB READ IT under hub.read (the read of the subject), every record of the hubs of the grant; and the keys that write it see the declarer's own records and no other's, so
--     that the declarer completes its own record and a colleague's record is, for the one who did not declare it, a record that is not there.
--   * THE KEY OF THE ADJUDICATION READS THE INTAKES OF ITS HUBS, as hub.read and hub.intake.count do (0092, 0093): the column grants withhold the declaration whatever a policy admits.
CREATE POLICY "pickup_intake_adjudicate_read" ON "pickup_intake" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "evidence_declare_intake" ON "evidence" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN (
        (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND "evidence"."purpose" = 'CONDITION')
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate' AND "evidence"."purpose" = 'OSD')
      )
      AND "evidence"."owner_type" = 'PICKUP_INTAKE'
      AND "evidence"."captured_by_principal_type" = 'STAFF' AND "evidence"."captured_by_actor" = melarc.current_principal_id()
      AND "evidence"."state" = 'PENDING_UPLOAD' AND "evidence"."access_rule" = 'SUBJECT_READERS' AND "evidence"."retention_policy" = 'PICKUP_INTAKE_EVIDENCE'
      AND "evidence"."responsible_hub_id" IS NOT NULL AND "evidence"."vendor_organization_id" IS NULL
      AND (melarc.hub_scope_mode() = 'ALL' OR "evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
      AND EXISTS (SELECT 1 FROM "pickup_intake" AS i WHERE i.id = "evidence"."owner_id" AND i.responsible_hub_id = "evidence"."responsible_hub_id" AND i.state <> 'AWAITING_COUNT')
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "evidence_read_intake" ON "evidence" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN "evidence"."owner_type" = 'PICKUP_INTAKE' AND "evidence"."responsible_hub_id" IS NOT NULL
      AND (melarc.hub_scope_mode() = 'ALL' OR "evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
      AND (
        coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.read'
        OR (coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.count', 'hub.osd.adjudicate') AND "evidence"."captured_by_actor" = melarc.current_principal_id())
      )
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "evidence_store_intake" ON "evidence" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN (
        (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND "evidence"."purpose" = 'CONDITION')
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate' AND "evidence"."purpose" = 'OSD')
      )
      AND "evidence"."owner_type" = 'PICKUP_INTAKE'
      AND "evidence"."captured_by_principal_type" = 'STAFF' AND "evidence"."captured_by_actor" = melarc.current_principal_id()
      AND "evidence"."state" = 'PENDING_UPLOAD'
      AND (melarc.hub_scope_mode() = 'ALL' OR "evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN "evidence"."state" = 'STORED'
    ELSE false
  END
);
