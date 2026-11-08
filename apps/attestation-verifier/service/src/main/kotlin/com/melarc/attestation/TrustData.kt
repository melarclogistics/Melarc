package com.melarc.attestation

import com.android.keyattestation.verifier.SoftwareRoot
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStreamReader
import java.nio.file.Files
import java.nio.file.Path
import java.security.cert.CertificateFactory
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.time.Duration
import java.time.Instant
import java.time.InstantSource
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/** Where the accepted roots come from. Configuration, reloaded when it changes. */
interface RootsSource {
  /** Reads and validates the accepted roots, or throws [TrustDataException]. */
  fun load(): Set<TrustAnchor>

  /** A token that changes when the source changes (a file's modification time), or null when it cannot tell. */
  fun version(): Long?
}

/** The accepted roots in a file of a JSON array of PEM texts, the form of the library's own `roots.json`. */
class FileRootsSource(private val path: Path) : RootsSource {
  override fun version(): Long? = runCatching { Files.getLastModifiedTime(path).toMillis() }.getOrNull()

  override fun load(): Set<TrustAnchor> {
    val bytes =
      try {
        if (Files.size(path) > MAX_FILE_BYTES) throw TrustDataException("The accepted roots file is too large")
        Files.readAllBytes(path)
      } catch (failure: IOException) {
        throw TrustDataException("The accepted roots file cannot be read")
      }
    return parseRoots(bytes)
  }

  companion object {
    private const val MAX_FILE_BYTES = 256 * 1024L
    private const val MAX_ROOTS = 16

    /** A JSON array of one to sixteen PEM texts, each an X.509 certificate that is self-issued and is no software root. */
    fun parseRoots(bytes: ByteArray): Set<TrustAnchor> {
      val pems = mutableListOf<String>()
      try {
        JsonReader(InputStreamReader(ByteArrayInputStream(bytes), Charsets.UTF_8)).use { reader ->
          reader.setStrictness(Strictness.STRICT)
          reader.beginArray()
          while (reader.hasNext()) {
            if (reader.peek() != JsonToken.STRING) throw TrustDataException("An accepted root is not text")
            if (pems.size >= MAX_ROOTS) throw TrustDataException("There are more accepted roots than the verifier holds")
            pems += reader.nextString()
          }
          reader.endArray()
          if (reader.peek() != JsonToken.END_DOCUMENT) throw TrustDataException("The accepted roots file has trailing content")
        }
      } catch (failure: TrustDataException) {
        throw failure
      } catch (failure: IOException) {
        throw TrustDataException("The accepted roots file does not parse")
      } catch (failure: IllegalStateException) {
        throw TrustDataException("The accepted roots file is not an array")
      }
      if (pems.isEmpty()) throw TrustDataException("There are no accepted roots")
      val factory = CertificateFactory.getInstance("X.509")
      val anchors = linkedSetOf<TrustAnchor>()
      for (pem in pems) {
        val certificate =
          try {
            factory.generateCertificate(ByteArrayInputStream(pem.toByteArray(Charsets.UTF_8))) as X509Certificate
          } catch (failure: Exception) {
            throw TrustDataException("An accepted root does not parse as a certificate")
          }
        if (certificate.issuerX500Principal != certificate.subjectX500Principal) {
          throw TrustDataException("An accepted root is not self-issued")
        }
        if (SoftwareRoot.SOFTWARE_ROOTS.any { it.publicKey == certificate.publicKey }) {
          throw TrustDataException("The software attestation root is not an accepted root")
        }
        anchors += TrustAnchor(certificate, null)
      }
      return anchors
    }
  }
}

/** What the verifier can say of its trust data now (SECURITY_DESIGN.md 15.2.2). */
sealed interface TrustState {
  /** Nothing is held yet (a start, or a revocation list that has not loaded). */
  data object NotLoaded : TrustState

  /** The accepted roots have never loaded. */
  data object RootsUnloadable : TrustState

  /** The held list is older than the maximum age. */
  data class Stale(val age: Duration) : TrustState

  data class Fresh(val roots: Set<TrustAnchor>, val revoked: Set<String>, val fetchedAt: Instant) : TrustState
}

/**
 * The trust data of one verifier instance, held in memory (SECURITY_DESIGN.md 15.2.2): the accepted roots (configuration, reloaded when the
 * file changes) and Google's revocation list, fetched from its one configured source on an in-process timer.
 *
 * - **At start it holds nothing**, and enrolment answers unavailable until the first load succeeds. No list is treated as infinitely old:
 *   a restart never serves a list this instance has not itself loaded.
 * - **Refresh** is every `refresh` (6 hours); **a failed load retries every `retry` (15 minutes)** until it succeeds, and the last-known-good
 *   list keeps serving while it is within the maximum age. A fetched list replaces the held one **only if it parses, validates and is
 *   non-empty**.
 * - **The maximum age** (24 hours at most) is measured from the held list's fetch time. Past it, and when the roots have never loaded,
 *   the data is unusable: [state] says so, and the caller fails closed.
 * - **Nothing is persisted**, and nothing here writes to a database or holds a lock.
 *
 * Time is the injected [InstantSource]; the timer is the injected executor, so a test drives both.
 */
class TrustData(
  private val clock: InstantSource,
  private val maxAge: Duration,
  private val refresh: Duration,
  private val retry: Duration,
  private val roots: RootsSource,
  private val revocation: RevocationFetcher,
  private val metrics: Metrics,
  private val log: StructuredLog,
  private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { task ->
    Thread(task, "trust-data").apply { isDaemon = true }
  },
) : AutoCloseable {
  private class Held(val revoked: Set<String>, val fetchedAt: Instant)

  private val startedAt: Instant = clock.instant()

  @Volatile private var heldRoots: Set<TrustAnchor>? = null

  @Volatile private var rootsAttempted = false

  @Volatile private var held: Held? = null

  @Volatile private var rootsVersion: Long? = null

  /** What the data is now, on the injected clock. */
  fun state(): TrustState {
    val currentRoots = heldRoots
    if (currentRoots == null) return if (rootsAttempted) TrustState.RootsUnloadable else TrustState.NotLoaded
    val currentList = held ?: return TrustState.NotLoaded
    val age = Duration.between(currentList.fetchedAt, clock.instant())
    return if (age > maxAge) TrustState.Stale(age) else TrustState.Fresh(currentRoots, currentList.revoked, currentList.fetchedAt)
  }

  /**
   * The gauge `attestation_trust_data_age_seconds`: the time since the held list was fetched, or since the process started when none is
   * held (SECURITY_DESIGN.md 15.2.2), so that an instance that never loads is the oldest of all.
   */
  fun ageSeconds(): Double {
    val since = held?.fetchedAt ?: startedAt
    return Duration.between(since, clock.instant()).toMillis().coerceAtLeast(0) / 1000.0
  }

  /** One load of the accepted roots; true when it succeeded. A failure keeps the roots already held. */
  fun reloadRoots(): Boolean {
    rootsAttempted = true
    // The version tried, whether or not it loads: a file that is wrong is not read again until it changes again.
    rootsVersion = roots.version()
    return try {
      heldRoots = roots.load()
      true
    } catch (failure: TrustDataException) {
      metrics.increment("attestation_trust_roots_load_failures_total")
      log.event("WARN", "roots_load_failed", mapOf("reason" to failure.message))
      false
    }
  }

  /** One fetch of the revocation list; true when it succeeded. A failure keeps the list already held. */
  fun refreshRevocation(): Boolean =
    try {
      val list = revocation.fetch()
      held = Held(list.serials, clock.instant())
      true
    } catch (failure: TrustDataException) {
      metrics.increment("attestation_trust_data_load_failures_total")
      log.event("WARN", "revocation_load_failed", mapOf("reason" to failure.message))
      false
    } catch (failure: RuntimeException) {
      metrics.increment("attestation_trust_data_load_failures_total")
      log.event("WARN", "revocation_load_failed", mapOf("reason" to failure.javaClass.simpleName))
      false
    }

  /** Loads what is not loaded; true when both are held fresh afterwards. */
  fun loadAll(): Boolean {
    val rootsOk = if (heldRoots == null || rootsChanged()) reloadRoots() else true
    val listOk = refreshRevocation()
    return rootsOk && listOk
  }

  private fun rootsChanged(): Boolean {
    val current = roots.version()
    return current != null && current != rootsVersion
  }

  /** Starts the loader: an immediate attempt, then every refresh interval, or every retry interval after a failure. */
  fun start() {
    scheduler.execute { tick() }
    // The file of the accepted roots is configuration, reloaded when it changes: looked at once a minute, loaded only if it changed.
    scheduler.scheduleWithFixedDelay(
      {
        if (rootsChanged()) {
          log.event("INFO", "roots_changed", emptyMap())
          reloadRoots()
        }
      },
      1,
      1,
      TimeUnit.MINUTES,
    )
  }

  private fun tick() {
    val ok =
      try {
        loadAll()
      } catch (failure: RuntimeException) {
        metrics.increment("attestation_trust_data_load_failures_total")
        log.event("ERROR", "trust_data_tick_failed", mapOf("reason" to failure.javaClass.simpleName))
        false
      }
    val next = if (ok) refresh else retry
    try {
      scheduler.schedule({ tick() }, next.toMillis(), TimeUnit.MILLISECONDS)
    } catch (rejected: java.util.concurrent.RejectedExecutionException) {
      // The scheduler was shut down: the process is stopping.
    }
  }

  override fun close() {
    scheduler.shutdownNow()
  }
}
