-- S1.20 closeout (SLICE-001; the reviewer's decisions of 1 and 2 November 2026; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md section 11):
-- what the cancellation of a request does to the stop that holds it, and the reason a manifest gives for each overdue request it carries over.
-- Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
--   * The reason catalogue gains the domain PICKUP_CARRYOVER (the generated statements below). Its codes are the Product Owner's and none is
--     seeded: a manifest that holds an overdue request cannot be made until they are (REASON_NOT_ACTIVE for every code), as the three pickup
--     domains of migration 0044 refused every code until the owner decided theirs.
--   * pickup_stop gains carryover_snapshot: the reason and its label as the actor saw them, written when the manifest is made and never
--     changed (the guard below holds it). Null for a request on the day it was promised.
--   * The runtime login may UPDATE three columns of pickup_stop, state, resolved_at and skip_snapshot, and only for a staff member who holds
--     pickup.request.cancel, in a hub of the grant, on a stop that is still to be worked, and only to SKIPPED: the cancellation of a request
--     resolves the stop that holds it in the same transaction, so a rider is never left with a stop for a request that no longer exists.
--     Nothing else about a stop can be changed by the runtime login; the operations that arrive, collect, fail, order and release a stop add
--     their own policies in their own migrations.
--   * The guard of a stop is replaced (CREATE OR REPLACE) to keep the carry-over reason with the stop. Everything else it holds is as in 0058.

ALTER TABLE "reason_code" DROP CONSTRAINT "reason_code_domain_closed";--> statement-breakpoint
ALTER TABLE "pickup_stop" ADD COLUMN "carryover_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "reason_code" ADD CONSTRAINT "reason_code_domain_closed" CHECK ("reason_code"."domain" IN ('DELIVERY_FAILURE', 'RECIPIENT_CONTACT', 'PICKUP_STOP_SKIP', 'HANDOFF_FAILURE', 'PICKUP_CANCELLATION', 'PICKUP_FAILURE', 'PICKUP_SHORT_COUNT', 'PICKUP_CARRYOVER', 'SESSION_REVOCATION', 'STAFF_PROFILE_REJECTION', 'STAFF_MFA_RESET', 'CREDENTIAL_ADMINISTRATION', 'RIDER_DEVICE_REPLACEMENT', 'RIDER_DEVICE_REVOCATION'));--> statement-breakpoint
ALTER TABLE "pickup_stop" ADD CONSTRAINT "pickup_stop_carryover_facts" CHECK ("pickup_stop"."carryover_snapshot" IS NULL OR ("pickup_stop"."carryover_snapshot" ->> 'reason_code') IS NOT NULL);--> statement-breakpoint
GRANT UPDATE ("state", "resolved_at", "skip_snapshot") ON "pickup_stop" TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "pickup_stop_update" ON "pickup_stop" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.request.cancel') AND "pickup_stop"."state" IN ('PENDING', 'ARRIVED') AND "pickup_stop"."released_at" IS NULL AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.request.cancel') AND "pickup_stop"."state" = 'SKIPPED' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a stop (0058) with one more member kept: the carry-over reason is written at creation and never changed.
CREATE OR REPLACE FUNCTION melarc.pickup_stop_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.pickup_manifest_id IS DISTINCT FROM OLD.pickup_manifest_id
     OR NEW.pickup_request_id IS DISTINCT FROM OLD.pickup_request_id
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.carryover_snapshot IS DISTINCT FROM OLD.carryover_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a pickup stop keeps its manifest, its request, its hub and its carry-over reason' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'PENDING' AND NEW.state IN ('ARRIVED', 'SKIPPED'))
       OR (OLD.state = 'ARRIVED' AND NEW.state IN ('COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED'))
     ) THEN
    RAISE EXCEPTION 'a pickup stop moves from PENDING to ARRIVED or SKIPPED and from ARRIVED to COLLECTED, PARTIALLY_COLLECTED, FAILED or SKIPPED, and no other way' USING ERRCODE = '23514';
  END IF;
  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'the release of the claim of a pickup stop is never changed or cleared' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED')
     AND (to_jsonb(NEW) - 'released_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at' - 'version') THEN
    RAISE EXCEPTION 'a resolved pickup stop is frozen but for the release of its claim' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_stop_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_guard() FROM PUBLIC;