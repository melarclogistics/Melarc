import { described } from '../../openapi/described-schema.js';
import { CLIENT_ROOT_SIGNALS } from '../ports/session-store.port.js';
import { CURRENT_SESSION_SCHEMA } from '../sessions/session-schemas.js';
import {
  CHALLENGE_PATTERN,
  DEVICE_SIGNATURE_MAX_CHARACTERS,
  DEVICE_SIGNATURE_MIN_CHARACTERS,
  DEVICE_SIGNATURE_PATTERN,
  RIDER_PIN_PATTERN,
} from './rider-vocabulary.js';

/**
 * The shapes of the rider's two pre-session operations as the application describes them (`RiderChallengeRequest`, `RiderChallenge`,
 * `RiderSignIn` and `RiderSessionIssued` of the contract); the conformance check compares them with the contract. The contract's schemas are
 * what a request is validated against at run time; these are what the application **says** it takes and gives.
 *
 * The request of a challenge is deliberately minimal and its answer deliberately uninformative: a number and a nonce with its expiry, and
 * nothing that says whether the number belongs to anyone. The sign-in body is closed: there is **no device identifier** (the server resolves
 * the rider's sole `ACTIVE` device), and the signature and the root signal are required, so a PIN alone never authenticates a rider.
 */
export const RIDER_CHALLENGE_REQUEST_BODY = described({
  type: 'object',
  required: ['phone'],
  additionalProperties: false,
  properties: {
    phone: { type: 'string' },
  },
});

export const RIDER_CHALLENGE_SCHEMA = described({
  type: 'object',
  required: ['challenge', 'expires_at'],
  properties: {
    challenge: { type: 'string', pattern: CHALLENGE_PATTERN },
    expires_at: { type: 'string', format: 'date-time' },
  },
});

export const RIDER_SIGN_IN_BODY = described({
  type: 'object',
  required: ['phone', 'pin', 'challenge', 'device_signature', 'client_root_signal'],
  additionalProperties: false,
  properties: {
    phone: { type: 'string' },
    pin: { type: 'string', pattern: RIDER_PIN_PATTERN },
    challenge: { type: 'string', pattern: CHALLENGE_PATTERN },
    device_signature: {
      type: 'string',
      pattern: DEVICE_SIGNATURE_PATTERN,
      minLength: DEVICE_SIGNATURE_MIN_CHARACTERS,
      maxLength: DEVICE_SIGNATURE_MAX_CHARACTERS,
    },
    client_root_signal: { type: 'string', enum: [...CLIENT_ROOT_SIGNALS] },
  },
});

/** The only response in the contract that returns a raw session credential, once: the session as the caller sees it, and the bearer. */
export const RIDER_SESSION_ISSUED_SCHEMA = described({
  type: 'object',
  required: ['session', 'access_token', 'token_type'],
  properties: {
    session: CURRENT_SESSION_SCHEMA,
    access_token: { type: 'string' },
    token_type: { type: 'string', enum: ['Bearer'] },
  },
});
