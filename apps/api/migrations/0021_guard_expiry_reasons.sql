-- A06 of the audit of 21 October 2026: a refusal of a consumption that lost a race with the clock states its reason. Forward-only: it
-- replaces the bodies of two guard functions (migrations 0018 and 0020) and changes no table, column, grant, policy, trigger or row.
--
--   * setup_grant_update_guard and mfa_challenge_update_guard keep every rule they had. The one refusal that a consumption meets when
--     its row expired during a wait for a lock that left the row unchanged ("consumed only while it has not expired") now carries
--     DETAIL 'reason=GRANT_EXPIRED' or 'reason=CHALLENGE_EXPIRED', and no other refusal of either function carries a reason. The
--     application maps that reason, and only that, to a typed refusal answered after the rollback; every other 23514 stays a defect.
--   * CREATE OR REPLACE keeps each function's owner, privileges and the trigger that calls it. The ALTER and the REVOKE that follow
--     restate what 0018 and 0020 set, so the migration is correct whoever ran it.
--   * This is a new migration and not an edit of 0018 and 0020 because a database may already hold those: a migration that a database
--     has applied is never amended (the history check refuses it), and the applied history of every environment is not known.
-- Applied as melarc_migration_elevated.

CREATE OR REPLACE FUNCTION melarc.setup_grant_update_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.principal_type IS DISTINCT FROM OLD.principal_type
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.episode_id IS DISTINCT FROM OLD.episode_id
     OR NEW.supersedes_grant_id IS DISTINCT FROM OLD.supersedes_grant_id
     OR NEW.continued_from_grant_id IS DISTINCT FROM OLD.continued_from_grant_id
     OR NEW.attestation_challenge_hash IS DISTINCT FROM OLD.attestation_challenge_hash THEN
    RAISE EXCEPTION 'a setup grant keeps everything but its state and the moment it was consumed' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    IF OLD.state IS DISTINCT FROM 'PENDING' THEN
      -- Consumed, expired and superseded are terminal: a later authorisation is a new grant, never this one brought back.
      RAISE EXCEPTION 'only a PENDING grant changes state' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'CONSUMED' AND OLD.expires_at IS NOT NULL AND OLD.expires_at <= clock_timestamp() THEN
      -- The one refusal of this table that states a reason: a consumption that waited for a lock and met the clock after the expiry is
      -- an ordinary outcome of a race, and the application answers it as a grant that cannot be used (the audit of 21 October 2026, A06).
      RAISE EXCEPTION 'a grant is consumed only while it has not expired'
        USING ERRCODE = '23514', DETAIL = 'reason=GRANT_EXPIRED';
    END IF;
    IF NEW.state = 'EXPIRED' AND (OLD.expires_at IS NULL OR OLD.expires_at > clock_timestamp()) THEN
      RAISE EXCEPTION 'a grant expires only when its expiry has passed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.setup_grant_update_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.setup_grant_update_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.mfa_challenge_update_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.staff_identity_id IS DISTINCT FROM OLD.staff_identity_id
     OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'an MFA challenge keeps everything but its state and its count of wrong codes' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count THEN
    IF OLD.state IS DISTINCT FROM 'PENDING' THEN
      -- Consumed, expired and unusable are terminal: another sign-in is a new challenge, never this one brought back.
      RAISE EXCEPTION 'only a PENDING challenge changes' USING ERRCODE = '23514';
    END IF;
    IF NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'the count of wrong codes of a challenge rises by one and never falls' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'CONSUMED' AND OLD.expires_at <= clock_timestamp() THEN
      -- The one refusal of this table that states a reason (see setup_grant_update_guard): the application answers it as an expired
      -- sign-in, and every other refusal of the guard stays a defect (the audit of 21 October 2026, A06).
      RAISE EXCEPTION 'a challenge is consumed only while it has not expired'
        USING ERRCODE = '23514', DETAIL = 'reason=CHALLENGE_EXPIRED';
    END IF;
    IF NEW.state = 'EXPIRED' AND OLD.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'a challenge expires only when its time has passed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.mfa_challenge_update_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.mfa_challenge_update_guard() FROM PUBLIC;
