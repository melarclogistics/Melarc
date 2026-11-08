import { FACTOR_CREATING_PURPOSES } from '../setup-grants/setup-grant-vocabulary.js';

/**
 * The closed sets of an MFA factor (S0.29; domain-model.md §6.8 `MfaFactor`; state-machines.md §18). The table repeats them as CHECK
 * constraints (migration 0018) and a database test compares the two.
 */

/** TOTP only: SMS is deliberately not a privileged factor. */
export const FACTOR_TYPES = ['TOTP'] as const;
export type FactorType = (typeof FACTOR_TYPES)[number];

/** `PENDING` grants nothing; a factor becomes `ACTIVE` only when a generated code has been proven; `REVOKED` is terminal. */
export const FACTOR_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const;
export type FactorStatus = (typeof FACTOR_STATUSES)[number];

/** The purpose of the grant whose consumption created the factor: the three creating purposes, which are the grant's own. */
export const FACTOR_CREATED_BY_PURPOSES = FACTOR_CREATING_PURPOSES;

/**
 * The time step of the last accepted code, written as decimal digits with no sign, no leading zero and no more than nineteen of them,
 * so that the database can compare two of them as numbers and refuse one that moves back (a code may not be accepted twice).
 */
export const FACTOR_COUNTER_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
export const isFactorCounter = (value: unknown): value is string =>
  typeof value === 'string' && FACTOR_COUNTER_PATTERN.test(value);

/**
 * The shape of the sealed secret `SecretCipher` makes: a 96-bit nonce and a ciphertext that ends with a 16-byte tag. The table holds
 * the same two numbers as a CHECK.
 */
export const SEALED_NONCE_BYTES = 12;
export const SEALED_TAG_BYTES = 16;

/**
 * The operation a seed is sealed for: one stable name, the same when the seed is sealed and every time it is opened, never taken from
 * a request (`sealedContext`). The record and the principal complete the context.
 */
export const TOTP_SEED_OPERATION = 'mfa.totp_seed';
