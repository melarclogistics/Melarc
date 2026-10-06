import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration. It exists to generate and check migrations; nothing here connects to a
 * database. There is one canonical migration history, in `migrations/` (DEVELOPMENT_EXECUTION_PLAN.md §5).
 *
 * Applying migrations is `pnpm db:migrate`, which runs as the migration identity. `drizzle-kit push`,
 * which synchronises a schema by itself, is never used: the plan forbids automatic schema synchronisation.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/platform/database/schema/index.ts',
  out: './migrations',
  strict: true,
});
