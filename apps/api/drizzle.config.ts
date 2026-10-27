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
  // The platform's tables, and the tables of a permission domain beside them: `src/staff/` holds the staff identity (S0.24) and the MFA
  // factor and challenge bound to it (S0.29, S0.32) and the trusted browser (migration 0033) and the rider identity (S0.53, migration
  // 0040) and its sign-in challenge (S0.59, migration 0041); `src/vendor/` the vendor organisation, account, credential and registered device (S0.47, migration 0034; the rider's part
  // of the device is S0.53's).
  schema: [
    './src/platform/database/schema/index.ts',
    './src/staff/staff-identity.schema.ts',
    './src/staff/mfa-factor.schema.ts',
    './src/staff/mfa-challenge.schema.ts',
    './src/staff/trusted-browser.schema.ts',
    './src/staff/rider-identity.schema.ts',
    './src/staff/rider-sign-in-challenge.schema.ts',
    './src/vendor/vendor-organization.schema.ts',
    './src/vendor/vendor-account.schema.ts',
    './src/vendor/registered-device.schema.ts',
  ],
  out: './migrations',
  strict: true,
});
