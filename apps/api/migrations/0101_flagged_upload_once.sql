-- Run D, 16 November 2026 (Part 2, finding F1 of the review of Run B). A flagged upload writes one enhanced event, pickup.evidence.flagged (0091), in the rider's transaction. Nothing held that
-- number: the rider's arm of the ledger's insert policy admits the event for a pending record of its own as many times as it is written, so a rider who sends a flagged file again to the address it
-- was given (it lives for its window) wrote one for every try, and two completions at once wrote two. The ledger now holds one for a record, for every writer: a second is the unique violation
-- (23505) whoever writes it, the administrator's statement included, and the application answers the refusal all the same (evidence.service.ts). The index is partial, so no other event of the
-- record, and no other record's, is touched. A development database that already holds two of these events for one record cannot take the index: the ledger is append-only, so there is nothing
-- to remove, and the migration says so by failing.
CREATE UNIQUE INDEX "audit_event_flagged_upload_once" ON "audit_event" USING btree ("object_id") WHERE "audit_event"."event_code" = 'pickup.evidence.flagged';
