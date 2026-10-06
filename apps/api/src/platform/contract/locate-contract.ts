import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const CONTRACT_PATH = join('contracts', 'openapi.yaml');

/**
 * The canonical contract, found by walking up from `startDirectory` to the repository root. The check runs
 * from the monorepo, from source in tests and from `dist/` as a command, and the contract is at the same
 * place relative to the root in each.
 */
export function locateContract(startDirectory: string): string {
  let directory = resolve(startDirectory);
  for (;;) {
    const candidate = join(directory, CONTRACT_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Cannot find ${CONTRACT_PATH} in or above ${startDirectory}.`);
    }
    directory = parent;
  }
}
