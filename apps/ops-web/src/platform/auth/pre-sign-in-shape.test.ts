import { describe, expect, it } from 'vitest';

import {
  parseCredentialSetupResult,
  parseMfaChallenge,
  parseMfaEnrolmentResult,
  parseMfaReenrolmentBegun,
} from './pre-sign-in-shape';

const CHALLENGE_ID = '0f9c6a52-3d8e-4b71-9a24-6c1e7d5b8f30';
const URI =
  'otpauth://totp/Melarc:synthetic.officer?secret=ABCDEFGHIJKLMNOP234567&issuer=Melarc&period=30';
const TOKEN = 'synthetic-continuation-grant';

describe('parseMfaChallenge: the answer of a privileged sign-in', () => {
  it('reads a challenge', () => {
    expect(
      parseMfaChallenge({
        challenge_id: CHALLENGE_ID,
        expires_at: '2026-10-24T09:05:00.000Z',
        trusted_browser_days: 7,
      }),
    ).toEqual({
      challenge_id: CHALLENGE_ID,
      expires_at: '2026-10-24T09:05:00.000Z',
      trusted_browser_days: 7,
    });
  });

  // Break caught: a proxy's page, a session body or a half-made challenge being taken for a challenge and the person sent on to a second
  // step that can never succeed.
  it.each([
    undefined,
    null,
    'challenge',
    [],
    {},
    { challenge_id: CHALLENGE_ID },
    { expires_at: '2026-10-24T09:05:00.000Z' },
    { challenge_id: 'not-a-uuid', expires_at: '2026-10-24T09:05:00.000Z', trusted_browser_days: 7 },
    { challenge_id: CHALLENGE_ID, expires_at: 'tomorrow', trusted_browser_days: 7 },
    { challenge_id: 42, expires_at: '2026-10-24T09:05:00.000Z', trusted_browser_days: 7 },
    // The number of days is the server's and has to be a sound one: a challenge without it, or with a nonsense one, is not the API's.
    { challenge_id: CHALLENGE_ID, expires_at: '2026-10-24T09:05:00.000Z' },
    { challenge_id: CHALLENGE_ID, expires_at: '2026-10-24T09:05:00.000Z', trusted_browser_days: 0 },
    {
      challenge_id: CHALLENGE_ID,
      expires_at: '2026-10-24T09:05:00.000Z',
      trusted_browser_days: 7.5,
    },
    {
      challenge_id: CHALLENGE_ID,
      expires_at: '2026-10-24T09:05:00.000Z',
      trusted_browser_days: '7',
    },
    {
      challenge_id: CHALLENGE_ID,
      expires_at: '2026-10-24T09:05:00.000Z',
      trusted_browser_days: 9999,
    },
  ])('refuses %j', (body) => {
    expect(parseMfaChallenge(body)).toBeUndefined();
  });

  // Break caught: a session body mistaken for a challenge, or the extra fields of a bigger answer carried into the page.
  it('keeps what it judged and nothing else', () => {
    expect(
      parseMfaChallenge({
        challenge_id: CHALLENGE_ID,
        expires_at: '2026-10-24T09:05:00.000Z',
        trusted_browser_days: 7,
        id: 'a session id',
        permissions: ['staff.read'],
      }),
    ).toEqual({
      challenge_id: CHALLENGE_ID,
      expires_at: '2026-10-24T09:05:00.000Z',
      trusted_browser_days: 7,
    });
  });
});

describe('parseCredentialSetupResult: the answer of completeStaffCredentialSetup', () => {
  it('reads an ordinary employee’s answer: ready, nothing to enrol', () => {
    expect(parseCredentialSetupResult({ authentication_ready: true })).toEqual({ kind: 'ready' });
  });

  it('reads a privileged employee’s answer: the authenticator’s material and the continuation grant', () => {
    expect(
      parseCredentialSetupResult({
        authentication_ready: false,
        mfa_enrolment_required: true,
        mfa_provisioning: { otpauth_uri: URI },
        mfa_setup_token: TOKEN,
      }),
    ).toEqual({ kind: 'enrol', otpauthUri: URI, setupToken: TOKEN });
  });

  // Break caught: an answer that says "ready" and also carries enrolment material being taken as ready, or one that says "not ready" with
  // nothing to continue with being taken as a reason to show a QR code of nothing.
  it.each([
    undefined,
    null,
    {},
    { authentication_ready: 'yes' },
    { authentication_ready: false },
    { authentication_ready: false, mfa_enrolment_required: true },
    {
      authentication_ready: false,
      mfa_enrolment_required: true,
      mfa_provisioning: { otpauth_uri: URI },
    },
    {
      authentication_ready: false,
      mfa_enrolment_required: true,
      mfa_provisioning: { otpauth_uri: URI },
      mfa_setup_token: '',
    },
    {
      authentication_ready: false,
      mfa_enrolment_required: true,
      mfa_provisioning: { otpauth_uri: URI },
      mfa_setup_token: null,
    },
    {
      authentication_ready: false,
      mfa_enrolment_required: true,
      mfa_provisioning: {},
      mfa_setup_token: TOKEN,
    },
    {
      authentication_ready: false,
      mfa_enrolment_required: false,
      mfa_provisioning: { otpauth_uri: URI },
      mfa_setup_token: TOKEN,
    },
    { authentication_ready: true, mfa_provisioning: { otpauth_uri: URI }, mfa_setup_token: TOKEN },
  ])('refuses %j', (body) => {
    expect(parseCredentialSetupResult(body)).toBeUndefined();
  });

  // Break caught: a provisioning address that is not a time-based one-time password being turned into a picture and a "key" to type.
  it.each([
    'https://example.test/?secret=ABCDEFGHIJKLMNOP',
    'otpauth://hotp/Melarc:x?secret=ABCDEFGHIJKLMNOP&counter=1',
    'otpauth://totp/Melarc:x',
    'otpauth://totp/Melarc:x?secret=not-base32!',
    'otpauth://totp/Melarc:x?secret=ABCDEFGHIJKLMNOP&secret=QRSTUVWXYZ234567',
    '',
  ])('refuses a provisioning address that is not a TOTP one: %j', (uri) => {
    expect(
      parseCredentialSetupResult({
        authentication_ready: false,
        mfa_enrolment_required: true,
        mfa_provisioning: { otpauth_uri: uri },
        mfa_setup_token: TOKEN,
      }),
    ).toBeUndefined();
  });

  // Break caught: a provisioning address too long to draw as a code a camera can read, which would fail while the secret is on the page.
  it('refuses a provisioning address that cannot be drawn as a QR code', () => {
    const long = `otpauth://totp/Melarc:x?secret=ABCDEFGHIJKLMNOP&issuer=${'x'.repeat(2000)}`;
    expect(
      parseCredentialSetupResult({
        authentication_ready: false,
        mfa_enrolment_required: true,
        mfa_provisioning: { otpauth_uri: long },
        mfa_setup_token: TOKEN,
      }),
    ).toBeUndefined();
  });

  it.each(['has a space', 'has\nnewline', 'x'.repeat(513)])(
    'refuses a continuation grant that could not be one: %j',
    (token) => {
      expect(
        parseCredentialSetupResult({
          authentication_ready: false,
          mfa_enrolment_required: true,
          mfa_provisioning: { otpauth_uri: URI },
          mfa_setup_token: token,
        }),
      ).toBeUndefined();
    },
  );
});

describe('parseMfaReenrolmentBegun: the answer of beginMfaReenrolment', () => {
  it('reads the material and the continuation grant', () => {
    expect(
      parseMfaReenrolmentBegun({ mfa_provisioning: { otpauth_uri: URI }, mfa_setup_token: TOKEN }),
    ).toEqual({ otpauthUri: URI, setupToken: TOKEN });
  });

  it.each([
    undefined,
    {},
    { mfa_provisioning: { otpauth_uri: URI } },
    { mfa_setup_token: TOKEN },
    { mfa_provisioning: { otpauth_uri: 'https://example.test' }, mfa_setup_token: TOKEN },
    { mfa_provisioning: { otpauth_uri: URI }, mfa_setup_token: 7 },
  ])('refuses %j', (body) => {
    expect(parseMfaReenrolmentBegun(body)).toBeUndefined();
  });
});

describe('parseMfaEnrolmentResult: the answer of completeMfaEnrolment', () => {
  // Break caught: an answer that does not say the identity is ready being shown as "your authenticator is set up".
  it('is done only when the answer says the identity is authentication-ready', () => {
    expect(parseMfaEnrolmentResult({ authentication_ready: true })).toBe(true);
    expect(parseMfaEnrolmentResult({ authentication_ready: false })).toBe(false);
    expect(parseMfaEnrolmentResult({})).toBe(false);
    expect(parseMfaEnrolmentResult(undefined)).toBe(false);
    expect(parseMfaEnrolmentResult({ authentication_ready: 'true' })).toBe(false);
  });
});
