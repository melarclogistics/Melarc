plugins {
  alias(libs.plugins.kotlin.jvm) apply false
}

// Reproducible archives (SOLUTION_ARCHITECTURE.md and the verifier's CLAUDE.md): the same sources give the same bytes, whatever the machine,
// the time or the order the file system lists a directory in.
allprojects {
  tasks.withType<AbstractArchiveTask>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
    filePermissions { unix("rw-r--r--") }
    dirPermissions { unix("rwxr-xr-x") }
  }
}
