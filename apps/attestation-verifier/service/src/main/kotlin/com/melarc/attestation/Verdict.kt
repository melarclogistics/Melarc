package com.melarc.attestation

/**
 * What the verifier decided (SECURITY_DESIGN.md sections 15.2.1 and 15.2.3). The classes are the API's port (`AttestationVerifier`), word for
 * word: the closed causes below are the ones `apps/api/src/platform/auth/ports/attestation-verifier.port.ts` lists, and a test holds the two
 * to each other.
 */
enum class IntegrityCause {
  /** Step 1: the chain does not parse, is too short, is extended, or the key description is malformed, duplicated or missing. */
  EVIDENCE_MALFORMED,
  /** Step 3: a certificate does not sign the next, the names do not chain, or one is outside its validity period. */
  CHAIN_INVALID,
  /** Step 4: the chain does not end at an accepted Android attestation root. */
  ROOT_NOT_TRUSTED,
  /** Step 5: a certificate of the chain is on the attestation revocation list. */
  CERTIFICATE_REVOKED,
  /** Step 6: the attested challenge is not the one issued with the grant. */
  CHALLENGE_MISMATCH,
  /** Step 7: the attested package is not the Melarc Rider package. */
  PACKAGE_NOT_APPROVED,
  /** Step 7: a signing-certificate digest the extension reports is not in the approved set. */
  SIGNER_NOT_APPROVED,
  /** Step 8: the device is not locked (hardware-enforced root of trust). */
  DEVICE_NOT_LOCKED,
  /** Step 8: the verified boot state is not `Verified`, or the hardware-enforced root of trust is absent. */
  BOOT_STATE_NOT_VERIFIED,
  /** Step 9: the key was not generated on the device, is not a signing key, or is not an EC P-256 key with SHA-256. */
  KEY_PROPERTIES_REJECTED,
  /** Step 10: the attested public key is not the public key submitted for registration. */
  KEY_MISMATCH,
}

/** The six closed causes of `TRUST_DATA_UNAVAILABLE`: they say nothing about the device. */
enum class UnavailableCause {
  TRUST_DATA_STALE,
  TRUST_DATA_NOT_LOADED,
  TRUST_ROOTS_UNLOADABLE,
  VERIFIER_UNREACHABLE,
  VERIFIER_TIMEOUT,
  VERIFIER_OVERLOADED,
}

/** What an accepted attestation says, without the chain: nothing here identifies a handset (no serial, no IMEI, no boot key). */
data class AttestationSummary(
  /** `TRUSTED_ENVIRONMENT` or `STRONG_BOX`. */
  val securityLevel: String,
  val attestationVersion: Int,
  val keyMintVersion: Int,
  val packageName: String,
  /** The signing-certificate digests the extension reported, lower-case hexadecimal, in order. */
  val signerDigests: List<String>,
)

sealed interface Verdict {
  data class Verified(
    /** The attested public key, as the standard base64 of its DER SubjectPublicKeyInfo. */
    val attestedPublicKey: String,
    val summary: AttestationSummary,
  ) : Verdict

  data class IntegrityFailed(val cause: IntegrityCause) : Verdict

  data object SecurityUnsupported : Verdict

  data class Unavailable(val cause: UnavailableCause) : Verdict

  /** The label of the verdict class, as the response and the metrics name it. */
  val label: String
    get() =
      when (this) {
        is Verified -> "VERIFIED"
        is IntegrityFailed -> "DEVICE_INTEGRITY_FAILED"
        SecurityUnsupported -> "DEVICE_SECURITY_UNSUPPORTED"
        is Unavailable -> "TRUST_DATA_UNAVAILABLE"
      }
}
