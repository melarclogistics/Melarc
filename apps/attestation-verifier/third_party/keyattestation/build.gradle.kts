// The pinned release of android/keyattestation (v0.4, commit 621149c), compiled from the vendored sources. The sources are byte for byte
// the release's (the task `verifyVendoredSources` holds them to FILES.sha256); this file is Melarc's, and replaces the release's own build
// file (its test-logger and toolchain-resolver plugins, its Maven publication and the generated Google trust anchors are not used here:
// the accepted roots are the service's configuration, not a constant of the library).
import java.security.MessageDigest

plugins {
  alias(libs.plugins.kotlin.jvm)
  `java-library`
}

kotlin { jvmToolchain(21) }

dependencies {
  implementation(libs.androidx.annotation)
  implementation(libs.cbor)
  api(libs.errorprone.annotations)
  api(libs.protobuf.javalite)
  implementation(libs.protobuf.kotlin.lite)
  api(libs.bouncycastle.bcpkix)
  api(libs.kotlin.stdlib)
  api(libs.coroutines.core)
  implementation(libs.coroutines.guava)
  api(libs.guava)
}

val verifyVendoredSources by tasks.registering {
  group = "verification"
  description = "Holds the vendored sources to the checksums of the pinned release (FILES.sha256)."
  // Everything the action reads is captured here, as plain values: the action runs under the configuration cache and holds no script
  // object.
  val list = layout.projectDirectory.file("FILES.sha256").asFile
  val root = layout.projectDirectory.asFile
  val vendored = fileTree(root) { include("src/**", "LICENSE", "roots.json") }
  inputs.file(list)
  inputs.files(vendored)
  doLast {
    val expected =
      list.readLines().filter { it.isNotBlank() }.associate {
        val (hash, path) = it.split("  ", limit = 2)
        path to hash
      }
    fun sha256(file: File): String =
      MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { byte ->
        "%02x".format(byte)
      }
    val actual: Map<String, String> =
      vendored.files.associate { file ->
        file.relativeTo(root).invariantSeparatorsPath to sha256(file)
      }
    val problems = buildList {
      for ((path, hash) in expected) {
        when {
          path !in actual -> add("missing: $path")
          actual.getValue(path) != hash -> add("changed: $path")
        }
      }
      for (path in actual.keys) if (path !in expected) add("not in the release: $path")
    }
    if (problems.isNotEmpty()) {
      throw GradleException(
        "The vendored sources are not the pinned release's:\n" + problems.joinToString("\n")
      )
    }
  }
}

tasks.named("check") { dependsOn(verifyVendoredSources) }
tasks.named("compileKotlin") { dependsOn(verifyVendoredSources) }
