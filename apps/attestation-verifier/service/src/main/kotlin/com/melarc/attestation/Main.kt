package com.melarc.attestation

import java.time.InstantSource
import kotlin.system.exitProcess

/**
 * The entry point: reads the environment, refuses to start on a bad one (naming settings and never values), loads its trust data in the
 * background and serves. A restart loads the trust data afresh: nothing is persisted (SECURITY_DESIGN.md 15.2.2).
 */
fun main() {
  val log = StructuredLog(System.out)
  val config =
    try {
      VerifierConfig.fromEnvironment(System.getenv())
    } catch (failure: ConfigurationException) {
      for (problem in failure.problems) {
        log.event("ERROR", "configuration_refused", mapOf("key" to problem.key, "expected" to problem.expected))
      }
      exitProcess(2)
    }

  val clock = InstantSource.system()
  val metrics = Metrics()
  val trust =
    TrustData(
      clock = clock,
      maxAge = config.maxAge,
      refresh = config.refreshInterval,
      retry = config.retryInterval,
      roots = FileRootsSource(config.acceptedRootsFile),
      revocation = HttpRevocationFetcher(config.revocationUrl, config.fetchTimeout, config.revocationMaxBytes),
      metrics = metrics,
      log = log,
    )
  val policy =
    PolicyVerifier(PolicyVerifier.Policy(config.packageName, config.signingDigests), clock, metrics, log)
  val server = VerifierServer(config, trust, policy, metrics, log, clock)

  Runtime.getRuntime()
    .addShutdownHook(
      Thread {
        log.event("INFO", "stopping")
        server.close()
        trust.close()
      }
    )
  trust.start()
  server.start()
}
