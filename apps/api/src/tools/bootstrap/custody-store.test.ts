import { describe, expect, it } from 'vitest';

import { FakeAccess, FakeDisk } from '../../test-support/custody-fakes.js';
import { BootstrapCustodyError } from './bootstrap-vocabulary.js';
import { BUNDLE_MAGIC, renderBundle, type BundleContent } from './custody-bundle.js';
import { CustodyStore } from './custody-store.js';

const DIRECTORY = '/custody';
const SECRET = 'sentinel-SECRET-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** The database this run is for, and another one: 32 hexadecimal digits each. */
const TARGET = 'a1'.repeat(16);
const OTHER_TARGET = 'b2'.repeat(16);

const content = (overrides: Partial<BundleContent> = {}): BundleContent => ({
  target: TARGET,
  purpose: 'BOOTSTRAP_SETUP',
  custodian: { fullName: 'Kofi Boateng', workEmail: 'kofi.boateng@melarc.example' },
  secret: SECRET,
  issuedAt: new Date('2026-10-21T08:00:00.000Z'),
  expiresAt: null,
  ...overrides,
});

function setup() {
  const disk = new FakeDisk();
  const access = new FakeAccess(disk);
  let counter = 0;
  const store = new CustodyStore(disk, access, () => {
    counter += 1;
    return counter.toString(16).padStart(32, '0');
  });
  return { disk, access, store };
}

const failureOf = async (run: () => Promise<unknown>): Promise<BootstrapCustodyError> => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(BootstrapCustodyError);
    return error as BootstrapCustodyError;
  }
  throw new Error('expected a custody refusal');
};

describe('writing a custody bundle (S0.30)', () => {
  // Break caught: the secret written before the file is private, or before the access was read back: it would exist for a moment
  // somewhere more than the operator can read. The order is exclusive creation, privacy, inspection, and only then the secret.
  it('creates the file empty, makes it private, inspects it, and only then writes the secret', async () => {
    const { disk, store } = setup();
    const written = await store.write(DIRECTORY, content());
    expect(disk.calls).toEqual(['create', 'secure', 'inspect', 'write', 'close']);
    expect(disk.files.get(written.path)).toBe(renderBundle(content()));
    expect(disk.files.get(written.path)).toContain(SECRET);
  });

  it('names a file by randomness alone, with the name of a bundle and nothing of the custodian', async () => {
    const { store } = setup();
    const one = await store.write(DIRECTORY, content());
    const two = await store.write(DIRECTORY, content());
    expect(one.name).toMatch(/^melarc-bootstrap-[0-9a-f]{32}\.bundle$/);
    expect(one.name).not.toBe(two.name);
    expect(one.name).not.toMatch(/kofi|boateng|melarc\.example/i);
    expect(one.path).toBe(`${DIRECTORY}/${one.name}`);
  });

  // Break caught: a file that the inspection refuses (broad or inherited access) being written anyway, or being left behind empty.
  it.each([
    ['REFUSED', 'ACCESS_REFUSED'],
    ['UNVERIFIED', 'ACCESS_UNVERIFIED'],
  ] as const)(
    'refuses a file the inspection found %s: no secret is ever written, and the file is removed',
    async (verdict, problem) => {
      const { disk, access, store } = setup();
      access.verdict = verdict;
      const failure = await failureOf(() => store.write(DIRECTORY, content()));
      expect(failure.problem).toBe(problem);
      expect(disk.calls).not.toContain('write');
      expect(disk.files.size).toBe(0);
      expect(disk.calls).toEqual(['create', 'secure', 'inspect', 'close', 'remove']);
    },
  );

  // Break caught: a file system's own error passing on, with the path or the secret in it.
  it('turns any other failure into the one rule it broke, never the file system’s words', async () => {
    const securing = setup();
    securing.access.failSecure = true;
    const first = await failureOf(() => securing.store.write(DIRECTORY, content()));
    expect(first.problem).toBe('WRITE_FAILED');
    expect(first.message).not.toMatch(/icacls|secret|path/);
    expect(securing.disk.files.size).toBe(0);
    expect(securing.disk.calls).not.toContain('write');

    const writing = setup();
    writing.disk.failWrite = true;
    const second = await failureOf(() => writing.store.write(DIRECTORY, content()));
    expect(second.problem).toBe('WRITE_FAILED');
    expect(`${second.message}${String(second.stack)}`).not.toContain('ENOSPC');
    expect(writing.disk.files.size).toBe(0);
  });

  // Break caught: exclusive creation losing to an existing file (overwriting or removing a bundle that holds a secret somebody
  // still needs).
  it('never overwrites or removes a file that is already there', async () => {
    const { disk, store } = setup();
    disk.files.set(
      `${DIRECTORY}/melarc-bootstrap-${'1'.padStart(32, '0')}.bundle`,
      'someone else’s bundle',
    );
    const failure = await failureOf(() => store.write(DIRECTORY, content()));
    expect(failure.problem).toBe('FILE_EXISTS');
    expect([...disk.files.values()]).toEqual(['someone else’s bundle']);
    expect(disk.calls).toEqual(['create']);
  });

  it('names no secret and no path in a failure it raises', async () => {
    const { access, store } = setup();
    access.verdict = 'REFUSED';
    const failure = await failureOf(() => store.write(DIRECTORY, content()));
    expect(`${failure.name} ${failure.message}`).not.toContain(SECRET);
    expect(`${failure.name} ${failure.message}`).not.toContain(DIRECTORY);
  });
});

/**
 * A write that fails after its file exists removes the file; and a removal that fails leaves a file that may hold the secret, whole or
 * in part, for a pair that was never made (the audit of 21 October 2026, A05). That file is **reported by its random name** in the
 * error that carries the primary failure, which stays the primary failure: the rule that was broken is what the operator is told first,
 * and the leftover is what they are told to delete. No path, no secret and none of the file system's words are in it.
 */
describe('a write that fails and cannot clean up after itself (the audit of 21 October 2026, A05)', () => {
  const NAME = `melarc-bootstrap-${'1'.padStart(32, '0')}.bundle`;
  const PATH = `${DIRECTORY}/${NAME}`;
  const stuck = () => {
    const made = setup();
    made.disk.stuck.add(PATH);
    return made;
  };

  // Break caught: a failed write whose file could not be removed reported as a plain failure, so that a file holding the secret stays
  // in the custody folder and nobody is told.
  it.each([
    [
      'a write that stored part of the secret',
      (disk: FakeDisk): void => {
        disk.partialWriteChars = 400;
      },
      'WRITE_FAILED',
    ],
    [
      'a sync that failed after the whole secret was stored',
      (disk: FakeDisk): void => {
        disk.failSyncAfterWrite = true;
      },
      'WRITE_FAILED',
    ],
    [
      'a close that failed after the whole secret was stored',
      (disk: FakeDisk): void => {
        disk.failClose = true;
      },
      'WRITE_FAILED',
    ],
  ] as const)(
    'names the file by its random name when %s and the file could not be removed',
    async (_what, fault, problem) => {
      const { disk, store } = stuck();
      fault(disk);

      const failure = await failureOf(() => store.write(DIRECTORY, content()));

      expect(failure.problem).toBe(problem);
      expect(failure.residual).toEqual([NAME]);
      // the file really is still there, and it is the one named
      expect(disk.files.has(PATH)).toBe(true);
      expect(`${failure.name} ${failure.message} ${String(failure.stack)}`).not.toContain(SECRET);
      // the path of the file, not the folder's name alone (a stack names source files whose own names contain it)
      expect(`${failure.name} ${failure.message} ${String(failure.stack)}`).not.toContain(PATH);
      expect(`${failure.name} ${failure.message} ${String(failure.stack)}`).not.toMatch(
        /EBUSY|ENOSPC|EIO/,
      );
    },
  );

  it('keeps the rule it broke as the failure when the file that refused it cannot be removed', async () => {
    for (const [verdict, problem] of [
      ['REFUSED', 'ACCESS_REFUSED'],
      ['UNVERIFIED', 'ACCESS_UNVERIFIED'],
    ] as const) {
      const { disk, access, store } = stuck();
      access.verdict = verdict;

      const failure = await failureOf(() => store.write(DIRECTORY, content()));

      expect(failure.problem).toBe(problem);
      expect(failure.residual).toEqual([NAME]);
      // no secret was ever written to a file whose access was refused
      expect(disk.calls).not.toContain('write');
      expect(disk.files.get(PATH)).toBe('');
    }
  });

  it('keeps the file system failure as the failure when the access could not be made private and the file cannot be removed', async () => {
    const { access, store } = stuck();
    access.failSecure = true;

    const failure = await failureOf(() => store.write(DIRECTORY, content()));

    expect(failure.problem).toBe('WRITE_FAILED');
    expect(failure.residual).toEqual([NAME]);
  });

  // Break caught: a leftover reported when there is none (the file was removed, or was already gone), which sends the operator to a
  // folder with nothing to delete.
  it.each([
    ['removed', (disk: FakeDisk) => disk],
    ['already gone', (disk: FakeDisk) => (disk.gone.add(PATH), disk)],
  ] as const)(
    'reports no leftover when the file was %s, whatever failed before',
    async (_what, arrange) => {
      for (const fault of [
        (disk: FakeDisk): void => {
          disk.partialWriteChars = 400;
        },
        (disk: FakeDisk): void => {
          disk.failSyncAfterWrite = true;
        },
        (disk: FakeDisk): void => {
          disk.failClose = true;
        },
        (disk: FakeDisk): void => {
          disk.failWrite = true;
        },
      ]) {
        const { disk, store } = setup();
        arrange(disk);
        fault(disk);

        const failure = await failureOf(() => store.write(DIRECTORY, content()));

        expect(failure.problem).toBe('WRITE_FAILED');
        expect(failure.residual).toEqual([]);
        expect(disk.files.size).toBe(0);
      }
    },
  );

  // Break caught: the file removed before its handle was closed, which Windows refuses (the file is in use) and which then reads as a
  // leftover that is not there, or the close skipped so that the handle outlives the run.
  it('closes the file before it tries to remove it, and tries both even when the close fails', async () => {
    const { disk, store } = setup();
    disk.failClose = true;

    await failureOf(() => store.write(DIRECTORY, content()));

    expect(disk.calls.slice(-2)).toEqual(['close', 'remove']);
    expect(disk.calls.filter((call) => call === 'close')).toHaveLength(2);
  });

  it('reports no leftover for a failure that made no file', async () => {
    const { disk, store } = setup();
    disk.files.set(PATH, 'someone else’s bundle');
    disk.stuck.add(PATH);

    const failure = await failureOf(() => store.write(DIRECTORY, content()));

    expect(failure.problem).toBe('FILE_EXISTS');
    expect(failure.residual).toEqual([]);
    // the file that was already there is never reported as this run's leftover, and never touched
    expect(disk.files.get(PATH)).toBe('someone else’s bundle');
    expect(disk.calls).not.toContain('remove');
  });
});

describe('preparing the folder', () => {
  it('makes it, checks its mode and owner, and reads its access list, in that order', async () => {
    const { disk, store } = setup();
    await store.prepare(DIRECTORY);
    expect(disk.calls).toEqual(['ensureDirectory', 'assertPrivateDirectory', 'inspectDirectory']);
  });

  // Break caught: a folder whose access list gives another account a way in being used all the same: a file takes its first access list
  // from its folder, and a handle another account opened before the file was made private keeps the access it was given.
  it.each([
    ['REFUSED', 'a folder whose list names a broad group or another account'],
    ['UNVERIFIED', 'a folder whose list could not be read'],
  ] as const)('refuses %s: %s, before any file is made in it', async (verdict, meaning) => {
    const { disk, access, store } = setup();
    access.directoryVerdict = verdict;

    const failure = await failureOf(() => store.prepare(DIRECTORY));

    expect(failure.problem, meaning).toBe('DIRECTORY_NOT_PRIVATE');
    expect(disk.calls).not.toContain('create');
    expect(`${failure.name} ${failure.message}`).not.toContain(DIRECTORY);
  });
});

describe('sweeping the bundles of a run that did not commit', () => {
  const bundleName = (n: number): string =>
    `melarc-bootstrap-${n.toString(16).padStart(32, '0')}.bundle`;
  const path = (name: string): string => `${DIRECTORY}/${name}`;

  // Break caught: a sweep that removes a file it cannot say is its own (a name that matches and no magic, magic under another name,
  // a file it cannot read), or one that leaves a bundle it can prove is.
  it('removes the files that are provably bundles and leaves every other file alone', async () => {
    const { disk, store } = setup();
    disk.files.set(path(bundleName(1)), renderBundle(content()));
    disk.files.set(
      path(bundleName(2)),
      `${BUNDLE_MAGIC}\r\ntarget: ${TARGET}\r\nwritten on Windows`,
    );
    disk.files.set(path(bundleName(3)), BUNDLE_MAGIC);
    disk.files.set(path(bundleName(4)), 'a file that has the name of a bundle and nothing of one');
    disk.files.set(path(bundleName(5)), `${BUNDLE_MAGIC} v2 is another layout`);
    disk.files.set(path('notes.txt'), renderBundle(content()));
    disk.files.set(path('melarc-bootstrap-short.bundle'), renderBundle(content()));
    disk.files.set(path(bundleName(6)), renderBundle(content()));
    disk.unreadable.add(path(bundleName(6)));

    const swept = await store.sweepOrphans(DIRECTORY, TARGET);

    expect(swept.removed.toSorted()).toEqual([bundleName(1), bundleName(2)].toSorted());
    expect(
      [...disk.files.keys()].map((file) => file.slice(DIRECTORY.length + 1)).toSorted(),
    ).toEqual(
      [
        bundleName(3),
        bundleName(4),
        bundleName(5),
        'notes.txt',
        'melarc-bootstrap-short.bundle',
        bundleName(6),
      ].toSorted(),
    );
    // the one that is a bundle and names no target is counted, so that the operator is told, and is not removed
    expect(swept.kept).toBe(1);
  });

  // Break caught: a sweep that removes every bundle in the folder, which in a folder shared by two environments is the bundle of a pair
  // that did commit: the only copy of a secret that is still to be handed over, deleted by the seed of another database.
  it('removes the bundles of this database and keeps, and counts, the bundles of any other', async () => {
    const { disk, store } = setup();
    disk.files.set(path(bundleName(1)), renderBundle(content()));
    disk.files.set(path(bundleName(2)), renderBundle(content({ target: OTHER_TARGET })));
    disk.files.set(path(bundleName(3)), renderBundle(content({ target: OTHER_TARGET })));
    disk.files.set(path(bundleName(4)), renderBundle(content()));

    const swept = await store.sweepOrphans(DIRECTORY, TARGET);

    expect(swept.removed.toSorted()).toEqual([bundleName(1), bundleName(4)].toSorted());
    expect(swept.kept).toBe(2);
    expect([...disk.files.keys()].toSorted()).toEqual(
      [path(bundleName(2)), path(bundleName(3))].toSorted(),
    );
  });

  // Break caught: a target read from anywhere but the second line of the head, or taken when it is not 32 hexadecimal digits.
  it('takes no target from a line that is not the second, or that is not 32 hexadecimal digits', async () => {
    const { disk, store } = setup();
    disk.files.set(path(bundleName(1)), `${BUNDLE_MAGIC}\n\ntarget: ${TARGET}\n`);
    disk.files.set(path(bundleName(2)), `${BUNDLE_MAGIC}\ntarget: ${TARGET.toUpperCase()}\n`);
    disk.files.set(path(bundleName(3)), `${BUNDLE_MAGIC}\ntarget: ${TARGET}0\n`);
    disk.files.set(path(bundleName(4)), `${BUNDLE_MAGIC}\r\ntarget: ${TARGET}\r\n`);

    const swept = await store.sweepOrphans(DIRECTORY, TARGET);

    expect(swept.removed).toEqual([bundleName(4)]);
    expect(swept.kept).toBe(3);
  });

  it('removes nothing from an empty folder', async () => {
    const { disk, store } = setup();
    expect(await store.sweepOrphans(DIRECTORY, TARGET)).toEqual({ removed: [], kept: 0 });
    expect(disk.calls).toEqual([]);
  });
});

describe('discarding the bundles of a run whose pair did not commit', () => {
  it('removes each, and names the ones it could not remove, never a path', async () => {
    const { disk, store } = setup();
    const a = await store.write(DIRECTORY, content());
    const b = await store.write(DIRECTORY, content());
    const c = await store.write(DIRECTORY, content());
    disk.stuck.add(b.path);
    disk.files.delete(c.path);

    const stuck = await store.discard([a, b, c]);

    expect(stuck).toEqual([b.name]);
    expect(disk.files.has(a.path)).toBe(false);
    expect(disk.files.has(b.path)).toBe(true);
  });
});
