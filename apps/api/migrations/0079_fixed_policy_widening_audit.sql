-- The audit follow-up of 7 November 2026, task A3.4 (the Product Owner's decision; contract change none, catalogue change `permission.fixed_policy.widened`): the primitive of the
-- fixed Vendor and Rider policy, `melarc.change_fixed_policy` (0017), records a REDUCTION (by the sessions it ends) and recorded a WIDENING nowhere, as the bundle primitive did before 0078.
-- This gives a widening the bundle's treatment. Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1), in the one transaction of the
-- migrator. Three steps, in this order.
--
--   0. The policy locks come first, as in 0078 (the reason is written there): both audiences' fixed-policy keys are taken before the ALTER TABLE of step 1 holds its ACCESS EXCLUSIVE lock on
--      audit_event, so that the migrator never holds the ledger while it waits for a key, and an application transaction that took a key first and writes the ledger after cannot be
--      waited for by a migrator that holds the ledger and wants the key.
--   1. The closed set of object types of the ledger gains FixedPermissionPolicy (audit.md section 3; the registry's entity of that name). The CHECK is dropped and added again the way 0047 and 0078
--      did it, as drizzle generates it from AUDIT_OBJECT_TYPES (src/platform/audit/audit-vocabulary.ts). The table is scanned once to validate the wider CHECK.
--   2. melarc.change_fixed_policy is replaced (CREATE OR REPLACE, so that its owner and its EXECUTE grant stay as 0017 left them; both are stated again below, which the lint requires of a SECURITY
--      DEFINER function in the migration that replaces it). Same signature, same attributes (SECURITY DEFINER, fixed search_path), same result, same checks, same lock and the same effect on the
--      policy and on the sessions: a reduction is exactly as before. What is new, and the only thing: a WIDENING (p_reduction false) also writes one enhanced permission.fixed_policy.widened
--      (audit.md section 5.6, "Facts of permission.fixed_policy.widened"), in the same transaction, by SYSTEM with no actor, under the authentication capability that already holds the ledger's
--      SYSTEM policy, carrying the caller's correlation id, the audience, the revision the policy was raised to, the minimum a widening does not move, and the revision before and after. The
--      compiled rules are code and not rows, so the event cannot say what they gained: it says that a release declared them wider, and the release is the record of what.
--
-- What is not done: the widenings that 0043 made under the old function (both audiences, to revision 2) are not recorded after the fact, as 0078 recorded those of 0075 and 0077. 0078 could show
-- that they happened on a given database because a bundle seeded after the decisions of 5 and 6 November starts at revision 1 and the revision counts the changes. A fixed policy has no such
-- count: since 0046 the seed writes the revision the build declares, so a database seeded after it holds revision 2 without 0043 having changed anything, and a database that 0043 raised holds
-- the same 2. An event written for either would state, in a ledger that cannot be corrected, something that may be false. It is a Finding of the audit follow-up (the run's report), not a record.

DO $fixed_policy_widening_audit_locks$
BEGIN
  -- Step 0: both audiences' fixed-policy keys, before the table lock of the statement after next (see the header).
  PERFORM melarc.lock_policy_keys(ARRAY[]::uuid[], ARRAY['RIDER', 'VENDOR']::text[]);
END
$fixed_policy_widening_audit_locks$;
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_event_object_type_closed";--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_object_type_closed" CHECK ("audit_event"."object_type" IN ('StaffIdentity', 'RiderIdentity', 'VendorAccount', 'VendorCredential', 'Session', 'MfaFactor', 'MfaChallenge', 'RiderSignInChallenge', 'SetupGrant', 'RecoveryRequest', 'RegisteredDevice', 'HUB', 'PickupRequest', 'AdHocSender', 'PickupManifest', 'PickupStop', 'CollectionRecord', 'CollectionHandshake', 'CollectionDispute', 'RunCustodyHandover', 'PickupIntake', 'Order', 'PayerCorrection', 'Evidence', 'RoleBundle', 'FixedPermissionPolicy'));
--> statement-breakpoint
-- The change of a compiled fixed policy, as 0017 defined it, with the event of a WIDENING. It raises the revision by one; a reduction also raises the minimum to it and ends every live session of
-- that audience recorded under a lower policy revision (or under none: such a session cannot be trusted), with AUTHORITY_CHANGED and one enhanced auth.session.authority_revoked each; a widening
-- ends no session and is recorded by one enhanced permission.fixed_policy.widened. It takes the fixed-policy lock, after any bundle lock of the same transaction, and runs at read committed only.
CREATE OR REPLACE FUNCTION melarc.change_fixed_policy(p_principal_type text, p_reduction boolean, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  current_revision integer;
  current_minimum integer;
  new_revision integer;
  ended uuid[] := ARRAY[]::uuid[];
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a fixed policy is changed at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  IF p_reduction IS NULL OR p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$' THEN
    RAISE EXCEPTION 'a fixed-policy change states whether it reduces the policy and carries a correlation id of 1 to 128 letters, digits and . _ : / # - (a release step or an operation)' USING ERRCODE = '22023';
  END IF;

  PERFORM melarc.lock_policy_fixed(p_principal_type);
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);

  SELECT f.revision, f.minimum_revision INTO current_revision, current_minimum
    FROM public.fixed_permission_policy AS f WHERE f.principal_type = p_principal_type FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no fixed policy for that audience' USING ERRCODE = 'P0002';
  END IF;
  new_revision := current_revision + 1;
  UPDATE public.fixed_permission_policy
     SET revision = new_revision, minimum_revision = CASE WHEN p_reduction THEN new_revision ELSE minimum_revision END
   WHERE principal_type = p_principal_type;

  IF p_reduction THEN
    PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
    WITH locked AS (
      SELECT s.id FROM public.session AS s
       WHERE s.principal_type = p_principal_type AND s.terminated_at IS NULL
         AND (s.policy_revision IS NULL OR s.policy_revision < new_revision)
       ORDER BY s.id FOR UPDATE
    ), done AS (
      UPDATE public.session AS s
         SET terminated_at = greatest(pg_catalog.clock_timestamp(), s.issued_at), termination_reason = 'AUTHORITY_CHANGED'
        FROM locked WHERE s.id = locked.id
      RETURNING s.id
    ), written AS (
      INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, object_id,
                                      correlation_id, reason_code, reason_label, related_ids, before_after, detail, outcome,
                                      enhanced, serialisation_version)
        SELECT pg_catalog.uuidv7(), 'auth.session.authority_revoked', pg_catalog.clock_timestamp(), 'SYSTEM', NULL, 'SYSTEM',
               'Session', done.id, p_correlation_id, 'AUTHORITY_CHANGED', 'Authority changed',
               pg_catalog.jsonb_build_object('principal_type', p_principal_type, 'minimum_revision', new_revision),
               '{"session": "ACTIVE_TO_TERMINATED"}'::pg_catalog.jsonb, '{}'::pg_catalog.jsonb, 'SUCCEEDED', true, 1
          FROM done
    )
    SELECT coalesce(pg_catalog.array_agg(done.id ORDER BY done.id), ARRAY[]::uuid[]) INTO ended FROM done;
  ELSE
    -- A widening ends no session and is recorded by one event, in the same transaction (audit.md section 5.6, "Facts of permission.fixed_policy.widened"). The policy belongs to
    -- no hub, has no identifier (its key is the audience, which is a fact in related_ids), and the minimum is the one the widening leaves where it was.
    PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
    INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, object_id,
                                    correlation_id, related_ids, before_after, detail, outcome, enhanced, serialisation_version)
      VALUES (pg_catalog.uuidv7(), 'permission.fixed_policy.widened', pg_catalog.clock_timestamp(), 'SYSTEM', NULL, 'SYSTEM',
              'FixedPermissionPolicy', NULL, p_correlation_id,
              pg_catalog.jsonb_build_object('principal_type', p_principal_type, 'revision', new_revision, 'minimum_revision', current_minimum),
              pg_catalog.jsonb_build_object('revision', pg_catalog.jsonb_build_object('before', current_revision, 'after', new_revision)),
              '{}'::pg_catalog.jsonb, 'SUCCEEDED', true, 1);
  END IF;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN pg_catalog.jsonb_build_object(
    'kind', CASE WHEN p_reduction THEN 'REDUCTION' ELSE 'ADDITION' END,
    'revision', new_revision,
    'minimum_revision', CASE WHEN p_reduction THEN new_revision ELSE current_minimum END,
    'ended', pg_catalog.to_jsonb(ended)
  );
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.change_fixed_policy(text, boolean, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.change_fixed_policy(text, boolean, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.change_fixed_policy(text, boolean, text) TO melarc_migration_elevated;
