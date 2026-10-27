import type { components } from '@melarc/api-client';

import { encodeQr } from '../../components/ui/qr-code/qr-matrix';
import { manualKeyOf } from '../secrets/otpauth';

/**
 * The runtime judgement of the answers of the pre-sign-in operations (the same discipline as `session-shape.ts`, U05 of 23 October 2026). The
 * send boundary guarantees JSON and the generated client gives an answer a type, but a type is a promise nobody checked at run time: a
 * proxy's `{}` or a body from another version would be taken for a challenge and send a person to a second step that cannot succeed, or for
 * the material of an authenticator and be drawn as a picture of nothing, while a secret is on the screen.
 *
 * It is not a second description of the wire. The types stay the contract's, and `test/pre-sign-in-contract.test.ts` reads the contract and
 * holds each list below to its schema. What each parser returns is what it judged and nothing else: a field the contract adds and this does
 * not read is not carried into the page.
 */
export const PRE_SIGN_IN_FIELDS = {
  MfaChallenge: { required: ['challenge_id', 'expires_at', 'trusted_browser_days'], optional: [] },
  CredentialSetupResult: {
    required: ['authentication_ready'],
    optional: ['mfa_enrolment_required', 'mfa_provisioning', 'mfa_setup_token'],
  },
  MfaProvisioning: { required: ['otpauth_uri'], optional: [] },
  MfaReenrolmentBegun: { required: ['mfa_provisioning', 'mfa_setup_token'], optional: [] },
  MfaEnrolmentResult: { required: ['authentication_ready'], optional: [] },
} as const;

export type MfaChallengeView = components['schemas']['MfaChallenge'];

/** What the page needs to set up an authenticator, and the grant that proves the code it will be given. Both are transient credentials. */
export interface EnrolmentMaterial {
  /** The provisioning address the QR code encodes and the key to type by hand is read from. */
  readonly otpauthUri: string;
  /** The `MFA_ENROLMENT` continuation grant. */
  readonly setupToken: string;
}

export type CredentialSetupOutcome =
  { readonly kind: 'ready' } | ({ readonly kind: 'enrol' } & EnrolmentMaterial);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** A grant as a link or an answer carries it: printable ASCII, and bounded. */
const GRANT = /^[!-~]{1,512}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a QR code can be drawn from the text, which is the same question the picture asks when it is rendered. */
function drawable(text: string): boolean {
  try {
    encodeQr(text, 'M');
    return true;
  } catch {
    return false;
  }
}

/** A provisioning address the page may draw and read a key from: a time-based one-time password one, with exactly one base32 secret. */
function uriOf(provisioning: unknown): string | undefined {
  if (!isRecord(provisioning)) return undefined;
  const uri = provisioning.otpauth_uri;
  if (typeof uri !== 'string' || manualKeyOf(uri) === undefined || !drawable(uri)) return undefined;
  return uri;
}

function grantOf(value: unknown): string | undefined {
  return typeof value === 'string' && GRANT.test(value) ? value : undefined;
}

/** The challenge a privileged sign-in answers with (`202`), or nothing when the answer is not one. */
export function parseMfaChallenge(body: unknown): MfaChallengeView | undefined {
  if (!isRecord(body)) return undefined;
  const { challenge_id: id, expires_at: expiresAt, trusted_browser_days: days } = body;
  if (typeof id !== 'string' || !UUID.test(id)) return undefined;
  if (typeof expiresAt !== 'string' || !ISO_INSTANT.test(expiresAt)) return undefined;
  if (Number.isNaN(Date.parse(expiresAt))) return undefined;
  // The number of days a remembered browser stays trusted is the server's, stated with the challenge so that the screen never says its own.
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) {
    return undefined;
  }
  return { challenge_id: id, expires_at: expiresAt, trusted_browser_days: days };
}

/**
 * The answer of `completeStaffCredentialSetup`: ready (an ordinary employee, who signs in next) or the material of an authenticator and
 * the grant to prove it with (a privileged one, who is not ready until a code is proven). An answer that says both, or neither, or that
 * lacks what its own claim needs, is not one.
 */
export function parseCredentialSetupResult(body: unknown): CredentialSetupOutcome | undefined {
  if (!isRecord(body) || typeof body.authentication_ready !== 'boolean') return undefined;

  if (body.authentication_ready) {
    const quiet =
      body.mfa_provisioning === undefined &&
      (body.mfa_setup_token === undefined || body.mfa_setup_token === null) &&
      (body.mfa_enrolment_required === undefined || body.mfa_enrolment_required === false);
    return quiet ? { kind: 'ready' } : undefined;
  }

  if (body.mfa_enrolment_required !== true) return undefined;
  const otpauthUri = uriOf(body.mfa_provisioning);
  const setupToken = grantOf(body.mfa_setup_token);
  if (otpauthUri === undefined || setupToken === undefined) return undefined;
  return { kind: 'enrol', otpauthUri, setupToken };
}

/** The answer of `beginMfaReenrolment`: the new authenticator's material and the continuation grant. */
export function parseMfaReenrolmentBegun(body: unknown): EnrolmentMaterial | undefined {
  if (!isRecord(body)) return undefined;
  const otpauthUri = uriOf(body.mfa_provisioning);
  const setupToken = grantOf(body.mfa_setup_token);
  if (otpauthUri === undefined || setupToken === undefined) return undefined;
  return { otpauthUri, setupToken };
}

/** Whether the answer of `completeMfaEnrolment` says the identity is now ready to sign in. Anything else is not "set up". */
export function parseMfaEnrolmentResult(body: unknown): boolean {
  return isRecord(body) && body.authentication_ready === true;
}
