package com.melarc.attestation

import com.google.gson.JsonParser
import com.melarc.attestation.fixtures.AttestationFixtures
import com.melarc.attestation.fixtures.FixtureWorld
import com.melarc.attestation.fixtures.hex
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test

/**
 * The process, as it is started: it refuses a configuration that is wrong with a non-zero exit and a log line that names settings and no
 * value, and one that is right loads its trust data in the background and serves. **Break caught:** a verifier that starts on a wrong
 * configuration, a start that waits for the network, a log that names a secret.
 */
class MainProcessTest {
  private val java: String = Path.of(System.getProperty("java.home"), "bin", "java").toString()
  private val classpath: String = System.getProperty("java.class.path")

  private fun launch(directory: Path, environment: Map<String, String>): Process {
    val builder = ProcessBuilder(java, "-Xmx128m", "-cp", classpath, "com.melarc.attestation.MainKt")
    builder.environment().clear()
    // Nothing of the developer's environment reaches the process, but Windows cannot open a socket without its system root.
    System.getenv("SystemRoot")?.let { builder.environment()["SystemRoot"] = it }
    builder.environment().putAll(environment)
    builder.redirectErrorStream(true)
    builder.redirectOutput(directory.resolve("verifier.log").toFile())
    return builder.start()
  }

  private fun freePort(): Int = ServerSocket(0).use { it.localPort }

  private val created = mutableListOf<Path>()

  /** A folder of the test's own, removed at the end as well as it can be: on Windows a process that has just ended may hold its log a moment longer, and that is no failure of the test. */
  private fun scratch(): Path = Files.createTempDirectory("melarc-verifier-process-").also { created.add(it) }

  @AfterEach
  fun cleanUp() {
    for (directory in created) {
      var attempts = 0
      while (!directory.toFile().deleteRecursively() && ++attempts < 30) Thread.sleep(100)
    }
    created.clear()
  }

  /** Ends the process and waits until it is gone, so that nothing of it holds a file. */
  private fun end(process: Process) {
    process.destroy()
    if (!process.waitFor(15, TimeUnit.SECONDS)) {
      process.destroyForcibly()
      process.waitFor(15, TimeUnit.SECONDS)
    }
  }

  @Test
  fun `a wrong configuration ends the process with a message that names settings and no value`() {
    val directory = scratch()
    val leak = "SECRET-LEAK-123"
    val process = launch(directory, mapOf("VERIFIER_CALLER_SECRET" to leak, "VERIFIER_PORT" to "0", "VERIFIER_PACKAGE_NAME" to "x"))
    assertTrue(process.waitFor(60, TimeUnit.SECONDS), "the process did not end")
    assertEquals(2, process.exitValue())
    val log = directory.resolve("verifier.log").readText()
    assertFalse(leak in log, "the log names the secret")
    val events = log.lines().filter { it.isNotBlank() }.map { JsonParser.parseString(it).asJsonObject }
    assertTrue(events.all { it["event"].asString == "configuration_refused" }, log)
    assertEquals(
      setOf("VERIFIER_PORT", "VERIFIER_CALLER_SECRET", "VERIFIER_PACKAGE_NAME", "VERIFIER_SIGNING_DIGESTS", "VERIFIER_ACCEPTED_ROOTS_FILE"),
      events.map { it["key"].asString }.toSet(),
    )
    assertFalse("\"x\"" in log, "the log names a value")
  }

  @Test
  fun `production refuses to start without its release inputs, its caller secret and an explicit maximum age`() {
    val directory = scratch()
    val process = launch(directory, mapOf("VERIFIER_ENVIRONMENT" to "production"))
    assertTrue(process.waitFor(60, TimeUnit.SECONDS), "the process did not end")
    assertEquals(2, process.exitValue())
    val events = directory.resolve("verifier.log").readText().lines().filter { it.isNotBlank() }.map { JsonParser.parseString(it).asJsonObject }
    // The accepted roots, the package, the signing digests, the caller's secret and the maximum age: AC-SLICE-000-55 for the verifier.
    assertEquals(
      setOf(
        "VERIFIER_CALLER_SECRET",
        "VERIFIER_PACKAGE_NAME",
        "VERIFIER_SIGNING_DIGESTS",
        "VERIFIER_ACCEPTED_ROOTS_FILE",
        "VERIFIER_TRUST_DATA_MAX_AGE_HOURS",
      ),
      events.map { it["key"].asString }.toSet(),
    )
    assertTrue(events.all { it["event"].asString == "configuration_refused" })
  }

  @Test
  fun `production refuses a maximum age that does not outlive the refresh, and a debug signer`() {
    val directory = scratch()
    val roots = directory.resolve("roots.json")
    roots.writeText(FixtureWorld.acceptedRootsJson())
    val process =
      launch(
        directory,
        mapOf(
          "VERIFIER_ENVIRONMENT" to "production",
          "VERIFIER_CALLER_SECRET" to "Q" + "A".repeat(42),
          "VERIFIER_PACKAGE_NAME" to FixtureWorld.PACKAGE,
          "VERIFIER_SIGNING_DIGESTS" to FixtureWorld.SIGNER_1.hex(),
          "VERIFIER_DEBUG_SIGNING_DIGESTS" to FixtureWorld.SIGNER_2.hex(),
          "VERIFIER_ACCEPTED_ROOTS_FILE" to roots.toString(),
          "VERIFIER_TRUST_DATA_MAX_AGE_HOURS" to "6",
        ),
      )
    assertTrue(process.waitFor(60, TimeUnit.SECONDS), "the process did not end")
    assertEquals(2, process.exitValue())
    val keys = directory.resolve("verifier.log").readText().lines().filter { it.isNotBlank() }.map { JsonParser.parseString(it).asJsonObject["key"].asString }
    assertEquals(listOf("VERIFIER_DEBUG_SIGNING_DIGESTS", "VERIFIER_TRUST_DATA_MAX_AGE_HOURS"), keys.sorted())
  }

  @Test
  fun `a right configuration serves, loads its trust data in the background, and answers a verification`() {
    val directory = scratch()
    val list = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    list.createContext("/status") { exchange ->
      val body = """{"entries":{"1d3c5a7e9f":{"status":"REVOKED"}}}""".toByteArray()
      exchange.sendResponseHeaders(200, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }
    list.start()
    val roots = directory.resolve("roots.json")
    roots.writeText(FixtureWorld.acceptedRootsJson())
    val port = freePort()
    val secret = "Q" + "A".repeat(42)
    val process =
      launch(
        directory,
        mapOf(
          "VERIFIER_PORT" to port.toString(),
          "VERIFIER_CALLER_SECRET" to secret,
          "VERIFIER_PACKAGE_NAME" to FixtureWorld.PACKAGE,
          "VERIFIER_SIGNING_DIGESTS" to FixtureWorld.SIGNER_1.hex(),
          "VERIFIER_ACCEPTED_ROOTS_FILE" to roots.toString(),
          "VERIFIER_REVOCATION_URL" to "http://127.0.0.1:${list.address.port}/status",
        ),
      )
    try {
      val client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()
      val auth = "Bearer $secret"
      fun get(path: String) =
        client.send(
          HttpRequest.newBuilder(URI.create("http://127.0.0.1:$port$path")).header("Authorization", auth).timeout(Duration.ofSeconds(5)).GET().build(),
          HttpResponse.BodyHandlers.ofString(),
        )
      // The process listens at once; its trust data loads in the background, and is ready within moments.
      var state = ""
      val until = System.nanoTime() + 60_000_000_000L
      while (System.nanoTime() < until && state != "READY") {
        state = runCatching { JsonParser.parseString(get("/v1/status").body()).asJsonObject["state"].asString }.getOrDefault("")
        if (state != "READY") Thread.sleep(200)
      }
      assertEquals("READY", state, directory.resolve("verifier.log").readText())

      val case = AttestationFixtures.named("valid_trusted_environment")
      val request = case.request()
      val chain = request.chain.joinToString(",", "[", "]") { "\"${Base64.getEncoder().encodeToString(it)}\"" }
      val body =
        """{"version":1,"certificate_chain":$chain,"expected_challenge_sha256":"${request.expectedChallengeSha256.hex()}","device_public_key":"${Base64.getEncoder().encodeToString(request.devicePublicKey)}"}"""
      val answer =
        client.send(
          HttpRequest.newBuilder(URI.create("http://127.0.0.1:$port/v1/verify"))
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build(),
          HttpResponse.BodyHandlers.ofString(),
        )
      assertEquals(200, answer.statusCode(), answer.body())
      assertEquals("VERIFIED", JsonParser.parseString(answer.body()).asJsonObject["verdict"].asString)

      val log = directory.resolve("verifier.log").readText()
      assertFalse(secret in log, "the log names the secret")
      assertTrue("\"event\":\"listening\"" in log)
    } finally {
      end(process)
      list.stop(0)
    }
  }

  @Test
  fun `a verifier whose revocation source is down serves nothing it cannot judge`() {
    val directory = scratch()
    val roots = directory.resolve("roots.json")
    roots.writeText(FixtureWorld.acceptedRootsJson())
    val port = freePort()
    val dead = freePort()
    val process =
      launch(
        directory,
        mapOf(
          "VERIFIER_PORT" to port.toString(),
          "VERIFIER_PACKAGE_NAME" to FixtureWorld.PACKAGE,
          "VERIFIER_SIGNING_DIGESTS" to FixtureWorld.SIGNER_1.hex(),
          "VERIFIER_ACCEPTED_ROOTS_FILE" to roots.toString(),
          "VERIFIER_REVOCATION_URL" to "http://127.0.0.1:$dead/status",
          "VERIFIER_FETCH_TIMEOUT_MS" to "500",
        ),
      )
    try {
      val client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()
      val case = AttestationFixtures.named("valid_trusted_environment")
      val request = case.request()
      val chain = request.chain.joinToString(",", "[", "]") { "\"${Base64.getEncoder().encodeToString(it)}\"" }
      val body =
        """{"version":1,"certificate_chain":$chain,"expected_challenge_sha256":"${request.expectedChallengeSha256.hex()}","device_public_key":"${Base64.getEncoder().encodeToString(request.devicePublicKey)}"}"""
      var verdict = ""
      val until = System.nanoTime() + 30_000_000_000L
      while (System.nanoTime() < until && verdict.isEmpty()) {
        verdict =
          runCatching {
              val answer =
                client.send(
                  HttpRequest.newBuilder(URI.create("http://127.0.0.1:$port/v1/verify"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build(),
                  HttpResponse.BodyHandlers.ofString(),
                )
              JsonParser.parseString(answer.body()).asJsonObject.let { it["verdict"].asString + "/" + it["cause"].asString }
            }
            .getOrDefault("")
        if (verdict.isEmpty()) Thread.sleep(200)
      }
      assertEquals("TRUST_DATA_UNAVAILABLE/TRUST_DATA_NOT_LOADED", verdict, directory.resolve("verifier.log").readText())
    } finally {
      end(process)
    }
  }
}
