// The Drizzle schema. Each slice adds its tables here and in a migration that also enables and forces row-level security for
// them (MIGRATION_AND_SEEDING.md §5.1; see migrations/). S0.8 adds the reference data.
export * from './reference-data.js';
