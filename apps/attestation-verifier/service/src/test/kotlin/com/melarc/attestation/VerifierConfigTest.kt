package com.melarc.attestation

import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

/**
 * The configuration of the verifier (SECURITY_DESIGN.md 15.2.1 to 15.2.3; DEPLOYMENT_AND_ENVIRONMENTS.md 12). **Break caught:** a release
 * input given a default, a production setting that production forbids, a debug signer in production, a secret that is not 32 random bytes,
 * a message that names a value, a problem that hides behind another.
 */
class VerifierConfigTest {
  private val digest = "a".repeat(64)
  private val secret = "A".repeat(42) + "A" // 43 characters whose last one has no spare bits set

  private fun env(directory: Path, vararg overrides: Pair<String, String?>): Map<String, String> {
    val roots = directory.resolve("roots.json")
    if (!Files.exists(roots)) roots.writeText("[]")
    val base =
      mutableMapOf(
        "VERIFIER_PACKAGE_NAME" to "com.melarc.rider",
        "VERIFIER_SIGNING_DIGESTS" to digest,
        "VERIFIER_ACCEPTED_ROOTS_FILE" to roots.toString(),
      )
    for ((key, value) in overrides) if (value == null) base.remove(key) else base[key] = value
    return base
  }

  private fun problems(env: Map<String, String>): List<ConfigProblem> =
    assertFailsWith<ConfigurationException> { VerifierConfig.fromEnvironment(env) }.problems

  private fun keysOf(env: Map<String, String>): List<String> = problems(env).map { it.key }

  @Test
  fun `a local verifier needs only its release inputs and takes the design's values for the rest`(@TempDir directory: Path) {
    val config = VerifierConfig.fromEnvironment(env(directory))
    assertEquals(VerifierEnvironment.LOCAL, config.environment)
    assertEquals("127.0.0.1", config.bindAddress)
    assertEquals(8765, config.port)
    assertEquals(null, config.callerSecret)
    assertEquals("com.melarc.rider", config.packageName)
    assertEquals(setOf(digest), config.signingDigests)
    assertEquals(Duration.ofHours(6), config.refreshInterval)
    assertEquals(Duration.ofMinutes(15), config.retryInterval)
    assertEquals(Duration.ofHours(24), config.maxAge)
    assertEquals(Duration.ofSeconds(10), config.fetchTimeout)
    assertEquals("https://android.googleapis.com/attestation/status", config.revocationUrl.toString())
    assertEquals(65_536, config.maxRequestBytes)
    assertEquals(8, config.maxConcurrent)
    assertEquals(Duration.ofSeconds(5), config.deadline)
  }

  @Test
  fun `a release input has no default`(@TempDir directory: Path) {
    assertEquals(listOf("VERIFIER_PACKAGE_NAME"), keysOf(env(directory, "VERIFIER_PACKAGE_NAME" to null)))
    assertEquals(listOf("VERIFIER_SIGNING_DIGESTS"), keysOf(env(directory, "VERIFIER_SIGNING_DIGESTS" to null)))
    assertEquals(listOf("VERIFIER_ACCEPTED_ROOTS_FILE"), keysOf(env(directory, "VERIFIER_ACCEPTED_ROOTS_FILE" to null)))
    assertEquals(
      listOf("VERIFIER_PACKAGE_NAME", "VERIFIER_SIGNING_DIGESTS", "VERIFIER_ACCEPTED_ROOTS_FILE"),
      keysOf(emptyMap()),
      "every missing input is reported, not the first",
    )
    assertEquals(listOf("VERIFIER_PACKAGE_NAME"), keysOf(env(directory, "VERIFIER_PACKAGE_NAME" to "")), "empty is absent")
  }

  @Test
  fun `a message names what is wrong and never what was given`(@TempDir directory: Path) {
    val given = "zzz-given-value-zzz"
    for (key in VerifierConfig.KEYS) {
      if (key == "VERIFIER_DEBUG_SIGNING_DIGESTS" || key == "VERIFIER_REVOCATION_URL") continue
      val failure = runCatching { VerifierConfig.fromEnvironment(env(directory, key to given)) }.exceptionOrNull()
      if (failure is ConfigurationException) {
        assertFalse("zzz" in (failure.message ?: ""), "$key: the message names the value")
        assertTrue(failure.problems.none { "zzz" in it.expected || "zzz" in it.key }, "$key: a problem names the value")
      }
    }
    // The caller secret in particular.
    val failure = assertFailsWith<ConfigurationException> { VerifierConfig.fromEnvironment(env(directory, "VERIFIER_CALLER_SECRET" to "SECRET-123")) }
    assertFalse("SECRET-123" in (failure.message ?: ""))
    assertEquals(listOf("VERIFIER_CALLER_SECRET"), failure.problems.map { it.key })
  }

  @Test
  fun `the caller secret is 32 random bytes in their one base64url spelling`(@TempDir directory: Path) {
    assertEquals(secret, VerifierConfig.fromEnvironment(env(directory, "VERIFIER_CALLER_SECRET" to secret)).callerSecret)
    val bad =
      listOf(
        secret + "A", // 44 characters
        secret.dropLast(1), // 42 characters
        secret.dropLast(1) + "B", // spare bits set: another spelling of 32 bytes
        secret.dropLast(1) + "=", // padding
        "+" + secret.drop(1), // the standard alphabet
        "/" + secret.drop(1),
        " " + secret.drop(1),
        secret + "\n",
      )
    for (candidate in bad) {
      assertEquals(listOf("VERIFIER_CALLER_SECRET"), keysOf(env(directory, "VERIFIER_CALLER_SECRET" to candidate)), "accepted: $candidate")
    }
    assertTrue(VerifierConfig.isCanonicalKey("A".repeat(42) + "Q"))
    assertFalse(VerifierConfig.isCanonicalKey("A".repeat(42) + "R"))
  }

  @Test
  fun `a verifier reachable beyond loopback, or in production, requires its caller's secret`(@TempDir directory: Path) {
    assertEquals(listOf("VERIFIER_CALLER_SECRET"), keysOf(env(directory, "VERIFIER_BIND_ADDRESS" to "0.0.0.0")))
    assertEquals(listOf("VERIFIER_CALLER_SECRET"), keysOf(env(directory, "VERIFIER_BIND_ADDRESS" to "10.0.0.5")))
    for (loopback in listOf("127.0.0.1", "::1", "localhost")) {
      VerifierConfig.fromEnvironment(env(directory, "VERIFIER_BIND_ADDRESS" to loopback))
    }
    VerifierConfig.fromEnvironment(env(directory, "VERIFIER_BIND_ADDRESS" to "0.0.0.0", "VERIFIER_CALLER_SECRET" to secret))
    assertTrue(
      "VERIFIER_CALLER_SECRET" in
        keysOf(env(directory, "VERIFIER_ENVIRONMENT" to "production", "VERIFIER_TRUST_DATA_MAX_AGE_HOURS" to "12"))
    )
  }

  @Test
  fun `production holds what production requires`(@TempDir directory: Path) {
    val production = arrayOf("VERIFIER_ENVIRONMENT" to "production", "VERIFIER_CALLER_SECRET" to secret, "VERIFIER_TRUST_DATA_MAX_AGE_HOURS" to "12")
    val config = VerifierConfig.fromEnvironment(env(directory, *production))
    assertEquals(VerifierEnvironment.PRODUCTION, config.environment)
    assertEquals(Duration.ofHours(12), config.maxAge)
    // The maximum age is stated, not defaulted, and exceeds six hours.
    assertEquals(
      listOf("VERIFIER_TRUST_DATA_MAX_AGE_HOURS"),
      keysOf(env(directory, "VERIFIER_ENVIRONMENT" to "production", "VERIFIER_CALLER_SECRET" to secret)).distinct(),
    )
    assertEquals(
      listOf("VERIFIER_TRUST_DATA_MAX_AGE_HOURS"),
      keysOf(env(directory, "VERIFIER_ENVIRONMENT" to "production", "VERIFIER_CALLER_SECRET" to secret, "VERIFIER_TRUST_DATA_MAX_AGE_HOURS" to "6")),
    )
    // A debug signer is refused in production and accepted elsewhere.
    val debug = "b".repeat(64)
    assertEquals(
      listOf("VERIFIER_DEBUG_SIGNING_DIGESTS"),
      keysOf(env(directory, *production, "VERIFIER_DEBUG_SIGNING_DIGESTS" to debug)),
    )
    val local = VerifierConfig.fromEnvironment(env(directory, "VERIFIER_DEBUG_SIGNING_DIGESTS" to debug))
    assertEquals(setOf(digest, debug), local.signingDigests)
    // An unknown environment is not production by default, and is refused.
    assertEquals(listOf("VERIFIER_ENVIRONMENT"), keysOf(env(directory, "VERIFIER_ENVIRONMENT" to "prod")))
  }

  @Test
  fun `the revocation list comes over https, or over loopback http outside production`(@TempDir directory: Path) {
    fun url(value: String, vararg more: Pair<String, String?>) = keysOf(env(directory, "VERIFIER_REVOCATION_URL" to value, *more))
    VerifierConfig.fromEnvironment(env(directory, "VERIFIER_REVOCATION_URL" to "https://example.org/attestation/status"))
    VerifierConfig.fromEnvironment(env(directory, "VERIFIER_REVOCATION_URL" to "http://127.0.0.1:9000/status"))
    VerifierConfig.fromEnvironment(env(directory, "VERIFIER_REVOCATION_URL" to "http://localhost:9000/status"))
    for (bad in listOf("http://example.org/status", "ftp://example.org/x", "https://user:pw@example.org/x", "not a url", "https:///x", "//example.org/x")) {
      assertEquals(listOf("VERIFIER_REVOCATION_URL"), url(bad), "accepted: $bad")
    }
    val production = arrayOf("VERIFIER_ENVIRONMENT" to "production", "VERIFIER_CALLER_SECRET" to secret, "VERIFIER_TRUST_DATA_MAX_AGE_HOURS" to "12")
    assertEquals(listOf("VERIFIER_REVOCATION_URL"), url("http://127.0.0.1:9000/status", *production))
  }

  @Test
  fun `the package is an android package name`(@TempDir directory: Path) {
    for (good in listOf("com.melarc.rider", "a.b", "com.melarc.rider_2", "Com.Melarc.Rider")) {
      assertEquals(good, VerifierConfig.fromEnvironment(env(directory, "VERIFIER_PACKAGE_NAME" to good)).packageName)
    }
    val long = "a." + "b".repeat(254)
    for (bad in listOf("com", "com.", ".com", "com..x", "1com.x", "com.melarc rider", "com.melarc-rider", "com.melarc.rider\n", long)) {
      assertEquals(listOf("VERIFIER_PACKAGE_NAME"), keysOf(env(directory, "VERIFIER_PACKAGE_NAME" to bad)), "accepted: $bad")
    }
  }

  @Test
  fun `signing digests are sha256 digests in hexadecimal, up to ten`(@TempDir directory: Path) {
    val config =
      VerifierConfig.fromEnvironment(env(directory, "VERIFIER_SIGNING_DIGESTS" to " ${"A".repeat(64)} , ${"b".repeat(64)},${"a".repeat(64)}"))
    assertEquals(setOf("a".repeat(64), "b".repeat(64)), config.signingDigests, "lower-cased, trimmed, one each")
    val ten = (1..10).joinToString(",") { it.toString(16).padStart(64, '0') }
    assertEquals(10, VerifierConfig.fromEnvironment(env(directory, "VERIFIER_SIGNING_DIGESTS" to ten)).signingDigests.size)
    val eleven = (1..11).joinToString(",") { it.toString(16).padStart(64, '0') }
    for (bad in listOf("a".repeat(63), "a".repeat(65), "g".repeat(64), "$digest,", ",$digest", eleven, "$digest $digest")) {
      assertEquals(listOf("VERIFIER_SIGNING_DIGESTS"), keysOf(env(directory, "VERIFIER_SIGNING_DIGESTS" to bad)), "accepted: $bad")
    }
  }

  @Test
  fun `numbers are in their ranges and in their one spelling`(@TempDir directory: Path) {
    val bad =
      mapOf(
        "VERIFIER_PORT" to listOf("0", "65536", "08080", " 8080", "8080 ", "80.5", "abc", "-1", "+8080"),
        "VERIFIER_FETCH_TIMEOUT_MS" to listOf("499", "120001", "1e3"),
        "VERIFIER_REVOCATION_MAX_BYTES" to listOf("1023", "67108865"),
        "VERIFIER_REFRESH_HOURS" to listOf("0", "24"),
        "VERIFIER_RETRY_MINUTES" to listOf("0", "181"),
        "VERIFIER_TRUST_DATA_MAX_AGE_HOURS" to listOf("1", "25"),
        "VERIFIER_MAX_REQUEST_BYTES" to listOf("1023", "1048577"),
        "VERIFIER_MAX_CONCURRENT" to listOf("0", "65"),
        "VERIFIER_DEADLINE_MS" to listOf("99", "30001"),
      )
    for ((key, values) in bad) {
      for (value in values) assertEquals(listOf(key), keysOf(env(directory, key to value)), "$key accepted $value")
    }
    assertEquals(1, VerifierConfig.fromEnvironment(env(directory, "VERIFIER_PORT" to "1")).port)
    assertEquals(65535, VerifierConfig.fromEnvironment(env(directory, "VERIFIER_PORT" to "65535")).port)
  }

  @Test
  fun `the list outlives the refresh cadence, and never more than a day`(@TempDir directory: Path) {
    // With a maximum age no longer than the refresh interval, enrolment would fail closed between two good refreshes.
    assertEquals(
      listOf("VERIFIER_TRUST_DATA_MAX_AGE_HOURS"),
      keysOf(env(directory, "VERIFIER_REFRESH_HOURS" to "8", "VERIFIER_TRUST_DATA_MAX_AGE_HOURS" to "8")),
    )
    VerifierConfig.fromEnvironment(env(directory, "VERIFIER_REFRESH_HOURS" to "8", "VERIFIER_TRUST_DATA_MAX_AGE_HOURS" to "9"))
    assertEquals(Duration.ofHours(24), VerifierConfig.MAX_AGE_CEILING)
  }

  @Test
  fun `the roots file must be there`(@TempDir directory: Path) {
    assertEquals(listOf("VERIFIER_ACCEPTED_ROOTS_FILE"), keysOf(env(directory, "VERIFIER_ACCEPTED_ROOTS_FILE" to directory.resolve("nothing.json").toString())))
    assertEquals(listOf("VERIFIER_ACCEPTED_ROOTS_FILE"), keysOf(env(directory, "VERIFIER_ACCEPTED_ROOTS_FILE" to directory.toString())), "a directory is not a file")
  }

  @Test
  fun `several problems are all reported, in the order of the settings`(@TempDir directory: Path) {
    val keys = keysOf(env(directory, "VERIFIER_PORT" to "0", "VERIFIER_PACKAGE_NAME" to "x", "VERIFIER_MAX_CONCURRENT" to "0", "VERIFIER_CALLER_SECRET" to "short"))
    assertEquals(listOf("VERIFIER_PORT", "VERIFIER_CALLER_SECRET", "VERIFIER_PACKAGE_NAME", "VERIFIER_MAX_CONCURRENT"), keys)
  }

  @Test
  fun `the example names every setting the service reads, and is a valid configuration once the release inputs are filled in`() {
    val folder = Path.of(checkNotNull(System.getProperty("melarc.verifier.dir")) { "melarc.verifier.dir is not set" })
    val example =
      Files.readAllLines(folder.resolve(".env.example"))
        .filter { it.isNotBlank() && !it.startsWith("#") }
        .associate { line -> line.substringBefore('=') to line.substringAfter('=') }
    assertEquals(VerifierConfig.KEYS.toSet(), example.keys, "a setting the service reads is missing from the example, or the reverse")
    // The three release inputs have no value there; the rest is the service's own default, spelled out.
    assertEquals(
      setOf("VERIFIER_CALLER_SECRET", "VERIFIER_PACKAGE_NAME", "VERIFIER_SIGNING_DIGESTS", "VERIFIER_DEBUG_SIGNING_DIGESTS"),
      example.filterValues { it.isEmpty() }.keys,
    )
    val filled =
      example +
        mapOf(
          "VERIFIER_PACKAGE_NAME" to "com.melarc.rider",
          "VERIFIER_SIGNING_DIGESTS" to digest,
          // A relative path is relative to the folder the process starts in, which is this one.
          "VERIFIER_ACCEPTED_ROOTS_FILE" to folder.resolve(example.getValue("VERIFIER_ACCEPTED_ROOTS_FILE")).toString(),
        )
    val config = VerifierConfig.fromEnvironment(filled)
    val defaults = VerifierConfig.fromEnvironment(filled.filterKeys { it !in DEFAULTED })
    assertEquals(defaults, config.copy(), "the example shows a value the service does not default to")
  }

  private val DEFAULTED =
    setOf(
      "VERIFIER_ENVIRONMENT",
      "VERIFIER_BIND_ADDRESS",
      "VERIFIER_PORT",
      "VERIFIER_REVOCATION_URL",
      "VERIFIER_FETCH_TIMEOUT_MS",
      "VERIFIER_REVOCATION_MAX_BYTES",
      "VERIFIER_REFRESH_HOURS",
      "VERIFIER_RETRY_MINUTES",
      "VERIFIER_TRUST_DATA_MAX_AGE_HOURS",
      "VERIFIER_MAX_REQUEST_BYTES",
      "VERIFIER_MAX_CONCURRENT",
      "VERIFIER_DEADLINE_MS",
    )

  @Test
  fun `the bind address is a host name or an address`(@TempDir directory: Path) {
    for (bad in listOf("a b", "host;rm", "", "x".repeat(254))) {
      if (bad.isEmpty()) continue
      assertTrue("VERIFIER_BIND_ADDRESS" in keysOf(env(directory, "VERIFIER_BIND_ADDRESS" to bad, "VERIFIER_CALLER_SECRET" to secret)), "accepted: $bad")
    }
  }
}
