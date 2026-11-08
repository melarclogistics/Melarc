package com.melarc.attestation

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.URI
import java.time.Duration
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test

/**
 * Google's revocation list as the verifier reads it (SECURITY_DESIGN.md 15.2.2: a fetched list replaces the held one only if it parses,
 * validates against its schema and is non-empty). **Break caught:** a list read loosely, a partial list held, an entry treated as revoked
 * only when its status says so, a redirect followed, a body read past its ceiling.
 */
class RevocationListTest {
  private fun list(body: String) = parseRevocationList(body.toByteArray(Charsets.UTF_8))

  private fun refused(body: String, message: String? = null) {
    val failure = assertFailsWith<TrustDataException>("accepted: $body") { list(body) }
    if (message != null) assertEquals(message, failure.message)
  }

  @Test
  fun `a list is the serial numbers of its entries, whatever their status`() {
    val parsed =
      list(
        """{"entries":{"2c8cd30bf7da9c1b":{"status":"REVOKED","reason":"KEY_COMPROMISE","comment":"x"},"AB0":{"status":"SUSPENDED"},"c8":{"status":"EXPIRED"}}}"""
      )
    assertEquals(3, parsed.entries)
    // Every entry is on the list: an entry that Google has suspended is on it, and the design says no certificate on the list.
    assertEquals(setOf("2c8cd30bf7da9c1b", "ab0", "c8"), parsed.serials)
  }

  @Test
  fun `serial numbers are compared in the form the library compares them`() {
    assertEquals("ab", normalisedSerial("000AB"))
    assertEquals("0", normalisedSerial("00"))
    assertEquals("0", normalisedSerial("0"))
    assertEquals("f92009e853b6b045", normalisedSerial("F92009E853B6B045"))
    for (bad in listOf("", "xyz", "12 3", "-1", "0x12", "ab".repeat(33))) assertNull(normalisedSerial(bad), "accepted: $bad")
    assertEquals("ab".repeat(32), normalisedSerial("ab".repeat(32)))
  }

  @Test
  fun `other members of the document are not read`() {
    val parsed = list("""{"generated":{"at":1},"entries":{"1":{"status":"REVOKED"}},"notes":[1,2,{"a":null}]}""")
    assertEquals(setOf("1"), parsed.serials)
  }

  @Test
  fun `a list with no entry is not a list`() {
    refused("""{"entries":{}}""", "The revocation list is empty")
    refused("""{}""", "The revocation list names no entries")
    refused("""{"other":{"1":{"status":"REVOKED"}}}""", "The revocation list names no entries")
  }

  @Test
  fun `a document of another shape is refused whole`() {
    refused("""["1"]""")
    refused("""{"entries":[]}""")
    refused("""{"entries":{"1":"REVOKED"}}""")
    refused("""{"entries":{"1":{"status":7}}}""", "A status is not text")
    refused("""{"entries":{"1":{"status":""}}}""", "An entry of the revocation list has no status")
    refused("""{"entries":{"1":{}}}""", "An entry of the revocation list has no status")
    refused("""{"entries":{"1":{"status":null}}}""")
    refused("""{"entries":{"zz":{"status":"REVOKED"}}}""", "A serial number of the revocation list is not hexadecimal")
    refused("""{"entries":{"":{"status":"REVOKED"}}}""", "A serial number of the revocation list is not hexadecimal")
    refused("""{"entries":{"1":{"status":"REVOKED"}},"entries":{"2":{"status":"REVOKED"}}}""", "The revocation list names its entries twice")
  }

  @Test
  fun `a document that does not parse strictly is refused, never held in part`() {
    refused("")
    refused("""{"entries":{"1":{"status":"REVOKED"}""")
    refused("""{"entries":{"1":{"status":"REVOKED"}}} {}""")
    refused("""{"entries":{"1":{"status":"REVOKED"}}}x""")
    refused("""{entries:{"1":{"status":"REVOKED"}}}""")
    refused("""{'entries':{'1':{'status':'REVOKED'}}}""")
    refused("""{"entries":{"1":{"status":"REVOKED"}},}""")
    refused("""{"entries":{"1":{"status":"REVOKED"}}}""" + "\u0000")
  }

  @Test
  fun `a repeated serial is one serial`() {
    val parsed = list("""{"entries":{"AB":{"status":"REVOKED"},"ab":{"status":"SUSPENDED"}}}""")
    assertEquals(2, parsed.entries)
    assertEquals(setOf("ab"), parsed.serials)
  }

  // ---- the fetch ----------------------------------------------------------------------------------------------------------------

  private var server: HttpServer? = null

  @AfterEach
  fun stop() {
    server?.stop(0)
  }

  private fun serve(handler: (HttpExchange) -> Unit): URI {
    val created = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    created.createContext("/") { exchange ->
      try {
        handler(exchange)
      } finally {
        exchange.close()
      }
    }
    created.start()
    server = created
    return URI.create("http://127.0.0.1:${created.address.port}/status")
  }

  private fun respond(exchange: HttpExchange, status: Int, body: ByteArray, headers: Map<String, String> = emptyMap()) {
    headers.forEach { (name, value) -> exchange.responseHeaders.add(name, value) }
    exchange.sendResponseHeaders(status, if (body.isEmpty()) -1 else body.size.toLong())
    if (body.isNotEmpty()) exchange.responseBody.use { it.write(body) }
  }

  private val valid = """{"entries":{"2c8cd30bf7da9c1b":{"status":"REVOKED"}}}"""

  private fun fetcher(url: URI, timeout: Duration = Duration.ofSeconds(5), maxBytes: Int = 4096) =
    HttpRevocationFetcher(url, timeout, maxBytes)

  @Test
  fun `a list is fetched from its one source`() {
    val url = serve { respond(it, 200, valid.toByteArray()) }
    assertEquals(setOf("2c8cd30bf7da9c1b"), fetcher(url).fetch().serials)
  }

  @Test
  fun `a status other than 200 is a failure`() {
    for (status in listOf(204, 304, 404, 500, 503)) {
      val url = serve { respond(it, status, valid.toByteArray().takeIf { status != 204 && status != 304 } ?: ByteArray(0)) }
      assertFailsWith<TrustDataException>("accepted $status") { fetcher(url).fetch() }
      server?.stop(0)
    }
  }

  @Test
  fun `a redirect is not followed`() {
    val target = serve { respond(it, 200, valid.toByteArray()) }
    val first = server
    val redirecting = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    redirecting.createContext("/") { exchange ->
      try {
        respond(exchange, 302, ByteArray(0), mapOf("Location" to target.toString()))
      } finally {
        exchange.close()
      }
    }
    redirecting.start()
    try {
      assertFailsWith<TrustDataException> { fetcher(URI.create("http://127.0.0.1:${redirecting.address.port}/status")).fetch() }
    } finally {
      redirecting.stop(0)
      first?.stop(0)
    }
  }

  @Test
  fun `a list larger than the ceiling is refused, declared or not`() {
    val big = """{"entries":{${(1..200).joinToString(",") { "\"$it\":{\"status\":\"REVOKED\"}" }}}}""".toByteArray()
    val declared = serve { respond(it, 200, big) }
    assertFailsWith<TrustDataException> { fetcher(declared, maxBytes = 1024).fetch() }
    server?.stop(0)
    // Chunked: no length is declared, so the bytes are counted as they are read.
    val chunked = serve {
      it.sendResponseHeaders(200, 0)
      it.responseBody.use { out -> out.write(big) }
    }
    assertFailsWith<TrustDataException> { fetcher(chunked, maxBytes = 1024).fetch() }
    server?.stop(0)
    val fits = serve { respond(it, 200, big) }
    assertEquals(200, fetcher(fits, maxBytes = big.size).fetch().entries)
  }

  @Test
  fun `a length the source declares beyond the ceiling is refused before a byte of the body is read`() {
    // The source promises ten mebibytes, sends a hundred bytes and then goes quiet: waiting for the rest would hold the loader until its
    // time-out, so the refusal must come from the declaration, at once, with the reason of the ceiling.
    val url = serve {
      it.sendResponseHeaders(200, 10L * 1024 * 1024)
      it.responseBody.write(ByteArray(100) { ' '.code.toByte() })
      it.responseBody.flush()
      Thread.sleep(3_000)
    }
    val started = System.nanoTime()
    val failure = assertFailsWith<TrustDataException> { fetcher(url, timeout = Duration.ofSeconds(10), maxBytes = 1024).fetch() }
    assertEquals("The revocation list is larger than the ceiling", failure.message)
    assertTrue((System.nanoTime() - started) / 1_000_000 < 2_500, "the fetch waited for the body")
  }

  @Test
  fun `a source that does not answer in time is a failure`() {
    val url = serve {
      Thread.sleep(2_000)
      respond(it, 200, valid.toByteArray())
    }
    val started = System.nanoTime()
    assertFailsWith<TrustDataException> { fetcher(url, timeout = Duration.ofMillis(300)).fetch() }
    assertTrue((System.nanoTime() - started) / 1_000_000 < 1_800, "the fetch waited for the slow source")
  }

  @Test
  fun `a source that is not there is a failure`() {
    val url = serve { respond(it, 200, valid.toByteArray()) }
    server?.stop(0)
    assertFailsWith<TrustDataException> { fetcher(url, timeout = Duration.ofSeconds(1)).fetch() }
  }

  @Test
  fun `a body that is not the list is a failure, not a partial list`() {
    for (body in listOf("<html>", "{}", """{"entries":{}}""", """{"entries":{"1":{"status":"REVOKED"}""")) {
      val url = serve { respond(it, 200, body.toByteArray()) }
      assertFailsWith<TrustDataException>("accepted: $body") { fetcher(url).fetch() }
      server?.stop(0)
    }
  }
}
