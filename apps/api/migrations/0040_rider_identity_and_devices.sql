-- S0.53 (the rider identity, the rider part of the registered device, `listRiders`, `getRider`, `registerRiderDevice`,
-- `reregisterRiderDevice`), forward-only: nothing an earlier migration created is amended except what 0034 announced it would be (the three
-- closed sets of `registered_device`, widened to hold the rider's key pair) and the bodies of two guard functions, which are replaced to keep
-- one more column write-once (0018/0021 and 0034 are the ones replaced). Applied as melarc_migration_elevated. The first statements are the
-- generated part (drizzle-kit, from src/staff/rider-identity.schema.ts, src/vendor/registered-device.schema.ts and the setup-grant schema);
-- the rest is written by hand and is in this migration so that the table never exists for a moment without its owner, its policies, its
-- grants and its guards.
--
-- THE RIDER IDENTITY (minimal: who, where, and the PIN the rider sets privately). No operation of this slice creates, renames, moves or
-- suspends a rider (SLICE-009, OQ-089); the rows of a demonstration come from the non-production fixture (MIGRATION_AND_SEEDING.md section
-- 4a) through `melarc.add_rider_fixture`, which the provisioning login alone may execute: ACTIVE riders with a number no real person holds
-- (the ITU-reserved +999 range), no PIN and no device.
--   * a STAFF context reads the riders of the scope of the operation it runs, only while the authorization key is `dispatch.read` (the
--     roster) or one of the three device keys (the guard reads the record a path names under the operation's own key): the riders whose
--     primary hub is among the context's hubs, or every rider under the explicit all-hub scope. `rider_identity_probe` is the scope
--     probe's policy (SECURITY_DESIGN.md section 14.4b). A rider reads its own row (the registry: self), the authentication capability reads
--     and updates (the PIN, its generation and the lockout), and the `seed` capability inserts the fixture.
--   * **The PIN's hash is not selectable by the runtime in any context**: `melarc.rider_pin_hash` returns it to the authentication
--     capability alone (sign-in verification, S0.59). The runtime may update the PIN columns (which is also what lets the identity lock be
--     taken) and nothing else; a STAFF context locks the row in its scope and changes none of it (the check of the lock policy is false).
-- THE REGISTERED DEVICE: a rider's device is the public half of a hardware-backed key (124 base64 characters), **not selectable by the
-- runtime** either (`melarc.rider_active_device` answers the authentication capability for the sign-in). A STAFF context reads the devices of
-- the riders its scope shows (the roster's detail), a rider its own, the authentication capability all; the authentication capability
-- inserts and ends a device (`completeRiderDeviceEnrolment`, S0.57) and a STAFF context under `staff.device.revoke` ends the active device
-- of the rider the operation has locked, as `REVOKED` (`revokeRiderDevice`, S0.58). **The database refuses a second ACTIVE device for a
-- rider** (`registered_device_one_active_rider_key`).
-- THE GRANTS THE OFFICERS ISSUE: `registerRiderDevice` (`staff.device.register`, Senior Ops, or a Platform Admin whose grant reaches the
-- rider's hub) and `reregisterRiderDevice` (`staff.device.reregister`, own hub) run in the caller's own staff context under the key of the
-- operation, the mechanism of migrations 0029, 0030 and 0035: `melarc.rider_locked_facts` locks the rider the caller's scope shows and binds
-- the transaction to it (`melarc.locked_rider`), and the arms below admit the key's act on that rider and nothing else: read, end
-- (`SUPERSEDED`, `EXPIRED`) and insert **one pending grant of the key's own purpose**, in the caller's name, with the attestation challenge's
-- hash and no episode, no continuation. The delivery job is not touched: a rider grant travels as a QR and is never queued.
--   * `setup_grant.idempotency_record_id` links a first-registration grant to the idempotency record whose response holds its token and
--     challenge sealed (SECURITY_DESIGN.md section 14.16). **The window of that replay ends when the grant leaves PENDING, and the database
--     ends it**: an AFTER UPDATE trigger erases the sealed fields in the same statement that consumes, supersedes or expires the grant,
--     whoever writes it, so a grant cannot end and leave its secret behind.
--   * the grants a rider can use, for every writer: a rider grant names a rider that exists and whose status is one a device is bound in
--     (not SUSPENDED, not OFFBOARDED: their access has been ended), a first-registration grant is for a rider with no device ACTIVE or
--     REVOKED (a revoked rider is re-bound by re-registration alone), and a re-registration grant for one that has one.
-- `revokeRiderDevice` (`staff.device.revoke`) also reads and ends the locked rider's live session as `DEVICE_REVOKED`.

CREATE TABLE "rider_identity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"full_name" text NOT NULL,
	"status" text NOT NULL,
	"primary_hub_id" uuid NOT NULL,
	"pin_hash" text,
	"pin_established_at" timestamp with time zone,
	"credential_generation" bigint DEFAULT 0 NOT NULL,
	"failed_attempt_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_identity_status_closed" CHECK ("rider_identity"."status" IN ('ACTIVE', 'INACTIVE', 'TEMPORARILY_UNAVAILABLE', 'SUSPENDED', 'OFFBOARDED')),
	CONSTRAINT "rider_identity_phone_shape" CHECK ("rider_identity"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "rider_identity_name_not_empty" CHECK (length(btrim("rider_identity"."full_name")) > 0),
	CONSTRAINT "rider_identity_pin_whole" CHECK (("rider_identity"."pin_hash" IS NULL) = ("rider_identity"."pin_established_at" IS NULL)
        AND ("rider_identity"."pin_hash" IS NULL) = ("rider_identity"."credential_generation" = 0)),
	CONSTRAINT "rider_identity_generation_non_negative" CHECK ("rider_identity"."credential_generation" >= 0),
	CONSTRAINT "rider_identity_pin_bounded" CHECK ("rider_identity"."pin_hash" IS NULL OR length("rider_identity"."pin_hash") BETWEEN 1 AND 1024),
	CONSTRAINT "rider_identity_failed_attempts_non_negative" CHECK ("rider_identity"."failed_attempt_count" >= 0),
	CONSTRAINT "rider_identity_lock_has_failures" CHECK ("rider_identity"."locked_until" IS NULL OR ("rider_identity"."failed_attempt_count" > 0 AND "rider_identity"."credential_generation" > 0))
);
--> statement-breakpoint
ALTER TABLE "registered_device" DROP CONSTRAINT "registered_device_principal_closed";--> statement-breakpoint
ALTER TABLE "registered_device" DROP CONSTRAINT "registered_device_kind_closed";--> statement-breakpoint
ALTER TABLE "registered_device" DROP CONSTRAINT "registered_device_vendor_shape";--> statement-breakpoint
ALTER TABLE "setup_grant" ADD COLUMN "idempotency_record_id" uuid;--> statement-breakpoint
ALTER TABLE "registered_device" ADD COLUMN "rider_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "registered_device" ADD COLUMN "public_key" text;--> statement-breakpoint
ALTER TABLE "rider_identity" ADD CONSTRAINT "rider_identity_primary_hub_fkey" FOREIGN KEY ("primary_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rider_identity_phone_key" ON "rider_identity" USING btree ("phone");--> statement-breakpoint
ALTER TABLE "registered_device" ADD CONSTRAINT "registered_device_rider_identity_fkey" FOREIGN KEY ("rider_identity_id") REFERENCES "public"."rider_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registered_device_one_active_rider_key" ON "registered_device" USING btree ("rider_identity_id") WHERE "registered_device"."status" = 'ACTIVE' AND "registered_device"."principal_type" = 'RIDER';--> statement-breakpoint
ALTER TABLE "setup_grant" ADD CONSTRAINT "setup_grant_replay_by_purpose" CHECK ("setup_grant"."idempotency_record_id" IS NULL OR "setup_grant"."purpose" = 'RIDER_DEVICE_ENROLMENT');--> statement-breakpoint
ALTER TABLE "registered_device" ADD CONSTRAINT "registered_device_rider_shape" CHECK ("registered_device"."principal_type" <> 'RIDER' OR ("registered_device"."rider_identity_id" = "registered_device"."principal_id"
          AND "registered_device"."vendor_account_id" IS NULL
          AND "registered_device"."device_credential_hash" IS NULL
          AND "registered_device"."device_kind" = 'RIDER_ANDROID_KEYPAIR'
          AND "registered_device"."public_key" IS NOT NULL
          AND "registered_device"."public_key" ~ '^[A-Za-z0-9+/]{121}[AQgw]==$'));--> statement-breakpoint
ALTER TABLE "registered_device" ADD CONSTRAINT "registered_device_principal_closed" CHECK ("registered_device"."principal_type" IN ('VENDOR', 'RIDER'));--> statement-breakpoint
ALTER TABLE "registered_device" ADD CONSTRAINT "registered_device_kind_closed" CHECK ("registered_device"."device_kind" IN ('VENDOR_BROWSER_CREDENTIAL', 'RIDER_ANDROID_KEYPAIR'));--> statement-breakpoint
ALTER TABLE "registered_device" ADD CONSTRAINT "registered_device_vendor_shape" CHECK ("registered_device"."principal_type" <> 'VENDOR' OR ("registered_device"."vendor_account_id" = "registered_device"."principal_id"
          AND "registered_device"."rider_identity_id" IS NULL
          AND "registered_device"."public_key" IS NULL
          AND "registered_device"."device_kind" = 'VENDOR_BROWSER_CREDENTIAL'
          AND "registered_device"."device_credential_hash" IS NOT NULL
          AND octet_length("registered_device"."device_credential_hash") = 32));
--> statement-breakpoint
ALTER TABLE "rider_identity" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "rider_identity" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rider_identity" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The rider: read by the staff keys that need the record (the roster, and the record a device operation names), by the rider itself and by
-- the authentication capability; locked by the three device keys and the capability; inserted, as the fixture, by the seed capability.
CREATE POLICY "rider_identity_staff_read" ON "rider_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) IN ('dispatch.read', 'staff.device.register', 'staff.device.reregister', 'staff.device.revoke')
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "rider_identity_select" ON "rider_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN id = melarc.current_principal_id()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "rider_identity_probe" ON "rider_identity" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
--> statement-breakpoint
-- The identity lock of a rider is its row (`FOR NO KEY UPDATE`), taken by the authentication capability (the sign-in, the enrolment) and by
-- a STAFF context under one of the three device keys for a rider its scope shows; nobody the API runs may change the row through it.
CREATE POLICY "rider_identity_update" ON "rider_identity" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) IN ('staff.device.register', 'staff.device.reregister', 'staff.device.revoke')
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
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
CREATE POLICY "rider_identity_seed_select" ON "rider_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "rider_identity_seed_insert" ON "rider_identity" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' AND status = 'ACTIVE' AND phone LIKE '+999%'
      AND pin_hash IS NULL AND pin_established_at IS NULL AND credential_generation = 0
      AND failed_attempt_count = 0 AND locked_until IS NULL
    ELSE false
  END
);
--> statement-breakpoint

-- Every column but the PIN's hash. `UPDATE` is the PIN, its generation and moment, and the lockout: never the name, the number, the status or
-- the hub (those are rider administration's, SLICE-009).
GRANT SELECT ("id", "phone", "full_name", "status", "primary_hub_id", "pin_established_at", "credential_generation", "failed_attempt_count", "locked_until", "created_at") ON "rider_identity" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("pin_hash", "pin_established_at", "credential_generation", "failed_attempt_count", "locked_until") ON "rider_identity" TO melarc_api_runtime;
--> statement-breakpoint
-- The new column of the device, and not the key: the sign-in reads the key through `melarc.rider_active_device`.
GRANT SELECT ("rider_identity_id") ON "registered_device" TO melarc_api_runtime;
--> statement-breakpoint

CREATE FUNCTION melarc.rider_identity_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a rider identity keeps its id and its creation time' USING ERRCODE = '23514';
  END IF;
  -- The staff credential's rule (0016): the generation says which PIN a sign-in verified, goes up by one when a PIN is set or replaced and
  -- never moves back, and the moment of establishment changes only with a new generation. A rehash changes the hash and neither.
  IF NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
     AND NEW.credential_generation <> OLD.credential_generation + 1 THEN
    RAISE EXCEPTION 'a PIN is replaced with its generation raised by one, and the generation never moves back' USING ERRCODE = '23514';
  END IF;
  IF NEW.pin_established_at IS DISTINCT FROM OLD.pin_established_at
     AND NEW.credential_generation = OLD.credential_generation THEN
    RAISE EXCEPTION 'the moment a PIN was established changes only with a new generation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.rider_identity_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.rider_identity_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "rider_identity_guard" BEFORE UPDATE ON "rider_identity"
  FOR EACH ROW EXECUTE FUNCTION melarc.rider_identity_guard();
--> statement-breakpoint

-- The registered device of 0034 keeps two more columns for good: the rider it is bound to and its key.
CREATE OR REPLACE FUNCTION melarc.registered_device_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.principal_type IS DISTINCT FROM OLD.principal_type
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.vendor_account_id IS DISTINCT FROM OLD.vendor_account_id
     OR NEW.rider_identity_id IS DISTINCT FROM OLD.rider_identity_id
     OR NEW.device_kind IS DISTINCT FROM OLD.device_kind
     OR NEW.device_credential_hash IS DISTINCT FROM OLD.device_credential_hash
     OR NEW.public_key IS DISTINCT FROM OLD.public_key
     OR NEW.registered_at IS DISTINCT FROM OLD.registered_at
     OR NEW.registered_by IS DISTINCT FROM OLD.registered_by THEN
    RAISE EXCEPTION 'a registered device keeps its principal, its kind, its credential or key and its registration' USING ERRCODE = '23514';
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

-- The setup grant of 0018 (as 0021 left it) keeps the link to its idempotency record for good.
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
     OR NEW.attestation_challenge_hash IS DISTINCT FROM OLD.attestation_challenge_hash
     OR NEW.idempotency_record_id IS DISTINCT FROM OLD.idempotency_record_id THEN
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

-- The end of a replay: a grant that leaves PENDING erases the sealed secret of the response that issued it, in the same statement and for
-- every writer (SECURITY_DESIGN.md section 14.16: "the transaction that consumes, supersedes or revokes the grant erases the sealed fields in
-- the same commit"). The record is another principal's often (an officer's grant superseded by a colleague's), which no policy lets the
-- caller touch, so the erasure is done as the authentication capability, which the registry names for it, and the caller's context is put
-- back at once. It erases and does nothing else, and only the record the grant names.
CREATE FUNCTION melarc.setup_grant_end_replay() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
BEGIN
  IF OLD.state = 'PENDING' AND NEW.state IS DISTINCT FROM 'PENDING' AND OLD.idempotency_record_id IS NOT NULL THEN
    PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
    PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
    UPDATE public.idempotency_record
       SET sealed_ciphertext = NULL, sealed_nonce = NULL, sealed_key_version = NULL, sealed_envelope_version = NULL,
           sealed_expires_at = NULL, replay_unavailable_at = pg_catalog.now()
     WHERE id = OLD.idempotency_record_id AND sealed_ciphertext IS NOT NULL;
    PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
    PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.setup_grant_end_replay() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.setup_grant_end_replay() FROM PUBLIC;
--> statement-breakpoint
-- A trigger function is run by the table's trigger and not called: the owner alone holds EXECUTE, and no login the API or a worker uses.
GRANT EXECUTE ON FUNCTION melarc.setup_grant_end_replay() TO melarc_owner;
--> statement-breakpoint
CREATE TRIGGER "setup_grant_end_replay" AFTER UPDATE ON "setup_grant"
  FOR EACH ROW EXECUTE FUNCTION melarc.setup_grant_end_replay();
--> statement-breakpoint

-- The registered device of a rider: read by the staff keys that need it for a rider the scope shows (the roster's detail, and the record a
-- device operation names), by the rider itself; the authentication capability's arms of 0034 already read, insert and end any device.
CREATE POLICY "registered_device_rider_select" ON "registered_device" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) IN ('dispatch.read', 'staff.device.register', 'staff.device.reregister', 'staff.device.revoke')
      AND principal_type = 'RIDER'
      AND EXISTS (SELECT 1 FROM rider_identity AS r WHERE r.id = registered_device.rider_identity_id)
    WHEN 'RIDER' THEN principal_type = 'RIDER' AND principal_id = melarc.current_principal_id()
    ELSE false
  END
);
--> statement-breakpoint
-- `revokeRiderDevice` ends the ACTIVE device of the rider the operation has locked, as REVOKED, on the database's clock and in no other way.
CREATE POLICY "registered_device_rider_revoke" ON "registered_device" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.device.revoke'
      AND principal_type = 'RIDER' AND status = 'ACTIVE'
      AND rider_identity_id = nullif(current_setting('melarc.locked_rider', true), '')::uuid
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.device.revoke'
      AND status = 'REVOKED' AND ended_at <= clock_timestamp() + interval '5 seconds'
    ELSE false
  END
);
--> statement-breakpoint

-- The grants the two issuing keys read, end and insert, for the rider the operation has locked and the purpose of the key. The arms name no
-- other table (the delivery worker reads this one and has no privilege on the rider tables), as in 0029 and 0035.
CREATE POLICY "setup_grant_rider_issuer_select" ON "setup_grant" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN principal_type = 'RIDER'
      AND principal_id = nullif(current_setting('melarc.locked_rider', true), '')::uuid
      AND ((current_setting('melarc.authorization_key', true) = 'staff.device.register' AND purpose = 'RIDER_DEVICE_ENROLMENT')
        OR (current_setting('melarc.authorization_key', true) = 'staff.device.reregister' AND purpose = 'RIDER_DEVICE_REREGISTRATION'))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_rider_issuer_insert" ON "setup_grant" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN state = 'PENDING'
      AND principal_type = 'RIDER'
      AND issued_by = melarc.current_principal_id()
      AND episode_id IS NULL
      AND continued_from_grant_id IS NULL
      AND attestation_challenge_hash IS NOT NULL
      AND consumed_at IS NULL
      AND principal_id = nullif(current_setting('melarc.locked_rider', true), '')::uuid
      AND ((current_setting('melarc.authorization_key', true) = 'staff.device.register' AND purpose = 'RIDER_DEVICE_ENROLMENT' AND idempotency_record_id IS NOT NULL)
        OR (current_setting('melarc.authorization_key', true) = 'staff.device.reregister' AND purpose = 'RIDER_DEVICE_REREGISTRATION' AND idempotency_record_id IS NULL))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_rider_issuer_update" ON "setup_grant" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN principal_type = 'RIDER'
      AND state = 'PENDING'
      AND principal_id = nullif(current_setting('melarc.locked_rider', true), '')::uuid
      AND ((current_setting('melarc.authorization_key', true) = 'staff.device.register' AND purpose = 'RIDER_DEVICE_ENROLMENT')
        OR (current_setting('melarc.authorization_key', true) = 'staff.device.reregister' AND purpose = 'RIDER_DEVICE_REREGISTRATION'))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN state IN ('SUPERSEDED', 'EXPIRED')
    ELSE false
  END
);
--> statement-breakpoint

-- The sessions of the rider whose device is revoked: seen and ended with `DEVICE_REVOKED`, for the rider the operation has locked and no other.
CREATE POLICY "session_device_revoker_select" ON "session" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.device.revoke'
      AND principal_type = 'RIDER'
      AND principal_id = nullif(current_setting('melarc.locked_rider', true), '')::uuid
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "session_device_revoker_update" ON "session" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.device.revoke'
      AND principal_type = 'RIDER'
      AND terminated_at IS NULL
      AND principal_id = nullif(current_setting('melarc.locked_rider', true), '')::uuid
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.device.revoke'
      AND terminated_at IS NOT NULL
      AND termination_reason = 'DEVICE_REVOKED'
    ELSE false
  END
);
--> statement-breakpoint

-- The grants a rider can use, for every writer (the authentication capability included): the rider exists, is in a status a device is bound
-- in, and has the device history the purpose assumes. The guard reads the rider tables as the authentication capability reads them, with the
-- writer's own privileges, and puts the writer's context back before it returns (the vendor's guard of 0035 does the same).
CREATE FUNCTION melarc.setup_grant_rider_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  rider_status text;
  live_or_revoked integer;
BEGIN
  IF NEW.principal_type IS DISTINCT FROM 'RIDER' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
  SELECT r.status INTO rider_status FROM public.rider_identity AS r WHERE r.id = NEW.principal_id;
  SELECT pg_catalog.count(*) INTO live_or_revoked FROM public.registered_device AS d
   WHERE d.rider_identity_id = NEW.principal_id AND d.status IN ('ACTIVE', 'REVOKED');
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);

  IF rider_status IS NULL THEN
    RAISE EXCEPTION 'a rider grant is issued to a rider' USING ERRCODE = '23514';
  END IF;
  IF rider_status NOT IN ('ACTIVE', 'INACTIVE', 'TEMPORARILY_UNAVAILABLE') THEN
    RAISE EXCEPTION 'a rider grant is issued to a rider whose access has not been ended' USING ERRCODE = '23514';
  END IF;
  IF NEW.purpose = 'RIDER_DEVICE_ENROLMENT' AND live_or_revoked > 0 THEN
    RAISE EXCEPTION 'a first-registration grant is issued to a rider with no active or revoked device: re-registration binds the others' USING ERRCODE = '23514';
  END IF;
  IF NEW.purpose = 'RIDER_DEVICE_REREGISTRATION' AND live_or_revoked = 0 THEN
    RAISE EXCEPTION 're-registration replaces a device the rider has held' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.setup_grant_rider_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.setup_grant_rider_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "setup_grant_rider_guard" BEFORE INSERT ON "setup_grant"
  FOR EACH ROW EXECUTE FUNCTION melarc.setup_grant_rider_guard();
--> statement-breakpoint

-- The one way to read the hash of a rider's PIN: the authentication capability alone, one rider by id.
CREATE FUNCTION melarc.rider_pin_hash(p_rider_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  found text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'SYSTEM' OR melarc.task_capability() IS DISTINCT FROM 'authentication' THEN
    RAISE EXCEPTION 'a rider PIN is read under the authentication capability alone' USING ERRCODE = '42501';
  END IF;
  SELECT r.pin_hash INTO found FROM public.rider_identity AS r WHERE r.id = p_rider_id;
  RETURN found;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.rider_pin_hash(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.rider_pin_hash(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.rider_pin_hash(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- The key of a rider's ACTIVE device, by the rider and by nothing else, for the authentication capability alone: the sign-in verifies a
-- signature against it. The runtime cannot select the column.
CREATE FUNCTION melarc.rider_active_device(p_rider_id uuid)
RETURNS TABLE (device_id uuid, public_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'SYSTEM' OR melarc.task_capability() IS DISTINCT FROM 'authentication' THEN
    RAISE EXCEPTION 'a rider device is read for its key under the authentication capability alone' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT d.id, d.public_key
      FROM public.registered_device AS d
     WHERE d.rider_identity_id = p_rider_id AND d.principal_type = 'RIDER' AND d.status = 'ACTIVE';
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.rider_active_device(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.rider_active_device(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.rider_active_device(uuid) TO melarc_api_runtime;
--> statement-breakpoint

-- What an administrative act on a rider's device reads under the rider's lock (`registerRiderDevice` under `staff.device.register`,
-- `reregisterRiderDevice` under `staff.device.reregister`, `revokeRiderDevice` under `staff.device.revoke`, at READ COMMITTED): the rider row
-- is locked in the caller's own context (`FOR NO KEY UPDATE`, the identity lock the sign-in and the enrolment take; the policy of the key
-- decides whether the scope shows it), the transaction is bound to it (`melarc.locked_rider`, which the policies of the grant, the device and
-- the session read) and the facts are read **in a statement of their own, after the lock**. A rider outside the scope is no row and no
-- binding, as for one that does not exist.
CREATE FUNCTION melarc.rider_locked_facts(p_id uuid)
RETURNS TABLE (
  rider_id uuid,
  status text,
  primary_hub_id uuid,
  pin_established boolean,
  credential_generation integer,
  active_device_id uuid,
  active_devices integer,
  revoked_devices integer,
  replaced_devices integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  locked uuid;
BEGIN
  IF previous_type <> 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('staff.device.register', 'staff.device.reregister', 'staff.device.revoke') THEN
    RAISE EXCEPTION 'the facts an act reads under a rider''s lock are read by staff.device.register, staff.device.reregister and staff.device.revoke alone' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a mutation reads under its locks at read committed, in no other level' USING ERRCODE = '25000';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'the facts are asked for one rider' USING ERRCODE = '22023';
  END IF;

  -- The rider the transaction acts on is none until one is locked in the caller's scope.
  PERFORM pg_catalog.set_config('melarc.locked_rider', '', true);
  SELECT r.id INTO locked FROM public.rider_identity AS r WHERE r.id = p_id FOR NO KEY UPDATE;
  IF locked IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('melarc.locked_rider', locked::text, true);

  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
  RETURN QUERY
    SELECT r.id, r.status, r.primary_hub_id, (r.pin_established_at IS NOT NULL), r.credential_generation::integer,
           (SELECT d.id FROM public.registered_device AS d WHERE d.rider_identity_id = r.id AND d.status = 'ACTIVE'),
           (SELECT pg_catalog.count(*)::integer FROM public.registered_device AS d WHERE d.rider_identity_id = r.id AND d.status = 'ACTIVE'),
           (SELECT pg_catalog.count(*)::integer FROM public.registered_device AS d WHERE d.rider_identity_id = r.id AND d.status = 'REVOKED'),
           (SELECT pg_catalog.count(*)::integer FROM public.registered_device AS d WHERE d.rider_identity_id = r.id AND d.status = 'REPLACED')
      FROM public.rider_identity AS r
     WHERE r.id = locked;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.rider_locked_facts(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.rider_locked_facts(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.rider_locked_facts(uuid) TO melarc_api_runtime;
--> statement-breakpoint

-- The non-production rider fixture (MIGRATION_AND_SEEDING.md section 4a), the only way it gets in: the provisioning login holds no privilege
-- on the rider tables. At least two riders, each ACTIVE with the seeded hub, a number of the ITU-reserved +999 range (no real person holds
-- one), no PIN and no device: the officers still bind the handset and the rider still sets the PIN, which is what the demonstration shows. It
-- creates nothing else, and a second run refuses (55000) while a fixture rider exists.
CREATE FUNCTION melarc.add_rider_fixture(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  riders public.rider_identity[];
  entry public.rider_identity;
  found bigint;
  inserted integer := 0;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the rider fixture is added at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  IF payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'object'
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(payload)) <> 1
     OR pg_catalog.jsonb_typeof(payload -> 'rider_identity') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(payload -> 'rider_identity') < 2
     OR pg_catalog.jsonb_array_length(payload -> 'rider_identity') > 8 THEN
    RAISE EXCEPTION 'the payload is two to eight riders' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(each) INTO riders
    FROM pg_catalog.jsonb_populate_recordset(NULL::public.rider_identity, payload -> 'rider_identity') AS each;
  FOREACH entry IN ARRAY riders LOOP
    IF entry.id IS NULL OR entry.primary_hub_id IS NULL OR entry.full_name IS NULL OR entry.phone IS NULL
       OR entry.phone !~ '^\+999[0-9]{7,11}$'
       OR entry.pin_hash IS NOT NULL OR entry.pin_established_at IS NOT NULL THEN
      RAISE EXCEPTION 'a fixture rider has an id, a name, a hub and a number of the reserved +999 range, and no PIN' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  LOCK TABLE public.rider_identity IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);

  SELECT pg_catalog.count(*) INTO found FROM public.rider_identity AS r WHERE r.phone LIKE '+999%';
  IF found <> 0 THEN
    RAISE EXCEPTION 'the rider fixture is already present: table rider_identity holds % of them', found
      USING ERRCODE = '55000', TABLE = 'rider_identity', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;
  FOREACH entry IN ARRAY riders LOOP
    INSERT INTO public.rider_identity (id, phone, full_name, status, primary_hub_id, created_at)
      VALUES (entry.id, entry.phone, entry.full_name, 'ACTIVE', entry.primary_hub_id, pg_catalog.clock_timestamp());
    inserted := inserted + 1;
  END LOOP;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN pg_catalog.jsonb_build_object('rider_identity', inserted);
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.add_rider_fixture(jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.add_rider_fixture(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.add_rider_fixture(jsonb) TO melarc_provisioning;
