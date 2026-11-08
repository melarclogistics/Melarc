package com.melarc.attestation

import com.android.keyattestation.verifier.ChallengeChecker
import com.android.keyattestation.verifier.SecurityLevel
import com.android.keyattestation.verifier.VerificationResult
import com.android.keyattestation.verifier.provider.KeyAttestationCertPath
import com.android.keyattestation.verifier.provider.ProvisioningMethod
import com.google.common.util.concurrent.Futures
import com.google.gson.JsonParser
import com.google.protobuf.ByteString
import com.melarc.attestation.fixtures.FixtureWorld
import com.melarc.attestation.fixtures.Root
import com.melarc.attestation.fixtures.sha256
import java.nio.file.Files
import java.nio.file.Path
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.time.Duration
import java.time.Instant
import java.time.InstantSource
import java.util.Base64
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test

/**
 * The qualification of the pinned library and this service's use of it against **real device chains**: the ten elliptic-curve chains the
 * pinned release ships as test data (Pixel 2 to Android 17, factory and remotely provisioned, the trusted environment and StrongBox, the
 * 2026 roots), judged against the roots Google publishes at the instant each key was made, as the release's own tests judge them.
 *
 * The test devices were unlocked or ran an unverified boot and their challenge is nine bytes, so no real chain reaches the later steps of the
 * policy: the later steps are held to the adversarial chains ([PolicyVerifierTest]). What a real chain proves is that **steps 1 to 5 accept
 * what real Android devices produce**, with this service's configuration (its constraints switched off, the roots and the list it holds) and
 * its stricter reading of the bytes.
 */
class RealChainsTest {
  private class RealChain(
    val name: String,
    val description: String,
    val certificates: List<ByteArray>,
    val at: Instant,
    val attestationSecurityLevel: String,
  ) {
    val parsed: List<X509Certificate> by lazy { certificates.map { FixtureWorld.x509(it) } }
    val software: Boolean
      get() = attestationSecurityLevel == "SOFTWARE"

    val provisioning: ProvisioningMethod by lazy { KeyAttestationCertPath(parsed).provisioningMethod() }
  }

  private val directory: Path = Path.of(checkNotNull(System.getProperty("melarc.verifier.dir")) { "melarc.verifier.dir is not set" })

  private val chains: List<RealChain> by lazy {
    val document = JsonParser.parseString(Files.readString(directory.resolve("fixtures/real-chains.v1.json"))).asJsonObject
    assertEquals("melarc.real-chains.v1", document["format"].asString)
    document["chains"].asJsonArray.map { element ->
      val chain = element.asJsonObject
      RealChain(
        chain["name"].asString,
        chain["description"].asString,
        chain["chain"].asJsonArray.map { Base64.getDecoder().decode(it.asString) },
        Instant.parse(chain["at"].asString),
        chain["attestation_security_level"].asString,
      )
    }
  }

  private val acceptAnyChallenge =
    object : ChallengeChecker {
      override fun checkChallenge(challenge: ByteString) = Futures.immediateFuture(true)
    }

  private val googleRoots: Set<TrustAnchor> by lazy {
    FileRootsSource.parseRoots(Files.readAllBytes(directory.resolve("third_party/keyattestation/roots.json")))
  }

  private fun trust(roots: Set<TrustAnchor> = googleRoots, revoked: Set<String> = emptySet()) =
    TrustState.Fresh(roots, revoked + FixtureWorld.DECOY_SERIAL, Instant.EPOCH)

  private fun request(chain: RealChain) =
    VerifyRequest(chain.certificates, sha256("a challenge the device did not attest"), chain.parsed.first().publicKey.encoded)

  private fun policy(at: Instant) = FixtureWorld.policy(now = at)

  @Test
  fun `the release's chains are all here, of both provisioning methods and both levels`() {
    assertEquals(10, chains.size)
    assertEquals(
      setOf(ProvisioningMethod.FACTORY_PROVISIONED, ProvisioningMethod.REMOTELY_PROVISIONED),
      chains.filterNot { it.software }.map { it.provisioning }.toSet(),
    )
    assertEquals(setOf("TRUSTED_ENVIRONMENT", "STRONG_BOX", "SOFTWARE"), chains.map { it.attestationSecurityLevel }.toSet())
    // The roots the pinned release lists: the RSA root of 2022 and the elliptic-curve root `Key Attestation CA1` of 2025.
    assertEquals(setOf("RSA", "EC"), googleRoots.map { it.trustedCert.publicKey.algorithm }.toSet())
    assertEquals(2, googleRoots.size)
  }

  @Test
  fun `the library, configured as this service configures it, accepts every real hardware chain at the instant its key was made`() {
    for (chain in chains.filterNot { it.software }) {
      val verifier = PolicyVerifier.libraryVerifier(trust(), InstantSource.fixed(chain.at))
      val result = verifier.verify(chain.parsed, acceptAnyChallenge)
      val success = assertIs<VerificationResult.Success>(result, "${chain.name}: $result")
      assertEquals(SecurityLevel.valueOf(chain.attestationSecurityLevel), success.securityLevel, chain.name)
      assertEquals(chain.parsed.first().publicKey, success.publicKey, chain.name)
    }
  }

  @Test
  fun `a software chain ends at a root nobody here accepts`() {
    val software = chains.filter { it.software }
    assertTrue(software.isNotEmpty())
    for (chain in software) {
      val result = PolicyVerifier.libraryVerifier(trust(), InstantSource.fixed(chain.at)).verify(chain.parsed, acceptAnyChallenge)
      assertIs<VerificationResult.PathValidationFailure>(result, chain.name)
      assertEquals(Verdict.SecurityUnsupported, policy(chain.at).verify(request(chain), trust()), "${chain.name}: the missing capability is the cause")
    }
  }

  @Test
  fun `the policy passes steps one to five for every real hardware chain and stops at the challenge`() {
    for (chain in chains.filterNot { it.software }) {
      assertEquals(
        Verdict.IntegrityFailed(IntegrityCause.CHALLENGE_MISMATCH),
        policy(chain.at).verify(request(chain), trust()),
        "${chain.name}: ${chain.description}",
      )
    }
  }

  @Test
  fun `a certificate of a real chain on the list is revoked, whichever certificate it is`() {
    for (chain in chains.filterNot { it.software }) {
      // Leaf, attestation certificate and intermediate, by the serial number the way the list spells it.
      for (index in listOf(0, 1, chain.parsed.size - 2)) {
        val serial = chain.parsed[index].serialNumber.toString(16)
        assertEquals(
          Verdict.IntegrityFailed(IntegrityCause.CERTIFICATE_REVOKED),
          policy(chain.at).verify(request(chain), trust(revoked = setOf(serial))),
          "${chain.name} certificate $index",
        )
      }
    }
  }

  @Test
  fun `a real chain is not trusted under roots that are not its roots`() {
    val others = FixtureWorld.anchors(listOf(Root.A, Root.B))
    for (chain in chains.filterNot { it.software }) {
      assertEquals(
        Verdict.IntegrityFailed(IntegrityCause.ROOT_NOT_TRUSTED),
        policy(chain.at).verify(request(chain), trust(roots = others)),
        chain.name,
      )
    }
  }

  @Test
  fun `long after the keys were made a factory chain is still accepted and a remotely provisioned one is not`() {
    val later = Duration.ofDays(36_500)
    for (chain in chains.filterNot { it.software }) {
      val verdict = policy(chain.at.plus(later)).verify(request(chain), trust())
      when (chain.provisioning) {
        // The design's exception (15.2.1 step 3): the expiry of the device's factory certificates alone does not refuse.
        ProvisioningMethod.FACTORY_PROVISIONED ->
          assertEquals(Verdict.IntegrityFailed(IntegrityCause.CHALLENGE_MISMATCH), verdict, chain.name)
        ProvisioningMethod.REMOTELY_PROVISIONED ->
          assertEquals(Verdict.IntegrityFailed(IntegrityCause.CHAIN_INVALID), verdict, chain.name)
        ProvisioningMethod.UNKNOWN -> error("${chain.name}: a chain of unknown provisioning")
      }
    }
  }

  @Test
  fun `a real chain before its certificates began is refused whatever the provisioning`() {
    for (chain in chains.filterNot { it.software }) {
      // The certificates between the leaf (whose validity is never judged) and the root (the anchor): the latest of their beginnings.
      val begun = chain.parsed.subList(1, chain.parsed.size - 1).maxOf { it.notBefore.toInstant() }
      val verdict = policy(begun.minus(Duration.ofDays(1))).verify(request(chain), trust())
      assertEquals(Verdict.IntegrityFailed(IntegrityCause.CHAIN_INVALID), verdict, chain.name)
    }
  }
}
