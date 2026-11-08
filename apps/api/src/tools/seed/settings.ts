import type {
  SETTING_SCOPES,
  SETTING_VALUE_TYPES,
} from '../../platform/database/schema/reference-data.js';

/**
 * The settings with an approved value that are not hub-scoped (settings.md section 7.1 company-wide, 7.5 platform authentication,
 * 7.7 platform security operations; MIGRATION_AND_SEEDING.md section 4). **Only `CONFIRMED` keys are seeded, with the value the
 * document gives.** An `OPEN` key (the accounting-export file retention, the evidence upload ceiling and MIME types, the retention
 * periods) is absent: a setting without a value cannot be seeded with an invented one, and its absence fails visibly where it is
 * needed (`SETTING_MISSING`). The hub-scoped settings (fees, cut-off times, windows) are `HubSetting` rows, a later table. The
 * handshake and notification keys (7.4) are not seeded: their scope is not stated, several are "source default" values the document
 * itself says meet the definition of `PROVISIONAL`, and none is used by this slice.
 *
 * A money amount is stored in pesewas (integer minor units: GH₵300 is 30000). A value the document gives per tier is an object
 * keyed by the tier. `seed-data.test.ts` reads settings.md and fails when this list and its confirmed keys differ, when a number
 * differs, or when an open key is seeded.
 */
export interface SettingSeed {
  readonly key: string;
  readonly scope: (typeof SETTING_SCOPES)[number];
  readonly valueType: (typeof SETTING_VALUE_TYPES)[number];
  readonly value: unknown;
  readonly unit: string;
  readonly description: string;
}

const company = (
  key: string,
  valueType: SettingSeed['valueType'],
  value: unknown,
  unit: string,
  description: string,
): SettingSeed => ({ key, scope: 'COMPANY', valueType, value, unit, description });

const platform = (
  key: string,
  valueType: SettingSeed['valueType'],
  value: unknown,
  unit: string,
  description: string,
): SettingSeed => ({ key, scope: 'PLATFORM', valueType, value, unit, description });

const PER_MINUTE = 'requests per minute';
const PESEWAS = 'pesewas (GHS minor units)';

export const SETTINGS: readonly SettingSeed[] = [
  // 7.1 Company-wide
  company(
    'service_window_days',
    'string',
    'Monday–Saturday',
    'days of the week',
    'The days Melarc serves; the denominator of the availability target. No Sunday delivery.',
  ),
  company(
    'service_window_hours',
    'string',
    '07:00–18:00 Africa/Accra',
    'time of day',
    'The hours Melarc operates each service day, company-wide.',
  ),
  company('transaction_currency', 'string', 'GHS', 'ISO 4217 code', 'The only launch currency.'),
  company(
    'liability_cap_amount',
    'integer',
    30000,
    PESEWAS,
    'The most payable per parcel for loss or damage.',
  ),
  company(
    'value_declaration_threshold',
    'integer',
    50000,
    PESEWAS,
    'Above this the sender declares the value and acknowledges the liability cap at booking.',
  ),
  company(
    'claim_report_window_hours',
    'integer',
    72,
    'hours',
    'The window in which loss or damage is reported; a late claim may still be accepted with a recorded reason.',
  ),
  company(
    'unclaimed_adjustment_grace_days',
    'integer',
    90,
    'days',
    'How long a financial adjustment stays open before an unclaimed disposition may be proposed.',
  ),
  company(
    'unpaid_return_storage_grace_days',
    'integer',
    14,
    'days',
    'How long an unpaid ad-hoc sender’s returned parcel stays in hub custody before escalation toward final disposition.',
  ),
  company(
    'return_fee_waiver_reasons',
    'list',
    [
      'Melarc-caused operational error',
      'Unresolved documented dispute at return-start',
      'One-time goodwill or service-recovery exception',
    ],
    'categories',
    'The three categories for which a return fee may be waived, each instance approved by Senior Ops.',
  ),
  company(
    'global_vendor_account_limit_amount',
    'integer',
    20000,
    PESEWAS,
    'The platform-wide limit on a vendor’s outstanding account; a near-prepay posture, not a credit line.',
  ),

  // 7.5 Platform — authentication
  platform(
    'session_lifetime_minutes',
    'object',
    { rider: 1440, standard: 720, privileged: 480 },
    'minutes',
    'The absolute lifetime of a session, per tier: Rider, Standard (Vendor, Ops Staff, Finance) and Privileged (Senior Ops, Platform Admin).',
  ),
  platform(
    'session_idle_timeout_minutes',
    'object',
    { rider: null, standard: 30, privileged: 15 },
    'minutes',
    'Minutes of inactivity before a browser session ends, per tier; the rider app has no idle rule, by rule.',
  ),
  platform(
    'signin_max_attempts',
    'integer',
    5,
    'attempts',
    'Wrong credential entries before lockout; the count and the lock sit on the credential record.',
  ),
  platform(
    'signin_lockout_minutes',
    'integer',
    15,
    'minutes',
    'How long a credential stays locked after too many wrong entries.',
  ),
  platform(
    'recovery_link_ttl_minutes',
    'integer',
    30,
    'minutes',
    'The lifetime of a recovery token; single-use regardless of lifetime.',
  ),
  platform(
    'recovery_request_supersede_guard_seconds',
    'integer',
    60,
    'seconds',
    'A recovery request made sooner than this after the pending link was issued neither supersedes it nor issues another.',
  ),
  platform(
    'mfa_max_attempts',
    'integer',
    3,
    'attempts',
    'Wrong second-factor codes per challenge before it is dead.',
  ),
  platform(
    'authentication_challenge_ttl_minutes',
    'integer',
    5,
    'minutes',
    'The lifetime of a privileged MFA sign-in challenge and of a rider cryptographic sign-in challenge.',
  ),

  // 7.7 Platform — security operations
  platform(
    'rate_limit_staff_signin',
    'integer',
    10,
    PER_MINUTE,
    'The staff sign-in bucket, keyed on the canonical submitted work email.',
  ),
  platform(
    'rate_limit_privileged_mfa',
    'integer',
    10,
    PER_MINUTE,
    'The privileged MFA bucket, keyed on the challenge and its principal.',
  ),
  platform(
    'rate_limit_vendor_signin',
    'integer',
    10,
    PER_MINUTE,
    'The vendor sign-in bucket, keyed on the account identifier and the device credential.',
  ),
  platform(
    'rate_limit_rider_challenge',
    'integer',
    20,
    PER_MINUTE,
    'The rider challenge bucket, keyed on the submitted phone number.',
  ),
  platform(
    'rate_limit_recovery',
    'integer',
    10,
    PER_MINUTE,
    'The credential setup and recovery bucket, keyed on the recovery principal or the grant presented.',
  ),
  platform(
    'rate_limit_authenticated_api',
    'integer',
    120,
    PER_MINUTE,
    'The general authenticated API bucket, keyed on the active session.',
  ),
  platform(
    'report_export_initiation_ceiling_per_minute',
    'integer',
    10,
    PER_MINUTE,
    'A sub-ceiling inside the authenticated API bucket for creating reports and exports.',
  ),
  platform(
    'provider_initiating_operation_ceiling_per_minute',
    'integer',
    20,
    PER_MINUTE,
    'A sub-ceiling inside the authenticated API bucket for operations that cause an outbound SMS or payment call.',
  ),
  platform(
    'evidence_upload_authorization_ttl_minutes',
    'integer',
    15,
    'minutes',
    'The lifetime of a single-object evidence upload authorization.',
  ),
  platform(
    'evidence_retrieval_authorization_ttl_minutes',
    'integer',
    5,
    'minutes',
    'The lifetime of a single-object evidence retrieval authorization.',
  ),
  platform(
    'accounting_export_retrieval_authorization_ttl_minutes',
    'integer',
    5,
    'minutes',
    'The lifetime of a retrieval authorization over a generated accounting-export package.',
  ),
  platform(
    'audit_integrity_checkpoint_interval_minutes',
    'integer',
    15,
    'minutes',
    'How often the audit integrity checkpoint is cut and signed.',
  ),
  platform(
    'idempotency_record_ttl_hours',
    'integer',
    24,
    'hours',
    'How long an idempotency record is kept before it may be reclaimed.',
  ),
];
