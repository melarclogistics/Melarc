package com.melarc.attestation

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.melarc.attestation.fixtures.AttestationFixtures
import com.melarc.attestation.fixtures.FixtureCase
import com.melarc.attestation.fixtures.FixtureWorld
import com.melarc.attestation.fixtures.hex
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import java.security.cert.TrustAnchor
import java.time.Duration
import java.time.Instant
import java.time.InstantSource
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test

/**
 * The private verifier service over HTTP (SECURITY_DESIGN.md 15.2.3), against the real policy and the chains of [AttestationFixtures]:
 * what each status means, what is refused before its body is read, what is bounded, and what the log and the metrics never carry.
 * **Break caught:** a verdict relabelled by the transport, an unauthenticated read, a body read past its ceiling, a permit that leaks, a
 * verification that blocks the next, a secret or a certificate in the log.
 */
class VerifierServerTest {
  private class MutableClock(var now: Instant) : InstantSource {
    override fun instant(): Instant = now
  }

  private class Running(
    val server: VerifierServer,
    val trust: TrustData,
    val metrics: Metrics,
    val log: ByteArrayOutputStream,
    val clock: MutableClock,
    val scheduler: ScheduledThreadPoolExecutor,
  ) : AutoCloseable {
    val base: String
      get() = "http://127.0.0.1:${server.port}"

    fun logText(): String = log.toString(Charsets.UTF_8)

    override fun close() {
      server.close()
      trust.close()
      scheduler.shutdownNow()
    }
  }

  private val running = mutableListOf<Running>()
  private val client: HttpClient = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).build()

  @AfterEach
  fun stop() {
    running.forEach { it.close() }
    running.clear()
  }

  private val secret = "Q" + "A".repeat(42)

  private fun config(
    callerSecret: String? = null,
    maxConcurrent: Int = 4,
    deadline: Duration = Duration.ofSeconds(5),
    maxRequestBytes: Int = 65_536,
  ) =
    VerifierConfig(
      environment = VerifierEnvironment.LOCAL,
      bindAddress = "127.0.0.1",
      port = 0,
      callerSecret = callerSecret,
      packageName = FixtureWorld.PACKAGE,
      signingDigests = FixtureWorld.APPROVED_DIGESTS,
      acceptedRootsFile = Path.of("unused"),
      revocationUrl = URI.create("https://example.org/status"),
      fetchTimeout = Duration.ofSeconds(1),
      revocationMaxBytes = 1024 * 1024,
      refreshInterval = Duration.ofHours(6),
      retryInterval = Duration.ofMinutes(15),
      maxAge = Duration.ofHours(24),
      maxRequestBytes = maxRequestBytes,
      maxConcurrent = maxConcurrent,
      deadline = deadline,
    )

  private fun start(
    policy: VerdictPolicy? = null,
    callerSecret: String? = null,
    maxConcurrent: Int = 4,
    deadline: Duration = Duration.ofSeconds(5),
    maxRequestBytes: Int = 65_536,
    loadRoots: Boolean = true,
    loadList: Boolean = true,
    revoked: Set<String> = emptySet(),
  ): Running {
    val clock = MutableClock(FixtureWorld.INSTANT)
    val metrics = Metrics()
    val log = ByteArrayOutputStream()
    val structured = StructuredLog(PrintStream(log, true, Charsets.UTF_8), clock)
    val scheduler = ScheduledThreadPoolExecutor(1) { task -> Thread(task).apply { isDaemon = true } }
    val roots =
      object : RootsSource {
        override fun load(): Set<TrustAnchor> = if (loadRoots) FixtureWorld.anchors() else throw TrustDataException("no roots")

        override fun version(): Long? = 1
      }
    val fetcher =
      RevocationFetcher { if (loadList) RevocationList(1 + revoked.size, revoked + FixtureWorld.DECOY_SERIAL) else throw TrustDataException("down") }
    val trust = TrustData(clock, Duration.ofHours(24), Duration.ofHours(6), Duration.ofMinutes(15), roots, fetcher, metrics, structured, scheduler)
    trust.loadAll()
    val verifying = policy ?: PolicyVerifier(PolicyVerifier.Policy(FixtureWorld.PACKAGE, FixtureWorld.APPROVED_DIGESTS), clock, metrics, structured)
    val server = VerifierServer(config(callerSecret, maxConcurrent, deadline, maxRequestBytes), trust, verifying, metrics, structured, clock)
    server.start()
    return Running(server, trust, metrics, log, clock, scheduler).also { running += it }
  }

  // ---- requests -----------------------------------------------------------------------------------------------------------------

  private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

  private fun bodyOf(case: FixtureCase): String {
    val request = case.request()
    val chain = request.chain.joinToString(",", "[", "]") { "\"${b64(it)}\"" }
    return """{"version":1,"certificate_chain":$chain,"expected_challenge_sha256":"${request.expectedChallengeSha256.hex()}","device_public_key":"${b64(request.devicePublicKey)}"}"""
  }

  private class Answer(val status: Int, val body: String, val headers: Map<String, List<String>>) {
    val json: JsonObject by lazy { JsonParser.parseString(body).asJsonObject }

    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value?.firstOrNull()
  }

  private fun send(
    running: Running,
    method: String,
    path: String,
    body: String? = null,
    headers: Map<String, String> = mapOf("Content-Type" to "application/json"),
    bytes: ByteArray? = null,
  ): Answer {
    val publisher =
      when {
        bytes != null -> HttpRequest.BodyPublishers.ofByteArray(bytes)
        body != null -> HttpRequest.BodyPublishers.ofString(body)
        else -> HttpRequest.BodyPublishers.noBody()
      }
    val builder = HttpRequest.newBuilder(URI.create(running.base + path)).timeout(Duration.ofSeconds(20)).method(method, publisher)
    headers.forEach { (name, value) -> builder.header(name, value) }
    val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    return Answer(response.statusCode(), response.body(), response.headers().map())
  }

  private fun verify(running: Running, case: FixtureCase, headers: Map<String, String> = mapOf("Content-Type" to "application/json")) =
    send(running, "POST", "/v1/verify", bodyOf(case), headers)

  // ---- the verdict, and what carries it -------------------------------------------------------------------------------------

  @Test
  fun `a chain that is accepted is a 200 with the verdict, the attested key and a summary that identifies no handset`() {
    val case = AttestationFixtures.named("valid_trusted_environment")
    val answer = verify(start(), case)
    assertEquals(200, answer.status)
    assertEquals("VERIFIED", answer.json["verdict"].asString)
    assertEquals(1, answer.json["version"].asInt)
    assertEquals(b64(case.devicePublicKey), answer.json["attested_public_key"].asString)
    val summary = answer.json["summary"].asJsonObject
    assertEquals("TRUSTED_ENVIRONMENT", summary["security_level"].asString)
    assertEquals(FixtureWorld.PACKAGE, summary["package_name"].asString)
    assertEquals(listOf(FixtureWorld.SIGNER_1.hex()), summary["signer_digests"].asJsonArray.map { it.asString })
    assertEquals(setOf("version", "verdict", "attested_public_key", "summary"), answer.json.keySet())
    assertEquals(setOf("security_level", "attestation_version", "key_mint_version", "package_name", "signer_digests"), summary.keySet())
  }

  @Test
  fun `a chain that is refused is a 200 with the verdict and its closed cause, never relabelled`() {
    val case = AttestationFixtures.named("device_unlocked")
    val answer = verify(start(), case)
    assertEquals(200, answer.status)
    assertEquals("DEVICE_INTEGRITY_FAILED", answer.json["verdict"].asString)
    assertEquals("DEVICE_NOT_LOCKED", answer.json["cause"].asString)
    assertEquals(setOf("version", "verdict", "cause"), answer.json.keySet())
    val software = verify(start(), AttestationFixtures.named("software_both"))
    assertEquals(200, software.status)
    assertEquals("DEVICE_SECURITY_UNSUPPORTED", software.json["verdict"].asString)
    assertEquals(setOf("version", "verdict"), software.json.keySet())
  }

  @Test
  fun `every answer is not cached, not sniffed and typed`() {
    val running = start()
    val answers =
      listOf(
        verify(running, AttestationFixtures.named("valid_trusted_environment")),
        send(running, "GET", "/v1/status"),
        send(running, "GET", "/v1/metrics"),
        send(running, "GET", "/nothing-here"),
        send(running, "GET", "/v1/verify"),
      )
    for (answer in answers) {
      assertEquals("no-store", answer.header("Cache-Control"))
      assertEquals("nosniff", answer.header("X-Content-Type-Options"))
    }
    assertEquals("application/json; charset=utf-8", answers[0].header("Content-Type"))
    assertEquals("text/plain; version=0.0.4; charset=utf-8", answers[2].header("Content-Type"))
  }

  @Test
  fun `a request id is echoed when it is well formed and replaced when it is not`() {
    val running = start()
    val case = AttestationFixtures.named("valid_trusted_environment")
    val kept = verify(running, case, mapOf("Content-Type" to "application/json", "X-Request-Id" to "req-123.abc_DEF"))
    assertEquals("req-123.abc_DEF", kept.header("X-Request-Id"))
    for (bad in listOf("a b", "x".repeat(65), "été", "a;b")) {
      val answer = verify(running, case, mapOf("Content-Type" to "application/json", "X-Request-Id" to bad))
      assertNotEquals(bad, answer.header("X-Request-Id"))
      assertTrue(Regex("^[0-9a-f]{16}$").matches(answer.header("X-Request-Id").orEmpty()), "generated: ${answer.header("X-Request-Id")}")
    }
  }

  // ---- what is refused before the body is read ---------------------------------------------------------------------------------

  @Test
  fun `a request without the caller's secret is a 401 before its body is read`() {
    val running = start(callerSecret = secret)
    val case = AttestationFixtures.named("valid_trusted_environment")
    for (headers in
      listOf(
        mapOf("Content-Type" to "application/json"),
        mapOf("Content-Type" to "application/json", "Authorization" to "Bearer ${secret.dropLast(1)}R"),
        mapOf("Content-Type" to "application/json", "Authorization" to secret),
        mapOf("Content-Type" to "application/json", "Authorization" to "bearer $secret"),
        mapOf("Content-Type" to "application/json", "Authorization" to "Bearer  $secret"),
        mapOf("Content-Type" to "application/json", "Authorization" to "Basic $secret"),
      )) {
      val answer = verify(running, case, headers)
      assertEquals(401, answer.status, headers.toString())
      assertEquals("Bearer", answer.header("WWW-Authenticate"))
      assertEquals("UNAUTHENTICATED", answer.json["error"].asString)
      assertFalse(secret in answer.body)
    }
    // Garbage in a body that would be a 400 is still a 401 without the secret: the body is not read first.
    assertEquals(401, send(running, "POST", "/v1/verify", "{not json").status)
    assertEquals(400, send(running, "POST", "/v1/verify", "{not json", mapOf("Content-Type" to "application/json", "Authorization" to "Bearer $secret")).status)
    assertEquals(200, verify(running, case, mapOf("Content-Type" to "application/json", "Authorization" to "Bearer $secret")).status)
  }

  @Test
  fun `the status and metrics are as private as the verification`() {
    val running = start(callerSecret = secret)
    for (path in listOf("/v1/status", "/v1/metrics")) {
      assertEquals(401, send(running, "GET", path).status)
      assertEquals(200, send(running, "GET", path, headers = mapOf("Authorization" to "Bearer $secret")).status)
    }
  }

  @Test
  fun `the wrong method and the wrong media type are refused`() {
    val running = start()
    val case = AttestationFixtures.named("valid_trusted_environment")
    assertEquals(405, send(running, "GET", "/v1/verify").status)
    assertEquals(405, send(running, "PUT", "/v1/verify", bodyOf(case)).status)
    assertEquals(405, send(running, "POST", "/v1/status", "{}").status)
    assertEquals(405, send(running, "POST", "/v1/metrics", "{}").status)
    assertEquals(404, send(running, "GET", "/").status)
    assertEquals(404, send(running, "POST", "/v1/verifyx", bodyOf(case)).status)
    for (type in listOf("text/plain", "application/x-www-form-urlencoded", "application/jsonp")) {
      assertEquals(415, send(running, "POST", "/v1/verify", bodyOf(case), mapOf("Content-Type" to type)).status, type)
    }
    assertEquals(415, send(running, "POST", "/v1/verify", bodyOf(case), emptyMap()).status)
    assertEquals(200, send(running, "POST", "/v1/verify", bodyOf(case), mapOf("Content-Type" to "Application/JSON; charset=utf-8")).status)
  }

  @Test
  fun `a body larger than the ceiling is a 413, declared or not`() {
    val running = start(maxRequestBytes = 2048)
    val big = ByteArray(5000) { ' '.code.toByte() }
    assertEquals(413, send(running, "POST", "/v1/verify", bytes = big, headers = mapOf("Content-Type" to "application/json")).status)
    // Chunked: nothing is declared, so the bytes are counted as they arrive.
    val chunked =
      client.send(
        HttpRequest.newBuilder(URI.create(running.base + "/v1/verify"))
          .header("Content-Type", "application/json")
          .POST(HttpRequest.BodyPublishers.fromPublisher(HttpRequest.BodyPublishers.ofByteArray(big)))
          .build(),
        HttpResponse.BodyHandlers.ofString(),
      )
    assertEquals(413, chunked.statusCode())
    assertEquals("REQUEST_TOO_LARGE", JsonParser.parseString(chunked.body()).asJsonObject["error"].asString)
  }

  @Test
  fun `a request that cannot be read is a 400 that names a field and no value`() {
    val running = start()
    val leak = "leak-me-" + "z".repeat(30)
    for (body in listOf("{not json", "{}", """{"version":1,"$leak":1}""", """{"version":"$leak"}""", "[]", "")) {
      val answer = send(running, "POST", "/v1/verify", body)
      assertEquals(400, answer.status, body)
      assertEquals("INVALID_REQUEST", answer.json["error"].asString)
      assertFalse(leak in answer.body)
      assertFalse(leak in running.logText(), "the log holds a value of the request")
    }
    assertEquals("unknown_member", send(running, "POST", "/v1/verify", """{"version":1,"$leak":1}""").json["field"].asString)
  }

  // ---- trust data comes first -------------------------------------------------------------------------------------------------

  @Test
  fun `before the trust data is loaded the answer is its own verdict, and nothing was judged`() {
    val case = AttestationFixtures.named("valid_trusted_environment")
    val cases =
      listOf(
        "TRUST_DATA_NOT_LOADED" to start(loadList = false),
        "TRUST_ROOTS_UNLOADABLE" to start(loadRoots = false),
      )
    for ((cause, running) in cases) {
      val answer = verify(running, case)
      assertEquals(200, answer.status)
      assertEquals("TRUST_DATA_UNAVAILABLE", answer.json["verdict"].asString)
      assertEquals(cause, answer.json["cause"].asString)
      assertEquals(1, running.metrics.count("attestation_verifier_unavailable_total", cause))
    }
  }

  @Test
  fun `a list older than the maximum age is no list, even for a chain that is valid`() {
    val running = start()
    val case = AttestationFixtures.named("valid_trusted_environment")
    assertEquals("VERIFIED", verify(running, case).json["verdict"].asString)
    running.clock.now = FixtureWorld.INSTANT.plus(Duration.ofHours(24)).plusSeconds(1)
    val answer = verify(running, case)
    assertEquals(200, answer.status)
    assertEquals("TRUST_DATA_UNAVAILABLE", answer.json["verdict"].asString)
    assertEquals("TRUST_DATA_STALE", answer.json["cause"].asString)
    assertEquals("STALE", send(running, "GET", "/v1/status").json["state"].asString)
  }

  @Test
  fun `a certificate on the list the instance holds is revoked`() {
    val case = AttestationFixtures.named("intermediate_revoked")
    val running = start(revoked = case.revokedSerials)
    assertEquals("CERTIFICATE_REVOKED", verify(running, case).json["cause"].asString)
  }

  // ---- bounds -----------------------------------------------------------------------------------------------------------------

  private class Gate : VerdictPolicy {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val calls = java.util.concurrent.atomic.AtomicInteger()

    override fun verify(request: VerifyRequest, trust: TrustState.Fresh): Verdict {
      calls.incrementAndGet()
      entered.countDown()
      release.await(10, TimeUnit.SECONDS)
      return Verdict.IntegrityFailed(IntegrityCause.KEY_MISMATCH)
    }
  }

  @Test
  fun `beyond the concurrency limit the next request is answered at once as overloaded, and costs nothing`() {
    val gate = Gate()
    val running = start(policy = gate, maxConcurrent = 1)
    val case = AttestationFixtures.named("valid_trusted_environment")
    val pool = Executors.newSingleThreadExecutor()
    try {
      val first = pool.submit<Answer> { verify(running, case) }
      assertTrue(gate.entered.await(10, TimeUnit.SECONDS))
      val started = System.nanoTime()
      val second = verify(running, case)
      assertTrue((System.nanoTime() - started) / 1_000_000 < 2_000, "the refusal waited")
      assertEquals(503, second.status)
      assertEquals("TRUST_DATA_UNAVAILABLE", second.json["verdict"].asString)
      assertEquals("VERIFIER_OVERLOADED", second.json["cause"].asString)
      assertEquals(1, gate.calls.get(), "the refused request was never verified")
      assertEquals(1, running.metrics.count("attestation_verifier_unavailable_total", "VERIFIER_OVERLOADED"))
      assertEquals("1", send(running, "GET", "/v1/status").json["in_flight"].asString)
      gate.release.countDown()
      assertEquals(200, first.get(10, TimeUnit.SECONDS).status)
      // The permit is back: the next request is verified.
      assertEquals(200, verify(running, case).status)
    } finally {
      gate.release.countDown()
      pool.shutdownNow()
    }
  }

  @Test
  fun `a verification that misses its deadline is a 503, and a stuck one keeps its place until it ends`() {
    val stuck = AtomicBoolean(true)
    val entered = CountDownLatch(1)
    val policy =
      VerdictPolicy { _, _ ->
        entered.countDown()
        // Ignores interrupts, as a verification stuck in native code would.
        while (stuck.get()) {
          try {
            Thread.sleep(10)
          } catch (ignored: InterruptedException) {
          }
        }
        Verdict.SecurityUnsupported
      }
    val running = start(policy = policy, maxConcurrent = 1, deadline = Duration.ofMillis(300))
    val case = AttestationFixtures.named("valid_trusted_environment")
    try {
      val late = verify(running, case)
      assertEquals(503, late.status)
      assertEquals("VERIFIER_TIMEOUT", late.json["cause"].asString)
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      // The worker is still running: the permit is held, so the next request is overloaded, not queued behind it.
      val next = verify(running, case)
      assertEquals(503, next.status)
      assertEquals("VERIFIER_OVERLOADED", next.json["cause"].asString)
      stuck.set(false)
      var answer = verify(running, case)
      val until = System.nanoTime() + 5_000_000_000L
      while (answer.status == 503 && System.nanoTime() < until) {
        Thread.sleep(50)
        answer = verify(running, case)
      }
      assertEquals(200, answer.status)
      assertEquals("DEVICE_SECURITY_UNSUPPORTED", answer.json["verdict"].asString)
    } finally {
      stuck.set(false)
    }
  }

  @Test
  fun `an unexpected failure of the policy is a 500 with no detail, and releases the permit`() {
    val calls = java.util.concurrent.atomic.AtomicInteger()
    val policy =
      VerdictPolicy { _, _ ->
        if (calls.incrementAndGet() == 1) throw IllegalStateException("secret detail of the defect") else Verdict.SecurityUnsupported
      }
    val running = start(policy = policy, maxConcurrent = 1)
    val case = AttestationFixtures.named("valid_trusted_environment")
    val failed = verify(running, case)
    assertEquals(500, failed.status)
    assertEquals("INTERNAL", failed.json["error"].asString)
    assertFalse("secret detail" in failed.body)
    assertFalse("secret detail" in running.logText(), "the log carries the class of the failure, not its message")
    assertTrue(running.logText().contains("IllegalStateException") || running.logText().contains("ExecutionException"))
    assertEquals(200, verify(running, case).status, "the permit leaked")
  }

  @Test
  fun `verifications that run at once do not disturb each other`() {
    val running = start(maxConcurrent = 16)
    val names =
      listOf("valid_trusted_environment", "valid_remotely_provisioned", "device_unlocked", "challenge_other", "signature_of_leaf_broken", "unknown_root", "software_both", "key_imported")
    val pool = Executors.newFixedThreadPool(12)
    try {
      val futures = (0 until 64).map { index -> AttestationFixtures.named(names[index % names.size]).let { case -> case to pool.submit<Answer> { verify(running, case) } } }
      for ((case, future) in futures) {
        val answer = future.get(60, TimeUnit.SECONDS)
        assertEquals(200, answer.status, case.name)
        val expected = case.expected
        when (expected) {
          is com.melarc.attestation.fixtures.Expected.Verified -> assertEquals("VERIFIED", answer.json["verdict"].asString, case.name)
          is com.melarc.attestation.fixtures.Expected.IntegrityFailed -> {
            assertEquals("DEVICE_INTEGRITY_FAILED", answer.json["verdict"].asString, case.name)
            assertEquals(expected.cause.name, answer.json["cause"].asString, case.name)
          }
          com.melarc.attestation.fixtures.Expected.SecurityUnsupported -> assertEquals("DEVICE_SECURITY_UNSUPPORTED", answer.json["verdict"].asString, case.name)
        }
      }
    } finally {
      pool.shutdownNow()
    }
  }

  // ---- status, metrics, log ---------------------------------------------------------------------------------------------------

  @Test
  fun `the status says whether the instance can verify`() {
    val ready = start()
    val status = send(ready, "GET", "/v1/status").json
    assertEquals("READY", status["state"].asString)
    assertEquals(1, status["version"].asInt)
    assertEquals(0.0, status["trust_data_age_seconds"].asDouble)
    assertEquals("local", status["environment"].asString)
    assertEquals("NOT_LOADED", send(start(loadList = false), "GET", "/v1/status").json["state"].asString)
    assertEquals("ROOTS_UNLOADABLE", send(start(loadRoots = false), "GET", "/v1/status").json["state"].asString)
  }

  @Test
  fun `the metrics are counters of closed labels and the age of the trust data`() {
    val running = start()
    verify(running, AttestationFixtures.named("valid_trusted_environment"), mapOf("Content-Type" to "application/json", "X-Request-Id" to "label-from-the-request"))
    verify(running, AttestationFixtures.named("device_unlocked"))
    send(running, "POST", "/v1/verify", "{bad")
    running.clock.now = FixtureWorld.INSTANT.plusSeconds(120)
    val text = send(running, "GET", "/v1/metrics").body
    assertTrue("attestation_verifications_total{verdict=\"VERIFIED\"} 1" in text, text)
    assertTrue("attestation_verifications_total{verdict=\"DEVICE_INTEGRITY_FAILED\"} 1" in text, text)
    assertTrue("attestation_integrity_failures_total{cause=\"DEVICE_NOT_LOCKED\"} 1" in text, text)
    assertTrue("attestation_requests_refused_total{reason=\"invalid_request\"} 1" in text, text)
    assertTrue("attestation_trust_data_age_seconds 120.0" in text, text)
    assertTrue("# TYPE attestation_verifier_in_flight gauge" in text, text)
    assertFalse("label-from-the-request" in text, "nothing a request carries becomes a label")
  }

  @Test
  fun `the log carries classes and durations, never a certificate, a challenge, a key or the secret`() {
    val running = start(callerSecret = secret)
    val auth = mapOf("Content-Type" to "application/json", "Authorization" to "Bearer $secret")
    val names = listOf("valid_trusted_environment", "device_unlocked", "challenge_other", "software_both", "unknown_root")
    for (name in names) verify(running, AttestationFixtures.named(name), auth)
    send(running, "POST", "/v1/verify", "{bad", auth)
    send(running, "GET", "/v1/status")
    val text = running.logText()
    assertTrue(text.isNotBlank())
    val forbidden = mutableListOf(secret, FixtureWorld.BOOT_KEY.hex(), FixtureWorld.BOOT_HASH.hex(), FixtureWorld.SIGNER_1.hex())
    for (name in names) {
      val case = AttestationFixtures.named(name)
      forbidden += case.issuedChallenge.hex()
      forbidden += sha256Hex(case.issuedChallenge)
      forbidden += b64(case.devicePublicKey)
      case.chain.forEach { forbidden += b64(it).take(60) }
    }
    for (value in forbidden) assertFalse(value in text, "the log holds $value")
    // Every line is one JSON object with a closed set of fields.
    val allowed = setOf("time", "level", "event", "request_id", "verdict", "cause", "duration_ms", "status", "error", "field", "environment", "port", "authenticated", "class", "reason", "key", "expected")
    for (line in text.lines().filter { it.isNotBlank() }) {
      val fields = JsonParser.parseString(line).asJsonObject.keySet()
      assertTrue(allowed.containsAll(fields), "a field outside the closed set: $line")
    }
  }

  private fun sha256Hex(bytes: ByteArray) = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).hex()

  @Test
  fun `a server that is closed no longer answers`() {
    val running = start()
    val base = running.base
    running.close()
    val failure = runCatching { client.send(HttpRequest.newBuilder(URI.create("$base/v1/status")).GET().build(), HttpResponse.BodyHandlers.ofString()) }
    assertTrue(failure.isFailure)
    assertNull(failure.getOrNull())
  }
}
