-- Audit finding A3 (7 November 2026; the Product Owner's decision, contract change approved): the bundle-change primitive (0017) recorded a REDUCTION (by the sessions it ends) and recorded
-- an ADDITION nowhere, so the widening of the Platform Admin's grants by 0075 and 0077 left no event. Applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1), in the one transaction of the migrator. Three steps, in this order.
--
--   1. The closed set of object types of the ledger gains RoleBundle (audit.md section 3; domain-model.md section 6.9). The CHECK is dropped and added again the way 0047 did it, as drizzle
--      generates it from AUDIT_OBJECT_TYPES (src/platform/audit/audit-vocabulary.ts). The table is scanned once to validate the wider CHECK.
--   2. melarc.change_role_bundle is replaced (CREATE OR REPLACE, so that its owner and its EXECUTE grant stay as 0017 left them; both are stated again below, which the lint requires of a
--      SECURITY DEFINER function in the migration that replaces it). Same signature, same attributes (SECURITY DEFINER, fixed search_path), same result, same checks, same lock and same
--      order of work. What is new, and the only thing: an ADDITION also writes one enhanced permission.bundle.widened (audit.md section 5.6, "Facts of permission.bundle.widened"), in the
--      same transaction, by SYSTEM with no actor, under the authentication capability that already holds the ledger's SYSTEM policy, carrying the caller's correlation id, the new revision
--      and the floor an addition does not move, the bundle's name as the change leaves it, and as before and after the grants the change added or widened, as texts
--      permission_key|hub_scope|ownership_scope|tier ordered by key. A REDUCTION, a change of the name alone and a change that changes nothing are exactly as before (the same revision and
--      floor, the same sessions ended, the same auth.session.authority_revoked, and no new event). The loop that decides the kind of change now visits the grants in the order of their keys,
--      which changes nothing it decides, so that the lists are the same on every run.
--   3. The two widenings that 0075 and 0077 made under the old primitive are put on record: one permission.bundle.widened for each, for the Platform Admin bundle, by SYSTEM, with the
--      correlation label that migration gave the primitive. See below for what is known and what is derived.
--
-- What the record of step 3 knows, and how it knows it. The ledger is append-only, so an event that states something false could never be taken back. The migration therefore writes an event only
-- for a widening that it can show happened on THIS database, and for nothing else.
--
--   * Which grants. 0075 changed every grant of the Platform Admin bundle whose hub scope was `own` to `all`, `staff.device.reregister` excepted, and 0077 changed that one. The grants of the
--     bundle at that point were the three lists of tools/seed/bundles.ts as first written (SLICE_000_GRANTS, SLICE_001_GRANTS, NOTIFICATION_READ_GRANTS: the content of a database seeded
--     before them, which 0043 and 0057 complete), so the Platform Admin's grants at `own` there are 34: the 33 listed below, and staff.device.reregister. The list is written out here and a database
--     test (platform-admin-widening-record.db.test.ts) holds it to those constants. The ownership scope and the tier of a grant were carried over unchanged by both migrations, so they are read
--     from the grant as it is now.
--   * Whether it happened here. A bundle starts at revision 1 (the seed) and its revision rises by one with every change of its grants, so the revision says how many changes the bundle has had. Only
--     four release steps ever changed the Platform Admin bundle, in this order: 0043 (the keys of SLICE-001), 0057 (notification.read), 0075 and 0077, and a database seeded at the build of
--     one of them was brought up by the steps after it and by none before it. A bundle seeded before 0043 is at revision 5, before 0057 at 4, before 0075 at 3, before 0077 at 2, and a bundle
--     seeded after the decisions of 5 and 6 November 2026 (a new database, or the owner's re-created one) is at revision 1 because nothing has changed it. So 0077 widened it when the revision is
--     at least 2 and 0075 when it is at least 3, and the revision 0075 raised it to is the stored one less the steps that followed it. A bundle at revision 1 gets no event, and neither does a
--     database with no bundle (not seeded yet: the seed writes the whole content there, as 0075 says).
--   * When the history is not that one, nothing is written. A floor other than 1 (the bundle has been reduced), a revision above 5 (it has been changed by something that is not one of the four
--     steps), or a grant the step names that is not now held at `all` means the arithmetic above does not describe this bundle; the migration says so in a warning and writes nothing for it, because
--     a record that cannot be shown to be true is worse than a missing one that is reported. It never refuses to go on: this is a record and changes no authority.
--   * When it happened. The moment of the widening was not recorded, so occurred_at is the moment this migration ran, and the two facts widened_by_migration and recorded_by_migration say what
--     happened and when it was written down. The event is otherwise the one the primitive writes for the same change (a database test compares the two).
--   * The migration changes no revision, no floor, no grant and no session, and ends none. It takes the exclusive lock of every bundle first, in the canonical order of lock_policy_keys
--     (SECURITY_DESIGN.md section 13.10a), as 0075 and 0077 did, so the reads that follow cannot be overtaken by a sign-in or another change; the labels are the ones the primitive uses, and it
--     puts back what it found.
--
-- A database that applied 0043 or 0057 under the old primitive has no record of those additions either; the decision names the widenings of 0075 and 0077 and this migration records those.
--
-- The record is written once, whatever happens to this file (the Product Owner's rule of 7 November 2026, afternoon: it is idempotent). The migrator applies each file once, but the file can be applied by
-- hand or by a test to a database that already holds it, and the ledger is append-only, so a second pair of events could never be taken back. The migration cannot ask the ledger whether an event is already
-- there: the ledger is read by staff alone (a SYSTEM context is "INSERT only" on it: data-scope-registry.md section 4.5, AuditEvent; probed: it counts 0 of the ledger's rows), and this file runs as the
-- migration identity, not as staff. So the guard is the identity of the event itself. Each of the two events has a fixed identifier of its own (5eed0078-0000-4000-8000-000000000075 for the widening of 0075,
-- ...000077 for that of 0077: the `5eed` reserved range the seeded rows use), and the insert is `ON CONFLICT DO NOTHING`, with no conflict target (a target needs the right to read the column, and the ledger's
-- read policy admits staff alone, so row-level security refuses the insert of a SYSTEM context that names one; the ledger's one unique constraint is its primary key): the primary key refuses the second event
-- of a widening, with no read of the ledger and with nothing to race. A notice says when an event was already there. The fixed identifiers also keep the order of the two in the ledger, oldest step first (the
-- ledger orders by `recorded_at`, then `id`). A database that applied an EARLIER TEXT of this file (it wrote the same two events under random identifiers, before the file had left the developer's machine) is
-- refused by the history check of the runner until its journal row is corrected or it is reset (MIGRATION_AND_SEEDING.md section 5.5).

ALTER TABLE "audit_event" DROP CONSTRAINT "audit_event_object_type_closed";--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_object_type_closed" CHECK ("audit_event"."object_type" IN ('StaffIdentity', 'RiderIdentity', 'VendorAccount', 'VendorCredential', 'Session', 'MfaFactor', 'MfaChallenge', 'RiderSignInChallenge', 'SetupGrant', 'RecoveryRequest', 'RegisteredDevice', 'HUB', 'PickupRequest', 'AdHocSender', 'PickupManifest', 'PickupStop', 'CollectionRecord', 'CollectionHandshake', 'CollectionDispute', 'RunCustodyHandover', 'PickupIntake', 'Order', 'PayerCorrection', 'Evidence', 'RoleBundle'));--> statement-breakpoint
-- The change of a bundle, as 0017 defined it, with the event of an ADDITION. `p_grants` is the complete new set of the bundle's grants as a JSON array of objects with exactly the keys
-- permission_key, hub_scope, ownership_scope and tier (tier null where the holder has none), or null to leave the grants alone; `p_name` is the new name or null. Returns a JSON object: the
-- kind of change (NONE, NAME_ONLY, ADDITION, REDUCTION), the bundle's revision and floor, and the ids of the sessions it ended. One transaction, in this order: the arguments are checked (no
-- table is read); the exclusive lock of the bundle is taken, and nothing is read before it; the current revision is read under it; the kind of change is decided on the diff; the new content and
-- the counters are written; and then, for a REDUCTION, every live session of the bundle recorded below the new floor is ended with AUTHORITY_CHANGED and given one enhanced
-- auth.session.authority_revoked, and, for an ADDITION, one enhanced permission.bundle.widened is written and no session is ended. A change of the name alone raises nothing and writes nothing.
-- It runs at read committed only, so that every read follows the lock.
CREATE OR REPLACE FUNCTION melarc.change_role_bundle(p_bundle_id uuid, p_name text, p_grants jsonb, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  current_revision integer;
  current_floor integer;
  current_name text;
  new_revision integer;
  kind text := 'NONE';
  removed boolean := false;
  narrowed boolean := false;
  widened boolean := false;
  each_grant record;
  changes text[];
  ended uuid[] := ARRAY[]::uuid[];
  -- What an ADDITION adds or widens, for its event: the grants a change widened as they were, and the grants it added or widened as they are, each as one text.
  before_grants text[] := ARRAY[]::text[];
  after_grants text[] := ARRAY[]::text[];
  added_count integer := 0;
  widened_count integer := 0;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a bundle is changed at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  -- The correlation id names a release step or an operation and is written to the ledger as it is: letters, digits and . _ : / # -,
  -- 1 to 128 of them. That is a check of shape and no screen for a secret or for data about a person: the caller passes an
  -- identifier it generated or a fixed label of the release step (a UUID, "release-2026.10#policy-1"), never text that a user typed.
  IF p_bundle_id IS NULL OR p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$' THEN
    RAISE EXCEPTION 'a bundle change names the bundle and carries a correlation id of 1 to 128 letters, digits and . _ : / # - (a release step or an operation)' USING ERRCODE = '22023';
  END IF;
  IF p_name IS NOT NULL AND pg_catalog.length(pg_catalog.btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'a bundle name is not empty' USING ERRCODE = '22023';
  END IF;
  IF p_grants IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_grants) <> 'array' THEN
      RAISE EXCEPTION 'the grants of a bundle are a JSON array of grants' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(p_grants) AS e
       WHERE CASE WHEN pg_catalog.jsonb_typeof(e) <> 'object' THEN true
                  ELSE (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(e)) <> 4
                       OR NOT (pg_catalog.jsonb_exists(e, 'permission_key') AND pg_catalog.jsonb_exists(e, 'hub_scope')
                               AND pg_catalog.jsonb_exists(e, 'ownership_scope') AND pg_catalog.jsonb_exists(e, 'tier'))
                       OR (e ->> 'permission_key') IS NULL
                       OR (e ->> 'hub_scope') IS NULL OR (e ->> 'hub_scope') NOT IN ('none', 'own', 'all')
                       OR (e ->> 'ownership_scope') IS NULL OR (e ->> 'ownership_scope') NOT IN ('own', 'assigned', 'any')
                       OR ((e ->> 'tier') IS NOT NULL AND (e ->> 'tier') NOT IN ('A', 'S', 'P'))
             END
    ) THEN
      RAISE EXCEPTION 'every grant has exactly a permission_key, a hub_scope (none, own, all), an ownership_scope (own, assigned, any) and a tier (A, S, P or null)' USING ERRCODE = '22023';
    END IF;
    IF (SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT e ->> 'permission_key') FROM pg_catalog.jsonb_array_elements(p_grants) AS e) THEN
      RAISE EXCEPTION 'a bundle holds each permission once' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- The exclusive lock first: nothing is read before it is held.
  PERFORM melarc.lock_policy_bundle(p_bundle_id);
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);

  SELECT b.revision, b.reduction_floor, b.name INTO current_revision, current_floor, current_name
    FROM public.role_bundle AS b WHERE b.id = p_bundle_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such bundle' USING ERRCODE = 'P0002';
  END IF;

  IF p_grants IS NOT NULL THEN
    FOR each_grant IN
      SELECT o.permission_key AS old_key, o.hub_scope AS old_hub, o.ownership_scope AS old_ownership, o.tier AS old_tier,
             n.permission_key AS new_key, n.hub_scope AS new_hub, n.ownership_scope AS new_ownership, n.tier AS new_tier
        FROM (SELECT g.permission_key, g.hub_scope, g.ownership_scope, g.tier
                FROM public.role_bundle_grant AS g WHERE g.bundle_id = p_bundle_id) AS o
        FULL JOIN (SELECT e ->> 'permission_key' AS permission_key, e ->> 'hub_scope' AS hub_scope,
                          e ->> 'ownership_scope' AS ownership_scope, e ->> 'tier' AS tier
                     FROM pg_catalog.jsonb_array_elements(p_grants) AS e) AS n
          ON n.permission_key = o.permission_key
       ORDER BY coalesce(n.permission_key, o.permission_key) COLLATE "C"
    LOOP
      IF each_grant.new_key IS NULL THEN
        removed := true;
      ELSIF each_grant.old_key IS NULL THEN
        widened := true;
        added_count := added_count + 1;
        after_grants := pg_catalog.array_append(after_grants,
          each_grant.new_key || '|' || each_grant.new_hub || '|' || each_grant.new_ownership || '|' || coalesce(each_grant.new_tier, '-'));
      ELSE
        changes := ARRAY[
          melarc.grant_attribute_change('hub_scope', each_grant.old_hub, each_grant.new_hub),
          melarc.grant_attribute_change('ownership_scope', each_grant.old_ownership, each_grant.new_ownership),
          melarc.grant_attribute_change('tier', each_grant.old_tier, each_grant.new_tier)
        ];
        IF 'OTHER' = ANY (changes) THEN narrowed := true;
        ELSIF 'WIDER' = ANY (changes) THEN
          widened := true;
          widened_count := widened_count + 1;
          before_grants := pg_catalog.array_append(before_grants,
            each_grant.old_key || '|' || each_grant.old_hub || '|' || each_grant.old_ownership || '|' || coalesce(each_grant.old_tier, '-'));
          after_grants := pg_catalog.array_append(after_grants,
            each_grant.new_key || '|' || each_grant.new_hub || '|' || each_grant.new_ownership || '|' || coalesce(each_grant.new_tier, '-'));
        END IF;
      END IF;
    END LOOP;
    IF removed OR narrowed THEN
      kind := 'REDUCTION';
    ELSIF widened THEN
      kind := 'ADDITION';
    END IF;
  END IF;

  IF kind = 'NONE' THEN
    IF p_name IS NOT NULL AND p_name <> current_name THEN
      UPDATE public.role_bundle SET name = p_name WHERE id = p_bundle_id;
      kind := 'NAME_ONLY';
    END IF;
  ELSE
    new_revision := current_revision + 1;
    DELETE FROM public.role_bundle_grant AS o
     WHERE o.bundle_id = p_bundle_id
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_grants) AS e WHERE e ->> 'permission_key' = o.permission_key);
    INSERT INTO public.role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier)
      SELECT p_bundle_id, e ->> 'permission_key', e ->> 'hub_scope', e ->> 'ownership_scope', e ->> 'tier'
        FROM pg_catalog.jsonb_array_elements(p_grants) AS e
      ON CONFLICT (bundle_id, permission_key)
      DO UPDATE SET hub_scope = excluded.hub_scope, ownership_scope = excluded.ownership_scope, tier = excluded.tier
      WHERE (role_bundle_grant.hub_scope, role_bundle_grant.ownership_scope, role_bundle_grant.tier)
            IS DISTINCT FROM (excluded.hub_scope, excluded.ownership_scope, excluded.tier);
    UPDATE public.role_bundle
       SET revision = new_revision,
           reduction_floor = CASE WHEN kind = 'REDUCTION' THEN new_revision ELSE reduction_floor END,
           name = coalesce(p_name, name)
     WHERE id = p_bundle_id;

    IF kind = 'REDUCTION' THEN
      -- Ending a session is the very state change a reduction makes, so these statements take session rows (in id order) and no
      -- policy lock; they and the audit run under the authentication capability, which has the policies for both.
      PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
      WITH locked AS (
        SELECT s.id FROM public.session AS s
         WHERE s.bundle_id = p_bundle_id AND s.terminated_at IS NULL AND s.bundle_revision < new_revision
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
                 pg_catalog.jsonb_build_object('bundle_id', p_bundle_id, 'revision', new_revision, 'reduction_floor', new_revision),
                 '{"session": "ACTIVE_TO_TERMINATED"}'::pg_catalog.jsonb, '{}'::pg_catalog.jsonb, 'SUCCEEDED', true, 1
            FROM done
      )
      SELECT coalesce(pg_catalog.array_agg(done.id ORDER BY done.id), ARRAY[]::uuid[]) INTO ended FROM done;
      PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);
    ELSE
      -- An addition ends no session and is recorded by one event, in the same transaction (audit.md section 5.6, "Facts of permission.bundle.widened"). The bundle belongs
      -- to no hub, the actor is the system, and the floor is the one the addition leaves where it was.
      PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
      INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, object_id,
                                      correlation_id, related_ids, before_after, detail, outcome, enhanced, serialisation_version)
        VALUES (pg_catalog.uuidv7(), 'permission.bundle.widened', pg_catalog.clock_timestamp(), 'SYSTEM', NULL, 'SYSTEM',
                'RoleBundle', p_bundle_id, p_correlation_id,
                pg_catalog.jsonb_build_object('bundle_id', p_bundle_id, 'revision', new_revision, 'reduction_floor', current_floor),
                pg_catalog.jsonb_build_object('grants', pg_catalog.jsonb_build_object(
                  'before', pg_catalog.to_jsonb(before_grants), 'after', pg_catalog.to_jsonb(after_grants))),
                pg_catalog.jsonb_build_object('bundle_name', coalesce(p_name, current_name), 'added', added_count, 'widened', widened_count),
                'SUCCEEDED', true, 1);
      PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN pg_catalog.jsonb_build_object(
    'kind', kind,
    'revision', coalesce(new_revision, current_revision),
    'reduction_floor', CASE WHEN kind = 'REDUCTION' THEN new_revision ELSE current_floor END,
    'ended', pg_catalog.to_jsonb(ended)
  );
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.change_role_bundle(uuid, text, jsonb, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.change_role_bundle(uuid, text, jsonb, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.change_role_bundle(uuid, text, jsonb, text) TO melarc_migration_elevated;
--> statement-breakpoint
DO $bundle_widening_audit$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  platform_admin constant uuid := '5eed0001-0000-4000-8000-000000000003';
  -- The grants of the Platform Admin that 0075 widened from own to all (the 34 at own as first written, less staff.device.reregister), by key, and the one that 0077 widened.
  widened_by_0075 constant text[] := ARRAY[
    'dispatch.read', 'fleet.custody.accept', 'fleet.custody.initiate', 'fleet.custody.read', 'hub.intake.close', 'hub.intake.close_exception',
    'hub.intake.count', 'hub.intake.itemize', 'hub.osd.adjudicate', 'hub.read', 'notification.read', 'pickup.attempt.extend',
    'pickup.cancellation_charge.waive', 'pickup.exception.request', 'pickup.failure.resolve', 'pickup.handshake.override',
    'pickup.handshake.resolve', 'pickup.manifest.assign', 'pickup.manifest.create', 'pickup.manifest.dispatch', 'pickup.read',
    'pickup.request.cancel', 'pickup.request.cancel_chargeable', 'pickup.request.confirm', 'pickup.request.create', 'pickup.stop.skip',
    'pricing.correction.approve', 'pricing.correction.create', 'pricing.read', 'settings.reason.read', 'staff.device.revoke',
    'vendor.organization.approve', 'vendor.pickup_location.manage'
  ];
  widened_by_0077 constant text[] := ARRAY['staff.device.reregister'];
  held_name text;
  held_revision integer;
  held_floor integer;
  step record;
  held integer;
  held_at_all integer;
  before_grants text[];
  after_grants text[];
  written integer;
BEGIN
  PERFORM melarc.lock_policy_keys(
    ARRAY[
      '5eed0001-0000-4000-8000-000000000001',
      '5eed0001-0000-4000-8000-000000000002',
      '5eed0001-0000-4000-8000-000000000003',
      '5eed0001-0000-4000-8000-000000000004',
      '5eed0001-0000-4000-8000-000000000005',
      '5eed0001-0000-4000-8000-000000000006'
    ]::uuid[],
    ARRAY[]::text[]
  );

  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);

  SELECT b.name, b.revision, b.reduction_floor INTO held_name, held_revision, held_floor
    FROM public.role_bundle AS b WHERE b.id = platform_admin;

  IF NOT FOUND OR held_revision = 1 THEN
    -- Not seeded yet, or seeded after the decisions and never changed since: nothing was widened on this database, so there is nothing to record.
    NULL;
  ELSIF held_floor <> 1 OR held_revision > 5 THEN
    RAISE WARNING 'migration 0078: the Platform Admin bundle is at revision % and floor %, which the four release steps that changed it cannot leave: the widening of 0075 and 0077 is not recorded',
      held_revision, held_floor;
  ELSE
    -- The oldest step first. The revision a step is recorded at is the stored one less the steps that followed it. Each step's event has the fixed identifier that makes its record once-only (see the header).
    FOR step IN
      SELECT *
        FROM (VALUES
          (3, 'release-p1#platform-admin-every-hub', '0075_platform_admin_every_hub', widened_by_0075, held_revision - 1,
           '5eed0078-0000-4000-8000-000000000075'::uuid),
          (2, 'release-p1-1#platform-admin-device-replacement', '0077_platform_admin_device_replacement', widened_by_0077, held_revision,
           '5eed0078-0000-4000-8000-000000000077'::uuid)
        ) AS s(needs_revision, step_label, migration_name, permission_keys, raised_to, event_id)
       WHERE held_revision >= s.needs_revision
       ORDER BY s.needs_revision DESC
    LOOP
      SELECT (pg_catalog.count(*))::pg_catalog.int4,
             (pg_catalog.count(*) FILTER (WHERE g.hub_scope = 'all'))::pg_catalog.int4,
             coalesce(pg_catalog.array_agg(g.permission_key || '|own|' || g.ownership_scope || '|' || coalesce(g.tier, '-')
                                           ORDER BY g.permission_key COLLATE "C"), ARRAY[]::text[]),
             coalesce(pg_catalog.array_agg(g.permission_key || '|all|' || g.ownership_scope || '|' || coalesce(g.tier, '-')
                                           ORDER BY g.permission_key COLLATE "C"), ARRAY[]::text[])
        INTO held, held_at_all, before_grants, after_grants
        FROM public.role_bundle_grant AS g
       WHERE g.bundle_id = platform_admin AND g.permission_key = ANY (step.permission_keys);

      IF held <> pg_catalog.cardinality(step.permission_keys) OR held_at_all <> held THEN
        RAISE WARNING 'migration 0078: the Platform Admin bundle does not hold every grant that % widened at all hubs: that widening is not recorded', step.migration_name;
        CONTINUE;
      END IF;

      PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
      INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, object_id,
                                      correlation_id, related_ids, before_after, detail, outcome, enhanced, serialisation_version)
        VALUES (step.event_id, 'permission.bundle.widened', pg_catalog.clock_timestamp(), 'SYSTEM', NULL, 'SYSTEM',
                'RoleBundle', platform_admin, step.step_label,
                pg_catalog.jsonb_build_object('bundle_id', platform_admin, 'revision', step.raised_to, 'reduction_floor', held_floor),
                pg_catalog.jsonb_build_object('grants', pg_catalog.jsonb_build_object(
                  'before', pg_catalog.to_jsonb(before_grants), 'after', pg_catalog.to_jsonb(after_grants))),
                pg_catalog.jsonb_build_object('bundle_name', held_name, 'added', 0, 'widened', held,
                                              'widened_by_migration', step.migration_name,
                                              'recorded_by_migration', '0078_bundle_widening_audit'),
                'SUCCEEDED', true, 1)
        ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS written = ROW_COUNT;
      PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);
      IF written = 0 THEN
        RAISE NOTICE 'migration 0078: the widening of % is already on record: nothing written', step.migration_name;
      END IF;
    END LOOP;
  END IF;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$bundle_widening_audit$;
