-- The audit ledger (S0.11). Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
-- Everything created here is owned by melarc_owner; no runtime role owns anything.
--
-- One table, audit_event, class AUDIT in data-scope-registry.md section 4.5 (AuditEvent): append-only. The CREATE TABLE and the
-- indexes below are the generated part (drizzle-kit, from src/platform/database/schema/audit.ts); the rest of this file is written
-- by hand and is in this migration so that the table never exists for a moment without its owner, row-level security, policies,
-- grants and the append-only guard.
--
-- Row-level security (the Staff, Vendor, Rider and SYSTEM columns of the registry row):
--   * a STAFF context inserts an event of its own (the actor is that staff member, so a context cannot write the ledger as
--     somebody else) and reads the events of its hubs (hub scope ALL, or the hub of the event among its authorized hubs; an
--     event with no hub is read under ALL only);
--   * a SYSTEM context inserts under the authentication capability alone (sign-in, challenge, setup, enrolment, recovery and
--     session lookup have no principal yet) and reads nothing: the registry gives SYSTEM "INSERT only". The bootstrap
--     capability's branch arrives with the bootstrap seed (S0.30), as the registry's note on that capability says;
--   * a VENDOR and a RIDER read and write nothing (the closed ELSE). Finding for the Product Owner, recorded in the plan section
--     7.13: the registry denies both principals the write, and an act that a vendor or rider session itself performs would
--     need its audit event in the same transaction; the first such operation settles it, and in this slice none exists.
--
-- Grants: SELECT and INSERT to the API runtime and nothing else. No login holds UPDATE, DELETE or TRUNCATE, and the trigger
-- below refuses all three even to the table owner and to the administrator. That is a control against the application and against
-- a mistake in a grant; it is not tamper evidence, which is the signed checkpoint chain of release gate G1 (audit.md section 2.1).
-- The worker's and the provisioning login's INSERT arrive with the first task that writes as each (S0.18, S0.30).

CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_code" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"actor_bundle" text,
	"surface_context" text NOT NULL,
	"device_context" jsonb,
	"vendor_organization_id" uuid,
	"responsible_hub_id" uuid,
	"object_type" text NOT NULL,
	"object_id" uuid,
	"correlation_id" text NOT NULL,
	"previous_state" text,
	"resulting_state" text,
	"reason_code" text,
	"reason_label" text,
	"note" text,
	"approval_id" uuid,
	"before_after" jsonb,
	"related_ids" jsonb,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"enhanced" boolean NOT NULL,
	"serialisation_version" smallint NOT NULL,
	CONSTRAINT "audit_event_code_grammar" CHECK ("audit_event"."event_code" ~ '^[a-z]+\.[a-z0-9_]+\.[a-z0-9_]+$'),
	CONSTRAINT "audit_event_actor_type_closed" CHECK ("audit_event"."actor_type" IN ('STAFF', 'RIDER', 'VENDOR_ACCOUNT', 'SYSTEM')),
	CONSTRAINT "audit_event_surface_closed" CHECK ("audit_event"."surface_context" IN ('OPS_PORTAL', 'VENDOR_PWA', 'RIDER_ANDROID', 'SYSTEM')),
	CONSTRAINT "audit_event_object_type_closed" CHECK ("audit_event"."object_type" IN ('StaffIdentity', 'RiderIdentity', 'VendorAccount', 'VendorCredential', 'Session', 'MfaFactor', 'MfaChallenge', 'RiderSignInChallenge', 'SetupGrant', 'RecoveryRequest', 'RegisteredDevice', 'HUB')),
	CONSTRAINT "audit_event_outcome_closed" CHECK ("audit_event"."outcome" IN ('SUCCEEDED', 'REJECTED', 'FAILED', 'REPLAYED', 'RECONCILED')),
	CONSTRAINT "audit_event_system_has_no_actor_id" CHECK (("audit_event"."actor_type" = 'SYSTEM') = ("audit_event"."actor_id" IS NULL)),
	CONSTRAINT "audit_event_reason_is_a_pair" CHECK (("audit_event"."reason_code" IS NULL) = ("audit_event"."reason_label" IS NULL)),
	CONSTRAINT "audit_event_correlation_bounded" CHECK (length("audit_event"."correlation_id") BETWEEN 1 AND 128),
	CONSTRAINT "audit_event_structured_are_objects" CHECK (("audit_event"."device_context" IS NULL OR jsonb_typeof("audit_event"."device_context") = 'object')
        AND ("audit_event"."before_after" IS NULL OR jsonb_typeof("audit_event"."before_after") = 'object')
        AND ("audit_event"."related_ids" IS NULL OR jsonb_typeof("audit_event"."related_ids") = 'object')
        AND jsonb_typeof("audit_event"."detail") = 'object'),
	CONSTRAINT "audit_event_serialisation_version_positive" CHECK ("audit_event"."serialisation_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "audit_event_recorded_idx" ON "audit_event" USING btree ("recorded_at","id");--> statement-breakpoint
CREATE INDEX "audit_event_object_idx" ON "audit_event" USING btree ("object_type","object_id","occurred_at");
--> statement-breakpoint
ALTER TABLE "audit_event" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_event_insert" ON "audit_event" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN actor_type = 'STAFF' AND actor_id = melarc.current_principal_id()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "audit_event_read" ON "audit_event" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids())
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_event" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.audit_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the audit ledger is append-only: % of an audit event is refused', TG_OP USING ERRCODE = '42501';
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.audit_event_append_only() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.audit_event_append_only() FROM PUBLIC;
--> statement-breakpoint
-- allow-delete: the triggers refuse DELETE and TRUNCATE of the audit ledger for every login, the owner included
CREATE TRIGGER "audit_event_no_change" BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION melarc.audit_event_append_only();
--> statement-breakpoint
-- allow-delete: the triggers refuse DELETE and TRUNCATE of the audit ledger for every login, the owner included
CREATE TRIGGER "audit_event_no_truncate" BEFORE TRUNCATE ON "audit_event"
  FOR EACH STATEMENT EXECUTE FUNCTION melarc.audit_event_append_only();