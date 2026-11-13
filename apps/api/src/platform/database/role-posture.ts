import {
  API_RUNTIME_ROLE,
  PROVISIONING_ROLE,
  WORKER_NOTIFICATION_ROLE,
  WORKER_PICKUP_BACKSTOP_ROLE,
  WORKER_RUNTIME_ROLE,
} from './technical-roles.js';

/**
 * What a runtime login may not be or hold (SECURITY_DESIGN.md §14.6, "What the API's posture check inspects"), asked of
 * the catalogue. One query serves the readiness check of the connected login (`DatabaseService.check`) and the catalogue
 * check of the named logins (`catalog-invariants.ts`), so the two cannot come to disagree about what is unsafe.
 *
 * A flag is a fact that makes row-level security bypassable or removable by the login, or makes the context it reads not
 * the application's to decide:
 *
 * - the attributes `rolsuper`, `rolbypassrls`, `rolcreatedb`, `rolcreaterole` and `rolreplication`;
 * - membership of a predefined `pg_*` role (`has_predefined_role`), or of any role that has an attribute above or can log
 *   in (`member_of_unsafe_role`); a grant-set role such as a worker capability is neither;
 * - a `melarc.*` setting stored on the role or the database (`has_stored_context`), which would be a context no
 *   transaction set;
 * - owning the database, an object (table, view, sequence, index), a schema or a function, directly or through
 *   membership (`owns_database`, `owns_objects`, `owns_schema`, `owns_function`): an owner can alter or drop a policy or
 *   replace an accessor;
 * - `CREATE` on the database or on any schema, however granted (`can_create_in_database`, `can_create_in_schema`): what
 *   it creates, it would own;
 * - `EXECUTE` on a `SECURITY DEFINER` function that an approved migration did not grant it (`can_execute_definer`): such
 *   a function runs with its owner's powers. `APPROVED_DEFINER_EXECUTE` lists the grants a reviewed migration made, per
 *   role, as `schema.function`; adding to it is a reviewed change.
 *
 * A privilege counts when the login holds it, when it inherits it, **and when it can acquire it by becoming a role it is a
 * member of**. A membership granted `WITH INHERIT FALSE, SET TRUE` gives the member none of the role's privileges as they
 * stand (`has_schema_privilege(login, ...)` is false) and lets it `SET ROLE` to the role and have all of them. So the three
 * privilege flags above, like the ownership flags, are asked of every role the login is a member of, directly or through
 * others (`pg_has_role(login, role, 'MEMBER')`, which is true whatever the INHERIT and SET options): a grant-set role that holds
 * no such privilege (the worker's capability role) is not a finding however the membership is granted, and one that holds
 * any of them is, however the membership is granted. This is deliberately wider than what a login can reach today: a
 * membership with neither option reaches nothing yet, and is refused all the same, because a later `GRANT ... SET` would
 * silently change that.
 *
 * The query returns booleans, and a flag that is not exactly `false` is unsafe: an inspection that did not say is not a
 * clean bill.
 */
export const POSTURE_FLAGS = [
  'rolsuper',
  'rolbypassrls',
  'rolcreatedb',
  'rolcreaterole',
  'rolreplication',
  'has_predefined_role',
  'member_of_unsafe_role',
  'has_stored_context',
  'owns_database',
  'owns_objects',
  'owns_schema',
  'owns_function',
  'can_create_in_database',
  'can_create_in_schema',
  'can_execute_definer',
] as const;

export type PostureFlag = (typeof POSTURE_FLAGS)[number];

/**
 * The `SECURITY DEFINER` functions each role may execute, as `schema.function`, because a reviewed migration granted it. Today that
 * is the provisioning login and the two seed functions of migration 0005 (the initialization of the reference data, once, and the
 * test-only reason fixtures): they are the only way that login writes the reference tables, and it holds no privilege on the tables.
 * And the one function of migration 0017 that the seed takes its policy locks with (`melarc.lock_policy_keys`, S0.27): it takes the
 * exclusive advisory locks of the bundles and the fixed policies named, in the canonical order, and reads and writes no table. The
 * change functions of the same migration are on no line: only the migration login, which is not a runtime identity, may execute them.
 * And the API runtime and two functions: the one of migration 0016 that reads a credential hash for the authentication capability, and
 * the one of migration 0027 that gives a staff read the second-factor facts of the identities its scope shows (and nothing else of the
 * factor, grant and delivery tables). The workers are on no line but one (the notification capability's, for the one operation that
 * records a delivered code), so EXECUTE on any other definer is a finding for them, and for the API runtime on any other.
 */
export const APPROVED_DEFINER_EXECUTE: Readonly<Record<string, readonly string[]>> = {
  [PROVISIONING_ROLE]: [
    'melarc.initialize_reference_data',
    'melarc.add_reason_fixtures',
    'melarc.lock_policy_keys',
    // The bootstrap seed and the resume command (migration 0019, S0.30): the only way the provisioning login reaches the identity,
    // grant, factor and audit tables, which it holds no privilege on.
    'melarc.bootstrap_status',
    'melarc.seed_bootstrap_administrators',
    'melarc.bootstrap_identity_state',
    'melarc.resume_bootstrap_identity',
    // The non-production vendor fixture (migration 0034, S0.47; MIGRATION_AND_SEEDING.md section 4b): the only way that login reaches the
    // vendor tables, which it holds no privilege on. One organisation, account and credential with no secret, refused while one exists.
    'melarc.add_vendor_fixture',
    // The non-production rider fixture (migration 0040, S0.53; MIGRATION_AND_SEEDING.md section 4a): the only way that login reaches the
    // rider tables. Two or more ACTIVE riders of the reserved +999 range with no PIN and no device, refused while one exists.
    'melarc.add_rider_fixture',
    // The launch hub's service zones and settings (migration 0042, S1.4; MIGRATION_AND_SEEDING.md section 4): once, refused while any
    // of the three tables holds a row. The only way that login reaches them.
    'melarc.seed_hub_configuration',
  ],
  // The one way to read the credential hash of a staff identity (migration 0016): the runtime has no SELECT on the column, and the
  // function refuses any context but a SYSTEM one under the authentication capability.
  // And the facts of a staff identity's second factor (migration 0027, F02 of the audit of 22 October 2026): for a staff read of
  // `staff.read` in one snapshot, or the authentication capability; it returns facts and no secret, hash, token or record identifier.
  // And the facts of one identity a mutation reads under the identity's lock (migration 0029, S0.36; extended in 0030, S0.37): for a STAFF
  // context under `staff.identity.approve` or `staff.mfa.reset` at READ COMMITTED, in the caller's scope; the same closed list of facts.
  // And the two authentication-only readers of a secret column (migration 0031, F01 of the audit of 23 October 2026): the session row
  // of a token hash (`melarc.session_by_token_hash`) and the sealed seed of one factor (`melarc.mfa_factor_sealed_seed`). The runtime
  // login holds no SELECT on `session.token_hash`, `session.bundle_snapshot` or `mfa_factor.secret_*`; each function answers only a
  // SYSTEM context under the authentication capability, and the seed reader only the factor's own identity.
  // And the two readers of the hash of a trusted browser (migration 0033, the Product Owner's instruction of 25 October 2026): the runtime
  // login cannot select `trusted_browser.token_hash`, so the sign-in uses a credential through `melarc.use_trusted_browser` (the
  // authentication capability alone: valid means not removed, unexpired, the identity active and the factor and generation as bound) and
  // a list recognises the browser asking through `melarc.trusted_browser_id_for` (that capability, or a staff context for its own
  // identity). `melarc.staff_locked_facts` admits `staff.session.revoke` from the same migration.
  // And the four readers of the vendor tables (migration 0034, S0.47): the hash of a vendor's shared secret and the browser a credential
  // belongs to (`melarc.vendor_secret_hash`, `melarc.vendor_device_by_credential`: the authentication capability alone; the runtime cannot
  // select either hash), the credential facts a staff read of `vendor.read` is given in one snapshot (`melarc.vendor_credential_facts`:
  // booleans, the channel's name and the generation, never an address or a hash), and the facts and the one destination an administrative
  // act reads under the credential's lock (`melarc.vendor_locked_facts`: `vendor.organization.approve` or `vendor.credential.recover` at
  // READ COMMITTED, in the caller's scope).
  [API_RUNTIME_ROLE]: [
    'melarc.staff_credential_hash',
    'melarc.staff_reset_facts',
    'melarc.staff_locked_facts',
    'melarc.session_by_token_hash',
    'melarc.mfa_factor_sealed_seed',
    'melarc.use_trusted_browser',
    'melarc.trusted_browser_id_for',
    'melarc.vendor_secret_hash',
    'melarc.vendor_device_by_credential',
    'melarc.vendor_credential_facts',
    'melarc.vendor_locked_facts',
    // And the three readers of the rider tables (migration 0040, S0.53): the hash of a rider's PIN and the key of a rider's active device
    // (`melarc.rider_pin_hash`, `melarc.rider_active_device`: the authentication capability alone; the runtime cannot select either), and
    // the facts an act reads under a rider's lock (`melarc.rider_locked_facts`: `staff.device.register`, `staff.device.reregister` and
    // `staff.device.revoke` at READ COMMITTED, in the caller's scope).
    'melarc.rider_pin_hash',
    'melarc.rider_active_device',
    'melarc.rider_locked_facts',
    // And the two narrow operations of the rider's count (migration 0068, S1.26; OB-S1-53): the direction of a handshake for a stop the rider has
    // arrived at (`melarc.collection_handshake_type`: one word, never a row of the request) and the promotion of an individual sender by a count the
    // rider recorded (`melarc.promote_collected_sender`: the one change, its event in the same change, and the sender's identifier). Each answers the
    // key `pickup.collection.confirm` of a rider alone; the policies of the request, the sender and the promotion's event admit that key only to a
    // statement that runs as the owner, which is a statement inside these two, so the rider's context reads no request and no sender, the login holds
    // no right to update a sender, and no statement of the login writes the promotion's event.
    'melarc.collection_handshake_type',
    'melarc.promote_collected_sender',
    // And the five operations of the collection handshake (migration 0070, S1.27): the code asked for by the rider that counted the stop
    // (`melarc.handshake_issue`), a code entered by the vendor or by the rider (`melarc.handshake_verify`), the SMS fallback
    // (`melarc.handshake_sms_fallback`), and the officer's override and manual resolution (`melarc.handshake_override`,
    // `melarc.handshake_resolve`). Each answers the key of its own act and the kind of principal that holds it, takes the lock of the stop first, and
    // writes the handshake, the close of the stop, the envelope for the notification lane and the events in one change; the policies of those tables
    // admit the keys only to a statement that runs as the owner, which is a statement inside these functions, so the login can write none of them.
    'melarc.handshake_issue',
    'melarc.handshake_verify',
    'melarc.handshake_sms_fallback',
    'melarc.handshake_override',
    'melarc.handshake_resolve',
    // And the one operation of a vendor's dispute of a collection (migration 0071, S1.29): it raises the reconciliation item, sets the handshake `DISPUTED` and
    // writes the event in one change, for the vendor whose pickup it is. The policies of the item, the handshake and the ledger admit the vendor's key only to a
    // statement that runs as the owner, which is a statement inside this function.
    'melarc.dispute_collection',
    // And the one read of a hub's door wait for the rider's failure key (migration 0073): the stop's guard asks it when a vendor-unavailable failure is reported, and the
    // application asks it to say when the report is allowed. It answers that key alone and reads the one setting; a hub that has none is a refusal, and no wait is invented.
    'melarc.rider_door_wait_minutes',
    // And the one derivation of the scope of the evidence of a stop (migration 0080, S1.11): the hub and the vendor organisation of a record about a pickup stop, asked by the
    // evidence guard when the rider that reports the stop's failure declares it. It answers that rider under that key, for a stop it has arrived at on a run in progress that is
    // assigned to it, and no other caller; the scope is derived and never given.
    'melarc.evidence_pickup_stop_scope',
    // And the two envelopes of the rider's acts (the migration `rider_act_envelopes`, S1.28 and OB-S1-51): the outbox envelope of a failure the calling rider has just reported
    // (`melarc.failure_envelope`, key `pickup.failure.report`) and of a short count it has just recorded (`melarc.shortfall_envelope`, key `pickup.collection.confirm`). Each
    // answers that key of a rider alone, for a stop of this rider's that the database shows to have been failed or counted short in the caller's own transaction, and reads
    // every member of the envelope from that stop; the policies of the outbox admit these two events only to a statement that runs as the owner, which is a statement
    // inside these functions, so the login can write neither envelope itself.
    'melarc.failure_envelope',
    'melarc.shortfall_envelope',
    // And the one operation of Ops's exception for the day the camera fails (migration 0088, D-A10): an officer of the stop's hub holding `pickup.handshake.override` lets a
    // stop's count through without parcel photos, once, before the count, with a note. It answers that key of a staff member alone and takes the stop's lock first; the
    // policy of the table admits the write only to a statement that runs as the owner, which is a statement inside this function, so the login can write no exception itself.
    'melarc.authorise_parcel_photo_exception',
  ],
  // The notification lane's grant set holds the one operation that tells a handshake its code was accepted by the provider (migration 0070, S1.27):
  // it moves a handshake from CODE_GENERATED to CODE_DELIVERED at the generation it was told and writes the event, and answers the notification
  // capability alone. The worker's login holds it only through this role, and the check asks both the role and the login that inherits it,
  // so the line is on both.
  // And the one that gives it the number a fallback code is texted to (migration 0073, F-23): the vendor credential's registered phone, for the request its envelope names
  // and only while a fallback code is live for it. The lane reads neither the organisation nor the credential.
  [WORKER_NOTIFICATION_ROLE]: [
    'melarc.handshake_mark_delivered',
    'melarc.notification_handshake_number',
  ],
  // The failure backstop lane's grant set holds the one operation that escalates the failures left undecided beyond their hub's threshold (migration 0084, S1.28; D-A1): it
  // answers the pickup_backstop capability alone, reads the failed stops and the hub's threshold, sets the moment of the escalation and writes its event, in one change. The
  // worker's login holds it only through this role, and the check asks both the role and the login that inherits it, so the line is on both.
  [WORKER_PICKUP_BACKSTOP_ROLE]: ['melarc.failure_backstop_escalate'],
  [WORKER_RUNTIME_ROLE]: [
    'melarc.handshake_mark_delivered',
    'melarc.notification_handshake_number',
    'melarc.failure_backstop_escalate',
  ],
};

/** Schemas that are the server's own and not ours to inspect. */
const OUR_SCHEMA = `n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`;

/**
 * `$1` is the role's name, or null for the connected login; `$2` is `APPROVED_DEFINER_EXECUTE` as JSON. Owning includes
 * owning through membership: a role that is a member of the owner has the owner's powers (it can alter or drop a table's
 * policies), so `pg_has_role(.., 'MEMBER')` is used, which is true for the role itself and for any role it belongs to,
 * directly or indirectly.
 */
export const ROLE_POSTURE_SQL = `
  SELECT r.rolname AS role,
         r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
         EXISTS (SELECT 1 FROM pg_roles p
                  WHERE p.rolname LIKE 'pg\\_%' AND p.rolname <> 'pg_database_owner'
                    AND pg_has_role(r.oid, p.oid, 'MEMBER')) AS has_predefined_role,
         EXISTS (SELECT 1 FROM pg_roles m
                  WHERE m.oid <> r.oid AND m.rolname NOT LIKE 'pg\\_%'
                    AND pg_has_role(r.oid, m.oid, 'MEMBER')
                    AND (m.rolsuper OR m.rolbypassrls OR m.rolcreatedb OR m.rolcreaterole
                         OR m.rolreplication OR m.rolcanlogin)) AS member_of_unsafe_role,
         EXISTS (SELECT 1 FROM pg_db_role_setting s, unnest(s.setconfig) AS setting
                  WHERE s.setrole IN (r.oid, 0)
                    AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                    AND setting LIKE 'melarc.%') AS has_stored_context,
         EXISTS (SELECT 1 FROM pg_database d
                  WHERE d.datname = current_database()
                    AND pg_has_role(r.oid, d.datdba, 'MEMBER')) AS owns_database,
         EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE pg_has_role(r.oid, c.relowner, 'MEMBER') AND ${OUR_SCHEMA}) AS owns_objects,
         EXISTS (SELECT 1 FROM pg_namespace n
                  WHERE pg_has_role(r.oid, n.nspowner, 'MEMBER') AND ${OUR_SCHEMA}) AS owns_schema,
         EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE pg_has_role(r.oid, p.proowner, 'MEMBER') AND ${OUR_SCHEMA}) AS owns_function,
         EXISTS (SELECT 1 FROM pg_roles x
                  WHERE pg_has_role(r.oid, x.oid, 'MEMBER')
                    AND has_database_privilege(x.oid, current_database(), 'CREATE')) AS can_create_in_database,
         EXISTS (SELECT 1 FROM pg_roles x CROSS JOIN pg_namespace n
                  WHERE pg_has_role(r.oid, x.oid, 'MEMBER') AND ${OUR_SCHEMA}
                    AND has_schema_privilege(x.oid, n.oid, 'CREATE')) AS can_create_in_schema,
         EXISTS (SELECT 1 FROM pg_roles x CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE pg_has_role(r.oid, x.oid, 'MEMBER') AND p.prosecdef AND ${OUR_SCHEMA}
                    AND has_function_privilege(x.oid, p.oid, 'EXECUTE')
                    AND (n.nspname || '.' || p.proname) NOT IN
                        (SELECT jsonb_array_elements_text(coalesce($2::jsonb -> x.rolname, '[]'::jsonb)))) AS can_execute_definer
    FROM pg_roles r
   WHERE r.rolname = coalesce($1::text, current_user)`;

/** The values of the two parameters of {@link ROLE_POSTURE_SQL} for a role, or for the connected login when it is null. */
export const rolePostureParameters = (role: string | null): [string | null, string] => [
  role,
  JSON.stringify(APPROVED_DEFINER_EXECUTE),
];

/** The flags that make the role unsafe, in the order of {@link POSTURE_FLAGS}. */
export function unsafeFlags(posture: Readonly<Record<string, unknown>>): PostureFlag[] {
  return POSTURE_FLAGS.filter((flag) => posture[flag] !== false);
}
