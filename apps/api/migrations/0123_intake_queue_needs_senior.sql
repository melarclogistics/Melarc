-- STAGE 7, THE WORK THAT WAITS FOR A SENIOR OFFICER (Run F, Part 1: D-S7-7 of the Product Owner's decisions of 23 November 2026; contract 5.119.0). Hand-written throughout: no table changes.
--
-- Orders to make gains a view, *Needs a senior*, for two kinds of vendor, and a row of Orders to make says how many orders are made and how many parcels still need one (D-S7-6, from `melarc.intake_progress`, which
-- already works it out). A list of the vendors cannot decide by itself what only the database can read (the reversal of an arrival is a record the staff read under the key of the adjudication, not under `hub.read`),
-- so the question is asked of one function, for the staff that read intakes:
--
--   * melarc.intake_senior_needed(intake): 'ARRIVAL_TAKEN_BACK' for a vendor sent back to review by an arrival a senior took back (the intake is in reconciliation and a reversal is on record for it: the senior decides it);
--     'CLOSE_EXCEPTION' for a vendor whose orders are under way (`ITEMIZING`) and that still has received parcels with no order, so that it closes only by a senior's exception or by the orders that remain;
--     null for every other vendor. READING OF MINE FOR THE PRODUCT OWNER (the decision says "nothing left an officer can order", which no fact of the database states): the second kind is every vendor being worked that
--     has a gap, because the database does not know that an officer has given up the rest; an explicit act of the officer ("I cannot order the rest") would say it, and is not built.
--
-- The function is for staff under `hub.read` and for nobody else (42501), and reads as the owner under the policies of the tables: the one new policy lets the owner read the reversal records under `hub.read` (the
-- policy of `0115` admits `hub.osd.adjudicate` and `pricing.read` only), so the runtime login still cannot select a reversal under it.

CREATE POLICY "order_reversal_worklist_read" ON "order_reversal" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.read'
      AND (melarc.hub_scope_mode() = 'ALL' OR "order_reversal"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE FUNCTION melarc.intake_senior_needed(p_intake uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  held public.pickup_intake%ROWTYPE;
  still_needed integer;
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
  IF held.state = 'ITEMIZING' THEN
    SELECT g.needs_order INTO still_needed FROM melarc.intake_progress(held.id) AS g;
    IF still_needed IS NOT NULL AND still_needed > 0 THEN
      RETURN 'CLOSE_EXCEPTION';
    END IF;
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
