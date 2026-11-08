-- S1.21 (SLICE-001), OB-S1-35: the mark on a pickup request is its CURRENT rider commitment (the Product Owner's decision of 2 November 2026;
-- delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md section 11; contracts/domain-model.md section 6.2; contracts/state-machines.md section 3.2).
-- Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). It is a NEW migration: 0060 and 0063
-- are not edited, because the history of other databases is not known. Nothing in the shape of a table changes and nothing is granted: the
-- runtime login already holds UPDATE on pickup_request (0045), and the policy below only says whom it admits.
--
-- The rule. A request is committed to a rider while a stop with no released_at holds it on a manifest that has a rider (assigned_rider_id is
-- not null), and at no other time: a rider who was once assigned establishes nothing. The mark (rider_assigned) is that fact, kept on the request
-- because the cancellation of a request reads the request it has locked, and because a read of the stop and the manifest through row-level
-- security can hide the very claim in question (a vendor reads no stop; an officer of another hub reads none), which must never be taken as
-- proof that none exists. Two acts change what the mark is made of, and each keeps it in the transaction that changes it:
--
--   * assignRider (pickup.manifest.assign) raises it on the confirmed requests the manifest holds (as 0060 made it), and now only while a
--     stop that has not released its claim holds the request on a manifest that has a rider: the database refuses to raise the mark unless it
--     can see that claim, for every writer under that key.
--   * cancelPickupManifest (pickup.manifest.create) lowers it on the requests whose claims it releases, which are still confirmed, and now
--     only when the request has released a claim and no stop holds it any more: so a request claimed by a later manifest (which holds an
--     unreleased stop) is never unmarked by an act on its earlier one. Every other key leaves the mark as it is.
--
-- A request that is cancelled is frozen (0045), mark and charge decision together: what its cancellation was decided on stays readable, and a
-- manifest's cancellation never reaches it. The decisions already recorded, and their snapshots, are untouched by this migration.
--
-- THE UPGRADE. This migration changes what the database enforces and REPAIRS NOTHING: a request returned to the pool by a cancellation made
-- before it keeps the old mark. The migration cannot look for them (its login reads these tables through row-level security and would find
-- none, which would pass for the wrong reason), so before it is applied to a persistent database the cluster administrator checks the marks with
-- `pnpm --filter @melarc/api run db:commitment-marks` (MIGRATION_AND_SEEDING.md section 5.5), records the result, and reconciles what disagrees
-- with its claim (`--reconcile`: only confirmed requests; a cancelled request and its charge decision are never touched).
--
-- The policy admits the key of the manifest's cancellation to UPDATE a CONFIRMED request in a hub of the grant, and the guard lets that key do
-- one thing: lower the mark.
--
-- WHAT THE GUARD CAN AND CANNOT SEE. It reads the stops as the invoker, through row-level security. Raising the mark needs positive evidence (a
-- visible stop that holds the request on a manifest that has a rider), so a claim it cannot see refuses the raise. Lowering needs two things: a
-- visible stop of the request that released its claim, and no visible stop that holds it. The first proves that a claim existed and ended. It does
-- NOT prove that no newer claim exists: the second is a read that row-level security could shorten if a stop were hidden from the actor, so this
-- check is not safe in general and is not claimed to be. It is complete while a request and every stop that holds or held it are in one hub, which
-- the actor who may update the request can read, and that holds today by construction and not by a constraint at the insert of a stop:
-- createPickupManifest takes only the requests of one hub and makes every stop in its manifest's hub (a stop's hub is its manifest's, by foreign
-- key), the guard of a request refuses any change of its hub for every writer, and the guard of a stop refuses any change of its hub. A composite
-- foreign key from the stop to the request's (id, hub) would hold the rest structurally; it is proposed in the plan (OB-S1-33) and not built.
-- A change that would let a request change hub while it is claimed (reassignPickupRequestHub, SLICE-014) must first reconcile the claim, the
-- scope of the stop and this guard, and is not built until it has.

CREATE POLICY "pickup_request_release" ON "pickup_request" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.manifest.create') AND "pickup_request"."state" = 'CONFIRMED' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_request"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.manifest.create') AND "pickup_request"."state" = 'CONFIRMED' AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_request"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a pickup request as 0060 made it, with the rules of the mark replaced: the mark is raised and lowered by the two acts above and
-- by nothing else, each only on the evidence of the claim as far as the guard can see it (see above), and each changes the mark and nothing
-- else. It repairs no mark that is already wrong: the upgrade check (MIGRATION_AND_SEEDING.md section 5.5) finds and reconciles those first.
CREATE OR REPLACE FUNCTION melarc.pickup_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acting_key text := coalesce(current_setting('melarc.authorization_key', true), '');
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.vendor_organization_id IS DISTINCT FROM OLD.vendor_organization_id
     OR NEW.ad_hoc_sender_id IS DISTINCT FROM OLD.ad_hoc_sender_id
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.pickup_intent IS DISTINCT FROM OLD.pickup_intent
     OR NEW.declared_package_count IS DISTINCT FROM OLD.declared_package_count
     OR NEW.replaces_request_id IS DISTINCT FROM OLD.replaces_request_id
     OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a pickup request keeps its identity, its sender, its hub, its intent, its package count and its place in the chain' USING ERRCODE = '23514';
  END IF;
  IF OLD.escalated_at IS NOT NULL AND NEW.escalated_at IS DISTINCT FROM OLD.escalated_at THEN
    RAISE EXCEPTION 'an escalation is recorded once and is never taken back or moved' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'PENDING' AND NEW.state IN ('CONFIRMED', 'CANCELLED'))
       OR (OLD.state = 'CONFIRMED' AND NEW.state = 'CANCELLED')
     ) THEN
    RAISE EXCEPTION 'a pickup request moves from PENDING to CONFIRMED or CANCELLED and from CONFIRMED to CANCELLED, and no other way' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'CANCELLED' THEN
    IF NOT (
      OLD.cancellation_charge_outcome = 'APPLIED'
      AND NEW.cancellation_charge_outcome = 'WAIVED'
      AND NEW.cancellation_charge_waived_by IS NOT NULL
      AND (to_jsonb(NEW) - 'cancellation_charge_outcome' - 'cancellation_charge_waived_by' - 'cancellation_charge_waiver_note' - 'version')
          = (to_jsonb(OLD) - 'cancellation_charge_outcome' - 'cancellation_charge_waived_by' - 'cancellation_charge_waiver_note' - 'version')
    ) THEN
      RAISE EXCEPTION 'a cancelled pickup request is frozen but for the waiver of its applied charge' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.rider_assigned IS DISTINCT FROM OLD.rider_assigned THEN
    IF acting_key = 'pickup.manifest.assign' THEN
      IF NOT (NEW.rider_assigned AND NOT OLD.rider_assigned) THEN
        RAISE EXCEPTION 'the assignment of a rider marks a request as having one and never takes the mark back' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.pickup_stop AS held
          JOIN public.pickup_manifest AS run ON run.id = held.pickup_manifest_id
         WHERE held.pickup_request_id = NEW.id AND held.released_at IS NULL AND run.assigned_rider_id IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'a request is marked as having a rider only while a stop that has not released its claim holds it on a manifest that has one' USING ERRCODE = '23514';
      END IF;
    ELSIF acting_key = 'pickup.manifest.create' THEN
      IF NOT (OLD.rider_assigned AND NOT NEW.rider_assigned) THEN
        RAISE EXCEPTION 'the cancellation of a manifest takes the mark of a rider from a request and never gives it' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.pickup_stop AS held WHERE held.pickup_request_id = NEW.id AND held.released_at IS NULL
      ) OR NOT EXISTS (
        SELECT 1 FROM public.pickup_stop AS released WHERE released.pickup_request_id = NEW.id AND released.released_at IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'the mark of a rider is taken from a request only when its claim has been released and no stop holds it any more' USING ERRCODE = '23514';
      END IF;
    ELSIF acting_key <> '' THEN
      RAISE EXCEPTION 'only the assignment of a rider and the cancellation of a manifest change the mark of a rider on a request' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF acting_key IN ('pickup.manifest.assign', 'pickup.manifest.create')
     AND (to_jsonb(NEW) - 'rider_assigned' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'rider_assigned' - 'version') THEN
    RAISE EXCEPTION 'a planning act marks or unmarks a request as having a rider and changes nothing else' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_request_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_request_guard() FROM PUBLIC;
