import { z } from 'zod';

import {
  ATTESTATION_INTEGRITY_CAUSES,
  ATTESTATION_UNAVAILABLE_CAUSES,
  type AttestationVerdict,
} from '../ports/attestation-verifier.port.js';
import { parseDevicePublicKey } from '../device-key/device-key-protocol.js';
import { AttestationInterfaceError } from './attestation-errors.js';

/**
 * The answer of the private verifier service (`POST /v1/verify`; apps/attestation-verifier, SECURITY_DESIGN.md §15.2.3), read **strictly**:
 * the status and the media type say which kind of answer it is, the body is a closed document (these members, once each, of these types, and
 * the closed vocabularies of the port for every cause), and anything else is `AttestationInterfaceError`, a defect of the interface and never
 * a verdict about a device. What the service says is never relabelled: a verdict it gave is returned as it is.
 *
 * | Answer | Read as |
 * |---|---|
 * | `200` with a verdict | that verdict |
 * | `503` with `TRUST_DATA_UNAVAILABLE` (its own refusals: overloaded, late) | that verdict |
 * | any other `5xx`, or a `503` that is not such a verdict (a proxy in front of it) | `TRUST_DATA_UNAVAILABLE` / `VERIFIER_UNREACHABLE` |
 * | `413`, whatever the body | `DEVICE_INTEGRITY_FAILED` / `EVIDENCE_MALFORMED`: the chain is bigger than the service reads |
 * | any other `4xx`, `3xx`, a `2xx` other than `200`, `1xx` | the interface is broken (it was not asked what it was told, or it moved) |
 * | `200` that is not a verdict | the interface is broken |
 *
 * A `4xx` is the verifier refusing the request this API made (its secret, its version): a misconfiguration or a version drift that no retry
 * cures, so it is alerted as a defect and not told to a rider as "try again". **The size is the one exception, because the size is the
 * caller's**: the API forwards nothing but the evidence, which a client chooses up to the API's own body limit (100 KiB by default) while the
 * service reads 64 KiB by default, so a chain between the two is the service saying that the evidence is oversized, which is a malformed chain
 * (SECURITY_DESIGN.md §15.2.1, step 1) and not a fault of ours: a `500` that anyone could ask for, and an alert for a request that was only too
 * big, would be the wrong answer.
 */

/** The longest answer read. A verdict is a few hundred bytes; the cap keeps a wrong peer from filling memory. */
export const MAX_ANSWER_BYTES = 16 * 1024;

const INTEGRITY = z.enum(ATTESTATION_INTEGRITY_CAUSES);
const UNAVAILABLE = z.enum(ATTESTATION_UNAVAILABLE_CAUSES);
const DIGEST = /^[0-9a-f]{64}$/;

const SUMMARY = z
  .object({
    security_level: z.enum(['TRUSTED_ENVIRONMENT', 'STRONG_BOX']),
    attestation_version: z.number().int().min(0).max(2_147_483_647),
    key_mint_version: z.number().int().min(0).max(2_147_483_647),
    package_name: z.string().min(1).max(255),
    signer_digests: z.array(z.string().regex(DIGEST)).min(1).max(10),
  })
  .strict();

const ANSWER = z.discriminatedUnion('verdict', [
  z
    .object({
      version: z.literal(1),
      verdict: z.literal('VERIFIED'),
      attested_public_key: z.string(),
      summary: SUMMARY,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      verdict: z.literal('DEVICE_INTEGRITY_FAILED'),
      cause: INTEGRITY,
    })
    .strict(),
  z.object({ version: z.literal(1), verdict: z.literal('DEVICE_SECURITY_UNSUPPORTED') }).strict(),
  z
    .object({
      version: z.literal(1),
      verdict: z.literal('TRUST_DATA_UNAVAILABLE'),
      cause: UNAVAILABLE,
    })
    .strict(),
]);

const UNREACHABLE: AttestationVerdict = {
  verdict: 'TRUST_DATA_UNAVAILABLE',
  cause: 'VERIFIER_UNREACHABLE',
};

/** A chain the service will not read for its size: oversized evidence, which step 1 of the policy refuses as malformed. */
const OVERSIZED_EVIDENCE: AttestationVerdict = {
  verdict: 'DEVICE_INTEGRITY_FAILED',
  cause: 'EVIDENCE_MALFORMED',
};

const isJson = (contentType: string | null): boolean =>
  contentType !== null &&
  /^application\/json\s*(?:;\s*charset=utf-8\s*)?$/i.test(contentType.trim());

/** The field a validation failure names: the path of its first issue, and never a value. */
function fieldOf(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'body';
  // An unrecognised member is named by a word of ours: a member the service sent is not echoed.
  if (issue.code === 'unrecognized_keys') return 'body.unknown_member';
  const path = issue.path.filter((part): part is string => typeof part === 'string');
  return path.length === 0 ? 'body' : `body.${path.join('.')}`;
}

/** The verdict of a body, or the field that broke the interface. */
function verdictOf(body: Uint8Array): AttestationVerdict {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new AttestationInterfaceError('body.encoding');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AttestationInterfaceError('body.json');
  }
  const parsed = ANSWER.safeParse(json);
  if (!parsed.success) throw new AttestationInterfaceError(fieldOf(parsed.error));
  const answer = parsed.data;
  switch (answer.verdict) {
    case 'VERIFIED': {
      // The key the verifier attested is held to the one canonical form the API uses, so it can be compared with the submitted key as bytes.
      const key = parseDevicePublicKey(answer.attested_public_key);
      if (!key.ok) throw new AttestationInterfaceError('body.attested_public_key');
      return {
        verdict: 'VERIFIED',
        attestedPublicKey: key.canonical,
        summary: {
          securityLevel: answer.summary.security_level,
          attestationVersion: answer.summary.attestation_version,
          keyMintVersion: answer.summary.key_mint_version,
          packageName: answer.summary.package_name,
          signerDigests: answer.summary.signer_digests,
        },
      };
    }
    case 'DEVICE_INTEGRITY_FAILED':
      return { verdict: 'DEVICE_INTEGRITY_FAILED', cause: answer.cause };
    case 'DEVICE_SECURITY_UNSUPPORTED':
      return { verdict: 'DEVICE_SECURITY_UNSUPPORTED' };
    case 'TRUST_DATA_UNAVAILABLE':
      return { verdict: 'TRUST_DATA_UNAVAILABLE', cause: answer.cause };
  }
}

/** What an answer of the service means: its status, its media type and its (already size-bounded) body. */
export function readVerifierAnswer(answer: {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}): AttestationVerdict {
  const { status } = answer;
  if (status === 200) {
    if (!isJson(answer.contentType)) throw new AttestationInterfaceError('content_type');
    return verdictOf(answer.body);
  }
  if (status >= 500) {
    // The service's own refusals (overloaded, late) come with the verdict body of an unavailable verifier; a 503 from anything else does not.
    if (status === 503 && isJson(answer.contentType)) {
      try {
        const verdict = verdictOf(answer.body);
        if (verdict.verdict === 'TRUST_DATA_UNAVAILABLE') return verdict;
      } catch {
        // Not the service's own verdict: whatever answered is in the way, and the verifier has not answered.
      }
    }
    return UNREACHABLE;
  }
  if (status === 413) return OVERSIZED_EVIDENCE;
  throw new AttestationInterfaceError(
    status >= 300 && status < 400 ? 'status.redirect' : status >= 400 ? 'status.refused' : 'status',
  );
}
