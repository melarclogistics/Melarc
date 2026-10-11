-- G2-07: the retention cleanup of sealed replays (S0.19, migration 0010) filters and orders idempotency_record by sealed_expires_at and
-- id, and until now nothing supported it: every run read every record to find the few that were due, and a run that found nothing
-- read them all to say so (an EXPLAIN of the cleanup's own statement, as the worker's role under its row-level policies, showed a
-- sequential scan and a sort of the whole table for a batch of fifty). Forward-only: it adds one index and changes no row, policy or grant.
--
-- The index is partial, on the records that still hold a sealed replay (sealed_expires_at IS NOT NULL): an erased record has no expiry
-- and leaves it, so it holds only what the cleanup can still erase, in the order the cleanup takes it. The predicate is a fixed
-- condition and not a clock: a predicate that changes with time cannot be indexed. The cleanup bounds the window with
-- statement_timestamp(), which is stable for the statement and so can descend the index; the row-level policy of migration 0010 still
-- judges every row against clock_timestamp() when it is reached, so an erasure is never early. Applied as melarc_migration_elevated.

CREATE INDEX "idempotency_record_sealed_expiry_idx" ON "idempotency_record" USING btree ("sealed_expires_at","id") WHERE "idempotency_record"."sealed_expires_at" IS NOT NULL;
