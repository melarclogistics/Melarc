// The Drizzle schema. It is empty on purpose: B0.4 builds the database foundation, not domain tables.
// Each product slice adds its tables here and in a migration that also enables and forces row-level
// security for them (MIGRATION_AND_SEEDING.md §5.1; see migrations/).
export {};
