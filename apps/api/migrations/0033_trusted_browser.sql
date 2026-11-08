-- Trusted browser (the Product Owner's instruction of 25 October 2026; staff-authentication.md §5.8; SECURITY_DESIGN.md §13.5a), forward-only.
-- A browser that proved the second factor and was asked to be remembered stands in for the code of the second step, for seven days. One
-- new table, the guards that keep it honest, the two readers of its hash, and one function replaced so that an administrator can lock the
-- identity whose trusted browsers it removes. Applied as melarc_migration_elevated. **No reference data is added or changed**: the project
-- has no way to upgrade the reference data of a database that was seeded before a key existed, so the administrator's operations use the
-- key that already ends a staff identity's standing access (`staff.session.revoke`, tier P, enforced by the application), the seven days
-- are a constant of the contract, and the reasons are those of `revokeSession`.
--
-- WHO MAY DO WHAT TO THE TABLE (forced row-level security; the runtime login holds no `DELETE` and cannot select the hash):
--   * the `authentication` capability reads, inserts and updates: the sign-in (finding and using a trusted browser, through the two
--     definer functions below, since it cannot select the hash), the second step (issuing one, and removing the oldest of five) and the
--     enrolment that replaces an authenticator (removing the person's trusted browsers);
--   * a STAFF context reads and removes **its own** rows (`SELF`): the list and the removal of a person's own trusted browsers;
--   * a STAFF context under `staff.session.revoke` reads the rows of an identity its scope shows, and removes **those of the one identity
--     the operation has locked** (`melarc.locked_identity`, set by `melarc.staff_locked_facts`, which admits that key from this migration)
--     with the cause `ADMINISTRATOR`; under `staff.mfa.reset` it removes those of the identity the reset has locked with `FACTOR_RESET`.
--   * the policies of `staff_identity` for `staff.session.revoke` below (read, and the lock that `FOR NO KEY UPDATE` is) are the resetter's
--     of 0030, for a second key: they let that key's operations read and lock an identity the caller's scope shows, and change none.
-- THE GUARDS: an insert is an unused, unremoved row for a privileged, `ACTIVE` identity, bound to the identity's `ACTIVE` factor and to the
-- generation it holds now, on the database's clock and for exactly seven days; an update keeps everything but the use and the removal, moves
-- `last_used_at` forward only, and never brings a removed row back.

CREATE TABLE "trusted_browser" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_identity_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"factor_id" uuid NOT NULL,
	"credential_generation" bigint NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_cause" text,
	"revoked_by" uuid,
	CONSTRAINT "trusted_browser_token_hash_is_sha256" CHECK (octet_length("trusted_browser"."token_hash") = 32),
	CONSTRAINT "trusted_browser_credential_generation_positive" CHECK ("trusted_browser"."credential_generation" >= 1),
	CONSTRAINT "trusted_browser_label_bounded" CHECK (char_length("trusted_browser"."label") BETWEEN 1 AND 80 AND "trusted_browser"."label" !~ '[[:cntrl:]]'),
	CONSTRAINT "trusted_browser_expiry_after_creation" CHECK ("trusted_browser"."expires_at" > "trusted_browser"."created_at"),
	CONSTRAINT "trusted_browser_last_use_not_before_creation" CHECK ("trusted_browser"."last_used_at" IS NULL OR "trusted_browser"."last_used_at" >= "trusted_browser"."created_at"),
	CONSTRAINT "trusted_browser_revocation_is_whole" CHECK (("trusted_browser"."revoked_at" IS NULL) = ("trusted_browser"."revocation_cause" IS NULL) AND ("trusted_browser"."revoked_at" IS NOT NULL OR "trusted_browser"."revoked_by" IS NULL) AND ("trusted_browser"."revoked_at" IS NULL OR "trusted_browser"."revoked_at" >= "trusted_browser"."created_at")),
	CONSTRAINT "trusted_browser_revocation_cause_closed" CHECK ("trusted_browser"."revocation_cause" IS NULL OR "trusted_browser"."revocation_cause" IN ('SELF', 'ADMINISTRATOR', 'FACTOR_RESET', 'FACTOR_REPLACED', 'CREDENTIAL_CHANGED', 'REPLACED')),
	CONSTRAINT "trusted_browser_revoker_follows_cause" CHECK (("trusted_browser"."revocation_cause" IN ('SELF', 'ADMINISTRATOR') AND "trusted_browser"."revoked_by" IS NOT NULL) OR ("trusted_browser"."revocation_cause" = 'REPLACED' AND "trusted_browser"."revoked_by" IS NULL) OR "trusted_browser"."revocation_cause" IN ('FACTOR_RESET', 'FACTOR_REPLACED', 'CREDENTIAL_CHANGED') OR "trusted_browser"."revocation_cause" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "trusted_browser" ADD CONSTRAINT "trusted_browser_identity_fkey" FOREIGN KEY ("staff_identity_id") REFERENCES "public"."staff_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_browser" ADD CONSTRAINT "trusted_browser_factor_fkey" FOREIGN KEY ("factor_id") REFERENCES "public"."mfa_factor"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_browser" ADD CONSTRAINT "trusted_browser_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "public"."staff_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_browser_token_hash_key" ON "trusted_browser" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "trusted_browser_identity_live_idx" ON "trusted_browser" USING btree ("staff_identity_id","created_at") WHERE "trusted_browser"."revoked_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "trusted_browser" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "trusted_browser" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trusted_browser" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trusted_browser_select" ON "trusted_browser" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    WHEN 'STAFF' THEN staff_identity_id = melarc.current_principal_id()
      OR (current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
          AND staff_identity_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid)
      OR (current_setting('melarc.authorization_key', true) = 'staff.session.revoke'
          AND EXISTS (SELECT 1 FROM staff_identity AS i WHERE i.id = trusted_browser.staff_identity_id))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "trusted_browser_insert" ON "trusted_browser" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
      AND last_used_at IS NULL AND revoked_at IS NULL AND revocation_cause IS NULL AND revoked_by IS NULL
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "trusted_browser_update" ON "trusted_browser" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    WHEN 'STAFF' THEN revoked_at IS NULL AND (
         staff_identity_id = melarc.current_principal_id()
      OR (current_setting('melarc.authorization_key', true) IN ('staff.mfa.reset', 'staff.session.revoke')
          AND staff_identity_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    WHEN 'STAFF' THEN revoked_at IS NOT NULL AND revoked_by = melarc.current_principal_id() AND (
         (staff_identity_id = melarc.current_principal_id() AND revocation_cause = 'SELF')
      OR (current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
          AND staff_identity_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
          AND revocation_cause = 'FACTOR_RESET')
      OR (current_setting('melarc.authorization_key', true) = 'staff.session.revoke'
          AND staff_identity_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
          AND revocation_cause = 'ADMINISTRATOR'))
    ELSE false
  END
);
--> statement-breakpoint
-- The identity a trusted-browser operation of an administrator acts on: read and locked in the caller's scope, changed never (the check of
-- the update arm is false). The same two policies as the resetter's of 0030, for the key that ends a staff identity's standing access.
CREATE POLICY "staff_identity_session_revoker_read" ON "staff_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.session.revoke'
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "staff_identity_session_revoker_lock" ON "staff_identity" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.session.revoke'
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN false
    ELSE false
  END
);
--> statement-breakpoint
-- Every column but the hash: nothing the runtime selects, in any context, can be used to sign in. `INSERT` writes the hash and cannot read it.
GRANT SELECT ("id", "staff_identity_id", "factor_id", "credential_generation", "label", "created_at", "expires_at", "last_used_at", "revoked_at", "revocation_cause", "revoked_by") ON "trusted_browser" TO melarc_api_runtime;
--> statement-breakpoint
GRANT INSERT ON "trusted_browser" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("last_used_at", "revoked_at", "revocation_cause", "revoked_by") ON "trusted_browser" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.trusted_browser_insert_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.last_used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.revocation_cause IS NOT NULL OR NEW.revoked_by IS NOT NULL THEN
    RAISE EXCEPTION 'a trusted browser is issued unused and not removed' USING ERRCODE = '23514';
  END IF;
  -- The database's own clock, and exactly seven days from it: the application cannot give a longer one.
  IF NEW.created_at > clock_timestamp() + interval '1 second' OR NEW.created_at < clock_timestamp() - interval '1 minute' THEN
    RAISE EXCEPTION 'a trusted browser is created at the database''s clock' USING ERRCODE = '23514';
  END IF;
  IF NEW.expires_at IS DISTINCT FROM NEW.created_at + interval '7 days' THEN
    RAISE EXCEPTION 'a trusted browser lasts seven days from the moment it is issued' USING ERRCODE = '23514';
  END IF;
  -- Only an identity that signs in with an authenticator has one, on the credential it holds now.
  IF NOT EXISTS (SELECT 1 FROM public.staff_identity s JOIN public.role_bundle b ON b.id = s.role_bundle_id
                  WHERE s.id = NEW.staff_identity_id AND s.status = 'ACTIVE'
                    AND s.credential_generation = NEW.credential_generation AND b.privileged) THEN
    RAISE EXCEPTION 'a trusted browser is issued to an active privileged identity on the credential it holds now' USING ERRCODE = '23514';
  END IF;
  -- And bound to the authenticator the code was proved against.
  IF NOT EXISTS (SELECT 1 FROM public.mfa_factor f
                  WHERE f.id = NEW.factor_id AND f.staff_identity_id = NEW.staff_identity_id AND f.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'a trusted browser is bound to the active authenticator of its identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.trusted_browser_insert_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.trusted_browser_insert_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "trusted_browser_insert_guard" BEFORE INSERT ON "trusted_browser"
  FOR EACH ROW EXECUTE FUNCTION melarc.trusted_browser_insert_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.trusted_browser_update_guard() RETURNS trigger LANGUAGE plpgsql
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
--> statement-breakpoint
CREATE TRIGGER "trusted_browser_update_guard" BEFORE UPDATE ON "trusted_browser"
  FOR EACH ROW EXECUTE FUNCTION melarc.trusted_browser_update_guard();
--> statement-breakpoint
-- The sign-in's one question and its one act: is this credential a valid trusted browser of this identity, and if it is, it was used now.
-- The hash is compared here, where it can be selected; the answer is the row's identifier, or nothing. It answers the `authentication`
-- capability alone. Valid means: not removed, `now < expires_at` on the clock read here, the identity `ACTIVE`, its `ACTIVE` factor the one
-- the browser was trusted with, and its credential generation the one it was trusted on. The caller has locked the identity first.
CREATE FUNCTION melarc.use_trusted_browser(p_token_hash bytea, p_identity uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  evaluated_at timestamptz;
  used uuid;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'SYSTEM' OR melarc.task_capability() IS DISTINCT FROM 'authentication' THEN
    RAISE EXCEPTION 'a trusted browser is used under the authentication capability alone' USING ERRCODE = '42501';
  END IF;
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 OR p_identity IS NULL THEN
    RETURN NULL;
  END IF;
  evaluated_at := pg_catalog.clock_timestamp();
  UPDATE public.trusted_browser AS t
     SET last_used_at = evaluated_at
    FROM public.staff_identity AS i, public.mfa_factor AS f
   WHERE t.token_hash = p_token_hash
     AND t.staff_identity_id = p_identity
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
-- Which of an identity's trusted browsers the credential in a request is, whatever its state: so that a list can mark the browser asking and
-- a removal of it can clear the cookie. The authentication capability may ask for any identity; a staff context only for its own.
CREATE FUNCTION melarc.trusted_browser_id_for(p_token_hash bytea, p_identity uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  found uuid;
BEGIN
  IF NOT (
       (melarc.principal_type() = 'SYSTEM' AND melarc.task_capability() = 'authentication')
    OR (melarc.principal_type() = 'STAFF' AND melarc.current_principal_id() = p_identity)) THEN
    RAISE EXCEPTION 'a trusted browser is recognised for its own identity, or under the authentication capability' USING ERRCODE = '42501';
  END IF;
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 OR p_identity IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT t.id INTO found FROM public.trusted_browser AS t
   WHERE t.token_hash = p_token_hash AND t.staff_identity_id = p_identity;
  RETURN found;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.trusted_browser_id_for(bytea, uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.trusted_browser_id_for(bytea, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.trusted_browser_id_for(bytea, uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- `melarc.staff_locked_facts` of 0029 and 0030, replaced to admit one more key: an administrator who removes the trusted browsers of a staff
-- identity locks it first, so that a sign-in that is issuing one at the same moment is either removed with the rest or issues nothing. The
-- body is that of 0031 (the latest definition) and only the list of keys (and its message) differ; a `CREATE OR REPLACE` keeps the owner, the grants and the callers.
CREATE OR REPLACE FUNCTION melarc.staff_locked_facts(p_id uuid)
RETURNS TABLE (
  identity_id uuid,
  status text,
  origin text,
  privileged boolean,
  has_credential boolean,
  has_active_factor boolean,
  has_pending_factor boolean,
  has_usable_grant boolean,
  has_pending_delivery boolean,
  latest_status text,
  latest_revoked_by_admin boolean,
  latest_has_episode boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  locked uuid;
  evaluated_at timestamptz;
BEGIN
  IF previous_type <> 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('staff.identity.approve', 'staff.mfa.reset', 'staff.session.revoke') THEN
    RAISE EXCEPTION 'the facts a mutation reads under the identity''s lock are read by staff.identity.approve, staff.mfa.reset and staff.session.revoke alone' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a mutation reads under its locks at read committed, in no other level' USING ERRCODE = '25000';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'the facts are asked for one staff identity' USING ERRCODE = '22023';
  END IF;

  -- The identity the transaction acts on is none until one is locked in the caller's scope.
  PERFORM pg_catalog.set_config('melarc.locked_identity', '', true);
  -- The identity, in the caller's own context and under the lock: the policies of the key decide whether the scope shows it.
  SELECT i.id INTO locked FROM public.staff_identity AS i WHERE i.id = p_id FOR NO KEY UPDATE;
  IF locked IS NULL THEN
    RETURN;
  END IF;
  -- The binding of the policies of the grant and the delivery job: this identity, which the scope showed and this transaction holds.
  PERFORM pg_catalog.set_config('melarc.locked_identity', locked::text, true);
  -- One clock for the grant's expiry and the message's deadline, read after the lock (and after any wait for it).
  evaluated_at := pg_catalog.clock_timestamp();

  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);

  RETURN QUERY
    SELECT i.id, i.status::text, i.origin::text, b.privileged, (i.credential_established_at IS NOT NULL),
           EXISTS (SELECT 1 FROM public.mfa_factor AS f WHERE f.staff_identity_id = i.id AND f.status = 'ACTIVE'),
           EXISTS (SELECT 1 FROM public.mfa_factor AS f WHERE f.staff_identity_id = i.id AND f.status = 'PENDING'),
           EXISTS (SELECT 1 FROM public.setup_grant AS g
                    WHERE g.principal_type = 'STAFF' AND g.principal_id = i.id
                      AND g.purpose IN ('MFA_ENROLMENT', 'MFA_REENROLMENT') AND g.state = 'PENDING'
                      AND (g.expires_at IS NULL OR g.expires_at > evaluated_at)),
           EXISTS (SELECT 1 FROM public.credential_delivery_job AS j
                     JOIN public.setup_grant AS g ON g.id = j.redemption_record_id
                    WHERE j.redemption_record_type = 'SETUP_GRANT' AND g.principal_type = 'STAFF' AND g.principal_id = i.id
                      AND g.purpose IN ('MFA_ENROLMENT', 'MFA_REENROLMENT') AND g.state = 'PENDING'
                      AND j.state IN ('QUEUED', 'LEASED', 'RETRYABLE') AND j.expires_at > evaluated_at),
           l.status::text, (l.revoked_by IS NOT NULL), (l.revocation_episode_id IS NOT NULL)
      FROM public.staff_identity AS i
      JOIN public.role_bundle AS b ON b.id = i.role_bundle_id
      LEFT JOIN LATERAL (SELECT f.status, f.revoked_by, f.revocation_episode_id
                           FROM public.mfa_factor AS f
                          WHERE f.staff_identity_id = i.id
                          ORDER BY f.ordinal DESC LIMIT 1) AS l ON true
     WHERE i.id = locked;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.staff_locked_facts(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.staff_locked_facts(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.staff_locked_facts(uuid) TO melarc_api_runtime;
