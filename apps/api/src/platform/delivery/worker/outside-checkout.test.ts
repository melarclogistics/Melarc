import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CaptureDirectoryInsideCheckoutError,
  CaptureDirectoryNotPrivateError,
  assertOutsideCheckout,
  assertPrivateDirectory,
  checkoutRootOf,
  isInside,
} from './outside-checkout.js';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'melarc-checkout-test-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('the capture sink stays out of the checkout (S0.18)', () => {
  // Break caught: a checkout not recognised, so that a sink inside it is allowed; a worktree has a .git file, not a directory.
  it('finds the root of a checkout from a folder inside it, whether .git is a directory or a file', async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'apps', 'api'), { recursive: true });
    const worktree = join(base, 'worktree');
    await mkdir(join(worktree, 'src'), { recursive: true });
    await writeFile(join(worktree, '.git'), 'gitdir: elsewhere');

    expect(checkoutRootOf(join(repo, 'apps', 'api'))).toBe(repo);
    expect(checkoutRootOf(join(worktree, 'src'))).toBe(worktree);
    expect(checkoutRootOf(base)).toBeUndefined();
  });

  // Break caught: a path inside the root taken for outside it (the prefix of a name is not its folder), or the root itself taken for outside.
  it('says a folder is inside the root when it is the root or below it, and not when it only shares a prefix', () => {
    const root = join(base, 'repo');

    expect(isInside(root, root)).toBe(true);
    expect(isInside(join(root, 'tmp', 'capture'), root)).toBe(true);
    expect(isInside(join(base, 'repo-capture'), root)).toBe(false);
    expect(isInside(join(base, 'capture'), root)).toBe(false);
    expect(isInside(base, root)).toBe(false);
  });

  // G2-01. Break caught: a relative path that merely begins with two dots taken for one that leaves the root. A folder named
  // "..capture" is an ordinary child of the checkout, and the check that treated every such name as outside accepted a sink in it.
  // Only the exact parent ("..") or a parent followed by the separator ("../x") leaves the root.
  it('judges containment by path components: a child named with leading dots is inside, the parent and a sibling are not', () => {
    const root = join(base, 'repo');

    expect(isInside(root, root)).toBe(true);
    expect(isInside(join(root, 'child'), root)).toBe(true);
    expect(isInside(join(root, 'child', 'nested', 'deeper'), root)).toBe(true);
    expect(isInside(join(root, '..capture'), root)).toBe(true);
    expect(isInside(join(root, '...'), root)).toBe(true);
    expect(isInside(join(root, '..capture', 'inner'), root)).toBe(true);
    expect(isInside(join(root, '.hidden'), root)).toBe(true);
    // The actual parent, a sibling, a sibling that shares the root's prefix, and a sibling named with leading dots.
    expect(isInside(base, root)).toBe(false);
    expect(isInside(join(base, 'sibling'), root)).toBe(false);
    expect(isInside(join(base, 'repo-capture'), root)).toBe(false);
    expect(isInside(join(base, '..capture'), root)).toBe(false);
    expect(isInside(join(root, '..', 'sibling'), root)).toBe(false);
    expect(isInside(join(root, '..'), root)).toBe(false);
  });

  // G2-01. Break caught: roots that share no ancestor taken for nested. A different drive has no relative path at all.
  it.skipIf(process.platform !== 'win32')(
    'says a folder on another drive is outside the root',
    () => {
      expect(isInside('D:\\capture', 'C:\\repo')).toBe(false);
      expect(isInside('C:\\repo\\..capture', 'C:\\repo')).toBe(true);
    },
  );

  // G2-01. The previously accepted path: a sink named "..capture" directly in the checkout was accepted because its relative path
  // began with two dots. It is refused, from the working directory or from the application's folder, and so is one below it.
  it('refuses a sink named with leading dots inside the checkout, which was once accepted', async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'apps', 'api'), { recursive: true });
    const startingPoints = [join(repo, 'apps', 'api')];

    expect(() => {
      assertOutsideCheckout(join(repo, '..capture'), startingPoints);
    }).toThrow(CaptureDirectoryInsideCheckoutError);
    expect(() => {
      assertOutsideCheckout(join(repo, '..capture', 'nested'), startingPoints);
    }).toThrow(CaptureDirectoryInsideCheckoutError);
    expect(() => {
      assertOutsideCheckout(join(base, '..capture'), startingPoints);
    }).not.toThrow();
  });

  // Break caught: a sink in the repository accepted (it would sit beside the sources the package is built from), or one beside it refused.
  it('refuses a sink in the checkout, from the working directory or from the application, and accepts one outside', async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'apps', 'api'), { recursive: true });
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere);

    expect(() => {
      assertOutsideCheckout(join(repo, 'tmp', 'capture'), [join(repo, 'apps', 'api')]);
    }).toThrow(CaptureDirectoryInsideCheckoutError);
    expect(() => {
      assertOutsideCheckout(join(repo, 'apps', 'api', 'out'), [elsewhere, join(repo, 'apps')]);
    }).toThrow(CaptureDirectoryInsideCheckoutError);
    expect(() => {
      assertOutsideCheckout(join(base, 'capture'), [join(repo, 'apps', 'api'), elsewhere]);
    }).not.toThrow();
  });

  // Break caught: a sink reached through a link into the checkout (a symbolic link, or a junction on Windows) accepted because its
  // written path is outside: the files land in a folder the source package is built from. The part of the path that does not exist yet
  // is judged by the part that does.
  it('refuses a sink that a link leads into the checkout, whether or not the folder exists yet', async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'apps', 'api'), { recursive: true });
    await mkdir(join(repo, 'tmp'), { recursive: true });
    const link = join(base, 'link');
    await symlink(join(repo, 'tmp'), link, process.platform === 'win32' ? 'junction' : 'dir');
    const startingPoints = [join(repo, 'apps', 'api')];

    expect(() => {
      assertOutsideCheckout(join(link, 'capture'), startingPoints);
    }).toThrow(CaptureDirectoryInsideCheckoutError);
    expect(() => {
      assertOutsideCheckout(join(link, 'not', 'made', 'yet'), startingPoints);
    }).toThrow(CaptureDirectoryInsideCheckoutError);
    expect(() => {
      assertOutsideCheckout(link, startingPoints);
    }).toThrow(CaptureDirectoryInsideCheckoutError);
  });

  // Break caught: the checkout itself reached through a link (the working directory is a link into it): the sink is compared with where
  // the checkout really is.
  it('refuses a sink inside the checkout when the checkout is reached through a link', async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'apps', 'api'), { recursive: true });
    const viaLink = join(base, 'checkout-link');
    await symlink(repo, viaLink, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => {
      assertOutsideCheckout(join(repo, 'tmp', 'capture'), [join(viaLink, 'apps', 'api')]);
    }).toThrow(CaptureDirectoryInsideCheckoutError);
    expect(() => {
      assertOutsideCheckout(join(base, 'elsewhere', 'capture'), [join(viaLink, 'apps', 'api')]);
    }).not.toThrow();
  });

  // Break caught: the refusal naming the path (a path in a log is harmless, but the rule is that a problem names a setting, never a value).
  it('names the setting and not the path', () => {
    const error = new CaptureDirectoryInsideCheckoutError();

    expect(error.message).toContain('DELIVERY_CAPTURE_DIRECTORY');
    expect(error.message).not.toContain(base);
  });
});

describe('the capture sink is private to its user (S0.18)', () => {
  const folder = (mode: number, uid = 1000) => ({
    isDirectory: () => true,
    mode: 0o040000 | mode,
    uid,
  });
  const posix = (stat: { isDirectory(): boolean; mode: number; uid: number } | undefined) => ({
    platform: 'linux' as const,
    userId: 1000,
    stat: () => stat,
  });

  // Break caught: a folder that other users can read or enter accepted for messages that hold a live link in clear, or one that
  // another user owns.
  it.each([
    ['readable by its group', 0o750],
    ['writable by its group', 0o770],
    ['writable by its group alone', 0o720],
    ['entered by its group alone', 0o710],
    ['readable by everyone', 0o755],
    ['open to everyone', 0o777],
    ['entered by others only', 0o701],
    ['written by others alone', 0o702],
    ['read by others alone', 0o704],
  ])('refuses an existing folder that is %s', (_label, mode) => {
    expect(() => {
      assertPrivateDirectory(join(base, 'sink'), posix(folder(mode)));
    }).toThrow(CaptureDirectoryNotPrivateError);
  });

  it('refuses an existing folder that another user owns, though its mode is private', () => {
    expect(() => {
      assertPrivateDirectory(join(base, 'sink'), posix(folder(0o700, 0)));
    }).toThrow(CaptureDirectoryNotPrivateError);
  });

  // Break caught: a private folder, or one that is not made yet (the sink makes it private), refused.
  it('accepts a folder only its user can enter, and one that does not exist yet', () => {
    expect(() => {
      assertPrivateDirectory(join(base, 'sink'), posix(folder(0o700)));
    }).not.toThrow();
    expect(() => {
      assertPrivateDirectory(join(base, 'sink'), posix(folder(0o500)));
    }).not.toThrow();
    expect(() => {
      assertPrivateDirectory(join(base, 'sink'), posix(undefined));
    }).not.toThrow();
  });

  // Break caught: a Windows folder judged by permission bits it does not have (Node reports 0o666 or 0o777 there): it is the user's
  // profile that keeps it private, as the settings files are.
  it('does not judge a folder on Windows, where Node reports no permission bits', () => {
    expect(() => {
      assertPrivateDirectory(join(base, 'sink'), {
        platform: 'win32',
        userId: undefined,
        stat: () => folder(0o777),
      });
    }).not.toThrow();
  });

  // Break caught: the refusal naming the path, or a file where the folder should be taken for a folder.
  it('names the setting and not the path, and refuses a file where the folder should be', () => {
    const error = new CaptureDirectoryNotPrivateError();

    expect(error.message).toContain('DELIVERY_CAPTURE_DIRECTORY');
    expect(error.message).not.toContain(base);
    expect(() => {
      assertPrivateDirectory(join(base, 'sink'), {
        platform: 'linux',
        userId: 1000,
        stat: () => ({ isDirectory: () => false, mode: 0o100600, uid: 1000 }),
      });
    }).toThrow(CaptureDirectoryNotPrivateError);
  });

  // The real file system, where it has permission bits: a folder made with the mode the sink asks for is private to its user.
  it.skipIf(process.platform === 'win32')(
    'accepts a real folder made private, and refuses one made open',
    async () => {
      const { chmod } = await import('node:fs/promises');
      const sink = join(base, 'real-sink');
      await mkdir(sink, { mode: 0o700 });
      await chmod(sink, 0o700);
      expect(() => {
        assertPrivateDirectory(sink);
      }).not.toThrow();

      await chmod(sink, 0o755);
      expect(() => {
        assertPrivateDirectory(sink);
      }).toThrow(CaptureDirectoryNotPrivateError);
    },
  );
});
