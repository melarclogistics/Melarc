import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';

import {
  PACKAGE_INFO_PATH,
  PackageSourceError,
  denyReason,
  findLeaks,
  packageSource,
  parseStatus,
  readSecretValues,
  secretKey,
  writeZip,
  type ZipEntry,
} from './package-source.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A throwaway directory. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'melarc-package-source-'));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function put(root: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A git checkout with the given files; `commit` stages and commits everything that is not ignored. */
function repository(
  files: Record<string, string | Buffer>,
  options: { commit?: boolean } = {},
): string {
  const root = scratch();
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'core.autocrlf', 'false');
  put(root, files);
  if (options.commit ?? true) {
    git(root, 'add', '--all');
    git(root, 'commit', '--quiet', '-m', 'initial');
  }
  return root;
}

interface ReadEntry {
  path: string;
  data: Buffer;
  method: number;
  versionMadeBy: number;
  externalAttributes: number;
  flags: number;
  time: number;
  date: number;
}

/**
 * Reads a ZIP the way any extractor does (end-of-central-directory record, central directory, then each local
 * header), checking every size and checksum, so a test proves the archive is readable and not just that the writer
 * and a reader written by the same hand agree.
 */
function readZip(zip: Buffer): ReadEntry[] {
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50, 'end of central directory signature');
  assert.equal(zip.readUInt16LE(eocd + 20), 0, 'no archive comment');
  const count = zip.readUInt16LE(eocd + 10);
  assert.equal(zip.readUInt16LE(eocd + 8), count);
  const directorySize = zip.readUInt32LE(eocd + 12);
  const directoryOffset = zip.readUInt32LE(eocd + 16);
  assert.equal(
    directoryOffset + directorySize,
    eocd,
    'the directory ends where the end record starts',
  );

  const entries: ReadEntry[] = [];
  let at = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, 'central directory signature');
    const versionMadeBy = zip.readUInt16LE(at + 4);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const time = zip.readUInt16LE(at + 12);
    const date = zip.readUInt16LE(at + 14);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const externalAttributes = zip.readUInt32LE(at + 38);
    const localOffset = zip.readUInt32LE(at + 42);
    const path = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');

    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
    assert.equal(zip.readUInt16LE(localOffset + 8), method);
    assert.equal(zip.readUInt16LE(localOffset + 10), time);
    assert.equal(zip.readUInt16LE(localOffset + 12), date);
    assert.equal(zip.readUInt32LE(localOffset + 14), crc);
    assert.equal(zip.readUInt32LE(localOffset + 18), compressedSize);
    assert.equal(zip.readUInt32LE(localOffset + 22), size);
    const localName = zip.readUInt16LE(localOffset + 26);
    const localExtra = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const stored = zip.subarray(start, start + compressedSize);
    const data = method === 0 ? Buffer.from(stored) : inflateRawSync(stored);
    assert.equal(data.length, size, `${path}: size`);
    assert.equal(crc32(data), crc, `${path}: crc`);

    entries.push({ path, data, method, versionMadeBy, externalAttributes, flags, time, date });
    at += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(at, directoryOffset + directorySize, 'every directory record was read');
  return entries;
}

const names = (entries: readonly { path: string }[]): string[] =>
  entries.map((entry) => entry.path).sort();

describe('writeZip', () => {
  const entry = (path: string, text: string): ZipEntry => ({ path, data: Buffer.from(text) });

  it('writes an archive that can be read back byte for byte', () => {
    const big = Buffer.alloc(50_000, 'abc');
    const read = readZip(
      writeZip([entry('a.txt', 'hello\n'), entry('dir/b.txt', ''), { path: 'big.bin', data: big }]),
    );
    assert.deepEqual(names(read), ['a.txt', 'big.bin', 'dir/b.txt']);
    assert.equal(read.find((e) => e.path === 'a.txt')?.data.toString(), 'hello\n');
    assert.equal(read.find((e) => e.path === 'dir/b.txt')?.data.length, 0);
    assert.ok(read.find((e) => e.path === 'big.bin')?.data.equals(big));
  });

  // Break caught: an archive that differs between two runs on the same input, so two packages cannot be compared.
  it('writes the same bytes for the same input', () => {
    const entries = [entry('a.txt', 'one'), entry('b/c.txt', 'two')];
    assert.ok(writeZip(entries).equals(writeZip(entries)));
  });

  // Break caught: a clock in the archive, so the same tree gives different bytes on different days.
  it('gives every entry the earliest time a ZIP can hold', () => {
    for (const read of readZip(writeZip([entry('a.txt', 'x'), entry('b.txt', 'y')]))) {
      assert.equal(read.time, 0);
      assert.equal(read.date, (1 << 5) | 1, 'date 1980-01-01');
    }
  });

  it('keeps names as UTF-8 and says so', () => {
    const [read] = readZip(writeZip([entry('docs/résumé-日本.md', 'x')]));
    assert.ok(read !== undefined);
    assert.equal(read.path, 'docs/résumé-日本.md');
    assert.equal(read.flags & 0x0800, 0x0800);
  });

  it('stores what does not shrink, and compresses what does', () => {
    const noise = Buffer.from(Array.from({ length: 64 }, (_, index) => (index * 97 + 13) % 251));
    const read = readZip(
      writeZip([{ path: 'noise.bin', data: noise }, entry('same.txt', 'a'.repeat(10_000))]),
    );
    assert.equal(read.find((e) => e.path === 'noise.bin')?.method, 0);
    assert.equal(read.find((e) => e.path === 'same.txt')?.method, 8);
  });

  it('marks entries as Unix files that are not executable', () => {
    const [read] = readZip(writeZip([entry('a.txt', 'x')]));
    assert.equal((read?.versionMadeBy ?? 0) >> 8, 3);
    assert.equal((read?.externalAttributes ?? 0) >>> 16, 0o100644);
  });

  // Break caught: a path that extracts outside the folder it is unpacked into.
  for (const bad of ['../x', 'a/../x', '/etc/x', 'C:/x', 'a\\b', 'a//b', './a', 'a/', '']) {
    it(`refuses the path ${JSON.stringify(bad)}`, () => {
      assert.throws(() => writeZip([entry(bad, 'x')]), /path/i);
    });
  }

  it('refuses a path twice', () => {
    assert.throws(() => writeZip([entry('a', '1'), entry('a', '2')]), /twice/);
  });

  it('refuses more entries than a plain ZIP can count', () => {
    const entries = Array.from({ length: 65_536 }, (_, index) => entry(`f${String(index)}`, ''));
    // The tool's own refusal, not Node's RangeError when the count no longer fits the end record.
    assert.throws(
      () => writeZip(entries),
      (error: unknown) => error instanceof PackageSourceError && error.message.includes('65535'),
    );
  });

  it('accepts exactly as many entries as a plain ZIP can count', () => {
    const entries = Array.from({ length: 65_535 }, (_, index) => entry(`f${String(index)}`, ''));
    assert.equal(readZip(writeZip(entries)).length, 65_535);
  });
});

describe('denyReason', () => {
  const denied: [string, RegExp][] = [
    ['.env', /settings/],
    ['apps/api/.env', /settings/],
    ['apps/api/.env.local', /settings/],
    ['infrastructure/postgres/.env.old', /settings/],
    ['apps/api/.env.production', /settings/],
    ['config/production.env', /settings/],
    ['certs/server.pem', /key/],
    ['certs/server.key', /key/],
    ['certs/bundle.p12', /key/],
    ['certs/bundle.pfx', /key/],
    ['certs/store.keystore', /key/],
    ['certs/store.jks', /key/],
    ['home/.ssh/id_rsa', /key/],
    ['home/.ssh/id_dsa', /key/],
    ['home/.ssh/id_ecdsa', /key/],
    ['home/id_ed25519', /key/],
    ['.npmrc', /credential/],
    ['apps/api/.npmrc', /credential/],
    ['node_modules/pkg/index.js', /dependenc/],
    ['apps/api/node_modules/pkg/index.js', /dependenc/],
    ['.pnpm-store/v3/x', /dependenc/],
    ['apps/api/dist/main.js', /output/],
    ['build/x.js', /output/],
    ['.turbo/cache/x', /output/],
    ['coverage/lcov.info', /output/],
    ['apps/ops-web/test-results/a.png', /output/],
    ['playwright-report/index.html', /output/],
    ['out/x.js', /output/],
    ['apps/ops-web/.vite/deps/x.js', /output/],
    ['.next/server/x.js', /output/],
    ['.nyc_output/x.json', /output/],
    ['blob-report/x.zip', /output/],
    ['logs/app.log', /output/],
    ['tmp/linux-check.sh', /scratch/],
    ['temp/x.txt', /scratch/],
    ['.local-data/x.db', /scratch/],
    ['.git/config', /history/],
    ['x/.git/HEAD', /history/],
    ['.claude/settings.local.json', /agent/],
    ['.superpowers/x.md', /agent/],
    ['backup.zip', /archive/],
    ['sub/old.tar.gz', /archive/],
    ['old.tar', /archive/],
    ['old.tgz', /archive/],
    ['old.gz', /archive/],
    ['old.7z', /archive/],
    ['old.rar', /archive/],
  ];
  for (const [path, reason] of denied) {
    it(`refuses ${path}`, () => {
      assert.match(denyReason(path) ?? 'allowed', reason);
    });
  }

  // Break caught: the examples a developer needs, or ordinary source, being refused by a pattern that is too broad.
  const allowed = [
    'apps/api/.env.example',
    'infrastructure/postgres/.env.example',
    'apps/ops-web/.env.production.example',
    'pnpm-lock.yaml',
    'apps/api/migrations/0000_init.sql',
    'apps/api/src/platform/database/schema/index.ts',
    'features/accounting.md',
    'design/assets/brand/logo.svg',
    'scripts/build-manifest.ts',
    'distribution/plan.md',
    'src/environment.ts',
    'src/keyboard.ts',
    'docs/keys.md',
    'apps/api/src/platform/dist-helper.ts',
    'tmpl/x.txt',
    '.github/workflows/ci.yml',
    '.vscode/extensions.json',
  ];
  for (const path of allowed) {
    it(`allows ${path}`, () => {
      assert.equal(denyReason(path), undefined);
    });
  }

  it('matches names whatever their case', () => {
    assert.notEqual(denyReason('apps/api/.ENV'), undefined);
    assert.notEqual(denyReason('Certs/Server.PEM'), undefined);
    assert.notEqual(denyReason('Node_Modules/x'), undefined);
  });
});

describe('parseStatus', () => {
  const buffer = (...tokens: string[]): Buffer => Buffer.from(`${tokens.join('\0')}\0`, 'utf8');

  it('reads each kind of entry as the status and the path', () => {
    assert.deepEqual(parseStatus(buffer(' M a.ts', '?? b.ts', ' D c.ts', 'A  d.ts', 'MM e.ts')), [
      { status: ' M', path: 'a.ts' },
      { status: '??', path: 'b.ts' },
      { status: ' D', path: 'c.ts' },
      { status: 'A ', path: 'd.ts' },
      { status: 'MM', path: 'e.ts' },
    ]);
  });

  // Break caught: the path a file came from being read as a change of its own, with a wrong status and path.
  it('skips the old path that follows a rename or a copy', () => {
    assert.deepEqual(
      parseStatus(
        buffer(
          'R  new.ts',
          'old.ts',
          ' M a.ts',
          'C  copy.ts',
          'source.ts',
          'RM both.ts',
          'was.ts',
          '?? z.ts',
        ),
      ),
      [
        { status: 'R ', path: 'new.ts' },
        { status: ' M', path: 'a.ts' },
        { status: 'C ', path: 'copy.ts' },
        { status: 'RM', path: 'both.ts' },
        { status: '??', path: 'z.ts' },
      ],
    );
  });

  it('keeps spaces and non-ASCII characters in a path, which -z does not quote', () => {
    assert.deepEqual(parseStatus(buffer('?? a b/résumé 日本.md')), [
      { status: '??', path: 'a b/résumé 日本.md' },
    ]);
  });

  it('reads nothing as no changes', () => {
    assert.deepEqual(parseStatus(Buffer.alloc(0)), []);
    assert.deepEqual(parseStatus(Buffer.from('\0')), []);
  });
});

describe('secretKey and readSecretValues', () => {
  it('recognizes the settings that hold a credential, and not the others', () => {
    for (const key of [
      'MELARC_PG_ADMIN_PASSWORD',
      'DATABASE_URL',
      'SESSION_SECRET',
      'API_TOKEN',
      'SIGNING_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'database_url',
      'DB_PASSWD',
      'KEY_PASSPHRASE',
      'SERVICE_CREDENTIAL',
      'AWS_CREDENTIALS',
      'REPORTING_CONNECTION_STRING',
      'SENTRY_DSN',
    ]) {
      assert.equal(secretKey(key), true, key);
    }
    for (const key of [
      'HTTP_PORT',
      'MELARC_PG_HOST',
      'NODE_ENV',
      'LOG_LEVEL',
      'KEYBOARD_LAYOUT_NAME',
    ]) {
      assert.equal(secretKey(key), false, key);
    }
  });

  it('reads values from the settings files, and from the password inside a connection string', () => {
    const root = scratch();
    put(root, {
      'infrastructure/postgres/.env':
        'MELARC_PG_HOST=127.0.0.1\nMELARC_PG_ADMIN_PASSWORD=adminadminadmin1\nMELARC_PG_RUNTIME_PASSWORD=runtimeruntime22\n',
      'apps/api/.env':
        'HTTP_PORT=3000\nDATABASE_URL=postgresql://melarc_api_runtime:runtimeruntime22@127.0.0.1:5432/melarc_dev\n',
    });
    const values = readSecretValues(root, ['infrastructure/postgres/.env', 'apps/api/.env']);
    assert.ok(values.includes('adminadminadmin1'));
    assert.ok(values.includes('runtimeruntime22'));
    assert.ok(
      values.includes('postgresql://melarc_api_runtime:runtimeruntime22@127.0.0.1:5432/melarc_dev'),
    );
    assert.ok(!values.includes('127.0.0.1'));
    assert.ok(!values.includes('3000'));
  });

  // Break caught: a password that is percent-encoded in a connection string being searched for only in that form,
  // and so missed where it was written out plainly.
  it('looks for a URL password as written and as decoded', () => {
    const root = scratch();
    put(root, { '.env': 'ANY_NAME=postgresql://u:pa%40ss-word-1234@127.0.0.1/db\n' });
    const values = readSecretValues(root, ['.env']);
    assert.ok(values.includes('pa%40ss-word-1234'));
    assert.ok(values.includes('pa@ss-word-1234'));
  });

  it('keeps a password that is not valid percent-encoding as it is', () => {
    const root = scratch();
    put(root, { '.env': 'ANY_NAME=postgresql://u:100%-secret-value@127.0.0.1/db\n' });
    assert.ok(readSecretValues(root, ['.env']).includes('100%-secret-value'));
  });

  // Break caught: a short or placeholder value matching ordinary text and failing every package.
  it('ignores values too short to be told from ordinary text, and placeholders', () => {
    const root = scratch();
    put(root, {
      '.env':
        'A_PASSWORD=abcdefghijk\nB_PASSWORD=CHANGE_ME\nC_PASSWORD=\nD_PASSWORD=abcdefghijkl\nE_PASSWORD=CHANGE_ME_before_use\n',
    });
    assert.deepEqual(readSecretValues(root, ['.env']), ['abcdefghijkl']);
  });

  it('skips a file that is not there', () => {
    assert.deepEqual(readSecretValues(scratch(), ['apps/api/.env']), []);
  });
});

describe('findLeaks', () => {
  it('names the files that contain a value, once each, and never the value', () => {
    const files = [
      { path: 'docs/notes.md', data: Buffer.from('the password is hunter2hunter2 ok') },
      { path: 'src/a.ts', data: Buffer.from('nothing here') },
      { path: 'src/b.ts', data: Buffer.from('hunter2hunter2 hunter2hunter2 and otherotherother') },
    ];
    const leaks = findLeaks(files, ['hunter2hunter2', 'otherotherother']);
    assert.deepEqual(leaks, ['docs/notes.md', 'src/b.ts']);
    assert.ok(!JSON.stringify(leaks).includes('hunter'));
  });

  // Break caught: a report whose order depends on the order Git listed the files in.
  it('lists them in path order whatever order the files came in', () => {
    const files = ['src/b.ts', 'docs/notes.md', 'a.txt'].map((path) => ({
      path,
      data: Buffer.from('hunter2hunter2'),
    }));
    assert.deepEqual(findLeaks(files, ['hunter2hunter2']), ['a.txt', 'docs/notes.md', 'src/b.ts']);
  });

  it('finds nothing when there is nothing to find', () => {
    assert.deepEqual(findLeaks([{ path: 'a', data: Buffer.from('x') }], []), []);
    assert.deepEqual(findLeaks([], ['somethinglongenough']), []);
  });
});

describe('packageSource', () => {
  const secretFiles = {
    'infrastructure/postgres/.env':
      'MELARC_PG_ADMIN_PASSWORD=admin-secret-value-123\nMELARC_PG_PORT=5432\n',
    'apps/api/.env':
      'DATABASE_URL=postgresql://u:runtime-secret-value-456@127.0.0.1:5432/db\nHTTP_PORT=3000\n',
  };
  const sourceFiles = {
    '.gitignore': '.env\n.env.*\n!.env.example\nnode_modules/\ndist/\ntmp/\n*.zip\n',
    'package.json': '{"name":"x"}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'README.md': '# x\n',
    'apps/api/.env.example': 'DATABASE_URL=postgresql://u:CHANGE_ME@127.0.0.1:5432/db\n',
    'apps/api/src/main.ts': 'export {};\n',
    'apps/api/migrations/0000_init.sql': 'select 1;\n',
    'specs/résumé.md': 'unicode name\n',
  };
  const ignoredFiles = {
    'node_modules/dep/index.js': 'module.exports = 1;\n',
    'apps/api/node_modules/dep/index.js': 'module.exports = 2;\n',
    'apps/api/dist/main.js': 'built\n',
    'tmp/scratch.log': 'scratch\n',
    ...secretFiles,
  };

  /** A repository with source committed, then settings and build output on disk that Git ignores. */
  function project(): string {
    const root = repository(sourceFiles);
    put(root, ignoredFiles);
    return root;
  }

  const outside = (): string => join(scratch(), 'out', 'source.zip');

  it('packages the source, and none of the settings, dependencies, output or scratch files', () => {
    const root = project();
    const out = outside();

    const result = packageSource(root, { out });

    const entries = readZip(readFileSync(out));
    assert.deepEqual(
      names(entries),
      [
        '.gitignore',
        PACKAGE_INFO_PATH,
        'README.md',
        'apps/api/.env.example',
        'apps/api/migrations/0000_init.sql',
        'apps/api/src/main.ts',
        'package.json',
        'pnpm-lock.yaml',
        'specs/résumé.md',
      ].sort(),
    );
    assert.equal(result.files, entries.length - 1);
    for (const secret of ['admin-secret-value-123', 'runtime-secret-value-456']) {
      for (const entry of entries) assert.ok(!entry.data.includes(secret), entry.path);
    }
  });

  // Break caught: an archive whose entry order depends on what Git listed first (tracked files, then untracked).
  it('lists the entries, and the files in SOURCE_PACKAGE.json, in path order', () => {
    const root = project();
    put(root, {
      'a-new-file.md': 'untracked, sorts first\n',
      'zz/last.md': 'untracked, sorts last\n',
    });
    const out = outside();

    packageSource(root, { out });

    const entries = readZip(readFileSync(out));
    const order = entries.map((e) => e.path);
    assert.deepEqual(order, [...order].sort());
    assert.equal(order[0], '.gitignore');
    assert.ok(order.indexOf('a-new-file.md') < order.indexOf('apps/api/src/main.ts'));
    const info = JSON.parse(
      entries.find((e) => e.path === PACKAGE_INFO_PATH)?.data.toString('utf8') ?? '',
    ) as { files: { path: string }[] };
    const listed = info.files.map((f) => f.path);
    assert.deepEqual(listed, [...listed].sort());
  });

  it('refuses a repository that already has a file named like the package description', () => {
    const root = repository({ '.gitignore': 'node_modules/\n', [PACKAGE_INFO_PATH]: '{}\n' });
    const out = outside();
    assert.throws(
      () => packageSource(root, { out }),
      (error: unknown) =>
        error instanceof PackageSourceError &&
        error.message.includes(PACKAGE_INFO_PATH) &&
        error.message.includes('cannot describe itself'),
    );
    assert.equal(existsSync(out), false);
  });

  // Break caught: a repository with no commit and nothing in it being called clean, when there is no commit the
  // tree could be said to match.
  it('does not call a repository with no commit clean, even when it has no files', () => {
    const root = repository({}, { commit: false });
    const out = outside();
    const result = packageSource(root, { out });
    assert.equal(result.revision, null);
    assert.equal(result.modified, true);
    assert.equal(result.files, 0);
    const info = JSON.parse(
      readZip(readFileSync(out))
        .find((e) => e.path === PACKAGE_INFO_PATH)
        ?.data.toString('utf8') ?? '',
    ) as { workingTree: string };
    assert.equal(info.workingTree, 'modified');
  });

  it('includes every byte of the source files unchanged', () => {
    const root = project();
    const out = outside();
    packageSource(root, { out });
    const entries = readZip(readFileSync(out));
    for (const [path, content] of Object.entries(sourceFiles)) {
      assert.equal(entries.find((e) => e.path === path)?.data.toString('utf8'), content, path);
    }
  });

  // Break caught: the owner's local settings being deleted, moved or changed as "cleanup".
  it('leaves every file in the working tree exactly as it was', () => {
    const root = project();
    const before = Object.fromEntries(
      [...Object.keys(sourceFiles), ...Object.keys(ignoredFiles)].map((path) => [
        path,
        readFileSync(join(root, path), 'utf8'),
      ]),
    );
    packageSource(root, { out: outside() });
    for (const [path, content] of Object.entries(before)) {
      assert.equal(readFileSync(join(root, path), 'utf8'), content, path);
    }
    assert.equal(git(root, 'status', '--porcelain'), '');
  });

  it('describes the package: the revision, a clean working tree, and every file with its hash', () => {
    const root = project();
    const out = outside();
    const head = git(root, 'rev-parse', 'HEAD').trim();

    const result = packageSource(root, { out });

    const info = JSON.parse(
      readZip(readFileSync(out))
        .find((e) => e.path === PACKAGE_INFO_PATH)
        ?.data.toString('utf8') ?? '',
    ) as {
      schema: number;
      revision: string;
      branch: string;
      workingTree: string;
      changes: unknown[];
      excluded: Record<string, number>;
      files: { path: string; bytes: number; sha256: string }[];
    };
    // node_modules/ twice, apps/api/dist/, tmp/ and the two settings files: what Git ignores, counted by reason.
    assert.deepEqual(info.excluded, { ignored: 6 });
    assert.equal(info.schema, 1);
    assert.equal(info.revision, head);
    assert.equal(result.revision, head);
    assert.equal(info.branch, 'main');
    assert.equal(info.workingTree, 'clean');
    assert.deepEqual(info.changes, []);
    assert.deepEqual(
      info.files.map((f) => f.path),
      Object.keys(sourceFiles).sort(),
    );
    for (const file of info.files) {
      const content = Buffer.from(sourceFiles[file.path as keyof typeof sourceFiles]);
      assert.equal(file.bytes, content.length);
      assert.equal(file.sha256, createHash('sha256').update(content).digest('hex'));
    }
  });

  // Break caught: a working-tree archive presented as if it were the commit it sits on.
  it('says the archive holds the working tree, not the commit, when files are changed, added or deleted', () => {
    const root = project();
    put(root, {
      'apps/api/src/main.ts': 'export const changed = true;\n',
      'apps/api/src/new.ts': 'export {};\n',
    });
    rmSync(join(root, 'README.md'));
    const out = outside();

    const result = packageSource(root, { out });

    const entries = readZip(readFileSync(out));
    const info = JSON.parse(
      entries.find((e) => e.path === PACKAGE_INFO_PATH)?.data.toString('utf8') ?? '',
    ) as {
      workingTree: string;
      changes: { status: string; path: string }[];
      note: string;
    };
    assert.equal(info.workingTree, 'modified');
    assert.deepEqual(
      info.changes.map((c) => `${c.status} ${c.path}`).sort(),
      ['?? apps/api/src/new.ts', ' D README.md', ' M apps/api/src/main.ts'].sort(),
    );
    assert.match(info.note, /working tree/);
    assert.equal(result.modified, true);
    assert.equal(
      entries.find((e) => e.path === 'apps/api/src/main.ts')?.data.toString(),
      'export const changed = true;\n',
    );
    assert.ok(entries.some((e) => e.path === 'apps/api/src/new.ts'));
    assert.ok(!entries.some((e) => e.path === 'README.md'), 'a deleted file is not packaged');
  });

  it('packages a repository with no commit yet, and says there is no revision', () => {
    const root = repository(sourceFiles, { commit: false });
    git(root, 'add', '--all');
    const out = outside();
    const result = packageSource(root, { out });
    const info = JSON.parse(
      readZip(readFileSync(out))
        .find((e) => e.path === PACKAGE_INFO_PATH)
        ?.data.toString('utf8') ?? '',
    ) as {
      revision: unknown;
      workingTree: string;
    };
    assert.equal(info.revision, null);
    assert.equal(info.workingTree, 'modified');
    assert.equal(result.revision, null);
  });

  // Break caught: a secret-looking file that is tracked, or not ignored, being shipped because Git does not
  // mind it. Git's own rules protect Git; this is the second line for the archive.
  it('refuses secret-looking files even when Git would include them, and says which', () => {
    const root = repository({
      ...sourceFiles,
      'apps/api/.env.local': 'API_TOKEN=tracked-token-value-789\n',
      'certs/server.pem': '-----BEGIN PRIVATE KEY-----\n',
      '.gitignore': 'node_modules/\n',
    });
    const out = outside();

    const result = packageSource(root, { out });

    const entries = readZip(readFileSync(out));
    assert.ok(
      !entries.some((e) => e.path === 'apps/api/.env.local' || e.path === 'certs/server.pem'),
    );
    assert.deepEqual(
      result.excluded
        .filter((e) => e.reason !== 'ignored')
        .map((e) => e.path)
        .sort(),
      ['apps/api/.env.local', 'certs/server.pem'],
    );
  });

  it('refuses to package a credential that appears inside a file, and never prints it', () => {
    const root = project();
    put(root, { 'docs/notes.md': 'connect with admin-secret-value-123 to the server\n' });
    const out = outside();

    assert.throws(
      () => packageSource(root, { out }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /docs\/notes\.md/);
        assert.doesNotMatch(error.message, /admin-secret-value-123/);
        return true;
      },
    );
    assert.equal(existsSync(out), false, 'no archive is left behind');
  });

  it('refuses to overwrite a file unless told to', () => {
    const root = project();
    const out = outside();
    packageSource(root, { out });
    const first = readFileSync(out);

    // The tool's own refusal, which names the way out, and not the file system's EEXIST from the write.
    assert.throws(
      () => packageSource(root, { out }),
      (error: unknown) =>
        error instanceof PackageSourceError &&
        error.message.includes('--overwrite') &&
        error.message.includes('--out'),
    );
    assert.ok(readFileSync(out).equals(first));

    packageSource(root, { out, overwrite: true });
    assert.ok(readFileSync(out).equals(first), 'the same input gives the same archive');
  });

  // Break caught: the archive being written into the tree it is made from and then packaged into itself.
  it('does not package its own output when that is inside the repository and Git does not ignore it', () => {
    const root = repository({ '.gitignore': 'node_modules/\n', 'package.json': '{}\n' });
    // A name without an archive extension, so only the tool's own knowledge of its output can leave it out.
    const out = join(root, 'review', 'source.pack');

    packageSource(root, { out });
    const result = packageSource(root, { out, overwrite: true });

    const entries = readZip(readFileSync(out));
    assert.deepEqual(names(entries), ['.gitignore', PACKAGE_INFO_PATH, 'package.json'].sort());
    assert.ok(
      result.excluded.some((e) => e.path === 'review/source.pack' && e.reason === 'this archive'),
    );
  });

  it('leaves out an earlier archive by its extension', () => {
    const root = repository({ '.gitignore': 'node_modules/\n', 'package.json': '{}\n' });
    put(root, { 'old-review.zip': 'PK' });
    const out = outside();
    const result = packageSource(root, { out });
    assert.ok(!readZip(readFileSync(out)).some((e) => e.path === 'old-review.zip'));
    assert.ok(
      result.excluded.some((e) => e.path === 'old-review.zip' && e.reason.includes('archive')),
    );
  });

  it('refuses to run where there is no git checkout', () => {
    assert.throws(() => packageSource(scratch(), { out: outside() }), /git/i);
  });

  // Break caught: a package of a subfolder presented as the repository, with paths that do not match its root.
  it('refuses a folder inside a checkout that is not its root', () => {
    const root = project();
    const out = outside();
    assert.throws(() => packageSource(join(root, 'apps'), { out }), /not its root/);
    assert.equal(existsSync(out), false);
  });

  // Break caught: the values to look for being read only from the settings files Git ignores, so a settings file
  // that was committed (and so is refused by name) could still be pasted into a file that is packed.
  it('also looks for the credentials in a settings file that is tracked', () => {
    const root = repository({
      '.gitignore': 'node_modules/\n',
      'apps/api/.env.local': 'API_TOKEN=tracked-token-value-789\n',
      'docs/notes.md': 'token: tracked-token-value-789\n',
    });
    assert.throws(
      () => packageSource(root, { out: outside() }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /docs\/notes\.md/);
        assert.doesNotMatch(error.message, /tracked-token-value-789/);
        return true;
      },
    );
  });

  // Break caught: a renamed file adding a second, false entry for the path it came from.
  it('reads a rename as one change, in the order Git prints it', () => {
    const root = project();
    git(root, 'mv', 'README.md', 'GUIDE.md');
    const out = outside();

    const result = packageSource(root, { out });

    const info = JSON.parse(
      readZip(readFileSync(out))
        .find((e) => e.path === PACKAGE_INFO_PATH)
        ?.data.toString('utf8') ?? '',
    ) as { changes: { status: string; path: string }[] };
    assert.deepEqual(info.changes, [{ status: 'R ', path: 'GUIDE.md' }]);
    assert.equal(result.changes, 1);
  });

  it('has no branch when HEAD is detached', () => {
    const root = project();
    git(root, 'checkout', '--quiet', '--detach');
    const result = packageSource(root, { out: outside() });
    assert.equal(result.branch, null);
    assert.equal(result.modified, false);
  });

  // A submodule is listed by Git as a path that is a directory on disk: a file list must not try to read it.
  it('skips a path that is a directory on disk, and says so', () => {
    const root = project();
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/sub`);
    mkdirSync(join(root, 'vendor', 'sub'), { recursive: true });
    const out = outside();

    const result = packageSource(root, { out });

    assert.ok(!readZip(readFileSync(out)).some((e) => e.path.startsWith('vendor/')));
    assert.ok(
      result.excluded.some((e) => e.path === 'vendor/sub' && e.reason === 'not a regular file'),
    );
  });

  it('skips a symbolic link, and says so', (context) => {
    const root = project();
    try {
      symlinkSync(join(root, 'README.md'), join(root, 'link-to-readme.md'));
    } catch {
      context.skip('this machine does not allow symbolic links without privilege');
      return;
    }
    git(root, 'add', 'link-to-readme.md');
    const out = outside();
    const result = packageSource(root, { out });
    assert.ok(!readZip(readFileSync(out)).some((e) => e.path === 'link-to-readme.md'));
    assert.ok(
      result.excluded.some(
        (e) => e.path === 'link-to-readme.md' && e.reason === 'not a regular file',
      ),
    );
  });

  // Break caught: an ignored file dropped from the report because another ignored entry starts with its name.
  it('keeps an ignored file whose name begins an ignored directory name', () => {
    const root = repository({
      '.gitignore': 'keep.local\nkeep.local.d/\n',
      'package.json': '{}\n',
    });
    put(root, { 'keep.local': 'x\n', 'keep.local.d/inside.txt': 'y\n' });
    const result = packageSource(root, { out: outside() });
    const ignored = result.excluded.filter((e) => e.reason === 'ignored').map((e) => e.path);
    assert.deepEqual(ignored, ['keep.local', 'keep.local.d/']);
  });

  it('reports what it left out by category and path, with no file content', () => {
    const root = project();
    const result = packageSource(root, { out: outside() });
    const reasons = new Set(result.excluded.map((e) => e.reason));
    assert.ok(reasons.has('ignored'));
    for (const entry of result.excluded) {
      assert.deepEqual(Object.keys(entry).sort(), ['path', 'reason']);
    }
    assert.ok(result.excluded.some((e) => e.path === 'apps/api/.env'));
    assert.ok(result.excluded.some((e) => e.path === 'infrastructure/postgres/.env'));
  });
});

describe('the command line', () => {
  const script = resolve(import.meta.dirname, 'package-source.ts');

  function run(cwd: string, ...args: string[]) {
    return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  }

  it('prints where the archive is, what it holds and what it left out, and no secret', () => {
    const root = repository({
      '.gitignore': '.env\n',
      'package.json': '{}\n',
      'src/a.ts': 'export {};\n',
    });
    put(root, { '.env': 'DATABASE_URL=postgresql://u:cli-secret-value-000@127.0.0.1/db\n' });
    const out = join(scratch(), 'review.zip');

    const result = run(root, '--out', out);

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(out));
    assert.match(result.stdout, /3 files/);
    assert.match(result.stdout, /review\.zip/);
    assert.match(result.stdout, /clean/);
    assert.match(result.stdout, /Left out: 1 ignored\./);
    // The connection string and the password inside it.
    assert.match(
      result.stdout,
      /Looked for 2 local credential values in every packed file: none found\./,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /cli-secret-value-000/);
  });

  it('says so when no settings file held a credential to look for', () => {
    const root = repository({ '.gitignore': 'node_modules/\n', 'package.json': '{}\n' });
    const result = run(root, '--out', join(scratch(), 'review.zip'));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Left out: nothing\./);
    assert.match(result.stdout, /No local settings file held a credential to look for\./);
  });

  it('says the working tree is not the commit when it is modified, and names the file for it', () => {
    const root = repository({ '.gitignore': 'tmp/\n', 'package.json': '{}\n' });
    put(root, { 'package.json': '{"changed":true}\n' });
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /modified \(1 changed paths\), so this is not the commit/);
    assert.match(result.stdout, /tmp[\\/]melarc-source-[0-9a-f]{12}-modified\.zip/);
  });

  it('packages the whole repository when run from a folder inside it', () => {
    const root = repository({ '.gitignore': 'tmp/\n', 'package.json': '{}\n', 'src/a.ts': 'x\n' });
    const result = run(join(root, 'src'));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /3 files/);
    assert.ok(existsSync(join(root, 'tmp')));
  });

  it('exits 1 when --out has no file after it', () => {
    for (const args of [['--out'], ['--out', '--overwrite']]) {
      const result = run(scratch(), ...args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, /Usage/);
    }
  });

  it('exits 1 with the reason when there is no git checkout', () => {
    const result = run(scratch());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /git checkout/);
  });

  it('exits 1 with the reason, and writes nothing, when a credential would be packaged', () => {
    const root = repository({
      '.gitignore': '.env\n',
      'notes.md': 'the value is cli-leak-value-12345\n',
    });
    put(root, { '.env': 'SOME_PASSWORD=cli-leak-value-12345\n' });
    const out = join(scratch(), 'review.zip');

    const result = run(root, '--out', out);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /notes\.md/);
    assert.doesNotMatch(result.stdout + result.stderr, /cli-leak-value-12345/);
    assert.equal(existsSync(out), false);
  });

  it('exits 1 for an option it does not know', () => {
    const result = run(scratch(), '--everything');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
  });

  it('writes to the default place when --out is not given, and that place is not packaged', () => {
    const root = repository({ '.gitignore': 'tmp/\n*.zip\n', 'package.json': '{}\n' });
    const first = run(root);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const second = run(root, '--overwrite');
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(first.stdout, /tmp[\\/]melarc-source-[0-9a-f]{12}\.zip/);
  });
});
