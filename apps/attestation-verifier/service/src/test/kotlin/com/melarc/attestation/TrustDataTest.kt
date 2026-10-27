package com.melarc.attestation

import com.android.keyattestation.verifier.SoftwareRoot
import com.melarc.attestation.fixtures.FixtureWorld
import com.melarc.attestation.fixtures.Root
import java.nio.file.Files
import java.nio.file.Path
import java.security.cert.TrustAnchor
import java.time.Duration
import java.time.Instant
import java.time.InstantSource
import java.util.concurrent.Callable
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

/**
 * The trust data of one instance (SECURITY_DESIGN.md 15.2.2): empty at start, refreshed every six hours and retried every fifteen minutes,
 * usable for at most twenty-four hours from its fetch, replaced only by a list that is whole, and never written anywhere. **Break caught:**
 * a restart that serves an unseen list, a boundary of the age moved, a bad list that replaces a good one, a failing roots file read in a
 * loop, an interval swapped.
 */
class TrustDataTest {
  private class Clock(var now: Instant) : InstantSource {
    override fun instant(): Instant = now
  }

  private class FakeRoots(var result: () -> Set<TrustAnchor>, var version: Long? = 1) : RootsSource {
    var loads = 0

    override fun load(): Set<TrustAnchor> {
      loads += 1
      return result()
    }

    override fun version(): Long? = version
  }

  private class FakeList(var result: () -> RevocationList) : RevocationFetcher {
    var fetches = 0

    override fun fetch(): RevocationList {
      fetches += 1
      return result()
    }
  }

  private val start: Instant = Instant.parse("2026-10-20T00:00:00Z")
  private val clock = Clock(start)
  private val metrics = Metrics()
  private val goodRoots = FixtureWorld.anchors()
  private val goodList = RevocationList(2, setOf("a1", "b2"))
  private val roots = FakeRoots({ goodRoots })
  private val list = FakeList({ goodList })

  private fun trust(
    maxAge: Duration = Duration.ofHours(24),
    refresh: Duration = Duration.ofHours(6),
    retry: Duration = Duration.ofMinutes(15),
    scheduler: ScheduledThreadPoolExecutor = Recording(),
  ) = TrustData(clock, maxAge, refresh, retry, roots, list, metrics, FixtureWorld.silentLog(), scheduler)

  /** Runs what it is given at once and records what it is asked to schedule, so that a test sees the cadence and runs no timer. */
  private class Recording : ScheduledThreadPoolExecutor(1, { task -> Thread(task).apply { isDaemon = true } }) {
    val scheduled = mutableListOf<Pair<Long, TimeUnit>>()
    val fixedDelays = mutableListOf<Triple<Long, Long, TimeUnit>>()

    override fun execute(command: Runnable) = command.run()

    override fun schedule(command: Runnable, delay: Long, unit: TimeUnit): ScheduledFuture<*> {
      scheduled += delay to unit
      return super.schedule(Runnable {}, 1, TimeUnit.DAYS)
    }

    override fun <V> schedule(callable: Callable<V>, delay: Long, unit: TimeUnit): ScheduledFuture<V> {
      scheduled += delay to unit
      return super.schedule(Callable<V> { null }, 1, TimeUnit.DAYS) as ScheduledFuture<V>
    }

    override fun scheduleWithFixedDelay(command: Runnable, initialDelay: Long, delay: Long, unit: TimeUnit): ScheduledFuture<*> {
      fixedDelays += Triple(initialDelay, delay, unit)
      return super.scheduleWithFixedDelay(Runnable {}, 1, 1, TimeUnit.DAYS)
    }
  }

  @Test
  fun `at start it holds nothing and says so`() {
    val data = trust()
    assertEquals(TrustState.NotLoaded, data.state())
    assertEquals(0, list.fetches)
  }

  @Test
  fun `a restart never serves a list the instance did not itself load`() {
    val first = trust()
    assertTrue(first.loadAll())
    assertIs<TrustState.Fresh>(first.state())
    // A new instance holds nothing, whatever the old one held: nothing is persisted.
    assertEquals(TrustState.NotLoaded, trust().state())
  }

  @Test
  fun `once both are loaded the data is fresh and carries what was loaded`() {
    val data = trust()
    assertTrue(data.loadAll())
    val state = assertIs<TrustState.Fresh>(data.state())
    assertEquals(goodRoots, state.roots)
    assertEquals(setOf("a1", "b2"), state.revoked)
    assertEquals(start, state.fetchedAt)
  }

  @Test
  fun `roots that never loaded are their own state`() {
    roots.result = { throw TrustDataException("no") }
    val data = trust()
    assertFalse(data.loadAll())
    assertEquals(TrustState.RootsUnloadable, data.state())
    assertEquals(1, metrics.count("attestation_trust_roots_load_failures_total"))
  }

  @Test
  fun `a list that never loaded leaves the data not loaded`() {
    list.result = { throw TrustDataException("no") }
    val data = trust()
    assertFalse(data.loadAll())
    assertEquals(TrustState.NotLoaded, data.state())
    assertEquals(1, metrics.count("attestation_trust_data_load_failures_total"))
  }

  @Test
  fun `the list is usable for exactly the maximum age from its fetch`() {
    val data = trust(maxAge = Duration.ofHours(24))
    data.loadAll()
    clock.now = start.plus(Duration.ofHours(24))
    assertIs<TrustState.Fresh>(data.state(), "at the maximum age it is still fresh")
    clock.now = start.plus(Duration.ofHours(24)).plusMillis(1)
    val stale = assertIs<TrustState.Stale>(data.state())
    assertEquals(Duration.ofHours(24).plusMillis(1), stale.age)
  }

  @Test
  fun `a failed refresh keeps the last list while it is within the maximum age and not a moment longer`() {
    val data = trust()
    data.loadAll()
    list.result = { throw TrustDataException("unreachable") }
    clock.now = start.plus(Duration.ofHours(7))
    assertFalse(data.refreshRevocation())
    val state = assertIs<TrustState.Fresh>(data.state())
    assertEquals(start, state.fetchedAt, "the list is the old one, with its old age")
    clock.now = start.plus(Duration.ofHours(25))
    assertIs<TrustState.Stale>(data.state())
  }

  @Test
  fun `a refresh that succeeds renews the age`() {
    val data = trust()
    data.loadAll()
    clock.now = start.plus(Duration.ofHours(23))
    list.result = { RevocationList(1, setOf("c3")) }
    assertTrue(data.refreshRevocation())
    clock.now = start.plus(Duration.ofHours(40))
    val state = assertIs<TrustState.Fresh>(data.state())
    assertEquals(setOf("c3"), state.revoked)
  }

  @Test
  fun `a failure of any kind in the fetch is contained and keeps the held list`() {
    val data = trust()
    data.loadAll()
    for (failure in listOf<() -> RevocationList>({ throw TrustDataException("bad") }, { throw IllegalStateException("x") }, { throw NumberFormatException() })) {
      list.result = failure
      assertFalse(data.refreshRevocation())
      assertEquals(setOf("a1", "b2"), assertIs<TrustState.Fresh>(data.state()).revoked)
    }
    assertEquals(3, metrics.count("attestation_trust_data_load_failures_total"))
  }

  @Test
  fun `the age gauge is the age of the list, or of the process while none is held`() {
    val data = trust()
    clock.now = start.plusSeconds(90)
    assertEquals(90.0, data.ageSeconds())
    data.loadAll()
    clock.now = start.plusSeconds(90 + 3600)
    assertEquals(3600.0, data.ageSeconds())
  }

  @Test
  fun `roots are reloaded when their source changes and not before`() {
    val data = trust()
    data.loadAll()
    assertEquals(1, roots.loads)
    data.loadAll()
    assertEquals(1, roots.loads, "unchanged: not read again")
    roots.version = 2
    roots.result = { setOf(FixtureWorld.anchors(listOf(Root.A)).first()) }
    assertTrue(data.loadAll())
    assertEquals(2, roots.loads)
    assertEquals(1, assertIs<TrustState.Fresh>(data.state()).roots.size)
  }

  @Test
  fun `a roots file that is wrong keeps the roots held and is not read again until it changes`() {
    val data = trust()
    data.loadAll()
    roots.version = 2
    roots.result = { throw TrustDataException("broken") }
    assertFalse(data.loadAll(), "the change was tried, and failed")
    assertEquals(2, roots.loads)
    assertTrue(data.loadAll(), "the roots held stand, and the file is not tried again")
    // The roots held stay in use.
    assertEquals(goodRoots, assertIs<TrustState.Fresh>(data.state()).roots)
    assertEquals(2, roots.loads, "read once for the change, not again: a loop would read it on every tick")
    roots.version = 3
    roots.result = { goodRoots }
    assertTrue(data.loadAll())
    assertEquals(3, roots.loads)
  }

  @Test
  fun `the loader runs at once and then every refresh interval, or every retry interval after a failure`() {
    val recording = Recording()
    val data = trust(refresh = Duration.ofHours(6), retry = Duration.ofMinutes(15), scheduler = recording)
    data.start()
    assertEquals(listOf(Duration.ofHours(6).toMillis() to TimeUnit.MILLISECONDS), recording.scheduled)
    list.result = { throw TrustDataException("down") }
    val second = Recording()
    trust(scheduler = second).start()
    assertEquals(listOf(Duration.ofMinutes(15).toMillis() to TimeUnit.MILLISECONDS), second.scheduled)
    // The file of the accepted roots is looked at once a minute.
    assertEquals(listOf(Triple(1L, 1L, TimeUnit.MINUTES)), recording.fixedDelays)
  }

  @Test
  fun `an exception in a tick is contained and the next tick is still scheduled`() {
    roots.result = { throw IllegalStateException("a defect") }
    val recording = Recording()
    trust(scheduler = recording).start()
    assertEquals(1, recording.scheduled.size)
    assertEquals(Duration.ofMinutes(15).toMillis(), recording.scheduled.single().first)
  }

  // ---- the accepted roots -----------------------------------------------------------------------------------------------------

  @Test
  fun `the accepted roots are read from a file of PEM texts`(@TempDir directory: Path) {
    val file = directory.resolve("roots.json")
    file.writeText(FixtureWorld.acceptedRootsJson())
    val source = FileRootsSource(file)
    assertEquals(2, source.load().size)
    assertNotNull(source.version())
  }

  @Test
  fun `a roots file that is not whole is refused`(@TempDir directory: Path) {
    val intermediate = FixtureWorld.pem(com.melarc.attestation.fixtures.AttestationFixtures.named("valid_trusted_environment").chain[2])
    val software = FixtureWorld.pem(SoftwareRoot.SOFTWARE_ROOTS.first().encoded)
    val one = FixtureWorld.pem(Root.A.certificate).replace("\n", "\\n")
    val cases =
      mapOf(
        "" to "does not parse",
        "[]" to "There are no accepted roots",
        "{}" to "is not an array",
        "[1]" to "is not text",
        """["not a certificate"]""" to "does not parse as a certificate",
        """["${intermediate.replace("\n", "\\n")}"]""" to "is not self-issued",
        """["${software.replace("\n", "\\n")}"]""" to "software attestation root",
        """["$one"] []""" to "does not parse",
        """["$one",]""" to "does not parse",
        "[" + (1..17).joinToString(",") { "\"$one\"" } + "]" to "more accepted roots",
      )
    for ((text, fragment) in cases) {
      val file = directory.resolve("roots-${text.hashCode()}.json")
      file.writeText(text)
      val failure = assertFailsWith<TrustDataException>("accepted: ${text.take(60)}") { FileRootsSource(file).load() }
      assertTrue(fragment in (failure.message ?: ""), "$fragment not in ${failure.message} for ${text.take(60)}")
    }
  }

  @Test
  fun `a roots file that is missing or too large is refused`(@TempDir directory: Path) {
    assertFailsWith<TrustDataException> { FileRootsSource(directory.resolve("absent.json")).load() }
    val large = directory.resolve("large.json")
    Files.write(large, ByteArray(300 * 1024) { ' '.code.toByte() })
    assertFailsWith<TrustDataException> { FileRootsSource(large).load() }
    assertEquals(null, FileRootsSource(directory.resolve("absent.json")).version())
  }
}
