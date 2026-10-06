import { posix } from 'node:path';

export interface SourceFile {
  /** Path relative to src/, with forward slashes. */
  readonly path: string;
  readonly text: string;
}

/** `from '...'`, a side-effect `import '...'` and a dynamic `import('...')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

/**
 * SOLUTION_ARCHITECTURE.md §5: "Nothing in platform/ may depend on a domain module." Every relative
 * import in a production file under platform/ must resolve inside platform/. Tests are exempt: they
 * build the whole application. Packages are never flagged.
 */
export function findPlatformBoundaryViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith('platform/') || file.path.endsWith('.test.ts')) continue;

    for (const match of file.text.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(file.path), specifier));
      if (!resolved.startsWith('platform/')) {
        violations.push(`${file.path} imports ${specifier}, which is outside platform/`);
      }
    }
  }
  return violations;
}
