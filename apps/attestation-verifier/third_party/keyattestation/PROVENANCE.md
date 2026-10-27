# The vendored `android/keyattestation` library

The verifier service ([../../CLAUDE.md](../../CLAUDE.md)) does not parse or validate an attestation chain itself: it uses Google's own library for that, and adds the policy of [SECURITY_DESIGN.md §15.2.1](../../../../architecture/SECURITY_DESIGN.md) on top. This file says exactly what the library is, so that it can be checked and replaced.

## What is vendored

| | |
|---|---|
| Source | <https://github.com/android/keyattestation>, tag `v0.4` |
| Commit | `621149c4ebaeeea844d6f43098687c73c4d370a3` (`git ls-remote` of the tag; the archive's own header names the same commit) |
| Licence | Apache-2.0, in [LICENSE](LICENSE); every vendored source file keeps its header. The release has no `NOTICE` file |
| Taken | `src/main/kotlin/**` (13 files), `LICENSE` and `roots.json`, byte for byte |
| Not taken | the release's tests, its test data (the real chains are converted into [../../fixtures/real-chains.v1.json](../../fixtures/real-chains.v1.json)), its demo app and its Gradle build |
| Ours | [build.gradle.kts](build.gradle.kts), which replaces the release's build file: no publication, no generated trust anchors (the accepted roots are the service's configuration, not a constant of the library), the task below |

[FILES.sha256](FILES.sha256) holds the SHA-256 of every vendored file. The task `verifyVendoredSources` (part of `check` and a dependency of `compileKotlin`) fails on a file that changed, one that is missing and one that the release does not have, so the library cannot drift unseen.

The Maven Central artifact is not used: it carries generated Google trust anchors and a build this project does not control, and a source drop can be read, diffed and checksummed.

## How it is used

- **Parsing and path validation** are the library's (`Verifier`, `KeyAttestationCertPath`, `KeyDescription`): its path validator reads the attestation extension from the one target certificate and refuses a chain extended past it or carrying the extension elsewhere (the chain-extension attack), and treats a factory chain's expired certificates leniently (the design's one exception, §15.2.1 step 3).
- **Its own constraints are switched off** in `PolicyVerifier.libraryVerifier` (the application identity, origin, security level and root of trust): the policy checks each in the order of the design and with the design's meaning (exactly one package, *every* signing digest approved, the hardware-enforced root of trust alone).
- **Roots**: `roots.json` is the release's list (the RSA root of 2022 and the elliptic-curve root `Key Attestation CA1` of 2025). The service reads the accepted roots from its own configuration file; the qualification test judges the real chains against this one. A software attestation root is refused twice (the loader and the library).

## Behaviour to know

- An authorization list with a **tag the release does not know** is refused as malformed (`EVIDENCE_MALFORMED`). A new Android version that adds a tag would be refused until the library is updated: watch the rate of `attestation_integrity_failures_total{cause="EVIDENCE_MALFORMED"}`.
- A **repeated tag** in one list keeps the last (a map), and a list out of ascending order is only logged. Neither can be forged without the attestation key, so neither is exploitable; they are why the policy never reads a field the TEE did not sign.
- Expiry is ignored for the non-leaf certificates of a **factory-provisioned** chain (not-yet-valid never is) and judged for a remotely provisioned one.

## Dependencies

The versions of [../../gradle/libs.versions.toml](../../gradle/libs.versions.toml) are exact and [../../gradle/verification-metadata.xml](../../gradle/verification-metadata.xml) holds the SHA-256 of every artifact, the build's own plugin classpath included. Kotlin and BouncyCastle are newer than the release's own (2.2.0 and 1.78.1) on purpose, because of advisories that touch this service: the reason is written in the catalogue. The pinned set was checked against osv.dev on the day it was pinned and had no advisory.

## Updating it

1. Take the new tag's `src/main/kotlin`, `LICENSE` and `roots.json` into this folder; regenerate [FILES.sha256](FILES.sha256) (`sha256sum`, paths relative to this folder) and change the tag and commit above.
2. Read the diff of the sources, not the summary of the release: the parsers and the path validator are what the service stakes its decision on.
3. Move the dependency versions to the release's if they are newer than ours, and check every artifact against osv.dev; regenerate `gradle/verification-metadata.xml` from an empty file (`./gradlew --write-verification-metadata sha256 --rerun-tasks check installDist`), so that no stale entry stays.
4. Re-convert the real chains (`node fixtures/convert-real-chains.mjs <the unpacked release> > fixtures/real-chains.v1.json`) and run the whole suite: the qualification test, the adversarial fixtures and the process tests all hold the new library to the old behaviour.
5. Record the change in the plan's section for the verifier.
