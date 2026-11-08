import { createHash } from 'node:crypto';

import type { Request } from 'express';

import type { AnonymousLimit } from '../../routes/access-declaration.js';
import type { LimitPartitioner } from '../../routes/limit-partitions.js';
import { isWellFormedUnicode } from '../credentials/unicode.js';
import { MAX_ADDRESS_BYTES } from '../staff/staff-sign-in-limit.js';
import { RECOVERY_PRINCIPAL_TYPES, type RecoveryPrincipalType } from './recovery-vocabulary.js';

/**
 * The namespace of the recovery request's keys in `rate_limit_recovery`: the bucket is shared with the setup and the redemption operations,
 * whose keys are purpose-qualified digests of the grant or token they present (`AC-SLICE-000-125`), so an identifier never counts as one.
 */
export const RECOVERY_REQUEST_LIMIT_NAMESPACE = 'melarc.recovery-request.v1';

/** The key of a body whose principal type is not one of the two: it is refused by validation, and keys one partition, never many. */
const UNTYPED = 'UNTYPED';

/** The identifier as typed, trimmed and NFKC-normalised: the common part of both canonical forms, which the partition finishes. */
function recoveryIdentifier(raw: string): string | undefined {
  if (!isWellFormedUnicode(raw)) return undefined;
  const text = raw.trim().normalize('NFKC');
  return text.length === 0 ? undefined : text;
}

/**
 * The limit of `requestCredentialRecovery` (settings.md section 7.5, `rate_limit_recovery`, 10 a minute; `AC-SLICE-000-104`): **keyed on
 * the principal type plus the canonical submitted identifier, whether or not it resolves**, and every request counts, a coalesced one
 * included. An identifier that matches nothing is limited by the same bucket in the same way, so `RATE_LIMITED` says nothing about whether
 * a principal exists. The canonical form is the type's: a work email lower-cased as a whole (`canonicalWorkEmail`), a vendor account
 * identifier upper-cased (`canonicalAccountIdentifier`); the partition reads the type from the body (`RECOVERY_PRINCIPAL`).
 */
export const RECOVERY_REQUEST_LIMIT: AnonymousLimit = {
  bucket: 'rate_limit_recovery',
  identifier: { field: 'identifier', maxBytes: MAX_ADDRESS_BYTES },
  canonical: recoveryIdentifier,
  partition: 'RECOVERY_PRINCIPAL',
};

function principalTypeOf(body: unknown): RecoveryPrincipalType | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const type: unknown = (body as Record<string, unknown>).principal_type;
  return typeof type === 'string' && (RECOVERY_PRINCIPAL_TYPES as readonly string[]).includes(type)
    ? (type as RecoveryPrincipalType)
    : undefined;
}

/**
 * The partition of the recovery request's key: the namespace, the principal type the body names and the identifier in that type's canonical
 * form. It reads nothing but the parsed body, so it needs no store; a body whose type is not one of the two keys a single partition.
 */
/** The longest a submitted recovery token may be, in bytes, for the limiter to take it as a key: a token is 43 characters. */
const MAX_TOKEN_BYTES = 128;

/** The namespace of the completion's key: a digest made here is not a digest of anything else, a setup token's included. */
const RECOVERY_TOKEN_NAMESPACE = 'melarc.recovery-token.v1';

/**
 * The limit of `completeCredentialRecovery` (settings.md section 7.7, `rate_limit_recovery`; `AC-SLICE-000-125`): keyed on **the
 * purpose-qualified SHA-256 digest of the bounded token the request presents**, whether or not it matches a request, as the setup
 * operations' are (`setupTokenLimit`), under a namespace and a purpose of its own, so a value presented here never counts against a setup
 * grant's purpose. The key holds no part of the token, and the limiter digests it once more before it stores anything.
 */
export const RECOVERY_COMPLETION_LIMIT: AnonymousLimit = {
  bucket: 'rate_limit_recovery',
  identifier: { field: 'token', maxBytes: MAX_TOKEN_BYTES },
  canonical: (token) =>
    createHash('sha256')
      .update(`${RECOVERY_TOKEN_NAMESPACE}\u0000CREDENTIAL_RECOVERY\u0000`, 'utf8')
      .update(token, 'utf8')
      .digest('base64url'),
};

export const recoveryPrincipalPartition: LimitPartitioner = (
  request: Request,
  identifier: string,
) => {
  const type = principalTypeOf(request.body);
  const canonical = type === 'VENDOR' ? identifier.toUpperCase() : identifier.toLowerCase();
  return Promise.resolve(
    `${RECOVERY_REQUEST_LIMIT_NAMESPACE}\u0000${type ?? UNTYPED}\u0000${canonical}`,
  );
};
