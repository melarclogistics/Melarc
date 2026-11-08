package com.melarc.attestation

import com.google.gson.JsonObject
import java.io.PrintStream
import java.time.InstantSource
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * The verifier's counters and gauges, served in the Prometheus text format at `/v1/metrics` (SECURITY_DESIGN.md 15.2.2: the age gauge and
 * the load-failure counter; the bounded `cause` label of the unavailability counter, 15.2.3). Every label is a member of a closed set that
 * this process names itself: nothing a request carries becomes a label, so the set cannot grow with traffic. The private metrics endpoint
 * of the API and the alerts built on these are S0.68's.
 */
class Metrics {
  private val counters = ConcurrentHashMap<String, AtomicLong>()

  fun increment(name: String, label: String? = null) {
    counters.computeIfAbsent(key(name, label)) { AtomicLong() }.incrementAndGet()
  }

  fun count(name: String, label: String? = null): Long = counters[key(name, label)]?.get() ?: 0L

  private fun key(name: String, label: String?): String =
    if (label == null) name else "$name{${labelName(name)}=\"$label\"}"

  private fun labelName(name: String): String =
    when (name) {
      "attestation_verifications_total" -> "verdict"
      "attestation_verifier_unavailable_total" -> "cause"
      "attestation_integrity_failures_total" -> "cause"
      "attestation_requests_refused_total" -> "reason"
      else -> "label"
    }

  /** The text of the metrics, with the gauges the caller reads at render time (the age of the trust data, the requests in flight). */
  fun render(gauges: Map<String, Double>): String {
    val out = StringBuilder()
    for ((name, value) in gauges.toSortedMap()) {
      out.append("# TYPE ").append(name).append(" gauge\n")
      out.append(name).append(' ').append(value).append('\n')
    }
    val byName = counters.entries.groupBy { it.key.substringBefore('{') }.toSortedMap()
    for ((name, entries) in byName) {
      out.append("# TYPE ").append(name).append(" counter\n")
      for (entry in entries.sortedBy { it.key }) {
        out.append(entry.key).append(' ').append(entry.value.get()).append('\n')
      }
    }
    return out.toString()
  }
}

/**
 * The structured log: one JSON object a line on standard output. **It never carries a certificate, a challenge, a key, a digest or a
 * secret**: only a closed event name, a request id, a verdict class, a cause class and a duration. A field is added here deliberately.
 */
class StructuredLog(private val out: PrintStream, private val clock: InstantSource = InstantSource.system()) {
  fun event(level: String, event: String, fields: Map<String, Any?> = emptyMap()) {
    val line = JsonObject()
    line.addProperty("time", clock.instant().toString())
    line.addProperty("level", level)
    line.addProperty("event", event)
    for ((name, value) in fields) {
      when (value) {
        null -> line.add(name, com.google.gson.JsonNull.INSTANCE)
        is Number -> line.addProperty(name, value)
        is Boolean -> line.addProperty(name, value)
        else -> line.addProperty(name, value.toString())
      }
    }
    synchronized(out) { out.println(line.toString()) }
  }
}
