package com.melarc.attestation

import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStreamReader
import java.security.KeyFactory
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/** A request the verifier will not read: it names the field and never the value. */
class InvalidRequestException(val field: String) : RuntimeException("invalid request: $field")

/**
 * The versioned request (`POST /v1/verify`), read strictly:
 *
 * ```json
 * { "version": 1,
 *   "certificate_chain": ["<standard base64 DER>", ...],          1 to 10, leaf first
 *   "expected_challenge_sha256": "<64 lower-case hex digits>",    the SHA-256 of the 32 challenge bytes issued with the grant
 *   "device_public_key": "<standard base64 of the 91-byte DER SubjectPublicKeyInfo of an uncompressed P-256 key>" }
 * ```
 *
 * Exactly these four members, once each, of exactly these types: an unknown member, a repeated one, a number where a string belongs, an
 * encoding that is not the canonical one, a chain of eleven and a certificate larger than the bound are all refused, before any of it is
 * parsed as a certificate. Input is bounded here and by the server (the body's size), so nothing the verifier reads is unbounded.
 */
object VerifyRequestParser {
  const val VERSION = 1
  const val MAX_CERTIFICATES = 10
  const val MAX_CERTIFICATE_BYTES = 16 * 1024
  private val MEMBERS = setOf("version", "certificate_chain", "expected_challenge_sha256", "device_public_key")
  private val HEX_64 = Regex("^[0-9a-f]{64}$")
  private val P256_SPKI_PREFIX =
    byteArrayOf(
      0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
      0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
    )

  fun parse(body: ByteArray): VerifyRequest {
    var chain: List<ByteArray>? = null
    var challenge: ByteArray? = null
    var key: ByteArray? = null
    var version: Int? = null
    val seen = mutableSetOf<String>()
    try {
      JsonReader(InputStreamReader(ByteArrayInputStream(body), Charsets.UTF_8)).use { reader ->
        reader.setStrictness(Strictness.STRICT)
        if (reader.peek() != JsonToken.BEGIN_OBJECT) throw InvalidRequestException("body")
        reader.beginObject()
        while (reader.hasNext()) {
          val name = reader.nextName()
          // A member this version does not know is named by a word of ours, never by the caller's text: nothing a caller sends comes back.
          if (name !in MEMBERS) throw InvalidRequestException("unknown_member")
          if (!seen.add(name)) throw InvalidRequestException(name)
          when (name) {
            "version" -> {
              if (reader.peek() != JsonToken.NUMBER) throw InvalidRequestException(name)
              if (reader.nextString() != VERSION.toString()) throw InvalidRequestException(name)
              version = VERSION
            }
            "certificate_chain" -> chain = chain(reader, name)
            "expected_challenge_sha256" -> challenge = challenge(string(reader, name), name)
            "device_public_key" -> key = devicePublicKey(string(reader, name), name)
          }
        }
        reader.endObject()
        if (reader.peek() != JsonToken.END_DOCUMENT) throw InvalidRequestException("body")
      }
    } catch (failure: InvalidRequestException) {
      throw failure
    } catch (failure: IOException) {
      throw InvalidRequestException("body")
    } catch (failure: IllegalStateException) {
      throw InvalidRequestException("body")
    } catch (failure: NumberFormatException) {
      throw InvalidRequestException("body")
    }
    if (version == null) throw InvalidRequestException("version")
    return VerifyRequest(
      chain = chain ?: throw InvalidRequestException("certificate_chain"),
      expectedChallengeSha256 = challenge ?: throw InvalidRequestException("expected_challenge_sha256"),
      devicePublicKey = key ?: throw InvalidRequestException("device_public_key"),
    )
  }

  private fun string(reader: JsonReader, field: String): String {
    if (reader.peek() != JsonToken.STRING) throw InvalidRequestException(field)
    return reader.nextString()
  }

  private fun chain(reader: JsonReader, field: String): List<ByteArray> {
    if (reader.peek() != JsonToken.BEGIN_ARRAY) throw InvalidRequestException(field)
    reader.beginArray()
    val certificates = mutableListOf<ByteArray>()
    while (reader.hasNext()) {
      if (certificates.size >= MAX_CERTIFICATES) throw InvalidRequestException(field)
      val text = string(reader, field)
      // The longest base64 text of a certificate within the bound: refused before it is decoded.
      if (text.length > (MAX_CERTIFICATE_BYTES + 2) / 3 * 4) throw InvalidRequestException(field)
      certificates += canonicalBase64(text, field)
    }
    reader.endArray()
    if (certificates.isEmpty()) throw InvalidRequestException(field)
    return certificates
  }

  /** Standard base64 in its one spelling (padded, no whitespace, no spare bits), so that the bytes are the bytes that were sent. */
  private fun canonicalBase64(text: String, field: String): ByteArray {
    val bytes =
      try {
        Base64.getDecoder().decode(text)
      } catch (failure: IllegalArgumentException) {
        throw InvalidRequestException(field)
      }
    if (bytes.isEmpty() || bytes.size > MAX_CERTIFICATE_BYTES && field == "certificate_chain") {
      throw InvalidRequestException(field)
    }
    if (Base64.getEncoder().encodeToString(bytes) != text) throw InvalidRequestException(field)
    return bytes
  }

  private fun challenge(text: String, field: String): ByteArray {
    if (!HEX_64.matches(text)) throw InvalidRequestException(field)
    return ByteArray(32) { index -> text.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
  }

  /** The key to enrol, in the form the API canonicalised it to: 91 bytes, P-256, uncompressed, a point the crypto stack accepts. */
  private fun devicePublicKey(text: String, field: String): ByteArray {
    if (text.length != 124) throw InvalidRequestException(field)
    val der = canonicalBase64(text, field)
    if (der.size != 91 || !der.copyOfRange(0, P256_SPKI_PREFIX.size).contentEquals(P256_SPKI_PREFIX)) {
      throw InvalidRequestException(field)
    }
    val parsed =
      try {
        KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der))
      } catch (failure: Exception) {
        throw InvalidRequestException(field)
      }
    if (!parsed.encoded.contentEquals(der)) throw InvalidRequestException(field)
    return der
  }
}
