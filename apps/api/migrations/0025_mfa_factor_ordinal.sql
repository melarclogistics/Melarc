-- F01 of the audit of 22 October 2026. The order of an identity's factors is a column the database allocates, not the order of their
-- identifiers. A UUIDv7 is time-ordered to the millisecond of the clock it is given and no more: two factors made in one millisecond are
-- not ordered between themselves, and nothing orders them across a clock that steps back, yet the reset rule (state-machines.md section
-- 18) reads "the most recent factor". Forward-only; nothing an earlier migration created is amended. Applied as
-- melarc_migration_elevated.
--
--   * `ordinal` is the place of a factor among its identity's factors: from one, allocated by a BEFORE INSERT trigger **under the
--     identity's row lock** (so two creations that overlap take turns and the places are consecutive) for every path that creates a
--     factor, and never changed (the same trigger refuses an update of it, as every guard of the table refuses a change of what a
--     factor keeps). A statement that gives an ordinal is not read: the database is the one allocator. The unique index is the backstop
--     for a path that does not take the lock.
--   * **No order is invented for history.** A factor row written before this migration has no recorded order of creation (there is no
--     creation time on the row, and the identifier is exactly what is in doubt). Where an identity holds one factor its place is not in
--     doubt and is one. Where an identity holds several, the migration REFUSES, names what it found, and changes nothing (the unique
--     index cannot be built over the places it would have to invent): the owner reconciles the durable environment that holds such a
--     history before it is migrated (a disposable database is rebuilt). The check is made by the index itself, which is not subject to
--     row-level security, so a login that cannot see the rows cannot make it pass.

ALTER TABLE "mfa_factor" ADD COLUMN "ordinal" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  CREATE UNIQUE INDEX "mfa_factor_identity_ordinal_key" ON "mfa_factor" USING btree ("staff_identity_id", "ordinal");
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'migration 0025 refused: an identity holds several factors and nothing recorded the order they were created in; the identifiers do not say it. Reconcile that history first (a disposable database is rebuilt), then migrate again.'
    USING ERRCODE = '55000';
END
$$;
--> statement-breakpoint
ALTER TABLE "mfa_factor" ALTER COLUMN "ordinal" DROP DEFAULT;
--> statement-breakpoint
CREATE FUNCTION melarc.mfa_factor_ordinal() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.ordinal IS DISTINCT FROM OLD.ordinal THEN
      RAISE EXCEPTION 'the place of a factor among its identity''s factors is allocated when it is created and never changes' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- The identity's lock first: a creation that overlaps this one waits here and then reads the places this one took. A caller that
  -- cannot see the row takes no lock and the unique index refuses a place that is taken twice.
  PERFORM 1 FROM public.staff_identity WHERE id = NEW.staff_identity_id FOR NO KEY UPDATE;
  NEW.ordinal := coalesce((SELECT max(f.ordinal) FROM public.mfa_factor f WHERE f.staff_identity_id = NEW.staff_identity_id), 0) + 1;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.mfa_factor_ordinal() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.mfa_factor_ordinal() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "mfa_factor_ordinal" BEFORE INSERT OR UPDATE ON "mfa_factor"
  FOR EACH ROW EXECUTE FUNCTION melarc.mfa_factor_ordinal();
