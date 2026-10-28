import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The folder of a package, found from the folder of another package that depends on it. pnpm lets a package see only what it names, so a
 * package that the portal does not name (one React Aria Components brings) can only be found through the one that brings it. A package whose
 * "exports" hides its package.json is found from its entry point, by walking up to the folder that holds it.
 */
export function packageDirectory(fromDirectory: string, name: string): string {
  const resolver = createRequire(join(fromDirectory, 'package.json'));
  try {
    return dirname(resolver.resolve(`${name}/package.json`));
  } catch {
    let directory = dirname(resolver.resolve(name));
    for (;;) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest) && readFileSync(manifest, 'utf8').includes(`"name": "${name}"`)) {
        return directory;
      }
      const parent = dirname(directory);
      if (parent === directory)
        throw new Error(`${name} has no package.json above its entry point.`);
      directory = parent;
    }
  }
}
