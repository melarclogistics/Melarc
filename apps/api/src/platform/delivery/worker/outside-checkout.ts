import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The capture adapter's sink holds every message in clear, tokens included, and "a sink outside the repository, restricted, never
 * inside `package:source`" is the rule (plan S0.18). The source package is built from the checkout, so a sink inside it could end up
 * in an archive that is shared for review. The worker therefore refuses to start with a sink in the checkout it runs from, **wherever
 * the path leads**: a symbolic link, a junction, a short name or a case that only differs on this file system puts a folder inside the
 * checkout though its written path is outside it, so the folder and the checkout are both compared as the operating system resolves
 * them. And a sink that already exists must be private to its user, where the file system has permission bits to say so.
 */

/** The folder that holds a `.git` entry (a directory, or the file a worktree has), found from `start` upwards; undefined if none. */
export function checkoutRootOf(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    if (existsSync(resolve(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Whether `directory` is `root` or lies inside it, comparing paths as the platform does and by path components. The relative path
 * leaves the root only when it is exactly `..` or begins with `..` and the separator; a child whose name merely begins with dots
 * (`..capture`) is inside, and a different drive has no relative path (it comes back absolute).
 */
export function isInside(directory: string, root: string): boolean {
  const path = relative(resolve(root), resolve(directory));
  if (path === '') return true;
  if (isAbsolute(path)) return false;
  return path !== '..' && !path.startsWith(`..${sep}`);
}

/**
 * The path as the operating system resolves it: every link in the part that exists is followed, and what does not exist yet (the sink
 * is made when the first message is written) is added back unchanged. A path nothing of which can be resolved is returned as written.
 */
export function resolvedPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(existing);
      return missing.length === 0 ? real : join(real, ...missing.toReversed());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/** The sink was configured inside the checkout the worker runs from. The message names the setting, never the path. */
export class CaptureDirectoryInsideCheckoutError extends Error {
  constructor() {
    super(
      'DELIVERY_CAPTURE_DIRECTORY is inside the checkout: the capture sink holds messages in clear and must be outside the repository.',
    );
    this.name = 'CaptureDirectoryInsideCheckoutError';
  }
}

/**
 * Refuses a sink directory inside any of the checkouts the process can be said to run from (the working directory's and the
 * application's own), and does nothing where there is no checkout, as in a deployed image.
 */
export function assertOutsideCheckout(directory: string, startingPoints: readonly string[]): void {
  const where = resolvedPath(directory);
  for (const start of startingPoints) {
    const root = checkoutRootOf(start);
    if (root === undefined) continue;
    if (isInside(directory, root) || isInside(where, resolvedPath(root))) {
      throw new CaptureDirectoryInsideCheckoutError();
    }
  }
}

/** The sink exists and other users could read or enter it, or another user owns it. The message names the setting, never the path. */
export class CaptureDirectoryNotPrivateError extends Error {
  constructor() {
    super(
      'DELIVERY_CAPTURE_DIRECTORY is not private to its user: the capture sink holds messages in clear, and its folder must be owned by the user the worker runs as, with no access for anyone else.',
    );
    this.name = 'CaptureDirectoryNotPrivateError';
  }
}

/** What the check reads of the file system, replaceable so that it can be shown on any platform. */
export interface PrivacyProbe {
  readonly platform: NodeJS.Platform;
  readonly userId: number | undefined;
  stat(path: string): { isDirectory(): boolean; mode: number; uid: number } | undefined;
}

const ON_THIS_MACHINE: PrivacyProbe = {
  platform: process.platform,
  userId: process.getuid?.(),
  stat: (path) => {
    try {
      return statSync(path);
    } catch {
      return undefined;
    }
  },
};

/**
 * Refuses a sink folder that exists and is not private to the worker's user: owned by another user, or with any permission for group
 * or others. A folder that does not exist yet is made private by the sink (mode 0700). On Windows Node reports no permission bits, and
 * the folder belongs in the user's profile, as the settings files do, so nothing is judged there.
 */
export function assertPrivateDirectory(
  directory: string,
  probe: PrivacyProbe = ON_THIS_MACHINE,
): void {
  if (probe.platform === 'win32') return;
  const found = probe.stat(directory);
  if (found === undefined) return;
  const ownedByUs = probe.userId === undefined || found.uid === probe.userId;
  if (!found.isDirectory() || !ownedByUs || (found.mode & 0o077) !== 0) {
    throw new CaptureDirectoryNotPrivateError();
  }
}
