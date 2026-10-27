-- G02 of the audit of 26 October 2026: a trusted browser stands in for the code of the second step only while it is valid, and "valid" is
-- judged on the clock **after** the row's lock is held, never before it. Forward-only: it replaces the body of one function and of one
-- trigger function of migration 0033, and changes no table, column, grant, policy or row. It is a new migration and not an edit of 0033
-- because a database may already hold that one (a migration that a database has applied is never amended, and the applied history of
-- every environment is not known).
--
-- THE DEFECT. `melarc.use_trusted_browser` of 0033 took `evaluated_at := clock_timestamp()` into a variable and then ran one UPDATE whose
-- predicate used it. The sign-in has locked the identity, which serializes the paths that lock the identity; it does not serialize the
-- trusted-browser row, which a person's own removal (`SELF`) holds without the identity lock. An UPDATE that waits for a row another
-- transaction holds proceeds when that transaction ends without changing the row (a rollback), and a variable taken before the wait is
-- the instant before the wait: a browser whose seven days ran out during the wait was still found valid against it, and stood in for the code.
-- PostgreSQL re-evaluates the predicate against the updated row version, but not a value the function had already captured.
--
-- THE ORDER NOW. (1) The candidate row is found and **locked** (`FOR NO KEY UPDATE`, the lock the UPDATE needs): a statement that waits
-- for a competing transaction re-reads the row it left, so a removal that committed makes the row no candidate at all. (2) Only then, in a
-- statement of its own, the instant is taken from the database's clock. (3) The row is judged against that instant with everything else it
-- depends on (not removed, not past its end, the identity `ACTIVE`, the credential generation it was trusted on, the `ACTIVE` factor it was
-- trusted with) and, if it stands, used. Anything that fails answers nothing and writes nothing, and the sign-in falls back to the ordinary
-- challenge. The hash is still compared inside this function alone: the runtime cannot select the column.
--
-- THE GUARD. A use is recorded only before the browser's end. The instant is the one the function judged (`NEW.last_used_at`), not a second
-- reading of the clock, so the guard cannot disagree with the function by the microseconds between the two; an update that records a use
-- at or after `expires_at` is refused for every writer. The guard grants nothing: `last_used_at` is a record, and what stands in for the
-- code is the function's answer.

CREATE OR REPLACE FUNCTION melarc.use_trusted_browser(p_token_hash bytea, p_identity uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  candidate uuid;
  evaluated_at timestamptz;
  used uuid;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'SYSTEM' OR melarc.task_capability() IS DISTINCT FROM 'authentication' THEN
    RAISE EXCEPTION 'a trusted browser is used under the authentication capability alone' USING ERRCODE = '42501';
  END IF;
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 OR p_identity IS NULL THEN
    RETURN NULL;
  END IF;
  -- (1) Wait for the row if another transaction holds it, and see it as that transaction left it.
  SELECT t.id INTO candidate
    FROM public.trusted_browser AS t
   WHERE t.token_hash = p_token_hash
     AND t.staff_identity_id = p_identity
     AND t.revoked_at IS NULL
     FOR NO KEY UPDATE OF t;
  IF candidate IS NULL THEN
    RETURN NULL;
  END IF;
  -- (2) The instant, now that the row is held: the wait is over and nothing can change the row until this transaction ends.
  evaluated_at := pg_catalog.clock_timestamp();
  -- (3) The judgement, on that instant.
  UPDATE public.trusted_browser AS t
     SET last_used_at = evaluated_at
    FROM public.staff_identity AS i, public.mfa_factor AS f
   WHERE t.id = candidate
     AND t.revoked_at IS NULL
     AND t.expires_at > evaluated_at
     AND i.id = t.staff_identity_id AND i.status = 'ACTIVE' AND i.credential_generation = t.credential_generation
     AND f.id = t.factor_id AND f.staff_identity_id = t.staff_identity_id AND f.status = 'ACTIVE'
  RETURNING t.id INTO used;
  RETURN used;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.use_trusted_browser(bytea, uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.use_trusted_browser(bytea, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.use_trusted_browser(bytea, uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- The guard of 0033, with one more rule: a use is recorded before the browser's end. Everything else is as it was.
CREATE OR REPLACE FUNCTION melarc.trusted_browser_update_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.staff_identity_id IS DISTINCT FROM OLD.staff_identity_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.factor_id IS DISTINCT FROM OLD.factor_id
     OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
     OR NEW.label IS DISTINCT FROM OLD.label
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a trusted browser keeps everything but its use and its removal' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (
       NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revocation_cause IS DISTINCT FROM OLD.revocation_cause
    OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
    OR NEW.last_used_at IS DISTINCT FROM OLD.last_used_at) THEN
    RAISE EXCEPTION 'a removed trusted browser stays removed and is not used again' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_used_at IS DISTINCT FROM OLD.last_used_at THEN
    IF OLD.last_used_at IS NOT NULL AND NEW.last_used_at < OLD.last_used_at THEN
      RAISE EXCEPTION 'the moment a trusted browser was last used moves forward only' USING ERRCODE = '23514';
    END IF;
    IF NEW.last_used_at > clock_timestamp() + interval '5 seconds' THEN
      RAISE EXCEPTION 'a trusted browser was not used in the future' USING ERRCODE = '23514';
    END IF;
    IF NEW.last_used_at >= OLD.expires_at THEN
      RAISE EXCEPTION 'a trusted browser is used before its end and not at or after it' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at AND NEW.revoked_at > clock_timestamp() + interval '5 seconds' THEN
    RAISE EXCEPTION 'a trusted browser is not removed in the future' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.trusted_browser_update_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.trusted_browser_update_guard() FROM PUBLIC;
