package com.melarc.attestation

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.InstantSource
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

/**
 * The private verifier service (SECURITY_DESIGN.md 15.2.3): one small persistent JVM process that answers `POST /v1/verify` and nothing
 * else of the API's. It holds **no database credential and no application secret**; it binds to loopback unless it is told otherwise (and
 * then it requires its caller's secret); it makes one outbound call, to the revocation list's configured source.
 *
 * - **Bounded**: the request body is read up to its ceiling; at most `maxConcurrent` verifications run at once, the next is answered
 *   `TRUST_DATA_UNAVAILABLE` / `VERIFIER_OVERLOADED` at once and costs nothing; each verification has a deadline, and one that misses it
 *   is answered `VERIFIER_TIMEOUT`.
 * - **Authenticated**: when a caller secret is configured (always in production and beyond loopback), a request without it is `401`, before
 *   its body is read. The comparison is in constant time.
 * - **Honest about its answers**: a verdict it computed is `200`; the refusals of the service itself (overload, deadline) are `503` with the
 *   same verdict body; a request it will not read is `400`, `413` or `415` with the name of the field and never its value. The verdict of the
 *   device is never relabelled by this layer.
 * - **Silent about what it was given**: the log and the metrics carry classes and durations, never a certificate, a challenge or a key.
 */
class VerifierServer(
  private val config: VerifierConfig,
  private val trust: TrustData,
  private val policy: VerdictPolicy,
  private val metrics: Metrics,
  private val log: StructuredLog,
  private val clock: InstantSource = InstantSource.system(),
) : AutoCloseable {
  private val permits = Semaphore(config.maxConcurrent)
  private val inFlight = AtomicInteger()
  private val workers: ExecutorService =
    Executors.newFixedThreadPool(config.maxConcurrent) { task -> Thread(task, "verify-worker").apply { isDaemon = true } }
  private val handlers: ExecutorService =
    Executors.newFixedThreadPool(config.maxConcurrent + 4) { task ->
      Thread(task, "http-handler").apply { isDaemon = true }
    }
  private val random = SecureRandom()
  private val callerDigest: ByteArray? =
    config.callerSecret?.let { MessageDigest.getInstance("SHA-256").digest("Bearer $it".toByteArray(StandardCharsets.UTF_8)) }
  private var server: HttpServer? = null

  /** The port actually bound (the configured one, or the one the system chose for port 0 in a test). */
  val port: Int
    get() = checkNotNull(server).address.port

  fun start() {
    val created = HttpServer.create(InetSocketAddress(config.bindAddress, config.port), BACKLOG)
    created.executor = handlers
    // The JDK server routes by prefix; a path is a route only if it is exactly the route's.
    created.createContext("/v1/verify") { exchange -> guarded(exchange) { routed(exchange, "/v1/verify") { verify(exchange) } } }
    created.createContext("/v1/status") { exchange -> guarded(exchange) { routed(exchange, "/v1/status") { status(exchange) } } }
    created.createContext("/v1/metrics") { exchange -> guarded(exchange) { routed(exchange, "/v1/metrics") { metricsText(exchange) } } }
    created.createContext("/") { exchange -> guarded(exchange) { notFound(exchange) } }
    created.start()
    server = created
    log.event(
      "INFO",
      "listening",
      mapOf("environment" to config.environment.name.lowercase(), "port" to created.address.port, "authenticated" to (callerDigest != null)),
    )
  }

  override fun close() {
    server?.stop(1)
    workers.shutdownNow()
    handlers.shutdownNow()
  }

  // ---- the routes ---------------------------------------------------------------------------------------------------------------

  private fun verify(exchange: HttpExchange) {
    val started = System.nanoTime()
    val requestId = requestIdOf(exchange)
    if (exchange.requestMethod != "POST") return refuse(exchange, 405, "METHOD_NOT_ALLOWED", "method", requestId)
    if (!authenticated(exchange)) return unauthenticated(exchange, requestId)
    val mediaType = exchange.requestHeaders.getFirst("Content-Type")?.substringBefore(';')?.trim()?.lowercase()
    if (mediaType != "application/json") return refuse(exchange, 415, "UNSUPPORTED_MEDIA_TYPE", "content-type", requestId)
    val declared = exchange.requestHeaders.getFirst("Content-Length")?.toLongOrNull()
    if (declared != null && declared > config.maxRequestBytes) {
      return refuse(exchange, 413, "REQUEST_TOO_LARGE", "body", requestId)
    }
    val body = exchange.requestBody.use { it.readNBytes(config.maxRequestBytes + 1) }
    if (body.size > config.maxRequestBytes) return refuse(exchange, 413, "REQUEST_TOO_LARGE", "body", requestId)
    val request =
      try {
        VerifyRequestParser.parse(body)
      } catch (failure: InvalidRequestException) {
        return refuse(exchange, 400, "INVALID_REQUEST", failure.field, requestId)
      }

    // Trust data comes first (SECURITY_DESIGN.md 15.2.1): before any evidence is read, so that nothing is decided on a list that is too old.
    val state = trust.state()
    val verdict: Verdict =
      when (state) {
        is TrustState.Fresh -> verifyWithinBounds(request, state)
        TrustState.NotLoaded -> Verdict.Unavailable(UnavailableCause.TRUST_DATA_NOT_LOADED)
        TrustState.RootsUnloadable -> Verdict.Unavailable(UnavailableCause.TRUST_ROOTS_UNLOADABLE)
        is TrustState.Stale -> Verdict.Unavailable(UnavailableCause.TRUST_DATA_STALE)
      }
    metrics.increment("attestation_verifications_total", verdict.label)
    if (verdict is Verdict.Unavailable) metrics.increment("attestation_verifier_unavailable_total", verdict.cause.name)
    if (verdict is Verdict.IntegrityFailed) metrics.increment("attestation_integrity_failures_total", verdict.cause.name)
    val serviceRefusal =
      verdict is Verdict.Unavailable &&
        (verdict.cause == UnavailableCause.VERIFIER_OVERLOADED || verdict.cause == UnavailableCause.VERIFIER_TIMEOUT)
    log.event(
      "INFO",
      "verified",
      mapOf(
        "request_id" to requestId,
        "verdict" to verdict.label,
        "cause" to causeOf(verdict),
        "duration_ms" to (System.nanoTime() - started) / 1_000_000,
      ),
    )
    send(exchange, if (serviceRefusal) 503 else 200, verdictBody(verdict), requestId)
  }

  /** Runs the policy on a worker under the concurrency limit and the deadline; a refusal of either is the service's, not a verdict on the device. */
  private fun verifyWithinBounds(request: VerifyRequest, trustState: TrustState.Fresh): Verdict {
    if (!permits.tryAcquire()) return Verdict.Unavailable(UnavailableCause.VERIFIER_OVERLOADED)
    inFlight.incrementAndGet()
    val task =
      try {
        workers.submit(
          Callable {
            try {
              policy.verify(request, trustState)
            } finally {
              // Released when the work ends, not when the caller gave up waiting: a stuck verification keeps its place.
              inFlight.decrementAndGet()
              permits.release()
            }
          }
        )
      } catch (rejected: java.util.concurrent.RejectedExecutionException) {
        inFlight.decrementAndGet()
        permits.release()
        return Verdict.Unavailable(UnavailableCause.VERIFIER_OVERLOADED)
      }
    return try {
      task.get(config.deadline.toMillis(), TimeUnit.MILLISECONDS)
    } catch (timeout: TimeoutException) {
      task.cancel(true)
      Verdict.Unavailable(UnavailableCause.VERIFIER_TIMEOUT)
    } catch (failure: ExecutionException) {
      throw failure
    }
  }

  private fun status(exchange: HttpExchange) {
    val requestId = requestIdOf(exchange)
    if (exchange.requestMethod != "GET") return refuse(exchange, 405, "METHOD_NOT_ALLOWED", "method", requestId)
    if (!authenticated(exchange)) return unauthenticated(exchange, requestId)
    val state = trust.state()
    val body = JsonObject()
    body.addProperty("version", VerifyRequestParser.VERSION)
    body.addProperty(
      "state",
      when (state) {
        is TrustState.Fresh -> "READY"
        TrustState.NotLoaded -> "NOT_LOADED"
        TrustState.RootsUnloadable -> "ROOTS_UNLOADABLE"
        is TrustState.Stale -> "STALE"
      },
    )
    body.addProperty("trust_data_age_seconds", trust.ageSeconds())
    body.addProperty("in_flight", inFlight.get())
    body.addProperty("environment", config.environment.name.lowercase())
    send(exchange, 200, body.toString(), requestId)
  }

  private fun metricsText(exchange: HttpExchange) {
    val requestId = requestIdOf(exchange)
    if (exchange.requestMethod != "GET") return refuse(exchange, 405, "METHOD_NOT_ALLOWED", "method", requestId)
    if (!authenticated(exchange)) return unauthenticated(exchange, requestId)
    val text =
      metrics.render(
        mapOf(
          "attestation_trust_data_age_seconds" to trust.ageSeconds(),
          "attestation_verifier_in_flight" to inFlight.get().toDouble(),
        )
      )
    send(exchange, 200, text, requestId, "text/plain; version=0.0.4; charset=utf-8")
  }

  // ---- plumbing -----------------------------------------------------------------------------------------------------------------

  private fun routed(exchange: HttpExchange, path: String, handler: () -> Unit) {
    if (exchange.requestURI.rawPath == path) handler() else notFound(exchange)
  }

  private fun notFound(exchange: HttpExchange) {
    metrics.increment("attestation_requests_refused_total", "not_found")
    send(exchange, 404, errorBody("NOT_FOUND"))
  }

  /** Nothing an exchange does may leave it open: an unexpected failure is a `500` with no detail. */
  private fun guarded(exchange: HttpExchange, work: () -> Unit) {
    try {
      work()
    } catch (failure: Throwable) {
      metrics.increment("attestation_requests_refused_total", "internal")
      log.event("ERROR", "request_failed", mapOf("class" to failure.javaClass.name))
      try {
        send(exchange, 500, errorBody("INTERNAL"))
      } catch (ignored: Exception) {
        exchange.close()
      }
    } finally {
      exchange.close()
    }
  }

  private fun authenticated(exchange: HttpExchange): Boolean {
    val expected = callerDigest ?: return true
    val presented = exchange.requestHeaders.getFirst("Authorization") ?: return false
    val digest = MessageDigest.getInstance("SHA-256").digest(presented.toByteArray(StandardCharsets.UTF_8))
    return MessageDigest.isEqual(digest, expected)
  }

  private fun unauthenticated(exchange: HttpExchange, requestId: String) {
    metrics.increment("attestation_requests_refused_total", "unauthenticated")
    exchange.responseHeaders.add("WWW-Authenticate", "Bearer")
    send(exchange, 401, errorBody("UNAUTHENTICATED"), requestId)
  }

  private fun refuse(exchange: HttpExchange, status: Int, code: String, field: String, requestId: String) {
    metrics.increment("attestation_requests_refused_total", code.lowercase())
    log.event("INFO", "refused", mapOf("request_id" to requestId, "status" to status, "error" to code, "field" to field))
    send(exchange, status, errorBody(code, field), requestId)
  }

  private fun requestIdOf(exchange: HttpExchange): String {
    val offered = exchange.requestHeaders.getFirst("X-Request-Id")
    if (offered != null && REQUEST_ID.matches(offered)) return offered
    val bytes = ByteArray(8)
    random.nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
  }

  private fun send(
    exchange: HttpExchange,
    status: Int,
    body: String,
    requestId: String? = null,
    contentType: String = "application/json; charset=utf-8",
  ) {
    val bytes = body.toByteArray(StandardCharsets.UTF_8)
    exchange.responseHeaders.set("Content-Type", contentType)
    exchange.responseHeaders.set("Cache-Control", "no-store")
    exchange.responseHeaders.set("X-Content-Type-Options", "nosniff")
    if (requestId != null) exchange.responseHeaders.set("X-Request-Id", requestId)
    exchange.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
    if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
  }

  private fun errorBody(code: String, field: String? = null): String {
    val body = JsonObject()
    body.addProperty("version", VerifyRequestParser.VERSION)
    body.addProperty("error", code)
    if (field != null) body.addProperty("field", field)
    return body.toString()
  }

  private fun causeOf(verdict: Verdict): String? =
    when (verdict) {
      is Verdict.IntegrityFailed -> verdict.cause.name
      is Verdict.Unavailable -> verdict.cause.name
      else -> null
    }

  companion object {
    private const val BACKLOG = 32
    private val REQUEST_ID = Regex("^[A-Za-z0-9._-]{1,64}$")

    /** The response body of a verdict, as the API's adapter reads it. */
    fun verdictBody(verdict: Verdict): String {
      val body = JsonObject()
      body.addProperty("version", VerifyRequestParser.VERSION)
      body.addProperty("verdict", verdict.label)
      when (verdict) {
        is Verdict.Verified -> {
          body.addProperty("attested_public_key", verdict.attestedPublicKey)
          val summary = JsonObject()
          summary.addProperty("security_level", verdict.summary.securityLevel)
          summary.addProperty("attestation_version", verdict.summary.attestationVersion)
          summary.addProperty("key_mint_version", verdict.summary.keyMintVersion)
          summary.addProperty("package_name", verdict.summary.packageName)
          val digests = JsonArray()
          verdict.summary.signerDigests.forEach { digests.add(it) }
          summary.add("signer_digests", digests)
          body.add("summary", summary)
        }
        is Verdict.IntegrityFailed -> body.addProperty("cause", verdict.cause.name)
        is Verdict.Unavailable -> body.addProperty("cause", verdict.cause.name)
        Verdict.SecurityUnsupported -> Unit
      }
      return body.toString()
    }
  }
}
