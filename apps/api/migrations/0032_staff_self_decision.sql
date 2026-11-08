-- The checker may be the maker when the maker is a Platform Admin, forward-only (the Product Owner's decision of 25 October 2026: the
-- highest authority needs no second person to approve what it made; a second person remains the rule for everyone else). Nothing an
-- earlier migration created is amended: the CHECK of 0016 that this replaces is dropped, and a trigger of its own takes its place.
-- Applied as melarc_migration_elevated.
--
-- THE MECHANISM, STATED BEFORE THE FUNCTION.
--
-- The problem. `staff_identity_checker_is_not_maker` (0016) said, as a CHECK, that a decided profile's checker is never its maker unless
-- the profile is a seeded bootstrap identity. A CHECK sees only the row, and the new rule needs a fact outside it: whether the maker
-- holds `staff.identity.approve` at tier P (the tier of a Platform Admin, permissions.md section 5). Tier is a property of the grant
-- (a bundle's `role_bundle_grant` row), never of a bundle's name, so the rule reads the grant.
--
-- The rule. For a row whose checker is its maker, and which is not a seeded bootstrap identity, the maker's bundle must carry a grant
-- of `staff.identity.approve` with tier `P`. Otherwise the write is refused with `23514` and the constraint name of 0016, which is
-- still what the rule is called, so that nothing that reads the name changes. The check is made when the checker is written (an INSERT
-- of a decided row, or an UPDATE that changes `approved_by`: the checker is written once, and the guard of 0029 holds that) and not on
-- every later update of the row. The maker is a staff identity that must exist: a maker the table cannot find is no Platform Admin,
-- so the rule fails closed.
--
-- Who it asks. It runs as the writer, under that writer's row-level security: the approving staff member reads their own row (they are
-- the maker) and the grant tables are readable by staff. It adds no privilege and no capability. The application states the same rule
-- first, from the tier of the grant that authorizes the request (`StaffIdentityAdministration.decide`), and this is the backstop for
-- every other writer.
--
-- Order. It is an AFTER trigger, so that it refuses where the CHECK it replaces refused: after the BEFORE triggers (`staff_identity_guard`,
-- 0016; `staff_identity_transition`, 0029; `staff_identity_version`, 0024), after the row-level-security checks of the writer's policies and
-- after the table's CHECK constraints. A write a policy refuses is still refused by the policy (`42501`) and a change of status the
-- machine does not make is still refused by the machine (`23514`); only a row that passes all of those meets this rule. (A BEFORE trigger
-- would have refused first and changed which refusal a writer sees: the bootstrap policies of 0019 are pinned to answering `42501`.)

ALTER TABLE "staff_identity" DROP CONSTRAINT "staff_identity_checker_is_not_maker";
--> statement-breakpoint
CREATE FUNCTION melarc.staff_identity_checker_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.approved_by IS NULL OR NEW.approved_by <> NEW.created_by OR NEW.origin = 'BOOTSTRAP' THEN
    RETURN NEW;
  END IF;
  -- A checker that is already the recorded one is not written again.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT EXISTS (
       SELECT 1
         FROM public.staff_identity AS maker
         JOIN public.role_bundle_grant AS g ON g.bundle_id = maker.role_bundle_id
        WHERE maker.id = NEW.created_by
          AND g.permission_key = 'staff.identity.approve'
          AND g.tier = 'P') THEN
    RAISE EXCEPTION 'a staff identity is decided by someone other than its maker, unless the maker is a Platform Admin'
      USING ERRCODE = '23514', CONSTRAINT = 'staff_identity_checker_is_not_maker';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.staff_identity_checker_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.staff_identity_checker_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "staff_identity_transition_checker" AFTER INSERT OR UPDATE ON "staff_identity"
  FOR EACH ROW EXECUTE FUNCTION melarc.staff_identity_checker_guard();
