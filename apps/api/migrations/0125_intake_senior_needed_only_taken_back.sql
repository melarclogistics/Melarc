-- STAGE 7, A SENIOR OFFICER IS FOR WHAT THE BUSINESS OR MONEY DECIDES (Run G1, Part 1, item 1: the Product Owner's decision D-S7-11 of 24 November 2026; contract 5.120.0). Hand-written throughout: no table changes.
--
-- Run F's reading (migration 0123, OB-S1-168) listed in *Needs a senior* every vendor whose orders are under way and that still has received parcels with no order (`CLOSE_EXCEPTION`). The Product Owner's decision of 24 November
-- says that reading was wrong: a parcel an officer cannot order yet (a label that cannot be read, a missing phone, an address that makes no sense) is the officer's, who calls or messages the vendor, gets the details and makes
-- the order. Seniors are not always on the floor, and a senior is for the decisions that affect the business or money. So `melarc.intake_senior_needed(intake)` now answers
--
--   * 'ARRIVAL_TAKEN_BACK' for a vendor sent back to review by an arrival a senior took back (the intake is in reconciliation and a reversal is on record for it: the senior decides it);
--   * null for every other vendor, whatever parcels it has left to order.
--
-- The close with an exception stays a senior's act on the close page (`closeHubIntake`, `hub.intake.close_exception`): it is not touched. The function's callers, its signature, its owner, its grants and the policy of 0123 stay;
-- only the second branch (and its read of `melarc.intake_progress`) is gone. CREATE OR REPLACE keeps the owner and the privileges; they are said again below so that the migration lint reads them in this file.

CREATE OR REPLACE FUNCTION melarc.intake_senior_needed(p_intake uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  held public.pickup_intake%ROWTYPE;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.read' THEN
    RAISE EXCEPTION 'what waits for a senior officer is read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF held.state = 'RECONCILIATION_REQUIRED'
     AND EXISTS (SELECT 1 FROM public.order_reversal AS r WHERE r.pickup_intake_id = held.id) THEN
    RETURN 'ARRIVAL_TAKEN_BACK';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_senior_needed(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_senior_needed(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_senior_needed(uuid) TO melarc_api_runtime;
