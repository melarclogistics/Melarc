// The Drizzle schema. Each slice adds its tables here and in a migration that also enables and forces row-level security for
// them (MIGRATION_AND_SEEDING.md §5.1; see migrations/). S0.8 adds the reference data.
export * from './reference-data.js';
// S0.11 adds the audit ledger.
export * from './audit.js';
// S0.12 adds the idempotency record.
export * from './idempotency.js';
// S0.14 adds the rate limiter's admitted requests.
export * from './rate-limit.js';
// S0.17 adds the durable credential-delivery job.
export * from './credential-delivery.js';
// S0.24 adds the session. The staff identity it belongs to is `src/staff/staff-identity.schema.ts`, which the Drizzle configuration
// reads beside this index.
export * from './session.js';
// S0.29 adds the setup grant. The MFA factor that a grant leads to is `src/staff/mfa-factor.schema.ts`, beside the identity it belongs to.
export * from './setup-grant.js';
// S0.50 adds the recovery request, the record that repairs an existing credential.
export * from './recovery-request.js';
// S1.4 (SLICE-001) adds the hub's configuration: its service zones, their aliases and its versioned settings.
export * from './hub-configuration.js';
// S1.12a (SLICE-001) adds the outbox envelope a business act writes, and the notification the lane of the delivery worker keeps.
export * from './notifications.js';
// S1.11 (SLICE-001) adds the evidence record: a controlled object captured in the course of another act, stored behind the object-store port.
export * from './evidence.js';
