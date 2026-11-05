ALTER TABLE "notification" DROP CONSTRAINT "notification_subject_closed";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_aggregate_type_closed";--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_subject_closed" CHECK ("notification"."subject_type" IN ('PICKUP_REQUEST', 'PICKUP_MANIFEST'));--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_aggregate_type_closed" CHECK ("outbox"."aggregate_type" IN ('PICKUP_REQUEST', 'PICKUP_MANIFEST'));
--> statement-breakpoint
-- THE HAND-WRITTEN PART (S1.21, the rider's text on dispatch; the Product Owner's decision of 29 October 2026, D-11: texts go "to the rider on
-- dispatch and reassignment"). Everything above is generated (drizzle-kit, from the vocabulary in src/platform/notifications/notification-vocabulary.ts):
-- the pickup manifest is the second aggregate a notification may be raised about. The rider's text is one message about the run, not about any one
-- request in it, so it is raised from the manifest and not from a request.
--
--   * The insert guard of the outbox is replaced (CREATE OR REPLACE) to read the manifest as it read the request: an envelope that names a manifest
--     carries the hub of that manifest, no vendor (a manifest spans vendors) and no rider scope, and is refused otherwise or when its writer cannot
--     read the manifest. The arm for a pickup request is as 0055 made it.
--   * The lane (the notification capability) reads the ONE manifest its envelope names, and the ONE rider that manifest is assigned to, and nothing
--     of either beyond the columns a message is made from: the manifest's code, state, day and rider, and the rider's number, which is read for one
--     send and held in memory only (a notification holds no destination). The accessors are 0055's.
--   * The two tables the lane reads are the manifest's and the rider's. No policy is added for any other principal, and no grant is widened.

CREATE OR REPLACE FUNCTION melarc.outbox_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  aggregate_hub uuid;
  aggregate_vendor uuid;
BEGIN
  -- A new envelope starts untouched: the relay's bookkeeping is the relay's to move.
  IF NEW.relay_state <> 'PENDING' OR NEW.attempt_count <> 0 OR NEW.lease_version <> 0 OR NEW.lease_owner IS NOT NULL
     OR NEW.lease_expires_at IS NOT NULL OR NEW.relayed_at IS NOT NULL OR NEW.last_outcome IS NOT NULL THEN
    RAISE EXCEPTION 'an envelope is written untouched: pending, never leased, never relayed' USING ERRCODE = '23514';
  END IF;
  -- Every scope field is the authoritative row's, read in this transaction under the writer's own context (SECURITY_DESIGN.md
  -- section 14.7): an envelope that names an aggregate its writer cannot read, or a scope the aggregate does not have, is refused.
  IF NEW.aggregate_type = 'PICKUP_REQUEST' THEN
    SELECT p.responsible_hub_id, p.vendor_organization_id INTO aggregate_hub, aggregate_vendor
      FROM pickup_request p WHERE p.id = NEW.aggregate_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an envelope names an aggregate that its writer can read' USING ERRCODE = '23514';
    END IF;
    IF aggregate_hub IS DISTINCT FROM NEW.responsible_hub_id OR aggregate_vendor IS DISTINCT FROM NEW.vendor_organization_id OR NEW.rider_id IS NOT NULL THEN
      RAISE EXCEPTION 'an envelope carries the scope of its aggregate and no other' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.aggregate_type = 'PICKUP_MANIFEST' THEN
    SELECT m.responsible_hub_id INTO aggregate_hub FROM pickup_manifest m WHERE m.id = NEW.aggregate_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an envelope names an aggregate that its writer can read' USING ERRCODE = '23514';
    END IF;
    IF aggregate_hub IS DISTINCT FROM NEW.responsible_hub_id OR NEW.vendor_organization_id IS NOT NULL OR NEW.rider_id IS NOT NULL THEN
      RAISE EXCEPTION 'an envelope carries the scope of its aggregate and no other' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.outbox_insert_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.outbox_insert_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY "pickup_manifest_notification_read" ON "pickup_manifest" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND id = melarc.outbox_aggregate_id() AND responsible_hub_id = melarc.outbox_hub_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "rider_identity_notification_read" ON "rider_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND EXISTS (SELECT 1 FROM pickup_manifest m WHERE m.id = melarc.outbox_aggregate_id() AND m.assigned_rider_id = rider_identity.id)
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ("id", "code", "state", "service_date", "responsible_hub_id", "assigned_rider_id") ON "pickup_manifest" TO melarc_worker_cap_notification;
--> statement-breakpoint
GRANT SELECT ("id", "phone") ON "rider_identity" TO melarc_worker_cap_notification;
