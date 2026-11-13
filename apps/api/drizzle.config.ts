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
    // SLICE-001 (S1.10, S1.13): a vendor's saved pickup locations and financial standing, the ad-hoc sender and the pickup request.
    './src/vendor/vendor-pickup-location.schema.ts',
    './src/vendor/vendor-financial-standing.schema.ts',
    './src/pickup/ad-hoc-sender.schema.ts',
    './src/pickup/pickup-request.schema.ts',
    // SLICE-001 (S1.20): the manifest (a run) and its stops, each the claim on one request.
    './src/pickup/pickup-manifest.schema.ts',
    './src/pickup/pickup-stop.schema.ts',
    // SLICE-001 (S1.24): the custody of a run's parcels moving from the rider who holds them to another rider or to the hub.
    './src/fleet/run-custody-handover.schema.ts',
    // SLICE-001 (S1.26): what the rider counted at the door, made at the count (D-04 option 1).
    './src/pickup/collection-record.schema.ts',
    // SLICE-001 (S1.27): the two-party handshake of a counted stop, which closes the stop when it ends well.
    './src/pickup/collection-handshake.schema.ts',
    './src/pickup/collection-dispute.schema.ts',
    // SLICE-001 (S1.28): the evidence photo of a failed stop, attached to the failure the rider reports (the evidence table is the platform's, S1.11).
    './src/pickup/pickup-stop-evidence.schema.ts',
    // SLICE-001 (Run A2, D-A10): the photo of every parcel at the door, attached to the count, and Ops's exception for the day the camera fails.
    './src/pickup/collection-parcel-photo.schema.ts',
    './src/pickup/parcel-photo-exception.schema.ts',
  ],
  out: './migrations',
  strict: true,
});
