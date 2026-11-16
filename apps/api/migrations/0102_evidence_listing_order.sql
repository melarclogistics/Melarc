-- Run D, 16 November 2026 (Part 2, finding F7 of the review of Run B). The stop's evidence was listed by the moment a record was made, kept to the second, and then by its identifier, and the
-- position of the next page was that pair. A record made by a transaction that began earlier and committed later than one a reader had already paged past had the earlier second or the smaller
-- identifier, and the reader never met it. The records of an owner now take a position the database gives them: evidence.listed_at, the database's clock to the microsecond, taken by the guard
-- AFTER it has taken a lock for the owner (a transaction-scoped advisory lock, held to the end of the transaction, so that the records of an owner are made one transaction at a time and a record
-- that begins later is never visible before one that began first) and never behind a position the owner already holds. What a reader sees at any moment is a prefix of what it will see when the
-- writers in flight have committed. The column is nullable: the records made before this migration have no position and are listed by when they were made, to the second, as they were (the
-- list reads coalesce(listed_at, created_at), and every position given from now on is later than every moment before it). The writer does not choose the position and no statement changes it.
-- The guard is restated from its last definition, 0088, in two places only: the lock and the position on insert, and the position among the columns that never change.
ALTER TABLE "evidence" ADD COLUMN "listed_at" timestamp with time zone;
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
    -- The position of the record in the list of its owner (Run D, finding F7): a lock for the owner, held to the end of the transaction, so that the records of an owner are made one transaction at a time
    -- and a record that begins later is never visible before one that began first; and then the position itself, the database's clock to the microsecond and never behind one the owner already
    -- holds (a clock that stood still or was stepped back). The writer does not choose it. Records made before this migration have none and are listed by when they were made, to the second.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('melarc.evidence.listing:' || NEW.owner_type || ':' || NEW.owner_id::text, 0));
    NEW.listed_at := greatest(
      pg_catalog.clock_timestamp(),
      coalesce((SELECT max(coalesce(e.listed_at, e.created_at)) FROM public.evidence AS e WHERE e.owner_type = NEW.owner_type AND e.owner_id = NEW.owner_id), '-infinity'::timestamp with time zone) + interval '1 microsecond'
    );
    -- The instants are the database's own: a writer does not choose when a record was made or when its upload window ends (to the second, so that the upload instruction can be made again, identically).
    NEW.created_at := pg_catalog.date_trunc('second', instant);
    NEW.upload_expires_at := NEW.created_at + pg_catalog.make_interval(secs => NEW.upload_ttl_seconds);
    NEW.version := 1;
    -- Under the rider's key (the failure's, or the count's for a parcel's photo) the scope is derived from the stop and is not the writer's to give (GBT-M9).
    IF NEW.owner_type = 'PICKUP_STOP'
       AND melarc.principal_type() = 'RIDER'
       AND coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') IN ('pickup.failure.report', 'pickup.collection.confirm') THEN
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
     OR NEW.upload_expires_at IS DISTINCT FROM OLD.upload_expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.listed_at IS DISTINCT FROM OLD.listed_at THEN
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
