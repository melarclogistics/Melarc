package com.melarc.attestation

import com.android.keyattestation.verifier.SoftwareRoot
import com.melarc.attestation.fixtures.AttestationFixtures
import com.melarc.attestation.fixtures.Expected
import com.melarc.attestation.fixtures.FixtureCase
import com.melarc.attestation.fixtures.FixtureWorld
import com.melarc.attestation.fixtures.Root
import com.melarc.attestation.fixtures.hex
import java.security.cert.TrustAnchor
import java.util.Base64
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.DynamicTest.dynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The policy of SECURITY_DESIGN.md 15.2.1, held to a chain for each way it says yes and each way it says no
 * ([AttestationFixtures]), built here and independent of the library that reads them. **Break caught:** a step moved, a cause renamed, a
 * list read where the design reads the other, a constraint relaxed or a comparison made on a prefix each change a verdict here.
 */
class PolicyVerifierTest {
  @TestFactory
  fun `every fixture gets the verdict the design gives it`(): List<DynamicTest> =
    AttestationFixtures.cases.map { case ->
      dynamicTest(case.name) {
        val verdict = FixtureWorld.policy().verify(case.request(), FixtureWorld.trust(case.revokedSerials))
        assertVerdict(case, verdict)
      }
    }

  @Test
  fun `the fixtures cover every closed cause the design names`() {
    val seen = AttestationFixtures.cases.map { it.expected }.filterIsInstance<Expected.IntegrityFailed>().map { it.cause }.toSet()
    assertEquals(IntegrityCause.entries.toSet(), seen, "a cause with no fixture is a cause nothing proves is reachable")
  }

  @Test
  fun `a fixture's name is unique and its chain is its own`() {
    val names = AttestationFixtures.cases.map { it.name }
    assertEquals(names.size, names.toSet().size)
    val chains = AttestationFixtures.cases.map { it.chain.map { cert -> cert.hex() } }
    assertEquals(chains.size, chains.toSet().size, "two cases with one chain prove one thing twice")
  }

  @Test
  fun `the verdict never carries what the evidence said`() {
    val case = AttestationFixtures.named("valid_trusted_environment")
    val verified = FixtureWorld.policy().verify(case.request(), FixtureWorld.trust())
    assertIs<Verdict.Verified>(verified)
    val text = VerifierServer.verdictBody(verified)
    // The boot key and hash, the challenge and every certificate are not in the answer: it carries the attested public key (which the API
    // already holds), the level, the versions, the package and the approved digests.
    for (secret in listOf(FixtureWorld.BOOT_KEY.hex(), FixtureWorld.BOOT_HASH.hex(), case.issuedChallenge.hex())) {
      assertTrue(secret !in text, "the answer holds $secret")
    }
  }

  @Test
  fun `a chain from the second accepted root needs that root to be accepted`() {
    val case = AttestationFixtures.named("valid_second_accepted_root")
    val onlyFirst = FixtureWorld.trust().copy(roots = FixtureWorld.anchors(listOf(Root.A)))
    assertEquals(
      Verdict.IntegrityFailed(IntegrityCause.ROOT_NOT_TRUSTED),
      FixtureWorld.policy().verify(case.request(), onlyFirst),
    )
  }

  @Test
  fun `the software root is never a root, even if the loader were bypassed`() {
    // The private keys of Google's software attestation roots are public (AOSP), so a chain under one can claim any security level. The
    // loader refuses such a root; if one were handed to the policy all the same, the library refuses it again and the answer is a refusal.
    val case = AttestationFixtures.named("valid_trusted_environment")
    val metrics = Metrics()
    val softwareRoots = SoftwareRoot.SOFTWARE_ROOTS.map { TrustAnchor(it, null) }.toSet()
    val trust = FixtureWorld.trust().copy(roots = softwareRoots)
    assertEquals(Verdict.IntegrityFailed(IntegrityCause.EVIDENCE_MALFORMED), FixtureWorld.policy(metrics).verify(case.request(), trust))
    assertEquals(1, metrics.count("attestation_unexpected_exceptions_total"), "the defect is counted, not hidden")
  }

  private fun assertVerdict(case: FixtureCase, verdict: Verdict) {
    val context = "${case.name}: ${case.description}"
    when (val expected = case.expected) {
      is Expected.Verified -> {
        assertIs<Verdict.Verified>(verdict, context)
        assertEquals(Base64.getEncoder().encodeToString(case.devicePublicKey), verdict.attestedPublicKey, context)
        assertEquals(expected.securityLevel, verdict.summary.securityLevel, context)
        assertEquals(FixtureWorld.PACKAGE, verdict.summary.packageName, context)
        assertEquals(expected.signers.map { it.hex() }.sorted(), verdict.summary.signerDigests.sorted(), context)
        assertEquals(300, verdict.summary.attestationVersion, context)
        assertEquals(300, verdict.summary.keyMintVersion, context)
      }
      is Expected.IntegrityFailed -> assertEquals(Verdict.IntegrityFailed(expected.cause), verdict, context)
      Expected.SecurityUnsupported -> assertEquals(Verdict.SecurityUnsupported, verdict, context)
    }
  }
}
