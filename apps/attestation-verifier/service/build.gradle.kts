plugins {
  alias(libs.plugins.kotlin.jvm)
  application
}

kotlin { jvmToolchain(21) }

dependencies {
  implementation(project(":keyattestation"))
  implementation(libs.gson)

  testImplementation(platform(libs.junit.bom))
  testImplementation(libs.junit.jupiter)
  testImplementation(libs.kotlin.test.junit5)
  testRuntimeOnly(libs.junit.platform.launcher)
}

application {
  mainClass = "com.melarc.attestation.MainKt"
  applicationName = "attestation-verifier"
  // A small, bounded process: the heap is capped, an out-of-memory error ends the process (a supervisor restarts it, and a restart loads
  // the trust data afresh) rather than leaving a half-working verifier, and outbound connections prefer IPv4 (the fetch of the revocation
  // list must not wait on an IPv6 route that goes nowhere).
  applicationDefaultJvmArgs =
    listOf(
      "-Xms64m",
      "-Xmx384m",
      "-XX:MaxMetaspaceSize=128m",
      "-XX:+ExitOnOutOfMemoryError",
      "-Dfile.encoding=UTF-8",
      "-Djava.net.preferIPv4Stack=true",
    )
}

// Writes the chains the API's tests send to the real service (apps/api/test/vectors/attestation-chains.v1.json) from this module's fixtures;
// `AttestationVectorsTest` holds the committed file to a fresh run, so the file is regenerated here and never edited by hand.
tasks.register<JavaExec>("attestationVectors") {
  group = "verification"
  description = "Regenerates apps/api/test/vectors/attestation-chains.v1.json from the deterministic fixtures"
  classpath = sourceSets["test"].runtimeClasspath
  mainClass = "com.melarc.attestation.fixtures.AttestationVectorsKt"
  args(rootProject.layout.projectDirectory.dir("../api/test/vectors").file("attestation-chains.v1.json").asFile.path)
}

tasks.test {
  useJUnitPlatform()
  maxHeapSize = "512m"
  // The real device chains of the pinned release and the roots Google publishes: the qualification test reads them from where they live.
  val verifierDirectory = rootProject.layout.projectDirectory
  systemProperty("melarc.verifier.dir", verifierDirectory.asFile.path)
  inputs.dir(verifierDirectory.dir("fixtures")).withPropertyName("fixtures")
  inputs.file(verifierDirectory.file("third_party/keyattestation/roots.json")).withPropertyName("roots")
  inputs.file(verifierDirectory.file(".env.example")).withPropertyName("settingsExample")
  // The vectors of the rider device-key protocol, which the API's tests consume and this JDK regenerates.
  val vectorsDirectory = verifierDirectory.dir("../api/test/vectors")
  systemProperty("melarc.vectors.dir", vectorsDirectory.asFile.canonicalPath)
  inputs.dir(vectorsDirectory).withPropertyName("vectors")
  testLogging {
    events("failed")
    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
  }
}
