package com.melarc.attestation

import com.google.gson.JsonParser
import com.melarc.attestation.fixtures.AttestationFixtures
import com.melarc.attestation.fixtures.AttestationVectors
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test

/**
 * The chains the API's tests send to the real service (`apps/api/test/vectors/attestation-chains.v1.json`, S0.57) are made by
 * [AttestationVectors] from this module's fixtures and consumed by `rider-device-enrolment-attested.db.test.ts`. This holds the committed file
 * to a fresh run of the generator: a fixture that changed without the file, or a file edited by hand, fails here. **Break caught:** a file
 * that no generator produced, and a selection that has lost a class of evidence the acceptance criteria name.
 */
class AttestationVectorsTest {
  private val vectors: Path = Path.of(checkNotNull(System.getProperty("melarc.vectors.dir")) { "melarc.vectors.dir is not set" })

  // A checkout may carry either line ending; the content is what is held.
  private fun normalised(text: String) = text.replace("\r\n", "\n")

  @Test
  fun `a fresh run of the generator gives the committed chains, byte for byte`() {
    assertEquals(
      normalised(Files.readString(vectors.resolve("attestation-chains.v1.json"))),
      normalised(AttestationVectors.document()),
      "regenerate with ./gradlew :service:attestationVectors",
    )
  }

  @Test
  fun `the selection names fixtures that exist, once each, and every class of evidence the criteria name is in it`() {
    assertEquals(AttestationVectors.SELECTION.size, AttestationVectors.SELECTION.toSet().size)
    val known = AttestationFixtures.cases.map { it.name }.toSet()
    assertTrue(known.containsAll(AttestationVectors.SELECTION), "a selected fixture does not exist")

    val expected = AttestationVectors.SELECTION.map { AttestationFixtures.named(it).expected }
    assertTrue(expected.any { it is com.melarc.attestation.fixtures.Expected.Verified }, "no accepted chain")
    assertTrue(expected.any { it is com.melarc.attestation.fixtures.Expected.SecurityUnsupported }, "no handset below hardware")
    val causes =
      expected.filterIsInstance<com.melarc.attestation.fixtures.Expected.IntegrityFailed>().map { it.cause }.toSet()
    // AC-62 (the application), AC-63 (the chain, the roots, the revocation), AC-64 (the challenge), AC-65 (the device state), AC-66 (the key).
    for (
      cause in
        listOf(
          IntegrityCause.PACKAGE_NOT_APPROVED,
          IntegrityCause.SIGNER_NOT_APPROVED,
          IntegrityCause.EVIDENCE_MALFORMED,
          IntegrityCause.CHAIN_INVALID,
          IntegrityCause.ROOT_NOT_TRUSTED,
          IntegrityCause.CERTIFICATE_REVOKED,
          IntegrityCause.CHALLENGE_MISMATCH,
          IntegrityCause.DEVICE_NOT_LOCKED,
          IntegrityCause.BOOT_STATE_NOT_VERIFIED,
          IntegrityCause.KEY_PROPERTIES_REJECTED,
          IntegrityCause.KEY_MISMATCH,
        )
    ) {
      assertTrue(cause in causes, "no chain for $cause")
    }
  }

  @Test
  fun `the file holds a challenge, a key and a chain of certificates for each case, and no private key`() {
    val text = AttestationVectors.document()
    assertFalse(text.contains("PRIVATE KEY"))
    val root = JsonParser.parseString(text).asJsonObject
    assertEquals(1, root.get("version").asInt)
    val service = root.getAsJsonObject("service")
    assertEquals("com.melarc.rider", service.get("package_name").asString)
    assertEquals(2, service.getAsJsonArray("signing_digests").size())
    assertEquals(2, service.getAsJsonArray("accepted_roots").size())
    for (case in root.getAsJsonArray("cases")) {
      val json = case.asJsonObject
      val name = json.get("name").asString
      assertEquals(43, json.get("challenge").asString.length, "$name: a challenge is 32 bytes in 43 characters")
      assertEquals(124, json.get("device_public_key").asString.length, "$name: a key is 91 bytes in 124 characters")
      assertTrue(json.getAsJsonArray("certificate_chain").size() in 1..10, "$name: a chain is one to ten certificates")
    }
  }
}
