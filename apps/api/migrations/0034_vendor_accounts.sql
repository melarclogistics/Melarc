-- S0.47 (the vendor fixture, `listVendorAccounts`, `getVendorAccount`), forward-only: nothing an earlier migration created is amended.
-- Applied as melarc_migration_elevated. The first statements are the generated part (drizzle-kit, from src/vendor/*.schema.ts); the rest is
-- written by hand and is in this migration so that the tables never exist for a moment without their owner, their policies, their grants
-- and their guards.
--
-- FOUR TABLES. A minimal `vendor_organization` (the recovery guard of S0.50 reads its status, a staff reader is scoped by its responsible
-- hub, a vendor session shows its name; creating and deciding one are SLICE-008's), the `vendor_account` (the one shared portal account
-- of an organisation, a global master record), its `vendor_credential` (the shared secret, its lockout, the recovery channel) and the
-- vendor part of `registered_device` (a browser the vendor registered; the rider part is S0.53's, in a migration of its own).
--
-- WHO MAY DO WHAT (forced row-level security on all four; the runtime login holds no DELETE, and no privilege on the two secret columns):
--   * the organisation is read by a STAFF context under one of the three vendor keys at any scope (it is the master an account's hub is
--     read from), by the vendor its own and by the `authentication` capability. Nothing the API runs writes it.
--   * an account is read by a STAFF context under `vendor.read`, `vendor.organization.approve` or `vendor.credential.recover` when its
--     organisation's responsible hub is in the scope of the operation (or under the explicit all-hub scope), by the vendor its own and by
--     the `authentication` capability. **The hub narrowing is structural** (data-scope-registry.md section 8.5 leaves where to the Backend
--     Engineer): the operations cannot forget it. `vendor_account_probe` is the scope probe's policy (SECURITY_DESIGN.md section 14.4b);
--     the probe reads the account's hub on its organisation (`hubVia`). **The account row is the identity lock**: the runtime may lock it
--     (the authentication capability; an administrative key in scope) and change nothing of it, since its status is SLICE-008's.
--   * the credential is the `authentication` capability's alone (the registry keeps Staff and Vendor `DENY`): the sign-in, the setup and
--     the recovery read and change it; the two reads of an account are given booleans by `melarc.vendor_credential_facts`, and an
--     administrative act the facts and the one destination it queues to by `melarc.vendor_locked_facts`, under the account's lock. The
--     runtime may change the secret, its generation and moment, and the lockout, and never the three columns of the recovery channel.
--   * a registered browser is read by a STAFF context under a vendor key for an account its scope shows, by the vendor its own and by the
--     `authentication` capability, which alone inserts and ends one. Its credential's hash is found by `melarc.vendor_device_by_credential`.
--   * the `seed` capability inserts the non-production fixture (MIGRATION_AND_SEEDING.md section 4b) through `melarc.add_vendor_fixture`,
--     which the provisioning login alone may execute: an `ACTIVE` organisation made and decided by the reserved system actor, its `ACTIVE`
--     account, and a credential with no secret, delivered by email.
-- THE GUARDS. An account keeps its identifier and organisation. A credential's generation rises by exactly one when its secret is set or
-- replaced, with a new moment, and never moves back; a rehash at a new cost keeps both. A browser keeps its account, kind, credential and
-- registration, and ends once: `ACTIVE` to `REVOKED` or `REPLACED`, with the moment, never back.
CREATE TABLE "vendor_organization" (
	"id" uuid PRIMARY KEY NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"trading_name" text,
	"contact_phone" text,
	"contact_email" text,
	"operational_status" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	CONSTRAINT "vendor_organization_status_closed" CHECK ("vendor_organization"."operational_status" IN ('CREATED_BY_OPS', 'PENDING_SENIOR_OPS_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'TERMINATED')),
	CONSTRAINT "vendor_organization_names_not_blank" CHECK (length(btrim("vendor_organization"."legal_name")) > 0 AND ("vendor_organization"."trading_name" IS NULL OR length(btrim("vendor_organization"."trading_name")) > 0)),
	CONSTRAINT "vendor_organization_contact_present" CHECK ("vendor_organization"."contact_phone" IS NOT NULL OR "vendor_organization"."contact_email" IS NOT NULL),
	CONSTRAINT "vendor_organization_decision_by_status" CHECK (("vendor_organization"."decided_by" IS NOT NULL) = ("vendor_organization"."operational_status" IN ('ACTIVE', 'REJECTED', 'SUSPENDED', 'TERMINATED'))
         AND ("vendor_organization"."decided_by" IS NULL) = ("vendor_organization"."decided_at" IS NULL)),
	CONSTRAINT "vendor_organization_checker_is_not_maker" CHECK ("vendor_organization"."decided_by" IS NULL OR "vendor_organization"."decided_by" <> "vendor_organization"."created_by"
         OR "vendor_organization"."created_by" = '5eed0000-0000-4000-8000-0000000000a1'),
	CONSTRAINT "vendor_organization_rejection_has_reason" CHECK ("vendor_organization"."operational_status" <> 'REJECTED' OR "vendor_organization"."decision_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "vendor_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vendor_organization_id" uuid NOT NULL,
	"account_identifier" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_account_status_closed" CHECK ("vendor_account"."status" IN ('ACTIVE', 'SUSPENDED')),
	CONSTRAINT "vendor_account_identifier_shape" CHECK ("vendor_account"."account_identifier" ~ '^[2-9A-HJKMNP-Z]{8}$')
);
--> statement-breakpoint
CREATE TABLE "vendor_credential" (
	"vendor_account_id" uuid PRIMARY KEY NOT NULL,
	"secret_hash" text,
	"credential_established_at" timestamp with time zone,
	"credential_generation" bigint DEFAULT 0 NOT NULL,
	"failed_attempt_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"recovery_phone" text,
	"recovery_email" text,
	"delivery_channel" text,
	CONSTRAINT "vendor_credential_whole" CHECK (("vendor_credential"."secret_hash" IS NULL) = ("vendor_credential"."credential_established_at" IS NULL) AND ("vendor_credential"."secret_hash" IS NULL) = ("vendor_credential"."credential_generation" = 0)),
	CONSTRAINT "vendor_credential_generation_non_negative" CHECK ("vendor_credential"."credential_generation" >= 0),
	CONSTRAINT "vendor_credential_secret_bounded" CHECK ("vendor_credential"."secret_hash" IS NULL OR length("vendor_credential"."secret_hash") BETWEEN 1 AND 1024),
	CONSTRAINT "vendor_credential_failures_non_negative" CHECK ("vendor_credential"."failed_attempt_count" >= 0),
	CONSTRAINT "vendor_credential_channel_present" CHECK ("vendor_credential"."recovery_phone" IS NOT NULL OR "vendor_credential"."recovery_email" IS NOT NULL),
	CONSTRAINT "vendor_credential_phone_shape" CHECK ("vendor_credential"."recovery_phone" IS NULL OR "vendor_credential"."recovery_phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "vendor_credential_email_shape" CHECK ("vendor_credential"."recovery_email" IS NULL OR (length("vendor_credential"."recovery_email") BETWEEN 3 AND 320 AND "vendor_credential"."recovery_email" !~ '[[:space:][:cntrl:]]' AND position('@' in "vendor_credential"."recovery_email") > 1)),
	CONSTRAINT "vendor_credential_delivery_channel_closed" CHECK ("vendor_credential"."delivery_channel" IS NULL OR "vendor_credential"."delivery_channel" IN ('PHONE', 'EMAIL')),
	CONSTRAINT "vendor_credential_delivery_channel_held" CHECK (("vendor_credential"."delivery_channel" IS DISTINCT FROM 'PHONE' OR "vendor_credential"."recovery_phone" IS NOT NULL) AND ("vendor_credential"."delivery_channel" IS DISTINCT FROM 'EMAIL' OR "vendor_credential"."recovery_email" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "registered_device" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"vendor_account_id" uuid,
	"device_kind" text NOT NULL,
	"device_credential_hash" "bytea",
	"status" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"registered_by" uuid,
	"ended_at" timestamp with time zone,
	CONSTRAINT "registered_device_principal_closed" CHECK ("registered_device"."principal_type" IN ('VENDOR')),
	CONSTRAINT "registered_device_kind_closed" CHECK ("registered_device"."device_kind" IN ('VENDOR_BROWSER_CREDENTIAL')),
	CONSTRAINT "registered_device_status_closed" CHECK ("registered_device"."status" IN ('ACTIVE', 'REPLACED', 'REVOKED')),
	CONSTRAINT "registered_device_vendor_shape" CHECK ("registered_device"."principal_type" <> 'VENDOR' OR ("registered_device"."vendor_account_id" = "registered_device"."principal_id"
          AND "registered_device"."device_kind" = 'VENDOR_BROWSER_CREDENTIAL'
          AND octet_length("registered_device"."device_credential_hash") = 32)),
	CONSTRAINT "registered_device_end_follows_status" CHECK (("registered_device"."status" = 'ACTIVE') = ("registered_device"."ended_at" IS NULL) AND ("registered_device"."ended_at" IS NULL OR "registered_device"."ended_at" >= "registered_device"."registered_at"))
);
--> statement-breakpoint
ALTER TABLE "vendor_organization" ADD CONSTRAINT "vendor_organization_hub_fkey" FOREIGN KEY ("responsible_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_account" ADD CONSTRAINT "vendor_account_organization_fkey" FOREIGN KEY ("vendor_organization_id") REFERENCES "public"."vendor_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credential" ADD CONSTRAINT "vendor_credential_account_fkey" FOREIGN KEY ("vendor_account_id") REFERENCES "public"."vendor_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registered_device" ADD CONSTRAINT "registered_device_vendor_account_fkey" FOREIGN KEY ("vendor_account_id") REFERENCES "public"."vendor_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_organization_hub_idx" ON "vendor_organization" USING btree ("responsible_hub_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_account_organization_key" ON "vendor_account" USING btree ("vendor_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_account_identifier_key" ON "vendor_account" USING btree ("account_identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "registered_device_credential_hash_key" ON "registered_device" USING btree ("device_credential_hash");--> statement-breakpoint
CREATE INDEX "registered_device_principal_idx" ON "registered_device" USING btree ("principal_type","principal_id","registered_at");
--> statement-breakpoint
ALTER TABLE "vendor_organization" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "vendor_account" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "vendor_credential" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "registered_device" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "vendor_organization" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendor_organization" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendor_account" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendor_account" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendor_credential" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendor_credential" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "registered_device" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "registered_device" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The organisation: the master record a staff reader under a vendor key reads an account's hub and names from, the vendor's own, and the
-- authentication capability's (the sign-in and the recovery read its status).
CREATE POLICY "vendor_organization_select" ON "vendor_organization" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) IN ('vendor.read', 'vendor.organization.approve', 'vendor.credential.recover')
    WHEN 'VENDOR' THEN id = melarc.current_vendor_organization_id()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "vendor_organization_seed_select" ON "vendor_organization" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "vendor_organization_seed_insert" ON "vendor_organization" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' AND operational_status = 'ACTIVE'
      AND created_by = melarc.reserved_system_actor_id() AND decided_by = melarc.reserved_system_actor_id() AND decision_reason IS NULL
    ELSE false
  END
);
--> statement-breakpoint

-- The account: in the hub scope of the operation for the three vendor keys, through the organisation (which the same keys read).
CREATE POLICY "vendor_account_select" ON "vendor_account" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) IN ('vendor.read', 'vendor.organization.approve', 'vendor.credential.recover')
      AND EXISTS (SELECT 1 FROM vendor_organization AS o
                   WHERE o.id = vendor_account.vendor_organization_id
                     AND (melarc.hub_scope_mode() = 'ALL' OR o.responsible_hub_id = ANY (melarc.authorized_hub_ids())))
    WHEN 'VENDOR' THEN id = melarc.current_principal_id() AND vendor_organization_id = melarc.current_vendor_organization_id()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
-- The identity lock of a vendor account is its row (`FOR NO KEY UPDATE`): the row a change of the account's standing updates, so that a
-- sign-in, a setup, a recovery or an administrator's act and such a change take turns. The authentication capability takes it, and a STAFF
-- context under one of the two administrative keys for an account its scope shows; nobody the API runs may change the row through it.
CREATE POLICY "vendor_account_lock" ON "vendor_account" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) IN ('vendor.organization.approve', 'vendor.credential.recover')
      AND EXISTS (SELECT 1 FROM vendor_organization AS o
                   WHERE o.id = vendor_account.vendor_organization_id
                     AND (melarc.hub_scope_mode() = 'ALL' OR o.responsible_hub_id = ANY (melarc.authorized_hub_ids())))
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN false
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "vendor_account_probe" ON "vendor_account" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
--> statement-breakpoint
CREATE POLICY "vendor_account_seed_select" ON "vendor_account" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "vendor_account_seed_insert" ON "vendor_account" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' AND status = 'ACTIVE'
    ELSE false
  END
);
--> statement-breakpoint

-- The credential: the authentication capability's, and the fixture's insert.
CREATE POLICY "vendor_credential_select" ON "vendor_credential" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "vendor_credential_update" ON "vendor_credential" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "vendor_credential_seed_insert" ON "vendor_credential" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' AND secret_hash IS NULL AND credential_generation = 0
      AND failed_attempt_count = 0 AND locked_until IS NULL AND delivery_channel = 'EMAIL'
    ELSE false
  END
);
--> statement-breakpoint

-- The registered browser: read by a staff context for an account its scope shows (the policy of the account decides), by the vendor its
-- own; registered and ended by the authentication capability alone, on the database's clock.
CREATE POLICY "registered_device_select" ON "registered_device" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) IN ('vendor.read', 'vendor.organization.approve', 'vendor.credential.recover')
      AND EXISTS (SELECT 1 FROM vendor_account AS a WHERE a.id = registered_device.vendor_account_id)
    WHEN 'VENDOR' THEN principal_type = 'VENDOR' AND principal_id = melarc.current_principal_id()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "registered_device_insert" ON "registered_device" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND status = 'ACTIVE' AND ended_at IS NULL
      AND registered_at <= clock_timestamp() + interval '1 second' AND registered_at >= clock_timestamp() - interval '1 minute'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "registered_device_update" ON "registered_device" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND status = 'ACTIVE'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication' AND status IN ('REVOKED', 'REPLACED')
      AND ended_at <= clock_timestamp() + interval '5 seconds'
    ELSE false
  END
);
--> statement-breakpoint

-- Every column but the secrets. `UPDATE` on the credential is the secret, its generation and moment, and the lockout: never the channel.
GRANT SELECT ON "vendor_organization" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "vendor_account" TO melarc_api_runtime;
--> statement-breakpoint
-- The privilege a row lock needs and nothing more: every update the runtime could make is refused by the lock policy's check.
GRANT UPDATE ("status") ON "vendor_account" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ("vendor_account_id", "credential_established_at", "credential_generation", "failed_attempt_count", "locked_until", "recovery_phone", "recovery_email", "delivery_channel") ON "vendor_credential" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("secret_hash", "credential_established_at", "credential_generation", "failed_attempt_count", "locked_until") ON "vendor_credential" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ("id", "principal_type", "principal_id", "vendor_account_id", "device_kind", "status", "registered_at", "registered_by", "ended_at") ON "registered_device" TO melarc_api_runtime;
--> statement-breakpoint
GRANT INSERT ON "registered_device" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("status", "ended_at") ON "registered_device" TO melarc_api_runtime;
--> statement-breakpoint

CREATE FUNCTION melarc.vendor_account_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.vendor_organization_id IS DISTINCT FROM OLD.vendor_organization_id
     OR NEW.account_identifier IS DISTINCT FROM OLD.account_identifier
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a vendor account keeps its organisation and its identifier' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.vendor_account_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.vendor_account_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "vendor_account_guard" BEFORE UPDATE ON "vendor_account"
  FOR EACH ROW EXECUTE FUNCTION melarc.vendor_account_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.vendor_credential_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.vendor_account_id IS DISTINCT FROM OLD.vendor_account_id THEN
    RAISE EXCEPTION 'a vendor credential stays with its account' USING ERRCODE = '23514';
  END IF;
  IF NEW.credential_generation IS DISTINCT FROM OLD.credential_generation THEN
    -- A secret set or replaced: exactly one more, a secret, and a moment of its own that is not before the last one.
    IF NEW.credential_generation <> OLD.credential_generation + 1 OR NEW.secret_hash IS NULL
       OR NEW.credential_established_at IS NULL
       OR NEW.credential_established_at IS NOT DISTINCT FROM OLD.credential_established_at
       OR (OLD.credential_established_at IS NOT NULL AND NEW.credential_established_at < OLD.credential_established_at) THEN
      RAISE EXCEPTION 'a vendor credential''s generation rises by one with each secret set, with its moment, and never moves back' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.credential_established_at IS DISTINCT FROM OLD.credential_established_at
     OR (NEW.secret_hash IS DISTINCT FROM OLD.secret_hash AND (OLD.secret_hash IS NULL OR NEW.secret_hash IS NULL)) THEN
    -- Without a new generation the secret is rehashed at most: it was there and stays, at the moment it was set.
    RAISE EXCEPTION 'a vendor secret is set or replaced only with a new generation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.vendor_credential_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.vendor_credential_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "vendor_credential_guard" BEFORE UPDATE ON "vendor_credential"
  FOR EACH ROW EXECUTE FUNCTION melarc.vendor_credential_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.registered_device_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.principal_type IS DISTINCT FROM OLD.principal_type
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.vendor_account_id IS DISTINCT FROM OLD.vendor_account_id
     OR NEW.device_kind IS DISTINCT FROM OLD.device_kind
     OR NEW.device_credential_hash IS DISTINCT FROM OLD.device_credential_hash
     OR NEW.registered_at IS DISTINCT FROM OLD.registered_at
     OR NEW.registered_by IS DISTINCT FROM OLD.registered_by THEN
    RAISE EXCEPTION 'a registered device keeps its principal, its kind, its credential and its registration' USING ERRCODE = '23514';
  END IF;
  -- REVOKED and REPLACED are terminal (domain-model.md section 6.8): an ended device is never restored or ended again.
  IF OLD.status <> 'ACTIVE' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.ended_at IS DISTINCT FROM OLD.ended_at) THEN
    RAISE EXCEPTION 'an ended device stays as it ended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.registered_device_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.registered_device_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "registered_device_guard" BEFORE UPDATE ON "registered_device"
  FOR EACH ROW EXECUTE FUNCTION melarc.registered_device_guard();
--> statement-breakpoint

-- The one way to read the hash of a vendor's shared secret: the authentication capability alone, one account by its id.
CREATE FUNCTION melarc.vendor_secret_hash(p_account_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  found text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'SYSTEM' OR melarc.task_capability() IS DISTINCT FROM 'authentication' THEN
    RAISE EXCEPTION 'a vendor secret is read under the authentication capability alone' USING ERRCODE = '42501';
  END IF;
  SELECT c.secret_hash INTO found FROM public.vendor_credential AS c WHERE c.vendor_account_id = p_account_id;
  RETURN found;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.vendor_secret_hash(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.vendor_secret_hash(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.vendor_secret_hash(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- The browser a credential belongs to, whatever its state, found by the hash of the credential and by nothing else, for the authentication
-- capability alone: its id, its account and its status. The hash is compared here and is not returned.
CREATE FUNCTION melarc.vendor_device_by_credential(p_credential_hash bytea)
RETURNS TABLE (device_id uuid, vendor_account_id uuid, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'SYSTEM' OR melarc.task_capability() IS DISTINCT FROM 'authentication' THEN
    RAISE EXCEPTION 'a registered browser is found by its credential under the authentication capability alone' USING ERRCODE = '42501';
  END IF;
  IF p_credential_hash IS NULL OR pg_catalog.octet_length(p_credential_hash) <> 32 THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT d.id, d.vendor_account_id, d.status
      FROM public.registered_device AS d
     WHERE d.device_credential_hash = p_credential_hash AND d.principal_type = 'VENDOR';
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.vendor_device_by_credential(bytea) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.vendor_device_by_credential(bytea) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.vendor_device_by_credential(bytea) TO melarc_api_runtime;
--> statement-breakpoint
-- What a staff read of accounts is told of their credentials (`listVendorAccounts`, `getVendorAccount`): for the accounts the caller's scope
-- shows and no other, in one snapshot (repeatable read), whether a secret is established, which channels are registered, which one messages
-- go by, and the generation (which the account's version includes). No hash, no address, no number.
CREATE FUNCTION melarc.vendor_credential_facts(p_ids uuid[])
RETURNS TABLE (
  vendor_account_id uuid,
  credential_established boolean,
  has_recovery_email boolean,
  has_recovery_phone boolean,
  delivery_channel text,
  credential_generation integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  visible uuid[];
BEGIN
  IF previous_type <> 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'vendor.read' THEN
    RAISE EXCEPTION 'the credential facts of vendor accounts are read under the authorization of vendor.read alone' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') NOT IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION 'the credential facts of vendor accounts are read in one snapshot or not at all (repeatable read)' USING ERRCODE = '25000';
  END IF;
  IF p_ids IS NULL OR pg_catalog.cardinality(p_ids) > 100 THEN
    RAISE EXCEPTION 'the facts are asked for a list of at most 100 vendor accounts' USING ERRCODE = '22023';
  END IF;

  -- The scope first, in the caller's own context: only accounts it is shown.
  SELECT coalesce(pg_catalog.array_agg(a.id), '{}'::uuid[]) INTO visible
    FROM public.vendor_account AS a
   WHERE a.id = ANY (p_ids);

  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);

  RETURN QUERY
    SELECT c.vendor_account_id, (c.secret_hash IS NOT NULL), (c.recovery_email IS NOT NULL), (c.recovery_phone IS NOT NULL),
           c.delivery_channel, c.credential_generation::integer
      FROM public.vendor_credential AS c
     WHERE c.vendor_account_id = ANY (visible)
     ORDER BY c.vendor_account_id;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.vendor_credential_facts(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.vendor_credential_facts(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.vendor_credential_facts(uuid[]) TO melarc_api_runtime;
--> statement-breakpoint
-- What an administrative act on a vendor account reads under the account's lock (`reissueVendorCredentialSetup` under
-- `vendor.organization.approve`, `recoverVendorCredential` under `vendor.credential.recover`, at READ COMMITTED): the account row is locked
-- in the caller's own context (`FOR NO KEY UPDATE`, the identity lock the sign-in, the setup and the recovery take; the policy of the key
-- decides whether the scope shows it), the transaction is bound to it (`melarc.locked_vendor_account`, which the policies of the grant and
-- the message read) and the facts are read **in a statement of their own, after the lock**, with **the one destination the act queues to**:
-- the registered address of the delivery channel. An account outside the scope is no row and no binding, as for one that does not exist.
CREATE FUNCTION melarc.vendor_locked_facts(p_id uuid)
RETURNS TABLE (
  vendor_account_id uuid,
  account_status text,
  organization_status text,
  credential_established boolean,
  credential_generation integer,
  has_recovery_email boolean,
  has_recovery_phone boolean,
  delivery_channel text,
  delivery_destination text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  locked uuid;
BEGIN
  IF previous_type <> 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('vendor.organization.approve', 'vendor.credential.recover') THEN
    RAISE EXCEPTION 'the facts an act reads under a vendor credential''s lock are read by vendor.organization.approve and vendor.credential.recover alone' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a mutation reads under its locks at read committed, in no other level' USING ERRCODE = '25000';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'the facts are asked for one vendor account' USING ERRCODE = '22023';
  END IF;

  -- The account the transaction acts on is none until one is locked in the caller's scope.
  PERFORM pg_catalog.set_config('melarc.locked_vendor_account', '', true);
  -- The account, in the caller's own context and under the lock: the policy of the key decides whether the scope shows it.
  SELECT a.id INTO locked FROM public.vendor_account AS a WHERE a.id = p_id FOR NO KEY UPDATE;
  IF locked IS NULL THEN
    RETURN;
  END IF;
  -- The binding of the policies of the grant and the delivery job: this account, which the scope showed and this transaction holds.
  PERFORM pg_catalog.set_config('melarc.locked_vendor_account', locked::text, true);

  -- The facts, in a statement of their own and so in a snapshot taken after any wait for the lock.
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
  RETURN QUERY
    SELECT a.id, a.status, o.operational_status, (c.secret_hash IS NOT NULL), c.credential_generation::integer,
           (c.recovery_email IS NOT NULL), (c.recovery_phone IS NOT NULL), c.delivery_channel,
           CASE c.delivery_channel WHEN 'EMAIL' THEN c.recovery_email WHEN 'PHONE' THEN c.recovery_phone END
      FROM public.vendor_account AS a
      JOIN public.vendor_organization AS o ON o.id = a.vendor_organization_id
      JOIN public.vendor_credential AS c ON c.vendor_account_id = a.id
     WHERE a.id = locked;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.vendor_locked_facts(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.vendor_locked_facts(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.vendor_locked_facts(uuid) TO melarc_api_runtime;
--> statement-breakpoint

-- The non-production vendor fixture (MIGRATION_AND_SEEDING.md section 4b), the only way it gets in: the provisioning login holds no
-- privilege on the vendor tables. One organisation of the payload's responsible hub, `ACTIVE`, made and decided by the reserved system actor;
-- its `ACTIVE` account with the identifier the command generated; a credential with **no secret**, a registered email that is the delivery
-- channel, no browser and no grant. A second run refuses (55000) while a fixture organisation exists: nothing in this slice makes another.
CREATE FUNCTION melarc.add_vendor_fixture(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  organization public.vendor_organization;
  account public.vendor_account;
  credential public.vendor_credential;
  found bigint;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the vendor fixture is added at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  IF payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'object'
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(payload)) <> 3
     OR pg_catalog.jsonb_typeof(payload -> 'vendor_organization') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(payload -> 'vendor_account') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(payload -> 'vendor_credential') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(payload -> 'vendor_organization') <> 1
     OR pg_catalog.jsonb_array_length(payload -> 'vendor_account') <> 1
     OR pg_catalog.jsonb_array_length(payload -> 'vendor_credential') <> 1 THEN
    RAISE EXCEPTION 'the payload is one organisation, one account and one credential' USING ERRCODE = '22023';
  END IF;
  organization := pg_catalog.jsonb_populate_record(NULL::public.vendor_organization, payload -> 'vendor_organization' -> 0);
  account := pg_catalog.jsonb_populate_record(NULL::public.vendor_account, payload -> 'vendor_account' -> 0);
  credential := pg_catalog.jsonb_populate_record(NULL::public.vendor_credential, payload -> 'vendor_credential' -> 0);
  IF account.vendor_organization_id IS DISTINCT FROM organization.id OR credential.vendor_account_id IS DISTINCT FROM account.id THEN
    RAISE EXCEPTION 'the fixture account is the organisation''s and the credential the account''s' USING ERRCODE = '22023';
  END IF;
  -- No secret: the vendor sets its own, through the grant the re-issue sends.
  IF credential.secret_hash IS NOT NULL OR credential.credential_established_at IS NOT NULL THEN
    RAISE EXCEPTION 'the fixture carries no secret' USING ERRCODE = '22023';
  END IF;
  -- A recovery channel no real person holds: an email address of the reserved `.invalid` domain, and no phone.
  IF credential.recovery_phone IS NOT NULL OR credential.recovery_email IS NULL OR credential.recovery_email NOT LIKE '%@%.invalid' THEN
    RAISE EXCEPTION 'the fixture is delivered by an email address of the .invalid domain and has no phone' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.vendor_organization IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);

  SELECT pg_catalog.count(*) INTO found FROM public.vendor_organization AS o WHERE o.created_by = melarc.reserved_system_actor_id();
  IF found <> 0 THEN
    RAISE EXCEPTION 'the vendor fixture is already present: table vendor_organization holds % of them', found
      USING ERRCODE = '55000', TABLE = 'vendor_organization', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;

  INSERT INTO public.vendor_organization (id, responsible_hub_id, legal_name, trading_name, contact_phone, contact_email, operational_status,
                                          created_by, created_at, decided_by, decided_at, decision_reason)
    VALUES (organization.id, organization.responsible_hub_id, organization.legal_name, organization.trading_name, NULL,
            organization.contact_email, 'ACTIVE', melarc.reserved_system_actor_id(), pg_catalog.clock_timestamp(),
            melarc.reserved_system_actor_id(), pg_catalog.clock_timestamp(), NULL);
  INSERT INTO public.vendor_account (id, vendor_organization_id, account_identifier, status, created_at)
    VALUES (account.id, organization.id, account.account_identifier, 'ACTIVE', pg_catalog.clock_timestamp());
  INSERT INTO public.vendor_credential (vendor_account_id, secret_hash, credential_established_at, credential_generation,
                                        failed_attempt_count, locked_until, recovery_phone, recovery_email, delivery_channel)
    VALUES (account.id, NULL, NULL, 0, 0, NULL, NULL, credential.recovery_email, 'EMAIL');

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN pg_catalog.jsonb_build_object('vendor_organization', 1, 'vendor_account', 1, 'vendor_credential', 1);
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.add_vendor_fixture(jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.add_vendor_fixture(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.add_vendor_fixture(jsonb) TO melarc_provisioning;
