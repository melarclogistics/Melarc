import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parse, stringify } from 'yaml';

import {
  CUSTOMISATION_FILES,
  findPolicyProblems,
  readPolicyInputs,
  type PolicyInputs,
} from './dependency-policy.ts';

type Json = Record<string, unknown>;

const root = resolve(import.meta.dirname, '..');

const INTEGRITY = 'sha512-0123456789abcdef';

/** A lockfile that keeps the policy: two importers, a workspace link, registry packages with integrity hashes. */
function goodLock(): Json {
  return {
    lockfileVersion: '9.0',
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: {
      '.': { devDependencies: { yaml: { specifier: '2.9.1', version: '2.9.1' } } },
      'apps/a': {
        dependencies: {
          '@x/lib': { specifier: 'workspace:*', version: 'link:../../packages/lib' },
          left: { specifier: '1.2.3', version: '1.2.3(peer@4.5.6)' },
        },
      },
      'packages/lib': { dependencies: { left: { specifier: '1.2.3', version: '1.2.3' } } },
    },
    packages: {
      'yaml@2.9.1': { resolution: { integrity: INTEGRITY }, engines: { node: '>= 14' } },
      'left@1.2.3': { resolution: { integrity: INTEGRITY } },
      '@scope/pkg@0.0.1-beta.2+build.5': { resolution: { integrity: INTEGRITY } },
    },
    snapshots: {
      'yaml@2.9.1': {},
      'left@1.2.3(peer@4.5.6)': { dependencies: { peer: '4.5.6' } },
      '@scope/pkg@0.0.1-beta.2+build.5': {},
    },
  };
}

const GOOD_WORKSPACE = `
packages:
  - apps/*
  - packages/*
allowBuilds:
  '@scarf/scarf': false
  esbuild: false
engineStrict: true
peerDependencyRules:
  allowedVersions:
    openapi-typescript>typescript: '6'
`;

function goodInputs(): PolicyInputs {
  return {
    packageJsons: {
      'package.json': { name: 'root', devDependencies: { yaml: '2.9.1' } },
      'apps/a/package.json': {
        name: '@x/a',
        dependencies: { '@x/lib': 'workspace:*', left: '1.2.3' },
        devDependencies: { vitest: '5.0.3' },
      },
      'packages/lib/package.json': { name: '@x/lib', dependencies: { left: '1.2.3' } },
    },
    workspaceYaml: GOOD_WORKSPACE,
    lockfile: stringify(goodLock()),
    workspaceDirectories: ['apps/a', 'packages/lib'],
    customisationFiles: [],
  };
}

/** The distinct problem codes for good inputs after `change` has edited them. */
function codesWith(change: (inputs: PolicyInputs, lock: Json) => void): string[] {
  const inputs = goodInputs();
  const lock = goodLock();
  change(inputs, lock);
  const found = findPolicyProblems({ ...inputs, lockfile: stringify(lock) });
  return [...new Set(found.map((problem) => problem.code))].toSorted();
}

const lockOf = (lock: Json, section: string): Json => lock[section] as Json;
const packageJson = (inputs: PolicyInputs, path: string): Json => {
  const found = inputs.packageJsons[path];
  assert.ok(typeof found === 'object' && found !== null);
  return found as Json;
};

describe('a lockfile and manifests that keep the policy', () => {
  it('are accepted', () => {
    assert.deepEqual(findPolicyProblems(goodInputs()), []);
  });
});

describe('dependency specifiers', () => {
  const accepted = ['1.2.3', '0.0.0', '10.20.30', '1.2.3-beta.1', '1.2.3+build.5', 'workspace:*'];
  for (const specifier of accepted) {
    it(`accepts ${specifier}`, () => {
      assert.deepEqual(
        codesWith((inputs) => {
          packageJson(inputs, 'apps/a/package.json').devDependencies = { tool: specifier };
        }),
        // Only the manifest and the lockfile disagree, which this policy does not check here.
        [],
      );
    });
  }

  // Break caught: a range, tag, alias or remote source in a manifest, so what runs is no longer what was
  // reviewed (a refresh of the lockfile moves it, or the source behind it changes).
  const rejected = [
    '^1.2.3',
    '~1.2.3',
    '>=1.2.3',
    '>1',
    '<2',
    '1.x',
    '1.2.x',
    '1.2',
    '1',
    '*',
    'x',
    '',
    'latest',
    'next',
    '1.2.3 - 2.0.0',
    '1.2.3 || 2.0.0',
    '=1.2.3',
    'v1.2.3',
    '1.2.3 ',
    ' 1.2.3',
    '1.2.3 extra',
    '1.2.3\n',
    'workspace:^',
    'workspace:~',
    'workspace:1.2.3',
    'workspace:../x',
    'npm:left@1.2.3',
    'git+https://github.com/x/y.git',
    'github:x/y',
    'x/y',
    'https://example.com/x.tgz',
    'http://example.com/x.tgz',
    'file:../x',
    'link:../x',
    'portal:../x',
    'catalog:',
    'catalog:default',
  ];
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    it(`rejects each of ${String(rejected.length)} non-exact specifiers in ${field}`, () => {
      for (const specifier of rejected) {
        assert.deepEqual(
          codesWith((inputs) => {
            packageJson(inputs, 'apps/a/package.json')[field] = { tool: specifier };
          }),
          ['SPECIFIER_NOT_EXACT'],
          JSON.stringify(specifier),
        );
      }
    });
  }

  it('rejects a specifier that is not a string', () => {
    for (const specifier of [1, null, true, ['1.2.3'], { version: '1.2.3' }]) {
      assert.deepEqual(
        codesWith((inputs) => {
          packageJson(inputs, 'apps/a/package.json').dependencies = { tool: specifier };
        }),
        ['SPECIFIER_NOT_EXACT'],
        JSON.stringify(specifier),
      );
    }
  });

  it('holds the root manifest and every workspace manifest to it', () => {
    for (const path of ['package.json', 'apps/a/package.json', 'packages/lib/package.json']) {
      assert.deepEqual(
        codesWith((inputs) => {
          packageJson(inputs, path).dependencies = { tool: '^1.0.0' };
        }),
        ['SPECIFIER_NOT_EXACT'],
        path,
      );
    }
  });

  it('names the manifest, the field and the dependency in the problem', () => {
    const inputs = goodInputs();
    packageJson(inputs, 'apps/a/package.json').devDependencies = { tool: '^1.0.0' };
    const [problem] = findPolicyProblems(inputs);
    assert.match(
      problem?.message ?? '',
      /apps\/a\/package\.json: devDependencies\.tool is "\^1\.0\.0"/,
    );
  });
});

describe('settings that rewrite what is resolved', () => {
  const keys = [
    'overrides',
    'resolutions',
    'patchedDependencies',
    'packageExtensions',
    'pnpmfile',
    'globalPnpmfile',
  ];

  // Break caught: a version or a patch put in place of what the lockfile resolves, out of sight of a reviewer
  // who reads the dependency lists.
  for (const key of keys) {
    it(`rejects ${key} in a manifest, at the top level and under pnpm`, () => {
      for (const path of ['package.json', 'apps/a/package.json']) {
        assert.deepEqual(
          codesWith((inputs) => {
            packageJson(inputs, path)[key] = { left: '9.9.9' };
          }),
          ['FORBIDDEN_SETTING'],
          `${path}: ${key}`,
        );
        assert.deepEqual(
          codesWith((inputs) => {
            packageJson(inputs, path).pnpm = { [key]: { left: '9.9.9' } };
          }),
          ['FORBIDDEN_SETTING'],
          `${path}: pnpm.${key}`,
        );
      }
    });

    it(`rejects ${key} in pnpm-workspace.yaml`, () => {
      assert.deepEqual(
        codesWith((inputs) => {
          inputs.workspaceYaml = `${GOOD_WORKSPACE}\n${key}:\n  left: 9.9.9\n`;
        }),
        ['FORBIDDEN_SETTING'],
      );
    });
  }

  it('rejects a lockfile that records overrides, patches or a pnpmfile', () => {
    for (const key of ['overrides', 'patchedDependencies', 'pnpmfileChecksum']) {
      assert.deepEqual(
        codesWith((_, lock) => {
          lock[key] = key === 'pnpmfileChecksum' ? 'abc' : { left: '9.9.9' };
        }),
        ['FORBIDDEN_SETTING'],
        key,
      );
    }
  });

  it('does not take a dependency named like a setting for the setting', () => {
    assert.deepEqual(
      codesWith((inputs, lock) => {
        packageJson(inputs, 'apps/a/package.json').dependencies = { overrides: '1.0.0' };
        lockOf(lock, 'importers')['apps/a'] = {
          dependencies: { overrides: { specifier: '1.0.0', version: '1.0.0' } },
        };
      }),
      [],
    );
  });

  // Break caught: code that changes an install, by its file name, though no setting names it.
  for (const file of CUSTOMISATION_FILES) {
    it(`rejects ${file} in the repository`, () => {
      assert.deepEqual(
        codesWith((inputs) => {
          inputs.customisationFiles = [file];
        }),
        ['CUSTOMISATION_FILE'],
      );
    });
  }

  it('looks for the customisation files that pnpm reads', () => {
    for (const file of ['.pnpmfile.cjs', '.pnpmfile.mjs', 'patches']) {
      assert.ok(CUSTOMISATION_FILES.includes(file), file);
    }
  });
});

describe('dependency build scripts', () => {
  // Break caught: a package allowed to run code at install time.
  for (const [label, value] of [
    ['true', 'true'],
    ['a name with "true"', "'true'"],
    ['a name with a path', '"./approved.js"'],
    ['a name with nothing', 'null'],
  ] as const) {
    it(`rejects an allowBuilds entry that is ${label}`, () => {
      assert.deepEqual(
        codesWith((inputs) => {
          inputs.workspaceYaml = GOOD_WORKSPACE.replace('esbuild: false', `esbuild: ${value}`);
        }),
        ['BUILD_ALLOWED'],
      );
    });
  }

  it('rejects allowBuilds that is not a map of names to false', () => {
    for (const text of ['allowBuilds: true', 'allowBuilds:\n  - esbuild', 'allowBuilds: false']) {
      assert.deepEqual(
        codesWith((inputs) => {
          inputs.workspaceYaml = GOOD_WORKSPACE.replace(
            /allowBuilds:[\s\S]*?engineStrict/,
            `${text}\nengineStrict`,
          );
        }),
        ['BUILD_ALLOWED'],
        text,
      );
    }
  });

  it('accepts a workspace that does not have allowBuilds at all, and one that has an empty map', () => {
    assert.deepEqual(
      codesWith((inputs) => {
        inputs.workspaceYaml = 'packages:\n  - apps/*\n';
      }),
      [],
    );
    assert.deepEqual(
      codesWith((inputs) => {
        inputs.workspaceYaml = 'packages:\n  - apps/*\nallowBuilds: {}\n';
      }),
      [],
    );
  });

  it('rejects the older and the blanket ways of approving builds', () => {
    for (const setting of [
      'onlyBuiltDependencies:\n  - esbuild\n',
      'dangerouslyAllowAllBuilds: true\n',
    ]) {
      assert.deepEqual(
        codesWith((inputs) => {
          inputs.workspaceYaml = `${GOOD_WORKSPACE}${setting}`;
        }),
        ['BUILD_ALLOWED'],
        setting,
      );
    }
    assert.deepEqual(
      codesWith((inputs) => {
        inputs.workspaceYaml = `${GOOD_WORKSPACE}onlyBuiltDependencies: []\ndangerouslyAllowAllBuilds: false\n`;
      }),
      [],
    );
  });

  it('keeps the exception the repository has documented: a peer range for the generator', () => {
    const settings: unknown = parse(GOOD_WORKSPACE);
    assert.ok(
      typeof settings === 'object' && settings !== null && 'peerDependencyRules' in settings,
    );
    assert.deepEqual(findPolicyProblems(goodInputs()), []);
  });
});

describe('what the lockfile resolves', () => {
  const pkg = (change: (packages: Json) => void) => (_: PolicyInputs, lock: Json) => {
    change(lockOf(lock, 'packages'));
  };

  // Break caught: a package that comes from somewhere else than the registry, by a URL, a repository, a folder
  // or a file, none of which has a published version whose hash can be compared.
  const sources: [label: string, key: string, entry: Json][] = [
    [
      'a tarball URL',
      'left@1.2.3',
      { resolution: { tarball: 'https://example.com/left-1.2.3.tgz' } },
    ],
    [
      'a tarball URL with an integrity hash',
      'left@1.2.3',
      { resolution: { tarball: 'https://example.com/left.tgz', integrity: INTEGRITY } },
    ],
    [
      'a git repository',
      'left@1.2.3',
      { resolution: { type: 'git', repo: 'https://github.com/x/left.git', commit: 'abc123' } },
    ],
    ['a folder', 'left@1.2.3', { resolution: { directory: '../left', type: 'directory' } }],
    ['a file', 'left@file:../left.tgz', { resolution: { integrity: INTEGRITY } }],
    [
      'a URL in the key',
      'left@https://example.com/left.tgz',
      { resolution: { integrity: INTEGRITY } },
    ],
    [
      'a git URL in the key',
      'left@git+https://github.com/x/left.git',
      { resolution: { integrity: INTEGRITY } },
    ],
    [
      'a shorthand repository in the key',
      'left@github:x/left',
      { resolution: { integrity: INTEGRITY } },
    ],
    ['an alias in the key', 'left@npm:other@1.2.3', { resolution: { integrity: INTEGRITY } }],
    ['a range in the key', 'left@^1.2.3', { resolution: { integrity: INTEGRITY } }],
    ['a link in the key', 'left@link:../left', { resolution: { integrity: INTEGRITY } }],
    ['no resolution', 'left@1.2.3', {}],
    ['no integrity', 'left@1.2.3', { resolution: {} }],
    ['a weak hash', 'left@1.2.3', { resolution: { integrity: 'md5-abc' } }],
    [
      'an integrity hash and a registry',
      'left@1.2.3',
      { resolution: { integrity: INTEGRITY, registry: 'https://x.example' } },
    ],
  ];
  for (const [label, key, entry] of sources) {
    it(`rejects a package resolved from ${label}`, () => {
      assert.deepEqual(
        codesWith(
          pkg((packages) => {
            Reflect.deleteProperty(packages, 'left@1.2.3');
            packages[key] = entry;
          }),
        ),
        ['LOCK_SOURCE'],
      );
    });
  }

  // Break caught: a key that starts like a registry version and goes on to name something else (a query, a
  // fragment, a path, more text), which a pattern open at the end would accept.
  it('rejects a package whose key has text after the version', () => {
    for (const key of [
      'left@1.2.3?tarball=x',
      'left@1.2.3#abc123',
      'left@1.2.3 evil',
      'left@1.2.3/sub',
      'left@1.2.3_x',
      'left@1.2.3.tgz',
      'left@1.2.3(peer@4.5.6)',
    ]) {
      assert.deepEqual(
        codesWith(
          pkg((packages) => {
            Reflect.deleteProperty(packages, 'left@1.2.3');
            packages[key] = { resolution: { integrity: INTEGRITY } };
          }),
        ),
        ['LOCK_SOURCE'],
        key,
      );
    }
  });

  it('rejects a snapshot whose key has text after the version and its peers', () => {
    for (const key of [
      'left@1.2.3?x=1',
      'left@1.2.3 evil',
      'left@1.2.3/sub',
      'left@1.2.3(peer',
      'left@1.2.3(peer)x',
    ]) {
      assert.deepEqual(
        codesWith((_, lock) => {
          lockOf(lock, 'snapshots')[key] = {};
        }),
        ['LOCK_SOURCE'],
        key,
      );
    }
  });

  it('rejects a snapshot that is not an exact registry version', () => {
    for (const key of [
      'left@file:../left',
      'left@https://example.com/l.tgz',
      'left@git+ssh://x/y.git',
      'left@^1.0.0',
    ]) {
      assert.deepEqual(
        codesWith((_, lock) => {
          lockOf(lock, 'snapshots')[key] = {};
        }),
        ['LOCK_SOURCE'],
        key,
      );
    }
  });

  it('accepts a scoped package, a prerelease, build metadata and peers in a snapshot key', () => {
    assert.deepEqual(
      codesWith(() => undefined),
      [],
    );
  });

  // Break caught: an importer resolved to a source, or locked from a specifier that is not exact.
  for (const version of [
    'file:../x',
    'https://example.com/x.tgz',
    'git+https://github.com/x/y.git',
    'npm:left@1.2.3',
    '^1.2.3',
    'github:x/y',
    '',
  ]) {
    it(`rejects an importer that resolves to ${JSON.stringify(version)}`, () => {
      assert.deepEqual(
        codesWith((_, lock) => {
          const importers = lockOf(lock, 'importers');
          importers['packages/lib'] = { dependencies: { left: { specifier: '1.2.3', version } } };
        }),
        ['LOCK_SOURCE'],
      );
    });
  }

  it('rejects an importer locked from a range', () => {
    assert.deepEqual(
      codesWith((_, lock) => {
        lockOf(lock, 'importers')['packages/lib'] = {
          dependencies: { left: { specifier: '^1.2.3', version: '1.2.3' } },
        };
      }),
      ['SPECIFIER_NOT_EXACT'],
    );
  });

  it('rejects an importer entry without a version', () => {
    assert.deepEqual(
      codesWith((_, lock) => {
        lockOf(lock, 'importers')['packages/lib'] = {
          dependencies: { left: { specifier: '1.2.3' } },
        };
      }),
      ['LOCK_SOURCE'],
    );
  });

  // Break caught: a link to a folder outside the workspace (or to one that is not a package), which would put
  // code the lockfile does not describe into node_modules.
  const links: [label: string, importer: string, specifier: string, version: string][] = [
    ['outside the repository', 'apps/a', 'workspace:*', 'link:../../../elsewhere'],
    ['to a folder that is not a package', 'apps/a', 'workspace:*', 'link:../../scripts'],
    ['to a package that is not in the workspace', 'apps/a', 'workspace:*', 'link:../b'],
    [
      'declared as a link in the manifest',
      'apps/a',
      'link:../../packages/lib',
      'link:../../packages/lib',
    ],
    ['declared as a version in the manifest', 'apps/a', '1.2.3', 'link:../../packages/lib'],
    ['from the root to a folder that is not a package', '.', 'workspace:*', 'link:tools'],
  ];
  for (const [label, importer, specifier, version] of links) {
    it(`rejects a link ${label}`, () => {
      assert.deepEqual(
        codesWith((_, lock) => {
          const importers = lockOf(lock, 'importers');
          importers[importer] = { dependencies: { '@x/lib': { specifier, version } } };
        }).filter((code) => code !== 'SPECIFIER_NOT_EXACT'),
        ['LOCK_LINK'],
      );
    });
  }

  it('accepts a link from the root to a package of the workspace', () => {
    assert.deepEqual(
      codesWith((_, lock) => {
        lockOf(lock, 'importers')['.'] = {
          devDependencies: { '@x/lib': { specifier: 'workspace:*', version: 'link:packages/lib' } },
        };
      }),
      [],
    );
  });

  // Break caught: a lockfile that cannot be read passing as though it held nothing wrong.
  it('says when there is nothing to check', () => {
    for (const text of [
      '',
      'just text',
      '[]',
      'importers: {}\npackages: {}\n',
      'importers:\n  .: {}\n',
      'packages:\n  a@1.0.0: {}\n',
    ]) {
      const found = findPolicyProblems({ ...goodInputs(), lockfile: text });
      assert.deepEqual(
        found.map((problem) => problem.code),
        ['LOCK_UNREADABLE'],
        JSON.stringify(text),
      );
    }
  });
});

describe('this repository', () => {
  const inputs = readPolicyInputs(root);

  // Never write a check that passes when it has nothing to check.
  it('has the manifests, the workspace file and the lockfile this policy is about', () => {
    assert.deepEqual(Object.keys(inputs.packageJsons).toSorted(), [
      'apps/api/package.json',
      'apps/ops-web/package.json',
      'e2e/package.json',
      'package.json',
      'packages/api-client/package.json',
    ]);
    const lock: unknown = parse(inputs.lockfile);
    assert.ok(typeof lock === 'object' && lock !== null && 'packages' in lock);
    const packages = (lock as { packages: Json }).packages;
    assert.ok(Object.keys(packages).length > 100, 'the lockfile resolves many packages');
    const count = Object.values(inputs.packageJsons).reduce<number>(
      (sum, json) =>
        sum +
        ['dependencies', 'devDependencies'].reduce(
          (inner, field) =>
            inner + Object.keys((json as Record<string, Json | undefined>)[field] ?? {}).length,
          0,
        ),
      0,
    );
    assert.ok(count > 30, 'the manifests declare dependencies');
    assert.ok(inputs.workspaceYaml.includes('allowBuilds'));
  });

  it('keeps the dependency policy', () => {
    assert.deepEqual(findPolicyProblems(inputs), []);
  });

  it('declares only dependencies that the lockfile locked from the same exact specifier', () => {
    const lock = parse(inputs.lockfile) as {
      importers: Record<string, Record<string, Record<string, { specifier: string }>>>;
    };
    for (const [path, json] of Object.entries(inputs.packageJsons)) {
      const importer = path === 'package.json' ? '.' : path.replace(/\/package\.json$/, '');
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const declared = (json as Record<string, Record<string, string> | undefined>)[field] ?? {};
        const locked = lock.importers[importer]?.[field] ?? {};
        assert.deepEqual(
          Object.fromEntries(
            Object.entries(locked).map(([name, entry]) => [name, entry.specifier]),
          ),
          declared,
          `${importer} ${field}`,
        );
      }
    }
  });

  it('is read from the files of the checkout, not from a copy', () => {
    assert.equal(inputs.lockfile, readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8'));
  });
});
