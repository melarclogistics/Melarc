import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  checkoutProblem,
  createManifest,
  readManifest,
  treeProblem,
  verifyManifest,
  type BuildManifest,
} from './ci-revision.ts';

const created: string[] = [];
after(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(root: string, path: string, content: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

interface Fixture {
  root: string;
  head: string;
}

/**
 * A real repository with one commit that holds what the build step needs (the manifest records both inputs)
 * and an ignored `dist/`, as the real one does. Nothing here is mocked: the checks ask Git itself.
 */
function buildTemplate(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'melarc-revision-template-'));
  created.push(root);
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'ci@example.invalid');
  git(root, 'config', 'user.name', 'CI test');
  git(root, 'config', 'core.autocrlf', 'false');
  write(root, '.gitignore', 'dist/\nbuild-manifest.json\n');
  write(root, 'package.json', JSON.stringify({ packageManager: 'pnpm@11.1.3' }));
  write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  write(root, 'contracts/openapi.yaml', 'openapi: 3.1.0\n');
  write(root, 'src/index.ts', 'export {};\n');
  git(root, 'add', '--all');
  git(root, 'commit', '--quiet', '--message', 'fixture');
  write(root, 'apps/api/dist/main.js', 'console.log("api");\n');
  write(root, 'apps/api/dist/tools/check.js', 'console.log("check");\n');
  write(root, 'apps/ops-web/dist/index.html', '<!doctype html>\n');
  return { root, head: git(root, 'rev-parse', 'HEAD') };
}

let template: Fixture | undefined;

/**
 * A repository of its own for one test, copied from the template: making one from nothing costs about a dozen
 * Git processes, which adds up to a minute over this file. Git compares content, not the copied timestamps,
 * so the copy is clean.
 */
function repository(): Fixture {
  template ??= buildTemplate();
  const root = mkdtempSync(join(tmpdir(), 'melarc-revision-'));
  created.push(root);
  cpSync(template.root, root, { recursive: true });
  return { root, head: template.head };
}

const ROOTS = ['apps/api/dist', 'apps/ops-web/dist', 'contracts/openapi.yaml'];

// `apps/*/dist` is ignored in the real repository through a pattern that also matches here: the fixture ignores
// `dist/` at any depth.

describe('checkoutProblem', () => {
  it('accepts a checkout at the revision under test', () => {
    const { root, head } = repository();
    assert.equal(checkoutProblem(root, { GITHUB_SHA: head }), undefined);
  });

  // Break caught: a job testing a different commit than the run is about (a moved pull-request merge ref, a
  // checkout of a branch tip instead of the revision).
  it('names both revisions when HEAD is not the revision under test', () => {
    const { root, head } = repository();
    const other = 'f'.repeat(40);
    const problem = checkoutProblem(root, { GITHUB_SHA: other });
    assert.match(problem ?? '', new RegExp(head));
    assert.match(problem ?? '', new RegExp(other));
  });

  // Break caught: the check passing when the variable that defines the revision is gone.
  for (const value of [undefined, '']) {
    it(`fails when GITHUB_SHA is ${JSON.stringify(value)}`, () => {
      const { root } = repository();
      assert.match(checkoutProblem(root, { GITHUB_SHA: value }) ?? '', /GITHUB_SHA/);
    });
  }

  it('does not mind letter case in the revision', () => {
    const { root, head } = repository();
    assert.equal(checkoutProblem(root, { GITHUB_SHA: head.toUpperCase() }), undefined);
  });

  it('fails where there is no repository', () => {
    const directory = mkdtempSync(join(tmpdir(), 'melarc-norepo-'));
    created.push(directory);
    assert.ok(checkoutProblem(directory, { GITHUB_SHA: 'a'.repeat(40) }) !== undefined);
  });
});

describe('treeProblem', () => {
  it('accepts a clean tree, ignored build output included', () => {
    const { root } = repository();
    assert.equal(treeProblem(root), undefined);
  });

  // Break caught: a tool rewriting a tracked file during the run (a generated file regenerated differently, a
  // lockfile changed by an install), so the tested tree is no longer the commit.
  it('reports a modified tracked file, by its path alone', () => {
    const { root } = repository();
    write(root, 'src/index.ts', 'export const changed = true;\n');
    assert.match(treeProblem(root) ?? '', /1 path\(s\) differ: src\/index\.ts\.$/);
  });

  it('reports a staged change', () => {
    const { root } = repository();
    write(root, 'src/index.ts', 'export const staged = true;\n');
    git(root, 'add', 'src/index.ts');
    assert.match(treeProblem(root) ?? '', /src\/index\.ts/);
  });

  // Break caught: output that was meant to be committed (a generated file) left untracked and not ignored.
  it('reports an untracked file that is not ignored, however deep', () => {
    const { root } = repository();
    write(root, 'generated/deep/er/file.ts', 'export {};\n');
    assert.match(treeProblem(root) ?? '', /generated\/deep\/er\/file\.ts/);
  });

  it('reports a deleted tracked file', () => {
    const { root } = repository();
    unlinkSync(join(root, 'src/index.ts'));
    assert.match(treeProblem(root) ?? '', /src\/index\.ts/);
  });

  it('lists at most ten paths and says how many more there are', () => {
    const { root } = repository();
    for (let index = 0; index < 13; index += 1) write(root, `extra/file-${String(index)}.txt`, 'x');
    const problem = treeProblem(root) ?? '';
    assert.equal(problem.match(/file-\d+\.txt/g)?.length, 10);
    assert.match(problem, /3 more/);
  });

  it('fails where there is no repository', () => {
    const directory = mkdtempSync(join(tmpdir(), 'melarc-norepo-'));
    created.push(directory);
    assert.ok(treeProblem(directory) !== undefined);
  });
});

describe('createManifest', () => {
  it('records the revision, the inputs and every file of every root, sorted', () => {
    const { root, head } = repository();
    const manifest = createManifest(root, ROOTS, {
      GITHUB_SHA: head,
      GITHUB_REF: 'refs/pull/7/merge',
      GITHUB_RUN_ID: '4242',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_JOB: 'integrated',
    });

    assert.equal(manifest.schema, 1);
    assert.deepEqual(manifest.source, {
      revision: head,
      ref: 'refs/pull/7/merge',
      runId: '4242',
      runAttempt: '2',
      job: 'integrated',
    });
    assert.deepEqual(manifest.toolchain, { node: process.version, packageManager: 'pnpm@11.1.3' });
    assert.deepEqual(manifest.inputs, {
      lockfileSha256: sha256('lockfileVersion: 9\n'),
      contractSha256: sha256('openapi: 3.1.0\n'),
    });
    assert.deepEqual(manifest.roots, ROOTS);
    assert.deepEqual(manifest.files, [
      {
        path: 'apps/api/dist/main.js',
        sha256: sha256('console.log("api");\n'),
        bytes: Buffer.byteLength('console.log("api");\n'),
      },
      {
        path: 'apps/api/dist/tools/check.js',
        sha256: sha256('console.log("check");\n'),
        bytes: Buffer.byteLength('console.log("check");\n'),
      },
      {
        path: 'apps/ops-web/dist/index.html',
        sha256: sha256('<!doctype html>\n'),
        bytes: Buffer.byteLength('<!doctype html>\n'),
      },
      {
        path: 'contracts/openapi.yaml',
        sha256: sha256('openapi: 3.1.0\n'),
        bytes: Buffer.byteLength('openapi: 3.1.0\n'),
      },
    ]);
  });

  it('records no run details when run outside a workflow, and still names the revision', () => {
    const { root, head } = repository();
    const manifest = createManifest(root, ROOTS, { GITHUB_SHA: head });
    assert.deepEqual(manifest.source, {
      revision: head,
      ref: null,
      runId: null,
      runAttempt: null,
      job: null,
    });
  });

  // Break caught: files listed in the order a directory walk finds them, which differs from path order where a
  // folder and a file share a prefix ("a/z.js" is found before "a.js", but "a.js" sorts first as a path).
  it('lists files in path order, not in the order a walk finds them', () => {
    const { root, head } = repository();
    write(root, 'apps/api/dist/a.js', 'x');
    write(root, 'apps/api/dist/a/z.js', 'x');
    const listed = createManifest(root, ROOTS, { GITHUB_SHA: head }).files.map((file) => file.path);
    assert.deepEqual(listed, listed.toSorted());
    assert.ok(listed.indexOf('apps/api/dist/a.js') < listed.indexOf('apps/api/dist/a/z.js'));
  });

  // Break caught: two runs of the same build writing different manifests, which would make the file useless
  // as evidence (a timestamp, a directory order the file system chose).
  it('is the same every time for the same files', () => {
    const { root, head } = repository();
    const first = createManifest(root, ROOTS, { GITHUB_SHA: head });
    const second = createManifest(root, [...ROOTS].reverse(), { GITHUB_SHA: head });
    assert.deepEqual(first.files, second.files);
    assert.deepEqual(first.roots, second.roots);
    assert.equal(
      JSON.stringify(first),
      JSON.stringify(createManifest(root, ROOTS, { GITHUB_SHA: head })),
    );
  });

  // Break caught: an artifact described as belonging to a commit it was not built from.
  it('refuses a tree that is not the committed revision', () => {
    const { root, head } = repository();
    write(root, 'src/index.ts', 'export const changed = true;\n');
    assert.throws(() => createManifest(root, ROOTS, { GITHUB_SHA: head }), /src\/index\.ts/);
  });

  it('refuses when HEAD is not the revision under test', () => {
    const { root } = repository();
    assert.throws(
      () => createManifest(root, ROOTS, { GITHUB_SHA: 'e'.repeat(40) }),
      /GITHUB_SHA|e{40}/,
    );
  });

  it('refuses when GITHUB_SHA is not set', () => {
    const { root } = repository();
    assert.throws(() => createManifest(root, ROOTS, {}), /GITHUB_SHA/);
  });

  // Break caught: a build that produced nothing being published as an empty, valid-looking artifact.
  it('refuses a root that does not exist', () => {
    const { root, head } = repository();
    assert.throws(
      () => createManifest(root, [...ROOTS, 'apps/missing/dist'], { GITHUB_SHA: head }),
      /apps\/missing\/dist/,
    );
  });

  it('refuses a root that holds no file', () => {
    const { root, head } = repository();
    mkdirSync(join(root, 'apps/empty/dist'), { recursive: true });
    assert.throws(
      () => createManifest(root, [...ROOTS, 'apps/empty/dist'], { GITHUB_SHA: head }),
      /apps\/empty\/dist/,
    );
  });

  it('refuses no roots at all', () => {
    const { root, head } = repository();
    assert.throws(() => createManifest(root, [], { GITHUB_SHA: head }), /root/);
  });

  // Break caught: a root that points outside the repository, or into Git's own data.
  for (const bad of [
    '../outside',
    '/etc',
    'C:\\Windows',
    'C:/Windows',
    'apps\\api\\dist',
    'apps/../../outside',
    '.git',
    '.git/config',
    '',
    '.',
    './',
  ]) {
    it(`refuses the root ${JSON.stringify(bad)}`, () => {
      const { root, head } = repository();
      assert.throws(
        () => createManifest(root, [...ROOTS, bad], { GITHUB_SHA: head }),
        /Invalid root/,
      );
    });
  }

  // Break caught: following a link out of the build output, so the manifest describes files that are not in it.
  it('refuses a link inside a root', () => {
    const { root, head } = repository();
    symlinkSync(join(root, 'src'), join(root, 'apps/api/dist/linked'), 'junction');
    assert.throws(() => createManifest(root, ROOTS, { GITHUB_SHA: head }), /linked/);
  });
});

describe('verifyManifest', () => {
  function built(): { root: string; manifest: BuildManifest } {
    const { root, head } = repository();
    return { root, manifest: createManifest(root, ROOTS, { GITHUB_SHA: head }) };
  }

  it('accepts files exactly as the manifest recorded them', () => {
    const { root, manifest } = built();
    assert.deepEqual(verifyManifest(root, manifest), []);
  });

  // Break caught: an artifact altered after it was described: a file changed, removed, or slipped in.
  it('reports a file whose content changed', () => {
    const { root, manifest } = built();
    write(root, 'apps/api/dist/main.js', 'console.log("tampered");\n');
    assert.deepEqual(verifyManifest(root, manifest), ['changed: apps/api/dist/main.js']);
  });

  // Break caught: a change that keeps the file's size being taken as the same file.
  it('reports a file whose content changed but whose size did not', () => {
    const { root, manifest } = built();
    write(root, 'apps/api/dist/main.js', 'console.log("apx");\n');
    assert.equal(
      Buffer.byteLength('console.log("apx");\n'),
      Buffer.byteLength('console.log("api");\n'),
    );
    assert.deepEqual(verifyManifest(root, manifest), ['changed: apps/api/dist/main.js']);
  });

  it('reports a file that is gone', () => {
    const { root, manifest } = built();
    unlinkSync(join(root, 'apps/ops-web/dist/index.html'));
    assert.deepEqual(verifyManifest(root, manifest), ['missing: apps/ops-web/dist/index.html']);
  });

  it('reports a file that the manifest does not list', () => {
    const { root, manifest } = built();
    write(root, 'apps/api/dist/extra/injected.js', 'x');
    assert.deepEqual(verifyManifest(root, manifest), ['unlisted: apps/api/dist/extra/injected.js']);
  });

  it('reports every difference, in path order', () => {
    const { root, manifest } = built();
    write(root, 'apps/api/dist/main.js', 'changed');
    unlinkSync(join(root, 'contracts/openapi.yaml'));
    write(root, 'apps/ops-web/dist/new.html', 'x');
    assert.deepEqual(verifyManifest(root, manifest), [
      'changed: apps/api/dist/main.js',
      'unlisted: apps/ops-web/dist/new.html',
      'missing: contracts/openapi.yaml',
    ]);
  });

  // Break caught (audit B-02): a manifest that lists no files verifying vacuously when it reaches the
  // verifier without going through readManifest.
  it('has nothing to verify against a manifest that lists no files, and says so', () => {
    const { root, manifest } = built();
    assert.deepEqual(verifyManifest(root, { ...manifest, files: [] }), [
      'the manifest lists no files, so there is nothing to verify',
    ]);
  });

  it('reports a root that no longer exists once, as its files going missing', () => {
    const { root, manifest } = built();
    rmSync(join(root, 'apps/api/dist'), { recursive: true });
    assert.deepEqual(verifyManifest(root, manifest), [
      'missing: apps/api/dist/main.js',
      'missing: apps/api/dist/tools/check.js',
    ]);
  });
});

// Audit B-02: a manifest is evidence, so one that cannot be trusted to describe a real build is refused whole.
// Each case below starts from a manifest the generator really made and breaks exactly one thing, so the reason
// it is refused is the one named.
type Json = Record<string, unknown>;

function generated(): Json {
  const { root, head } = repository();
  return JSON.parse(JSON.stringify(createManifest(root, ROOTS, { GITHUB_SHA: head }))) as Json;
}

const asRecord = (value: unknown): Json => value as Json;
const fileEntries = (manifest: Json): Json[] => manifest.files as Json[];

describe('readManifest', () => {
  function manifestFile(content: unknown): string {
    const directory = mkdtempSync(join(tmpdir(), 'melarc-manifest-'));
    created.push(directory);
    const file = join(directory, 'build-manifest.json');
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  }

  it('reads what createManifest wrote', () => {
    const { root, head } = repository();
    const manifest = createManifest(root, ROOTS, { GITHUB_SHA: head });
    assert.deepEqual(readManifest(manifestFile(manifest)), manifest);
  });

  it('accepts a revision that is a 64-character object name, as a SHA-256 repository has', () => {
    const manifest = generated();
    asRecord(manifest.source).revision = 'a'.repeat(64);
    assert.doesNotThrow(() => readManifest(manifestFile(manifest)));
  });

  const unreadable: [label: string, change: (manifest: Json) => void, reason: RegExp][] = [
    // The report's counterexample: no files at all, so there is nothing to compare, and it "verified" 0 files.
    [
      'no files at all',
      (m) => {
        m.files = [];
      },
      /lists no files/,
    ],
    [
      'files that are not a list',
      (m) => {
        m.files = {};
      },
      /files are not a list/,
    ],

    // Break caught: a manifest that does not name a real revision, so "verified against revision X" means nothing.
    ...['not-a-real-revision', '', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 3].map(
      (revision): [string, (manifest: Json) => void, RegExp] => [
        `the revision ${JSON.stringify(revision)}`,
        (m) => {
          asRecord(m.source).revision = revision;
        },
        /revision/,
      ],
    ),
    [
      'a run number that is not text',
      (m) => {
        asRecord(m.source).runId = 7;
      },
      /source/,
    ],
    [
      'an unknown field in source',
      (m) => {
        asRecord(m.source).signedBy = 'nobody';
      },
      /source/,
    ],
    [
      'no toolchain',
      (m) => {
        delete m.toolchain;
      },
      /toolchain/,
    ],
    [
      'an empty Node.js version',
      (m) => {
        asRecord(m.toolchain).node = '';
      },
      /toolchain/,
    ],
    [
      'an empty package manager version',
      (m) => {
        asRecord(m.toolchain).packageManager = '';
      },
      /toolchain/,
    ],
    [
      'an unknown field in toolchain',
      (m) => {
        asRecord(m.toolchain).runner = 'somewhere';
      },
      /toolchain/,
    ],
    [
      'an unknown field in inputs',
      (m) => {
        asRecord(m.inputs).extraSha256 = 'e'.repeat(64);
      },
      /inputs/,
    ],
    // Break caught: a malformed contract hash passing because the contract is not listed, so nothing else compares it.
    [
      'a contract hash that is not a hash, with no contract listed',
      (m) => {
        m.roots = (m.roots as string[]).filter((root) => root !== 'contracts/openapi.yaml');
        m.files = fileEntries(m).filter((entry) => entry.path !== 'contracts/openapi.yaml');
        asRecord(m.inputs).contractSha256 = 'zz';
      },
      /not two SHA-256 hashes/,
    ],
    ...['zz', 'A'.repeat(64), 'a'.repeat(63)].map(
      (hash): [string, (manifest: Json) => void, RegExp] => [
        `the lockfile hash ${JSON.stringify(hash.slice(0, 8))}`,
        (m) => {
          asRecord(m.inputs).lockfileSha256 = hash;
        },
        /inputs/,
      ],
    ),
    [
      'an unknown top-level field',
      (m) => {
        m.approvedBy = 'nobody';
      },
      /unknown field/,
    ],
    [
      'a different schema number',
      (m) => {
        m.schema = 2;
      },
      /schema/,
    ],

    // Break caught: roots that are not what createManifest would have written, or that point out of the repository.
    [
      'no roots',
      (m) => {
        m.roots = [];
      },
      /no roots/,
    ],
    [
      'a root that is not text',
      (m) => {
        m.roots = [3];
      },
      /no roots/,
    ],
    ...['../outside', '/etc', '.git', 'C:/Windows', 'apps\\api\\dist'].map(
      (root): [string, (manifest: Json) => void, RegExp] => [
        `the root ${JSON.stringify(root)}`,
        (m) => {
          m.roots = [...(m.roots as string[]), root];
        },
        /Invalid root/,
      ],
    ),
    ...['apps/api/dist/', './apps/api/dist', 'apps//api/dist'].map(
      (root): [string, (manifest: Json) => void, RegExp] => [
        `the root ${JSON.stringify(root)}, not in canonical form`,
        (m) => {
          m.roots = [root, ...(m.roots as string[]).slice(1)];
        },
        /canonical/,
      ],
    ),
    [
      'a root listed twice',
      (m) => {
        m.roots = [...(m.roots as string[]), (m.roots as string[])[0]];
      },
      /twice/,
    ],
    [
      'a root that has no file under it',
      (m) => {
        m.roots = [...(m.roots as string[]), 'apps/other/dist'];
      },
      /no file/,
    ],

    // Break caught: file entries that cannot be what the generator wrote.
    [
      'a file entry that is not an object',
      (m) => {
        m.files = [...fileEntries(m), 'apps/api/dist/extra.js'];
      },
      /files/,
    ],
    [
      'a file entry without a hash',
      (m) => {
        delete fileEntries(m)[0]?.sha256;
      },
      /files/,
    ],
    [
      'a file entry with an unknown field',
      (m) => {
        asRecord(fileEntries(m)[0]).mode = '0755';
      },
      /files/,
    ],
    ...['zz', 'A'.repeat(64), 'a'.repeat(63), ''].map(
      (hash): [string, (manifest: Json) => void, RegExp] => [
        `a file hash ${JSON.stringify(hash.slice(0, 8))}`,
        (m) => {
          asRecord(fileEntries(m)[0]).sha256 = hash;
        },
        /sha256/,
      ],
    ),
    ...[-1, 1.5, '1', null].map((bytes): [string, (manifest: Json) => void, RegExp] => [
      `a file size of ${JSON.stringify(bytes)}`,
      (m) => {
        asRecord(fileEntries(m)[0]).bytes = bytes;
      },
      /bytes/,
    ]),
    ...[
      '../outside/file',
      '/etc/passwd',
      'apps\\api\\dist\\x.js',
      '.git/config',
      'apps/api/dist/',
    ].map((path): [string, (manifest: Json) => void, RegExp] => [
      `a file path ${JSON.stringify(path)}`,
      (m) => {
        asRecord(fileEntries(m)[0]).path = path;
      },
      /Invalid file path|canonical/,
    ]),
    [
      'a file that lies outside every root',
      (m) => {
        m.files = [...fileEntries(m), { path: 'src/index.ts', sha256: 'c'.repeat(64), bytes: 3 }];
      },
      /outside every root/,
    ],
    // Break caught: "inside" decided by a shared prefix, so a sibling folder is mistaken for a root.
    [
      'a file in a folder whose name only starts like a root',
      (m) => {
        m.files = [
          ...fileEntries(m),
          { path: 'apps/api/dist-extra/x.js', sha256: 'c'.repeat(64), bytes: 3 },
        ];
      },
      /outside every root/,
    ],
    [
      'the same file listed twice',
      (m) => {
        m.files = [...fileEntries(m), { ...asRecord(fileEntries(m)[0]) }];
      },
      /twice/,
    ],

    // Break caught: a manifest that contradicts itself, so at least one half of it is wrong.
    [
      'a contract hash that is not the hash of the contract it lists',
      (m) => {
        asRecord(m.inputs).contractSha256 = 'd'.repeat(64);
      },
      /contractSha256/,
    ],
  ];
  for (const [label, change, reason] of unreadable) {
    it(`rejects a manifest with ${label}`, () => {
      const manifest = generated();
      change(manifest);
      assert.throws(() => readManifest(manifestFile(manifest)), reason);
    });
  }

  it('rejects text that is not JSON, and an array', () => {
    assert.throws(() => readManifest(manifestFile('not json')), /JSON/);
    assert.throws(() => readManifest(manifestFile([])), /not an object/);
  });

  it('rejects a file that is not there', () => {
    assert.throws(() => readManifest(join(tmpdir(), 'melarc-no-such-manifest.json')), /manifest/i);
  });
});

// The commands the workflow runs, started as real processes in a repository of their own.
describe('the command line', () => {
  const script = resolve(import.meta.dirname, 'ci-revision.ts');

  function run(cwd: string, env: Record<string, string>, ...args: string[]) {
    // Whatever the machine running this test says about a workflow run must not reach the command.
    const outside = Object.entries(process.env).filter(([name]) => !name.startsWith('GITHUB_'));
    return spawnSync(process.execPath, [script, ...args], {
      cwd,
      env: { ...Object.fromEntries(outside), ...env },
      encoding: 'utf8',
    });
  }

  it('checkout exits 0 at the revision under test and 1 anywhere else', () => {
    const { root, head } = repository();
    const ok = run(root, { GITHUB_SHA: head }, 'checkout');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, new RegExp(head));
    assert.equal(run(root, { GITHUB_SHA: 'd'.repeat(40) }, 'checkout').status, 1);
    assert.equal(run(root, {}, 'checkout').status, 1);
  });

  it('clean exits 0 on a clean tree and 1 on a changed one', () => {
    const { root } = repository();
    assert.equal(run(root, {}, 'clean').status, 0);
    write(root, 'src/index.ts', 'export const changed = true;\n');
    const dirty = run(root, {}, 'clean');
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /src\/index\.ts/);
  });

  it('manifest writes the file, and verify accepts it, then refuses it after a change', () => {
    const { root, head } = repository();
    const made = run(root, { GITHUB_SHA: head }, 'manifest', 'build-manifest.json', ...ROOTS);
    assert.equal(made.status, 0, made.stdout + made.stderr);
    const written = JSON.parse(
      readFileSync(join(root, 'build-manifest.json'), 'utf8'),
    ) as BuildManifest;
    assert.equal(written.source.revision, head);

    const ok = run(root, {}, 'verify', 'build-manifest.json');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);

    write(root, 'apps/api/dist/main.js', 'tampered');
    const bad = run(root, {}, 'verify', 'build-manifest.json');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /changed: apps\/api\/dist\/main\.js/);
  });

  // Break caught (audit B-02): the command calling a manifest of a build that was never made "verified". This is
  // the report's own counterexample, run as the command: no files, a root that does not exist, no real revision.
  it('verify refuses a manifest that describes no build, and does not say verified', () => {
    const { root } = repository();
    write(
      root,
      'build-manifest.json',
      '{"schema":1,"source":{"revision":"not-a-real-revision"},"roots":["missing-build-root"],"files":[]}',
    );

    const result = run(root, {}, 'verify', 'build-manifest.json');

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Not a readable build manifest/);
    assert.doesNotMatch(result.stdout, /Verified/);
  });

  // Break caught: a build checked by the script of another commit, against another commit's source.
  it('verify refuses a checkout that is not at the revision the manifest describes', () => {
    const { root, head } = repository();
    run(root, { GITHUB_SHA: head }, 'manifest', 'build-manifest.json', ...ROOTS);
    const manifest = JSON.parse(
      readFileSync(join(root, 'build-manifest.json'), 'utf8'),
    ) as BuildManifest;
    manifest.source.revision = 'e'.repeat(40);
    write(root, 'build-manifest.json', JSON.stringify(manifest));

    const result = run(root, {}, 'verify', 'build-manifest.json');

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(head));
    assert.match(result.stderr, /e{40}/);
    assert.doesNotMatch(result.stdout, /Verified/);
  });

  // Break caught: matching checksums being presented as more than they are. The files match the manifest; the
  // artifact is not thereby authentic, and nothing here knows whether CI passed for the revision.
  it('verify says what it checked, and what it did not', () => {
    const { root, head } = repository();
    run(root, { GITHUB_SHA: head }, 'manifest', 'build-manifest.json', ...ROOTS);

    const result = run(root, {}, 'verify', 'build-manifest.json');

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Verified 4 files: their contents match build-manifest\.json/);
    assert.match(result.stdout, new RegExp(`The checkout is at revision ${head}`));
    assert.match(result.stdout, /does not authenticate the artifact/);
    assert.match(result.stdout, /does not show that CI succeeded/);
  });

  // Break caught: no checkout, so no revision check, being silent about it. A downloaded build unpacked in a
  // plain directory is still compared file by file, and the output says the checkout was not checked.
  it('verify outside a Git checkout compares the files and says the revision was not checked', () => {
    const { root, head } = repository();
    run(root, { GITHUB_SHA: head }, 'manifest', 'build-manifest.json', ...ROOTS);
    const plain = mkdtempSync(join(tmpdir(), 'melarc-unpacked-'));
    created.push(plain);
    for (const path of [...ROOTS, 'build-manifest.json']) {
      mkdirSync(dirname(join(plain, path)), { recursive: true });
      cpSync(join(root, path), join(plain, path), { recursive: true });
    }

    const ok = run(plain, {}, 'verify', 'build-manifest.json');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /not a Git checkout/);
    assert.doesNotMatch(ok.stdout, /The checkout is at revision/);

    write(plain, 'apps/api/dist/main.js', 'tampered');
    const bad = run(plain, {}, 'verify', 'build-manifest.json');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /changed: apps\/api\/dist\/main\.js/);
  });

  it('manifest exits 1 and writes nothing for a tree that is not the revision', () => {
    const { root, head } = repository();
    write(root, 'src/index.ts', 'export const changed = true;\n');
    const result = run(root, { GITHUB_SHA: head }, 'manifest', 'build-manifest.json', ...ROOTS);
    assert.equal(result.status, 1);
    assert.throws(() => readFileSync(join(root, 'build-manifest.json')), { code: 'ENOENT' });
  });

  it('exits 1 for an unknown command, and for missing arguments', () => {
    const { root, head } = repository();
    assert.equal(run(root, { GITHUB_SHA: head }, 'publish').status, 1);
    assert.equal(run(root, { GITHUB_SHA: head }).status, 1);
    assert.equal(run(root, { GITHUB_SHA: head }, 'manifest').status, 1);
    const noRoots = run(root, { GITHUB_SHA: head }, 'manifest', 'build-manifest.json');
    assert.equal(noRoots.status, 1);
    assert.match(noRoots.stderr, /Usage/);
    assert.equal(run(root, {}, 'verify').status, 1);
  });
});
