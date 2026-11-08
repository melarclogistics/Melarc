// The private attestation verifier service (S0.55; SECURITY_DESIGN.md section 15.2.3). Its build is independent of Node package discovery:
// it is not a pnpm workspace package, and nothing in it is reached through node_modules.
pluginManagement {
  repositories {
    gradlePluginPortal()
    mavenCentral()
  }
}

dependencyResolutionManagement {
  repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
  repositories {
    mavenCentral()
    // `androidx.annotation` (the `@RequiresApi` markers of the vendored library) is published to Google's Maven repository alone, so that
    // repository is asked for that group and nothing else. Every artifact it serves is pinned by gradle/verification-metadata.xml.
    google {
      content { includeGroupByRegex("androidx[.].*") }
    }
  }
}

rootProject.name = "melarc-attestation-verifier"

include(":keyattestation", ":service")

// The pinned release of android/keyattestation, vendored byte for byte (third_party/keyattestation/PROVENANCE.md).
project(":keyattestation").projectDir = file("third_party/keyattestation")
