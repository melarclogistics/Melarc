ALTER TABLE "evidence" ADD COLUMN "scanner" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "scanner_signature_version" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_scan_facts" CHECK (("evidence"."state" = 'STORED' AND "evidence"."scanner" IS NOT NULL AND "evidence"."scanner_signature_version" IS NOT NULL AND "evidence"."scanned_at" IS NOT NULL) OR ("evidence"."state" <> 'STORED' AND "evidence"."scanner" IS NULL AND "evidence"."scanner_signature_version" IS NULL AND "evidence"."scanned_at" IS NULL));--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_scan_shape" CHECK (("evidence"."scanner" IS NULL OR "evidence"."scanner" ~ '^[a-z][a-z0-9-]{0,31}$') AND ("evidence"."scanner_signature_version" IS NULL OR char_length("evidence"."scanner_signature_version") BETWEEN 1 AND 200));
--> statement-breakpoint
-- Run A2, 12 November 2026 (finding H1 of the review of Run A; the Product Owner's decision D-A6). Everything above this comment is generated (drizzle-kit, from
-- src/platform/database/schema/evidence.ts); everything below is in this migration so that the new columns are never writable without the guard that holds them. Forward of 0080 and 0085.
--
--   * A record becomes STORED only on the clean verdict of a malicious-content check, recorded on it: the scanner that decided, the version of its signatures and the moment. Until now nothing
--     but the service held that: SECURITY_DESIGN.md section 14.18 required the check before STORED and no rule of the database or the composition enforced it. The two checks above hold the
--     facts together (all three exactly when the record is STORED), and the guard below refuses to store a record that carries none.
--   * The moment of the scan is the database's own, taken once the record is written (a writer does not choose it, as it does not choose the instant of the upload): the runtime login is
--     granted the two columns the service names and not the moment.
--   * What the database cannot do is judge the verdict: it holds that a verdict is recorded, not that the scanner told the truth. The truth of the verdict is the scanner adapter's and the
--     composition's (production refuses the stand-in scanner, and a production without a scanner stores nothing: `adapter-refusals.ts`), as the signature of a file is the service's.
GRANT UPDATE ("scanner", "scanner_signature_version") ON "evidence" TO melarc_api_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  derived record;
  instant timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence is retained and never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING_UPLOAD' OR NEW.uploaded_at IS NOT NULL OR NEW.validated_signature IS NOT NULL
       OR NEW.scanner IS NOT NULL OR NEW.scanner_signature_version IS NOT NULL OR NEW.scanned_at IS NOT NULL THEN
      RAISE EXCEPTION 'evidence is declared pending its upload' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
    END IF;
    -- The moment of a capture may run ahead of the database's clock by the platform's tolerance and no more (D-A8). It bounds the future only.
    IF NEW.captured_at > instant + pg_catalog.make_interval(mins => melarc.evidence_limit('evidence_capture_clock_tolerance_minutes', 0)) THEN
      RAISE EXCEPTION 'the moment of a capture is not ahead of the clock by more than the tolerance' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
    END IF;
    -- The lifetime of the upload instruction and the size of the file are the platform's settings, for every writer (finding M1 of the review of Run A). A shorter lifetime is no harm.
    IF NEW.upload_ttl_seconds::bigint > melarc.evidence_limit('evidence_upload_authorization_ttl_minutes', 1)::bigint * 60 THEN
      RAISE EXCEPTION 'the upload instruction of evidence lives no longer than the platform setting grants' USING ERRCODE = '23514', DETAIL = 'reason=UPLOAD_LIFETIME_EXCEEDED';
    END IF;
    IF NEW.byte_size::bigint > melarc.evidence_limit('evidence_upload_max_bytes', 1)::bigint THEN
      RAISE EXCEPTION 'evidence is no larger than the platform setting grants' USING ERRCODE = '23514', DETAIL = 'reason=UPLOAD_SIZE_EXCEEDED';
    END IF;
    -- The instants are the database's own: a writer does not choose when a record was made or when its upload window ends (to the second, so that the upload instruction can be made again, identically).
    NEW.created_at := pg_catalog.date_trunc('second', instant);
    NEW.upload_expires_at := NEW.created_at + pg_catalog.make_interval(secs => NEW.upload_ttl_seconds);
    NEW.version := 1;
    -- Under the rider's key the scope is derived from the stop and is not the writer's to give (GBT-M9).
    IF NEW.owner_type = 'PICKUP_STOP'
       AND melarc.principal_type() = 'RIDER'
       AND coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' THEN
      SELECT * INTO derived FROM melarc.evidence_pickup_stop_scope(NEW.owner_id);
      NEW.responsible_hub_id := derived.out_hub;
      NEW.vendor_organization_id := derived.out_vendor;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_type IS DISTINCT FROM OLD.owner_type OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
     OR NEW.captured_by_actor IS DISTINCT FROM OLD.captured_by_actor OR NEW.captured_by_principal_type IS DISTINCT FROM OLD.captured_by_principal_type
     OR NEW.device_context IS DISTINCT FROM OLD.device_context OR NEW.storage_ref IS DISTINCT FROM OLD.storage_ref
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id OR NEW.vendor_organization_id IS DISTINCT FROM OLD.vendor_organization_id
     OR NEW.access_rule IS DISTINCT FROM OLD.access_rule OR NEW.retention_policy IS DISTINCT FROM OLD.retention_policy
     OR NEW.content_type IS DISTINCT FROM OLD.content_type OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256 OR NEW.upload_ttl_seconds IS DISTINCT FROM OLD.upload_ttl_seconds
     OR NEW.upload_expires_at IS DISTINCT FROM OLD.upload_expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'evidence keeps its owner, its scope, its storage reference and what was declared of it' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'PENDING_UPLOAD' THEN
    RAISE EXCEPTION 'stored and expired evidence is final' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  IF NEW.state = 'STORED' THEN
    IF instant >= OLD.upload_expires_at THEN
      RAISE EXCEPTION 'the upload window of this evidence has passed' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_UPLOAD_EXPIRED';
    END IF;
    -- Stored only on a clean verdict (D-A6): the scanner and the version of its signatures are on the record, and the moment is the database's, never the writer's.
    IF NEW.scanner IS NULL OR NEW.scanner_signature_version IS NULL THEN
      RAISE EXCEPTION 'evidence is stored only with the clean verdict of the content scan recorded on it' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
    END IF;
    NEW.uploaded_at := instant;
    NEW.scanned_at := instant;
  ELSIF NEW.state = 'EXPIRED' THEN
    IF instant < OLD.upload_expires_at THEN
      RAISE EXCEPTION 'an upload window that is still open does not expire' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
    END IF;
  ELSE
    RAISE EXCEPTION 'evidence changes by being stored or by expiring, and in no other way' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.evidence_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.evidence_guard() FROM PUBLIC;
