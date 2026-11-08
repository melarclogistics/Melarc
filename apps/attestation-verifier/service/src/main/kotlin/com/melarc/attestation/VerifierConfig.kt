package com.melarc.attestation

import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration

/**
 * The configuration of the verifier, read from its environment and validated at start (SECURITY_DESIGN.md sections 15.2.1 to 15.2.3;
 * DEPLOYMENT_AND_ENVIRONMENTS.md section 12). A process that is configured wrongly **refuses to start**: it never starts with a default for
 * a value that is a release input (the package, the signing digests, the accepted roots), and it never starts in production with a
 * setting production forbids. A problem names the setting and what it needs, and **never a value** (the caller secret is among them).
 */
enum class VerifierEnvironment { LOCAL, STAGING, PRODUCTION }

class ConfigurationException(val problems: List<ConfigProblem>) :
  RuntimeException(
    "The verifier is configured wrongly: " + problems.joinToString("; ") { "${it.key} (${it.expected})" }
  )

data class ConfigProblem(val key: String, val expected: String)

data class VerifierConfig(
  val environment: VerifierEnvironment,
  val bindAddress: String,
  val port: Int,
  /** The secret a caller presents as `Authorization: Bearer`; absent only on loopback outside production. Compared in constant time. */
  val callerSecret: String?,
  /** The one package the Melarc Rider app is installed as. */
  val packageName: String,
  /** The approved signing-certificate SHA-256 digests, lower-case hexadecimal. More than one is how a certificate is rotated. */
  val signingDigests: Set<String>,
  /** The accepted Android attestation roots, as a file of a JSON array of PEM texts. Reloaded when the file changes. */
  val acceptedRootsFile: Path,
  val revocationUrl: URI,
  val fetchTimeout: Duration,
  val revocationMaxBytes: Int,
  val refreshInterval: Duration,
  val retryInterval: Duration,
  /** How old the held revocation list may be before enrolment fails closed. Never more than 24 hours. */
  val maxAge: Duration,
  val maxRequestBytes: Int,
  val maxConcurrent: Int,
  val deadline: Duration,
) {
  companion object {
    private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
    private val DIGEST = Regex("^[0-9a-fA-F]{64}$")
    private val BASE64URL_KEY = Regex("^[A-Za-z0-9_-]{43}$")
    private val LOOPBACK = setOf("127.0.0.1", "::1", "localhost")

    /** 32 bytes in their one unpadded base64url spelling (the two spare bits of the last character are zero). */
    fun isCanonicalKey(text: String): Boolean {
      if (!BASE64URL_KEY.matches(text)) return false
      val bytes = runCatching { java.util.Base64.getUrlDecoder().decode(text) }.getOrNull() ?: return false
      return bytes.size == 32 && java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes) == text
    }

    /** The environment variables the verifier reads, in the order the problems are reported. */
    val KEYS =
      listOf(
        "VERIFIER_ENVIRONMENT",
        "VERIFIER_BIND_ADDRESS",
        "VERIFIER_PORT",
        "VERIFIER_CALLER_SECRET",
        "VERIFIER_PACKAGE_NAME",
        "VERIFIER_SIGNING_DIGESTS",
        "VERIFIER_DEBUG_SIGNING_DIGESTS",
        "VERIFIER_ACCEPTED_ROOTS_FILE",
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

    /** The longest the held list may be used for (SECURITY_DESIGN.md 15.2.2): never past 24 hours. */
    val MAX_AGE_CEILING: Duration = Duration.ofHours(24)

    fun fromEnvironment(env: Map<String, String>): VerifierConfig {
      val problems = mutableListOf<ConfigProblem>()
      fun problem(key: String, expected: String) {
        problems += ConfigProblem(key, expected)
      }
      fun text(key: String): String? = env[key]?.takeIf { it.isNotEmpty() }

      fun integer(key: String, default: Int?, range: IntRange, expected: String): Int {
        val raw = text(key) ?: return default ?: 0.also { problem(key, "required: $expected") }
        val value = raw.toIntOrNull()?.takeIf { raw == it.toString() && it in range }
        if (value == null) {
          problem(key, expected)
          return default ?: range.first
        }
        return value
      }

      val environment =
        when (text("VERIFIER_ENVIRONMENT")) {
          null,
          "local" -> VerifierEnvironment.LOCAL
          "staging" -> VerifierEnvironment.STAGING
          "production" -> VerifierEnvironment.PRODUCTION
          else -> {
            problem("VERIFIER_ENVIRONMENT", "one of: local, staging, production")
            VerifierEnvironment.LOCAL
          }
        }
      val production = environment == VerifierEnvironment.PRODUCTION

      val bindAddress = text("VERIFIER_BIND_ADDRESS") ?: "127.0.0.1"
      if (!Regex("^[A-Za-z0-9.:_-]{1,253}$").matches(bindAddress)) {
        problem("VERIFIER_BIND_ADDRESS", "a host name or an address")
      }
      val loopback = bindAddress in LOOPBACK
      val port = integer("VERIFIER_PORT", 8765, 1..65535, "a port, 1 to 65535")

      val secret = text("VERIFIER_CALLER_SECRET")
      // The same text the API holds as ATTESTATION_VERIFIER_CALLER_SECRET: 32 random bytes in their one base64url spelling.
      if (secret != null && !isCanonicalKey(secret)) {
        problem("VERIFIER_CALLER_SECRET", "32 random bytes as canonical unpadded base64url (43 characters)")
      }
      // The verifier authenticates its caller if it crosses hosts (SECURITY_DESIGN.md 15.2.3), and in production always.
      if (secret == null && (production || !loopback)) {
        problem(
          "VERIFIER_CALLER_SECRET",
          "required in production and whenever the verifier is bound beyond loopback",
        )
      }

      val packageName = text("VERIFIER_PACKAGE_NAME")
      if (packageName == null) {
        problem("VERIFIER_PACKAGE_NAME", "required: the Melarc Rider package name")
      } else if (packageName.length > 255 || !PACKAGE.matches(packageName)) {
        problem("VERIFIER_PACKAGE_NAME", "an Android package name, such as a.b.c")
      }

      fun digests(key: String): Set<String> {
        val raw = text(key) ?: return emptySet()
        val parts = raw.split(',').map { it.trim() }
        if (parts.size > 10 || parts.any { !DIGEST.matches(it) }) {
          problem(key, "up to ten SHA-256 digests, each 64 hexadecimal characters, separated by commas")
          return emptySet()
        }
        return parts.map { it.lowercase() }.toSet()
      }
      val release = digests("VERIFIER_SIGNING_DIGESTS")
      if (text("VERIFIER_SIGNING_DIGESTS") == null) {
        problem("VERIFIER_SIGNING_DIGESTS", "required: the approved signing-certificate digests")
      }
      // A debug signer is accepted only outside production (SECURITY_DESIGN.md 15.2.3): the set is named apart so that production can
      // refuse it, because a digest alone does not say whether the key behind it is a debug key.
      val debug = digests("VERIFIER_DEBUG_SIGNING_DIGESTS")
      if (production && debug.isNotEmpty()) {
        problem("VERIFIER_DEBUG_SIGNING_DIGESTS", "empty in production: a debug signer is refused there")
      }

      val rootsFile = text("VERIFIER_ACCEPTED_ROOTS_FILE")
      if (rootsFile == null) problem("VERIFIER_ACCEPTED_ROOTS_FILE", "required: a file of the accepted roots")
      val rootsPath = rootsFile?.let { runCatching { Path.of(it) }.getOrNull() }
      if (rootsFile != null && (rootsPath == null || !Files.isRegularFile(rootsPath))) {
        problem("VERIFIER_ACCEPTED_ROOTS_FILE", "a readable file")
      }

      val revocationUrl = text("VERIFIER_REVOCATION_URL") ?: "https://android.googleapis.com/attestation/status"
      val revocation = runCatching { URI.create(revocationUrl) }.getOrNull()
      val revocationHost = revocation?.host
      val httpsOrLocalLoopback =
        revocation != null &&
          revocationHost != null &&
          revocation.userInfo == null &&
          (revocation.scheme == "https" ||
            (revocation.scheme == "http" && !production && revocationHost in LOOPBACK))
      if (!httpsOrLocalLoopback) {
        problem("VERIFIER_REVOCATION_URL", "an https URL (http only to loopback outside production)")
      }

      val fetchTimeoutMs = integer("VERIFIER_FETCH_TIMEOUT_MS", 10_000, 500..120_000, "milliseconds, 500 to 120000")
      val revocationMaxBytes =
        integer("VERIFIER_REVOCATION_MAX_BYTES", 8 * 1024 * 1024, 1024..64 * 1024 * 1024, "bytes, 1024 to 67108864")
      val refreshHours = integer("VERIFIER_REFRESH_HOURS", 6, 1..23, "hours, 1 to 23")
      val retryMinutes = integer("VERIFIER_RETRY_MINUTES", 15, 1..180, "minutes, 1 to 180")
      val maxAgeHours = integer("VERIFIER_TRUST_DATA_MAX_AGE_HOURS", 24, 2..24, "hours, up to 24")
      // The list always outlives one refresh cadence: with a maximum age no greater than the cadence, enrolment would fail closed
      // between two successful refreshes (and production requires more than six hours: 15.2.2).
      if (maxAgeHours <= refreshHours || (production && maxAgeHours <= 6)) {
        problem(
          "VERIFIER_TRUST_DATA_MAX_AGE_HOURS",
          "greater than the refresh interval, and greater than 6 in production; never more than 24",
        )
      }
      if (production && text("VERIFIER_TRUST_DATA_MAX_AGE_HOURS") == null) {
        problem("VERIFIER_TRUST_DATA_MAX_AGE_HOURS", "required in production")
      }
      val maxRequestBytes = integer("VERIFIER_MAX_REQUEST_BYTES", 65_536, 1024..1_048_576, "bytes, 1024 to 1048576")
      val maxConcurrent = integer("VERIFIER_MAX_CONCURRENT", 8, 1..64, "1 to 64")
      val deadlineMs = integer("VERIFIER_DEADLINE_MS", 5_000, 100..30_000, "milliseconds, 100 to 30000")

      if (problems.isNotEmpty()) throw ConfigurationException(problems)
      return VerifierConfig(
        environment = environment,
        bindAddress = bindAddress,
        port = port,
        callerSecret = secret,
        packageName = checkNotNull(packageName),
        signingDigests = release + debug,
        acceptedRootsFile = checkNotNull(rootsPath),
        revocationUrl = checkNotNull(revocation),
        fetchTimeout = Duration.ofMillis(fetchTimeoutMs.toLong()),
        revocationMaxBytes = revocationMaxBytes,
        refreshInterval = Duration.ofHours(refreshHours.toLong()),
        retryInterval = Duration.ofMinutes(retryMinutes.toLong()),
        maxAge = Duration.ofHours(maxAgeHours.toLong()),
        maxRequestBytes = maxRequestBytes,
        maxConcurrent = maxConcurrent,
        deadline = Duration.ofMillis(deadlineMs.toLong()),
      )
    }
  }
}
