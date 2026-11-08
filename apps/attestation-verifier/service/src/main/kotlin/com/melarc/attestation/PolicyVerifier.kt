package com.melarc.attestation

import com.android.keyattestation.verifier.AttestationApplicationIdConstraint
import com.android.keyattestation.verifier.AuthorizationList
import com.android.keyattestation.verifier.ConstraintConfig
import com.android.keyattestation.verifier.ExtensionParsingException
import com.android.keyattestation.verifier.IgnoredConstraint
import com.android.keyattestation.verifier.InputLimits
import com.android.keyattestation.verifier.KeyAttestationReason
import com.android.keyattestation.verifier.KeyDescription
import com.android.keyattestation.verifier.Origin
import com.android.keyattestation.verifier.SecurityLevel
import com.android.keyattestation.verifier.VerificationResult
import com.android.keyattestation.verifier.Verifier
import com.android.keyattestation.verifier.VerifiedBootState
import com.android.keyattestation.verifier.ChallengeChecker
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.protobuf.ByteString
import java.io.ByteArrayInputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.PKIXReason
import java.security.cert.X509Certificate
import java.security.spec.X509EncodedKeySpec
import java.time.InstantSource
import java.util.Base64

/** What the verifier is asked: the chain (leaf first), the hash of the challenge issued with the grant, and the key being enrolled. */
class VerifyRequest(
  /** Each certificate as the DER bytes the handset sent. */
  val chain: List<ByteArray>,
  /** The SHA-256 of the 32 challenge bytes issued with the grant. */
  val expectedChallengeSha256: ByteArray,
  /** The canonical DER SubjectPublicKeyInfo of the key submitted for registration. */
  val devicePublicKey: ByteArray,
)

/** What the server asks of a policy: a verdict on a request, judged against the trust data the instance holds fresh. */
fun interface VerdictPolicy {
  fun verify(request: VerifyRequest, trust: TrustState.Fresh): Verdict
}

/**
 * The policy of SECURITY_DESIGN.md 15.2.1, evaluated **in its order, the first failure ending it**, on top of the pinned `android/keyattestation`
 * library. **No certificate parser and no path validator is written here**: the library parses the chain, validates the path from the root
 * (in the steps its model of an Android chain has, so that the attestation extension is read only from the one target certificate and a
 * chain extended past it, or with the extension anywhere else, is refused: the extension nearest the root is the only one trusted, and an
 * appended one is never read) and reads the key description. What this adds is the policy the library does not state or states more
 * leniently, as Melarc's:
 *
 * | Step | Decided by |
 * |---|---|
 * | trust data fresh (before step 1) | [TrustData] |
 * | 1 structure | the library (chain, extension); the bytes parsed are the bytes sent |
 * | 2 security level | here: neither level is `Software`, whatever the chain's root |
 * | 3 chain validity, 4 roots, 5 revocation | the library's path validation, over the roots and the list this instance holds |
 * | 6 challenge | here: SHA-256 of the attested challenge equals the hash of the grant's, in constant time |
 * | 7 application identity | here: exactly the configured package, and **every** reported signing digest approved |
 * | 8 device state | here: the hardware-enforced root of trust, locked and `Verified` |
 * | 9 key properties | here: generated on the device, a signing key, EC P-256 with SHA-256 |
 * | 10 key binding | here: the attested key, canonicalised, is the submitted key |
 *
 * The library's own constraints for the attestation application identity (which is satisfied by **any one** matching package and signer),
 * the origin, the security level and the root of trust are switched off, so that the steps above run in the order of the design and say what
 * the design says; each is checked here instead.
 *
 * An unexpected exception while a chain is being read is the evidence's, not the verifier's: the same input fails the same way, so it is
 * answered `EVIDENCE_MALFORMED`, counted and logged by class (a library defect would show as a rate).
 */
class PolicyVerifier(
  private val policy: Policy,
  private val clock: InstantSource,
  private val metrics: Metrics,
  private val log: StructuredLog,
) : VerdictPolicy {
  class Policy(val packageName: String, val signingDigests: Set<String>)

  private val limits = InputLimits()

  override fun verify(request: VerifyRequest, trust: TrustState.Fresh): Verdict =
    try {
      evaluate(request, trust)
    } catch (failure: Exception) {
      metrics.increment("attestation_unexpected_exceptions_total")
      log.event("WARN", "unexpected_exception", mapOf("class" to failure.javaClass.name))
      Verdict.IntegrityFailed(IntegrityCause.EVIDENCE_MALFORMED)
    }

  private fun evaluate(request: VerifyRequest, trust: TrustState.Fresh): Verdict {
    // Step 1, the bytes: every certificate parses, and parses to exactly the bytes that were sent (no trailing data, no other encoding).
    val chain =
      try {
        request.chain.map { parse(it) }
      } catch (failure: CertificateException) {
        return Verdict.IntegrityFailed(IntegrityCause.EVIDENCE_MALFORMED)
      }
    val leaf = chain.firstOrNull() ?: return Verdict.IntegrityFailed(IntegrityCause.EVIDENCE_MALFORMED)

    // Step 1, the extension, and step 2, the security level: read from the leaf by the library's parser before the chain is judged, because
    // the missing capability is the cause whatever the chain's root.
    val description =
      try {
        KeyDescription.parseFrom(leaf, {}, limits)
      } catch (failure: ExtensionParsingException) {
        null
      } catch (failure: RuntimeException) {
        null
      } ?: return Verdict.IntegrityFailed(IntegrityCause.EVIDENCE_MALFORMED)
    if (
      description.attestationSecurityLevel == SecurityLevel.SOFTWARE ||
        description.keyMintSecurityLevel == SecurityLevel.SOFTWARE
    ) {
      return Verdict.SecurityUnsupported
    }

    // Steps 3 to 6: path validation (chain, roots, revocation) and the challenge, by the library.
    val result = libraryVerifier(trust, clock, limits).verify(chain, HashedChallenge(request.expectedChallengeSha256))
    val success =
      when (result) {
        is VerificationResult.Success -> result
        is VerificationResult.ChallengeMismatch ->
          return Verdict.IntegrityFailed(IntegrityCause.CHALLENGE_MISMATCH)
        is VerificationResult.ChainParsingFailure,
        is VerificationResult.ExtensionParsingFailure ->
          return Verdict.IntegrityFailed(IntegrityCause.EVIDENCE_MALFORMED)
        is VerificationResult.PathValidationFailure ->
          return Verdict.IntegrityFailed(causeOfPathFailure(result.cause))
        // Constraints that were switched off cannot be violated; a violation here is the library answering something this build did not
        // ask of it, and is refused as the evidence's.
        is VerificationResult.ConstraintViolation,
        VerificationResult.SoftwareAttestationUnsupported ->
          return Verdict.IntegrityFailed(IntegrityCause.EVIDENCE_MALFORMED)
      }

    // Step 7, the application identity.
    val identity = description.softwareEnforced.attestationApplicationId
    val packages = identity?.packages.orEmpty()
    if (packages.size != 1 || packages.single().name != policy.packageName) {
      return Verdict.IntegrityFailed(IntegrityCause.PACKAGE_NOT_APPROVED)
    }
    val digests = identity?.signatures.orEmpty().map { hex(it.toByteArray()) }
    if (digests.isEmpty() || digests.any { it !in policy.signingDigests }) {
      return Verdict.IntegrityFailed(IntegrityCause.SIGNER_NOT_APPROVED)
    }

    // Step 8, the device state: both fields from the hardware-enforced list alone, never from the software-enforced one.
    val rootOfTrust = description.hardwareEnforced.rootOfTrust
    if (rootOfTrust == null) return Verdict.IntegrityFailed(IntegrityCause.BOOT_STATE_NOT_VERIFIED)
    if (!rootOfTrust.deviceLocked) return Verdict.IntegrityFailed(IntegrityCause.DEVICE_NOT_LOCKED)
    if (rootOfTrust.verifiedBootState != VerifiedBootState.VERIFIED) {
      return Verdict.IntegrityFailed(IntegrityCause.BOOT_STATE_NOT_VERIFIED)
    }

    // Step 9, the key properties, from the hardware-enforced list.
    if (!hasSigningKeyProperties(description.hardwareEnforced)) {
      return Verdict.IntegrityFailed(IntegrityCause.KEY_PROPERTIES_REJECTED)
    }

    // Step 10, the key binding: both keys canonicalised by the crypto stack, then compared as the bytes it encodes.
    val attested = success.publicKey.encoded
    val submitted =
      try {
        KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(request.devicePublicKey)).encoded
      } catch (failure: Exception) {
        return Verdict.IntegrityFailed(IntegrityCause.KEY_MISMATCH)
      }
    if (!MessageDigest.isEqual(attested, submitted)) return Verdict.IntegrityFailed(IntegrityCause.KEY_MISMATCH)

    return Verdict.Verified(
      attestedPublicKey = Base64.getEncoder().encodeToString(attested),
      summary =
        AttestationSummary(
          securityLevel = levelName(success.securityLevel),
          attestationVersion = description.attestationVersion.toIntExact(),
          keyMintVersion = description.keyMintVersion.toIntExact(),
          packageName = policy.packageName,
          signerDigests = digests,
        ),
    )
  }

  /** One certificate, DER: parsed by the JDK, and required to be exactly the bytes that were sent. */
  private fun parse(der: ByteArray): X509Certificate {
    // A factory for each certificate: nothing is shared between the requests that run at once.
    val certificate =
      CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate
    if (!certificate.encoded.contentEquals(der)) throw CertificateException("trailing or re-encoded bytes")
    return certificate
  }

  private fun causeOfPathFailure(failure: CertPathValidatorException): IntegrityCause =
    when (val reason = failure.reason) {
      PKIXReason.NO_TRUST_ANCHOR -> IntegrityCause.ROOT_NOT_TRUSTED
      CertPathValidatorException.BasicReason.REVOKED -> IntegrityCause.CERTIFICATE_REVOKED
      is KeyAttestationReason -> IntegrityCause.EVIDENCE_MALFORMED
      // An invalid signature, broken name chaining, an expired or not-yet-valid certificate, and anything the path validator does not name.
      else -> {
        metrics.increment("attestation_integrity_failures_total", "path_" + reason.toString().lowercase())
        IntegrityCause.CHAIN_INVALID
      }
    }

  private fun hasSigningKeyProperties(list: AuthorizationList): Boolean =
    list.origin == Origin.GENERATED &&
      list.purposes?.contains(PURPOSE_SIGN) == true &&
      list.algorithms == ALGORITHM_EC &&
      list.ecCurve == CURVE_P_256 &&
      list.digests?.contains(DIGEST_SHA_256) == true

  private fun levelName(level: SecurityLevel): String =
    when (level) {
      SecurityLevel.STRONG_BOX -> "STRONG_BOX"
      SecurityLevel.TRUSTED_ENVIRONMENT -> "TRUSTED_ENVIRONMENT"
      SecurityLevel.SOFTWARE -> throw IllegalStateException("a software level was accepted")
    }

  private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

  private fun BigInteger.toIntExact(): Int = this.intValueExact()

  /** The attested challenge must hash to the grant's: a 32-byte value, compared in constant time. */
  private class HashedChallenge(private val expectedSha256: ByteArray) : ChallengeChecker {
    override fun checkChallenge(challenge: ByteString): ListenableFuture<Boolean> {
      val bytes = challenge.toByteArray()
      val matches =
        bytes.size == CHALLENGE_BYTES &&
          MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(bytes), expectedSha256)
      return Futures.immediateFuture(matches)
    }
  }

  companion object {
    const val CHALLENGE_BYTES = 32

    /**
     * The library's verifier as this service configures it: the roots and the revocation list this instance holds, the instant on the
     * injected clock, and none of the library's own constraints (each is checked by the policy, in its order). A test builds the very same
     * one to hold the real device chains the release ships to it.
     */
    internal fun libraryVerifier(trust: TrustState.Fresh, clock: InstantSource, limits: InputLimits = InputLimits()): Verifier =
      Verifier(
        trustAnchorsSource = { trust.roots },
        revokedSerialsSource = { trust.revoked },
        instantSource = { clock.instant() },
        expectedAttestationApplicationId = null,
        constraintConfig =
          ConstraintConfig(
            allowSoftwareRoot = false,
            attestationApplicationId = AttestationApplicationIdConstraint.NONE,
            keyOrigin = IgnoredConstraint,
            securityLevel = IgnoredConstraint,
            rootOfTrust = IgnoredConstraint,
            additionalConstraints = ImmutableList.of(),
            inputLimits = limits,
          ),
      )

    // KeyMint tag values (https://source.android.com/docs/security/features/keystore/tags): signing is purpose 2, EC is algorithm 3, P-256
    // is curve 1 and SHA-256 is digest 4.
    private val PURPOSE_SIGN: BigInteger = BigInteger.valueOf(2)
    private val ALGORITHM_EC: BigInteger = BigInteger.valueOf(3)
    private val CURVE_P_256: BigInteger = BigInteger.valueOf(1)
    private val DIGEST_SHA_256: BigInteger = BigInteger.valueOf(4)
  }
}
