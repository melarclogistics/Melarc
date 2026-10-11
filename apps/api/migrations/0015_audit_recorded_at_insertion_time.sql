-- Product decision, 11 October 2026 (closing plan obligation OB-111): audit_event.recorded_at is the moment the database inserted the
-- row (clock_timestamp()), not the start of the transaction that wrote it (now()). Forward-only: it changes the column's default and
-- nothing else.
--
--   * Rows already written are left exactly as they are. They carry the transaction's start time, which was their default then; no
--     row is rewritten (the table is append-only, and no login could rewrite one), and a reader that needs to tell the two kinds apart
--     does so by this migration.
--   * The canonical serialisation does not change. recorded_at is the same field in the same microsecond UTC text, so
--     serialisation_version stays 1; only where the database takes the value from changed.
--   * Neither recorded_at nor the event id is a commit-order cursor: a row inserted early in a long transaction commits after rows
--     inserted later in a short one. The signed checkpoint chain (audit.md section 2.1) records its membership explicitly for that.
-- Applied as melarc_migration_elevated.

ALTER TABLE "audit_event" ALTER COLUMN "recorded_at" SET DEFAULT clock_timestamp();
