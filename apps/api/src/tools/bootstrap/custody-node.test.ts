import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BootstrapCustodyError } from './bootstrap-vocabulary.js';
import { BUNDLE_MAGIC, type BundleContent } from './custody-bundle.js';
import {
  assertCustodyDirectory,
  NodeCustodyDisk,
  PosixPrivateAccess,
  randomBundleName,
  WindowsPrivateAccess,
  privateAccessFor,
} from './custody-node.js';
import { CustodyStore } from './custody-store.js';

/**
 * The custody adapters over the real file system and, on Windows, the real `icacls` (S0.30; OB-25). Every file here is made in a
 * disposable folder of the operating system's temporary directory and holds a sentinel that is not a secret: **no real custody file
 * and no real credential is made** (the open item of the plan about this machine). The POSIX mode inspection runs where there are
 * permission bits (Linux, CI) and the Windows access-list inspection runs on Windows: each is skipped on the other, and the plan
 * records which has run where (OB-25).
 */
const SENTINEL = 'sentinel-NOT-A-SECRET-0000000000000000000000';

let folder: string;
let counter = 0;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'melarc-custody-test-'));
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

const fresh = (): string => join(folder, `bundle-${String((counter += 1))}.txt`);

const TARGET = 'c3'.repeat(16);

const content = (): BundleContent => ({
  target: TARGET,
  purpose: 'BOOTSTRAP_SETUP',
  custodian: { fullName: 'Test Custodian', workEmail: 'custodian@melarc.example' },
  secret: SENTINEL,
  issuedAt: new Date('2026-10-21T08:00:00.000Z'),
  expiresAt: null,
});

describe('the disk of the custody store', () => {
  const disk = new NodeCustodyDisk();

  // Break caught: exclusive creation replaced by a truncating write, which would destroy a bundle that holds a secret somebody
  // still needs.
  it('creates a file exclusively and refuses a name that exists, leaving it as it was', async () => {
    const path = fresh();
    const file = await disk.createExclusive(path);
    await file.write('first');
    await file.close();
    await expect(disk.createExclusive(path)).rejects.toMatchObject({ problem: 'FILE_EXISTS' });
    expect(readFileSync(path, 'utf8')).toBe('first');
  });

  it('refuses a name that is a link, as it refuses any name that exists', async () => {
    const target = fresh();
    await writeFile(target, 'target');
    const link = fresh();
    try {
      symlinkSync(target, link);
    } catch {
      return; // creating a symbolic link needs a privilege on Windows: nothing to show there
    }
    await expect(disk.createExclusive(link)).rejects.toMatchObject({ problem: 'FILE_EXISTS' });
    expect(readFileSync(target, 'utf8')).toBe('target');
  });

  it('removes a file, and says it did not when there was none', async () => {
    const path = fresh();
    await writeFile(path, 'x');
    expect(await disk.remove(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await disk.remove(path)).toBe(false);
  });

  it('reads the head of a file and no more, and lists names', async () => {
    const path = fresh();
    await writeFile(path, 'abcdefghij');
    expect(await disk.readHead(path, 4)).toBe('abcd');
    expect(await disk.readHead(path, 100)).toBe('abcdefghij');
    expect(await disk.listNames(folder)).toContain(path.slice(folder.length + 1));
    expect(await disk.listNames(join(folder, 'missing'))).toEqual([]);
  });

  it('makes a folder that is not there', async () => {
    const path = join(folder, 'made', 'twice');
    await disk.ensureDirectory(path);
    await disk.ensureDirectory(path);
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a folder that others can read or enter, and accepts a private one',
    async () => {
      const open = join(folder, 'open');
      await disk.ensureDirectory(open);
      chmodSync(open, 0o755);
      expect(() => {
        disk.assertPrivateDirectory(open);
      }).toThrow(BootstrapCustodyError);
      chmodSync(open, 0o700);
      expect(() => {
        disk.assertPrivateDirectory(open);
      }).not.toThrow();
      expect(() => {
        disk.assertPrivateDirectory(join(folder, 'absent'));
      }).toThrow(BootstrapCustodyError);
    },
  );
});

describe('the folder the bundles go in', () => {
  it('is named, absolute and outside the checkout', () => {
    expect(assertCustodyDirectory(folder, [process.cwd()])).toBe(folder);
    expect(() => assertCustodyDirectory(undefined, [])).toThrow(BootstrapCustodyError);
    expect(() => assertCustodyDirectory('   ', [])).toThrow(BootstrapCustodyError);
    for (const [value, problem] of [
      [undefined, 'DIRECTORY_MISSING'],
      ['', 'DIRECTORY_MISSING'],
      ['relative/path', 'DIRECTORY_NOT_ABSOLUTE'],
      ['./custody', 'DIRECTORY_NOT_ABSOLUTE'],
    ] as const) {
      try {
        assertCustodyDirectory(value, [process.cwd()]);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as BootstrapCustodyError).problem, String(value)).toBe(problem);
      }
    }
  });

  // Break caught: a custody folder inside the repository, which the source package is built from and so could carry a secret in
  // clear into an archive shared for review.
  it('refuses a folder inside the checkout, whether it exists or not and however the path is spelled', () => {
    const checkout = process.cwd();
    for (const inside of [
      checkout,
      join(checkout, 'custody'),
      join(checkout, 'a', '..', 'b'),
      join(checkout, 'tmp', 'x'),
    ]) {
      try {
        assertCustodyDirectory(inside, [checkout]);
        throw new Error(`expected a refusal for ${inside}`);
      } catch (error) {
        expect((error as BootstrapCustodyError).problem).toBe('DIRECTORY_INSIDE_CHECKOUT');
      }
    }
  });

  it('refuses a folder inside the checkout from any starting point the process runs from', () => {
    expect(() =>
      assertCustodyDirectory(join(process.cwd(), 'custody'), ['/nowhere', process.cwd()]),
    ).toThrow(BootstrapCustodyError);
  });

  // Break caught: the check of the path as it is written alone, so that a link or a junction that lives outside the checkout and
  // leads into it puts the custody folder in the checkout all the same: the source package is built from there. A junction needs no
  // privilege on Windows and a symbolic link needs none elsewhere, so this runs everywhere and is never skipped for want of one.
  it('refuses a folder that a link or junction outside the checkout leads into it, and accepts one that leads elsewhere', async () => {
    const checkout = process.cwd();
    const into = join(folder, `link-into-checkout-${String((counter += 1))}`);
    symlinkSync(checkout, into, 'junction');
    const elsewhere = join(folder, `link-elsewhere-${String((counter += 1))}`);
    const target = join(folder, `target-${String((counter += 1))}`);
    await mkdir(target);
    symlinkSync(target, elsewhere, 'junction');

    for (const inside of [into, join(into, 'custody'), join(into, 'a', 'b')]) {
      try {
        assertCustodyDirectory(inside, [checkout]);
        throw new Error(`expected a refusal for ${inside}`);
      } catch (error) {
        expect((error as BootstrapCustodyError).problem, inside).toBe('DIRECTORY_INSIDE_CHECKOUT');
      }
    }
    expect(assertCustodyDirectory(join(elsewhere, 'custody'), [checkout])).toBe(
      join(elsewhere, 'custody'),
    );
  });
});

describe.skipIf(process.platform === 'win32')(
  'the access of a bundle on POSIX (OB-25: the mode inspection, run on Linux or CI)',
  () => {
    const access = new PosixPrivateAccess();

    // The folder's mode and owner are judged by the disk before the store asks, so the access has nothing to add.
    it('leaves the judgement of the folder to the disk', async () => {
      expect(await access.inspectDirectory()).toBe('PRIVATE');
    });

    it('makes the mode 0600 and finds the file private', async () => {
      const path = fresh();
      await writeFile(path, 'x', { mode: 0o666 });
      chmodSync(path, 0o666);
      expect(await access.inspect(path)).toBe('REFUSED');
      await access.secure(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(await access.inspect(path)).toBe('PRIVATE');
    });

    // Break caught: each way a file that looks private is not: group or other permission, a second name, a link, a file that is gone.
    it('refuses a file with any permission for group or others, or a second hard link, or a link', async () => {
      for (const mode of [0o640, 0o604, 0o660, 0o606, 0o666, 0o700 | 0o010]) {
        const path = fresh();
        await writeFile(path, 'x');
        chmodSync(path, mode);
        expect(await access.inspect(path), mode.toString(8)).toBe('REFUSED');
      }
      const path = fresh();
      await writeFile(path, 'x');
      chmodSync(path, 0o600);
      linkSync(path, fresh());
      expect(await access.inspect(path)).toBe('REFUSED');

      const target = fresh();
      await writeFile(target, 'x');
      chmodSync(target, 0o600);
      const link = fresh();
      symlinkSync(target, link);
      expect(await access.inspect(link)).toBe('REFUSED');
      expect(await access.inspect(join(folder, 'absent'))).toBe('UNVERIFIED');
    });
  },
);

describe.skipIf(process.platform !== 'win32')(
  'the access of a bundle on Windows (OB-25: the access list inspection)',
  () => {
    const access = new WindowsPrivateAccess();
    const icacls = (...args: string[]): string =>
      execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), args, {
        encoding: 'utf8',
        windowsHide: true,
      });

    // Break caught: the inspection passing the access a file inherits from the folder it is made in, which is the user, the system and
    // the administrators, all inherited, and which changes whenever the folder's list does.
    it('refuses a file as the folder made it, and finds it private once the inheritance is removed and the user alone is granted', async () => {
      const path = fresh();
      await writeFile(path, 'x');
      expect(await access.inspect(path)).toBe('REFUSED');
      await access.secure(path);
      expect(await access.inspect(path)).toBe('PRIVATE');
    });

    it('refuses a private file the moment a broad group is given access, or the inheritance is switched back on', async () => {
      const path = fresh();
      await writeFile(path, 'x');
      await access.secure(path);
      expect(await access.inspect(path)).toBe('PRIVATE');
      icacls(path, '/grant', '*S-1-1-0:(R)');
      expect(await access.inspect(path)).toBe('REFUSED');
      icacls(path, '/remove', '*S-1-1-0');
      expect(await access.inspect(path)).toBe('PRIVATE');
      icacls(path, '/grant', '*S-1-5-32-545:(R)');
      expect(await access.inspect(path)).toBe('REFUSED');
      icacls(path, '/remove', '*S-1-5-32-545');
      expect(await access.inspect(path)).toBe('PRIVATE');
      icacls(path, '/inheritance:e');
      expect(await access.inspect(path)).toBe('REFUSED');
    });

    it('refuses a file that is private to somebody else, whoever that is', async () => {
      const path = fresh();
      await writeFile(path, 'x');
      await access.secure(path);
      icacls(path, '/grant', '*S-1-5-19:(R)'); // the local service account
      expect(await access.inspect(path)).toBe('REFUSED');
    });

    // Break caught: a folder that gives another account a way in being used for bundles: a file takes its first list from its folder,
    // and a handle another account opened before the file was made private keeps its access when the list changes.
    it('finds a folder private when only the user, the system and the administrators are named, and refuses one that names anyone else', async () => {
      const directory = join(folder, `private-folder-${String((counter += 1))}`);
      await mkdir(directory);
      const sid = /"(S-1-5-[0-9-]+)"\s*$/m.exec(
        execFileSync(
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
          ['/user', '/fo', 'csv', '/nh'],
          { encoding: 'utf8', windowsHide: true },
        ),
      )?.[1];
      expect(sid).toBeDefined();
      // Private to the user by construction: no inheritance, the user alone.
      icacls(directory, '/inheritance:r', '/grant:r', `*${String(sid)}:(OI)(CI)F`);
      expect(await access.inspectDirectory(directory)).toBe('PRIVATE');

      icacls(directory, '/grant', '*S-1-1-0:(OI)(CI)R');
      expect(await access.inspectDirectory(directory)).toBe('REFUSED');
      icacls(directory, '/remove', '*S-1-1-0');
      expect(await access.inspectDirectory(directory)).toBe('PRIVATE');

      icacls(directory, '/grant', '*S-1-5-32-545:(OI)(CI)R');
      expect(await access.inspectDirectory(directory)).toBe('REFUSED');
      icacls(directory, '/remove', '*S-1-5-32-545');

      icacls(directory, '/grant', '*S-1-5-19:(OI)(CI)R');
      expect(await access.inspectDirectory(directory)).toBe('REFUSED');
    });

    // Break caught: the store using a folder that the system could not judge, or whose list it could not read.
    it('says it could not inspect a folder when the program fails or says nothing it understands', async () => {
      const failing = new WindowsPrivateAccess(() =>
        Promise.reject(new Error('the program failed')),
      );
      expect(await failing.inspectDirectory(folder)).toBe('UNVERIFIED');
      const silent = new WindowsPrivateAccess((file) =>
        Promise.resolve(file === 'whoami.exe' ? '"x\\y","S-1-5-21-1-2-3-1001"\r\n' : ''),
      );
      expect(await silent.inspectDirectory(folder)).toBe('UNVERIFIED');
    });

    // Break caught: a failure to read the list passing as a clean bill.
    it('says it could not inspect when the program fails or says nothing it understands', async () => {
      const path = fresh();
      await writeFile(path, 'x');
      const failing = new WindowsPrivateAccess(() =>
        Promise.reject(new Error('the program failed')),
      );
      expect(await failing.inspect(path)).toBe('UNVERIFIED');
      await expect(failing.secure(path)).rejects.toBeDefined();
      const silent = new WindowsPrivateAccess((file) =>
        Promise.resolve(file === 'whoami.exe' ? '"x\\y","S-1-5-21-1-2-3-1001"\r\n' : ''),
      );
      expect(await silent.inspect(path)).toBe('UNVERIFIED');
      const noSid = new WindowsPrivateAccess(() => Promise.resolve('nothing'));
      expect(await noSid.inspect(path)).toBe('UNVERIFIED');
    });
  },
);

describe('the store over the real disk and the access of this platform', () => {
  // The whole of it on this platform: made, private, inspected, then written; swept; and discarded.
  it('writes a bundle only this user can read, sweeps it as an orphan, and leaves other files alone', async () => {
    const directory = join(folder, 'store');
    const store = new CustodyStore(new NodeCustodyDisk(), privateAccessFor(), randomBundleName);
    await store.prepare(directory);
    const written = await store.write(directory, content());
    expect(readFileSync(written.path, 'utf8')).toContain(SENTINEL);
    expect(readFileSync(written.path, 'utf8').startsWith(BUNDLE_MAGIC)).toBe(true);
    expect(await privateAccessFor().inspect(written.path)).toBe('PRIVATE');

    await writeFile(join(directory, 'notes.txt'), `${BUNDLE_MAGIC}\nnot a bundle by its name`);
    const swept = await store.sweepOrphans(directory, TARGET);
    expect(swept).toEqual({ removed: [written.name], kept: 0 });
    expect(readdirSync(directory)).toEqual(['notes.txt']);
  });

  it('discards what a run wrote', async () => {
    const directory = join(folder, 'discard');
    const store = new CustodyStore(new NodeCustodyDisk(), privateAccessFor(), randomBundleName);
    await store.prepare(directory);
    const a = await store.write(directory, content());
    const b = await store.write(directory, content());
    expect(await store.discard([a, b])).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('makes a name from 128 bits of randomness each time', () => {
    const names = new Set(Array.from({ length: 50 }, () => randomBundleName()));
    expect(names.size).toBe(50);
    for (const name of names) expect(name).toMatch(/^[0-9a-f]{32}$/);
  });
});
