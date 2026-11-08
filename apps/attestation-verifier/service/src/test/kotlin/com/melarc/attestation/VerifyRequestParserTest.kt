package com.melarc.attestation

import com.melarc.attestation.fixtures.AttestationFixtures
import com.melarc.attestation.fixtures.hex
import java.util.Base64
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test

/**
 * The versioned request (`POST /v1/verify`), read strictly: four members, once each, of exactly these types, in the one spelling of each
 * encoding. **Break caught:** a lenient JSON reader, a member that may repeat or be unknown, an encoding that is not the canonical one, a
 * bound moved, and a refusal that names a value instead of a field.
 */
class VerifyRequestParserTest {
  private val request = AttestationFixtures.named("valid_trusted_environment").request()

  private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

  private fun quoted(text: String) = "\"$text\""

  private val chainJson = request.chain.joinToString(",", "[", "]") { quoted(b64(it)) }
  private val challengeJson = quoted(request.expectedChallengeSha256.hex())
  private val keyJson = quoted(b64(request.devicePublicKey))

  private fun body(
    version: String = "1",
    chain: String = chainJson,
    challenge: String = challengeJson,
    key: String = keyJson,
    extra: String = "",
  ) = """{"version":$version,"certificate_chain":$chain,"expected_challenge_sha256":$challenge,"device_public_key":$key$extra}"""

  private fun refusedField(text: String): String =
    assertFailsWith<InvalidRequestException>("accepted: ${text.take(120)}") { VerifyRequestParser.parse(text.toByteArray(Charsets.UTF_8)) }.field

  @Test
  fun `a request of four members is read`() {
    val parsed = VerifyRequestParser.parse(body().toByteArray())
    assertEquals(request.chain.size, parsed.chain.size)
    request.chain.indices.forEach { assertContentEquals(request.chain[it], parsed.chain[it]) }
    assertContentEquals(request.expectedChallengeSha256, parsed.expectedChallengeSha256)
    assertContentEquals(request.devicePublicKey, parsed.devicePublicKey)
  }

  @Test
  fun `members may come in any order and the document may be spaced`() {
    val text =
      """ { "device_public_key" : $keyJson , "expected_challenge_sha256":$challengeJson,
          "certificate_chain" : $chainJson,
          "version" : 1 } """
    assertContentEquals(request.devicePublicKey, VerifyRequestParser.parse(text.toByteArray()).devicePublicKey)
  }

  @Test
  fun `the version is the number one and nothing else`() {
    for (bad in listOf("2", "0", "\"1\"", "1.0", "1e0", "-1", "true", "null", "[1]", "{}")) {
      assertEquals("version", refusedField(body(version = bad)), "accepted version $bad")
    }
  }

  @Test
  fun `each member is required`() {
    val all = mapOf("version" to "1", "certificate_chain" to chainJson, "expected_challenge_sha256" to challengeJson, "device_public_key" to keyJson)
    for (missing in all.keys) {
      val text = all.filterKeys { it != missing }.entries.joinToString(",", "{", "}") { (key, value) -> "\"$key\":$value" }
      assertEquals(missing, refusedField(text))
    }
    assertEquals("version", refusedField("{}"))
  }

  @Test
  fun `a member that is unknown or repeated is refused, and the answer is one of our words`() {
    assertEquals("unknown_member", refusedField(body(extra = ""","extra":1""")))
    assertEquals("unknown_member", refusedField(body(extra = ""","leak-me-123":1""")))
    assertEquals("unknown_member", refusedField(body(extra = ""","leak-me-123":1,"leak-me-123":2""")))
    assertEquals("version", refusedField(body(extra = ""","version":1""")))
    assertEquals("certificate_chain", refusedField(body(extra = ""","certificate_chain":$chainJson""")))
    assertEquals("expected_challenge_sha256", refusedField(body(extra = ""","expected_challenge_sha256":$challengeJson""")))
    assertEquals("device_public_key", refusedField(body(extra = ""","device_public_key":$keyJson""")))
    // A name spelled with an escape is the name it spells.
    assertEquals("version", refusedField(body(extra = ""","version":1""")))
  }

  @Test
  fun `the chain is one to ten certificates, each text in its one spelling`() {
    val first = b64(request.chain.first())
    for (bad in listOf("\"$first\"", "{}", "[]", "[1]", "[null]", "[[]]", "[\"\"]", "[\"@@@@\"]", "null", "true")) {
      assertEquals("certificate_chain", refusedField(body(chain = bad)), "accepted: ${bad.take(60)}")
    }
    // Ten are the most.
    fun many(count: Int) = (1..count).joinToString(",", "[", "]") { "\"$first\"" }
    VerifyRequestParser.parse(body(chain = many(10)).toByteArray())
    assertEquals("certificate_chain", refusedField(body(chain = many(11))))
  }

  @Test
  fun `a certificate's text is the one spelling of its bytes`() {
    val padded = b64(ByteArray(10) { 7 }) // ends in two padding characters
    assertTrue(padded.endsWith("=="))
    VerifyRequestParser.parse(body(chain = "[\"$padded\"]").toByteArray())
    val spareBits = padded.dropLast(3) + "x=="
    val urlSafe = b64(byteArrayOf(0xfb.toByte(), 0xef.toByte(), 0xbe.toByte(), 1)).replace('+', '-').replace('/', '_')
    val bad =
      mapOf(
        "padding left off" to padded.trimEnd('='),
        "one padding character" to padded.dropLast(1),
        "a newline" to padded + "\\n",
        "a space" to " $padded",
        "a space inside" to padded.substring(0, 4) + " " + padded.substring(4),
        "spare bits set" to spareBits,
        "the url alphabet" to urlSafe,
      )
    for ((what, text) in bad) {
      assertEquals("certificate_chain", refusedField(body(chain = "[\"$text\"]")), "accepted $what")
    }
  }

  @Test
  fun `a certificate is at most sixteen kibibytes`() {
    fun text(size: Int) = quoted(b64(ByteArray(size) { 1 }))
    // The bound is written out here, not read from the parser: a test that quotes the constant moves with it.
    VerifyRequestParser.parse(body(chain = "[${text(16 * 1024)}]").toByteArray())
    assertEquals("certificate_chain", refusedField(body(chain = "[${text(16 * 1024 + 1)}]")))
    assertEquals("certificate_chain", refusedField(body(chain = "[${text(64 * 1024)}]")))
    assertEquals(16 * 1024, VerifyRequestParser.MAX_CERTIFICATE_BYTES)
    assertEquals(10, VerifyRequestParser.MAX_CERTIFICATES)
  }

  @Test
  fun `the challenge hash is sixty-four lower-case hexadecimal digits`() {
    val good = request.expectedChallengeSha256.hex()
    for (bad in listOf(good.uppercase(), good.dropLast(1), good + "0", "g" + good.drop(1), " $good", "0x$good", "")) {
      assertEquals("expected_challenge_sha256", refusedField(body(challenge = quoted(bad))), "accepted: $bad")
    }
    for (bad in listOf("1", "null", "[]", "{}", "true")) {
      assertEquals("expected_challenge_sha256", refusedField(body(challenge = bad)))
    }
    // The value is decoded, byte for byte.
    assertContentEquals(ByteArray(32) { 0xab.toByte() }, VerifyRequestParser.parse(body(challenge = quoted("ab".repeat(32))).toByteArray()).expectedChallengeSha256)
  }

  @Test
  fun `the device key is a ninety-one byte uncompressed P-256 SubjectPublicKeyInfo in its one spelling`() {
    val der = request.devicePublicKey
    val prefix = der.copyOf(26)
    val wrongPrefix = der.copyOf().also { it[10] = (it[10].toInt() xor 1).toByte() } // another curve's object identifier
    val compressed = der.copyOf(59) // too short for the uncompressed form
    val tooLong = der + byteArrayOf(0)
    val other = der.copyOf().also { it[26] = 0x02 } // a compressed-point marker in the uncompressed slot
    for (bad in listOf(wrongPrefix, compressed, tooLong, prefix, ByteArray(91), other)) {
      assertEquals("device_public_key", refusedField(body(key = quoted(b64(bad)))), "accepted ${bad.size} bytes")
    }
    val text = b64(der)
    for (bad in listOf(text.dropLast(1), text + "\\n", " $text", text.dropLast(2) + "x=")) {
      assertEquals("device_public_key", refusedField(body(key = quoted(bad))), "accepted: $bad")
    }
    for (bad in listOf("null", "1", "[]", "{}", "true")) assertEquals("device_public_key", refusedField(body(key = bad)))
  }

  @Test
  fun `the document is one object and nothing after it`() {
    for (bad in listOf("", " ", "[]", "\"x\"", "1", "null", "true", body() + " {}", body() + "x", body() + ",", "{" + body().drop(1).dropLast(1), body().dropLast(1))) {
      assertEquals("body", refusedField(bad), "accepted: ${bad.take(40)}")
    }
  }

  @Test
  fun `json that is not strict is refused`() {
    val lenient =
      listOf(
        body().replace("\"version\"", "version"),
        body().replace("\"", "'"),
        body().replace("}", ",}"),
        "/* c */" + body(),
        body().replace("\"version\":1", "\"version\":01"),
        body().replace(",\"certificate_chain\"", ";\"certificate_chain\""),
      )
    for (bad in lenient) {
      val field = refusedField(bad)
      assertTrue(field in setOf("body", "version", "unknown_member", "certificate_chain", "expected_challenge_sha256", "device_public_key"), "refused with $field")
    }
  }

  @Test
  fun `bytes that are not text are refused without being echoed`() {
    val bytes = body().toByteArray().also { it[body().indexOf("\"version\"") + 3] = 0xff.toByte() }
    val failure = assertFailsWith<InvalidRequestException> { VerifyRequestParser.parse(bytes) }
    assertTrue(failure.field in setOf("body", "unknown_member"), failure.field)
    assertTrue("�" !in failure.message.orEmpty())
  }

  @Test
  fun `a refusal names a field of the request and never a value`() {
    val secret = "leak-me-" + "z".repeat(40)
    val fields =
      listOf(
        refusedField(body(version = quoted(secret))),
        refusedField(body(chain = "[${quoted(secret)}]")),
        refusedField(body(challenge = quoted(secret))),
        refusedField(body(key = quoted(secret))),
        refusedField(body(extra = ""","$secret":1""")),
      )
    assertTrue(fields.none { secret in it }, fields.toString())
    assertEquals(setOf("version", "certificate_chain", "expected_challenge_sha256", "device_public_key", "unknown_member"), fields.toSet())
  }
}
