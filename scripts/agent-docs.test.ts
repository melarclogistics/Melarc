import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  NESTED_LINE_BUDGET,
  REQUIRED_ROOT_SECTIONS,
  ROOT_LINE_BUDGET,
  findAgentDocProblems,
} from './agent-docs.ts';

const created: string[] = [];
after(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

/** A small repository whose agent documents keep every rule. `overrides` adds, replaces or (null) removes files. */
const GOOD: Record<string, string> = {
  'CLAUDE.md': [
    '# Demo',
    '',
    '## Start here',
    'Read [the plan](delivery/PLAN.md).',
    '',
    '## Working rules',
    '- Do the bounded task.',
    '',
    '## Where things are',
    '| Need | Open |',
    '|---|---|',
    '| Requirements | [specs](specs/index.md) |',
    '| API code | [apps/api](apps/api/CLAUDE.md) |',
    '',
    '## Commands',
    '```text',
    'pnpm run build',
    '```',
    '',
    '## Never',
    '- Invent defaults.',
    '',
  ].join('\n'),
  'delivery/PLAN.md': '# Plan\n\nSee [the index](../specs/index.md).\n',
  'specs/index.md': '# Index\n\n- [A](a.md)\n',
  'specs/a.md': '# A\n\n## Details\n\nText.\n',
  'apps/api/CLAUDE.md':
    '# API\n\nRun `pnpm --filter @demo/api run start`. Rules are in [specs](../../specs/a.md#details).\n',
  'package.json': JSON.stringify({ name: 'demo', scripts: { build: 'x' } }),
  'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
  'apps/api/package.json': JSON.stringify({ name: '@demo/api', scripts: { start: 'x' } }),
};

function repository(overrides: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'melarc-agent-docs-'));
  created.push(root);
  const files: Record<string, string | null> = { ...GOOD, ...overrides };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const codes = (overrides: Record<string, string | null> = {}): string[] =>
  findAgentDocProblems(repository(overrides)).map((problem) => problem.code);

const claudeWith = (change: (text: string) => string): Record<string, string> => ({
  'CLAUDE.md': change(GOOD['CLAUDE.md'] ?? ''),
});

describe('a repository whose agent documents keep every rule', () => {
  it('has no problems', () => {
    assert.deepEqual(findAgentDocProblems(repository()), []);
  });

  it('may have a root file that is exactly at its budget', () => {
    const padded = (GOOD['CLAUDE.md'] ?? '').trimEnd().split('\n');
    while (padded.length < ROOT_LINE_BUDGET) padded.push('');
    assert.deepEqual(codes({ 'CLAUDE.md': `${padded.join('\n')}\n` }), []);
  });
});

// Break caught: the budgets raised, one edit at a time, until the file the whole idea depends on is no longer
// short. Raising a budget is a decision to make here, in the open, not a side effect of editing the checker.
describe('the budgets', () => {
  it('are the agreed ones', () => {
    assert.equal(ROOT_LINE_BUDGET, 90);
    assert.equal(NESTED_LINE_BUDGET, 40);
  });
});

describe('the root file', () => {
  // Break caught: no entry point at all, so an agent has nothing to be told.
  it('must exist', () => {
    assert.deepEqual(codes({ 'CLAUDE.md': null }), ['ROOT_MISSING']);
  });

  // Break caught: the file growing until nobody reads it. The long detail belongs in the linked documents.
  it('must stay within its line budget', () => {
    const long = `${GOOD['CLAUDE.md'] ?? ''}${'- filler\n'.repeat(ROOT_LINE_BUDGET)}`;
    assert.deepEqual(codes({ 'CLAUDE.md': long }), ['OVER_BUDGET']);
  });

  for (const section of REQUIRED_ROOT_SECTIONS) {
    it(`must keep its "${section}" section`, () => {
      const without = claudeWith((text) =>
        text.replace(new RegExp(`^## ${section}$`, 'm'), '## Something else'),
      );
      assert.deepEqual(codes(without), ['SECTION_MISSING']);
    });
  }
});

describe('area files', () => {
  // Break caught: an area file that is really a second manual.
  it('must stay within their line budget', () => {
    const long = `# API\n\n${'- filler\n'.repeat(NESTED_LINE_BUDGET)}`;
    assert.deepEqual(codes({ 'apps/api/CLAUDE.md': long }), ['OVER_BUDGET']);
  });

  // Break caught: an area file the root never mentions, so nobody learns it is there.
  it('must be linked from the root file', () => {
    const unlinked = claudeWith((text) =>
      text.replace(
        '| API code | [apps/api](apps/api/CLAUDE.md) |\n',
        '| API code | [apps/api](apps/api/package.json) |\n',
      ),
    );
    assert.ok(codes(unlinked).includes('NESTED_NOT_LINKED'));
  });

  it('may be linked by its folder', () => {
    const byFolder = claudeWith((text) => text.replace('(apps/api/CLAUDE.md)', '(apps/api/)'));
    assert.deepEqual(codes(byFolder), []);
  });

  it('count toward reachability: what they link is not an orphan', () => {
    const extra = {
      'specs/b.md': '# B\n',
      'apps/api/CLAUDE.md':
        '# API\n\nSee [B](../../specs/b.md) and [A](../../specs/a.md#details).\n',
    };
    assert.deepEqual(codes(extra), []);
  });
});

describe('links', () => {
  // Break caught: a file moved or renamed, and a link nobody updated.
  it('must resolve to a file or a folder', () => {
    const broken = claudeWith((text) => `${text}\nSee [gone](specs/gone.md).\n`);
    assert.deepEqual(codes(broken), ['BROKEN_LINK']);
  });

  it('must point at a heading that exists, when they name one', () => {
    const badAnchor = {
      'apps/api/CLAUDE.md': '# API\n\nSee [x](../../specs/a.md#no-such-heading).\n',
    };
    assert.deepEqual(codes(badAnchor), ['BROKEN_LINK']);
  });

  // Break caught: the second of two headings with the same text linked by the name GitHub gives it ("-1"),
  // and the check calling a working link broken (or the first one).
  it('may name the second of two headings that read the same', () => {
    const twice = {
      'specs/a.md': '# A\n\n## Details\n\nOne.\n\n## Details\n\nTwo.\n',
      'apps/api/CLAUDE.md':
        '# API\n\nSee [one](../../specs/a.md#details) and [two](../../specs/a.md#details-1).\n',
    };
    assert.deepEqual(codes(twice), []);
    const third = {
      ...twice,
      'apps/api/CLAUDE.md': '# API\n\nSee [x](../../specs/a.md#details-2).\n',
    };
    assert.deepEqual(codes(third), ['BROKEN_LINK']);
  });

  it('ignore web links', () => {
    const web = claudeWith((text) => `${text}\nSee [docs](https://example.com/a/b.md).\n`);
    assert.deepEqual(codes(web), []);
  });
});

describe('paths in code spans', () => {
  // Break caught: a path written in prose that does not exist (the way a link is not).
  it('must exist, relative to the repository or to the file', () => {
    const bad = claudeWith((text) => `${text}\nSee \`specs/missing.md\`.\n`);
    assert.deepEqual(codes(bad), ['BROKEN_PATH']);
    const good = claudeWith((text) => `${text}\nSee \`specs/a.md\` and \`apps/api/\`.\n`);
    assert.deepEqual(codes(good), []);
  });

  // Break caught: a path checked from only one place. An area file names paths inside its own folder, and
  // sometimes one from the repository root.
  it('are accepted from the file’s own folder and from the repository root', () => {
    const area = {
      'apps/api/src/main.ts': 'export {};\n',
      'apps/api/CLAUDE.md': '# API\n\nSee `src/main.ts` and `specs/a.md`.\n',
    };
    assert.deepEqual(codes(area), []);
    const neither = { 'apps/api/CLAUDE.md': '# API\n\nSee `src/gone.ts`.\n' };
    assert.deepEqual(codes(neither), ['BROKEN_PATH']);
  });

  // Break caught: a path to a document under a folder that does not exist passing because nothing in the
  // repository starts with that name.
  it('that end in a document extension must exist even under an unknown folder', () => {
    const unknown = claudeWith(
      (text) => `${text}\nSee \`nowhere/gone.md\` and \`nowhere/gone.yaml\`.\n`,
    );
    assert.deepEqual(codes(unknown), ['BROKEN_PATH', 'BROKEN_PATH']);
  });

  it('that are not documents and start with no known folder are not paths', () => {
    const ok = claudeWith((text) => `${text}\nSend \`application/json\` or \`text/plain\`.\n`);
    assert.deepEqual(codes(ok), []);
  });

  it('leave URL paths, package names, placeholders and globs alone', () => {
    const ok = claudeWith(
      (text) =>
        `${text}\nUse \`/api/v1\`, \`@demo/api\`, \`specs/<name>.md\`, \`specs/*.md\` and \`a/b c\`.\n`,
    );
    assert.deepEqual(codes(ok), []);
  });
});

describe('commands', () => {
  // Break caught: a command that was renamed or never existed, shown as if it works.
  it('must name scripts that exist, in a code block or a code span', () => {
    const block = claudeWith((text) => text.replace('pnpm run build', 'pnpm run nope'));
    assert.deepEqual(codes(block), ['UNKNOWN_COMMAND']);
    const span = { 'apps/api/CLAUDE.md': '# API\n\nRun `pnpm --filter @demo/api run nope`.\n' };
    assert.deepEqual(codes(span), ['UNKNOWN_COMMAND']);
    const pkg = { 'apps/api/CLAUDE.md': '# API\n\nRun `pnpm --filter @demo/missing run start`.\n' };
    assert.deepEqual(codes(pkg), ['UNKNOWN_COMMAND']);
  });

  it('accept pnpm commands that are not scripts', () => {
    const ok = claudeWith((text) => `${text}\nSee \`pnpm install --frozen-lockfile\`.\n`);
    assert.deepEqual(codes(ok), []);
  });
});

describe('documents nobody links', () => {
  // Break caught: a document added to the repository that no agent will ever be pointed at.
  it('are reported by name', () => {
    const found = findAgentDocProblems(repository({ 'specs/orphan.md': '# Orphan\n' }));
    assert.deepEqual(
      found.map((problem) => problem.code),
      ['ORPHAN_DOCUMENT'],
    );
    assert.match(found[0]?.message ?? '', /specs\/orphan\.md/);
  });

  it('are found in any folder, however deep', () => {
    assert.deepEqual(codes({ 'a/b/c/deep.md': '# Deep\n' }).sort(), [
      'DIRECTORY_NOT_MAPPED',
      'ORPHAN_DOCUMENT',
    ]);
  });

  it('do not include generated or ignored folders', () => {
    const ignored = {
      'node_modules/x/README.md': '# x\n',
      'apps/api/dist/notes.md': '# d\n',
      'tmp/notes.md': '# t\n',
      '.turbo/notes.md': '# t\n',
      'test-results/notes.md': '# t\n',
    };
    assert.deepEqual(codes(ignored), []);
  });
});

describe('folders', () => {
  // Break caught: a top-level folder that the map never mentions.
  it('must each be mapped from the root file', () => {
    const found = findAgentDocProblems(repository({ 'tools/script.ts': 'export {};\n' }));
    assert.deepEqual(
      found.map((problem) => problem.code),
      ['DIRECTORY_NOT_MAPPED'],
    );
    assert.match(found[0]?.message ?? '', /tools/);
  });

  it('are mapped by a link to the folder or to anything inside it', () => {
    const mapped = {
      'tools/script.ts': 'export {};\n',
      ...claudeWith((text) => `${text}\nSee [tools](tools/script.ts).\n`),
    };
    assert.deepEqual(codes(mapped), []);
  });

  it('do not include hidden, ignored or generated folders', () => {
    assert.deepEqual(
      codes({ '.github/x.yml': 'a: 1\n', node_modules: null, 'dist/x.js': 'x\n' }),
      [],
    );
  });
});

describe('the git-ignored tmp folder', () => {
  // Break caught: an instruction that only works on one machine because of a helper nobody else has.
  it('must not be referenced', () => {
    const bad = claudeWith((text) => `${text}\nRun tmp/db-up.cmd first.\n`);
    assert.deepEqual(codes(bad), ['IGNORED_FOLDER']);
    const backslash = claudeWith((text) => `${text}\nRun tmp\\db-up.cmd first.\n`);
    assert.deepEqual(codes(backslash), ['IGNORED_FOLDER']);
  });

  it('may be named as a warning', () => {
    const warning = claudeWith(
      (text) => `${text}\nNever depend on the git-ignored \`tmp/\` folder.\n`,
    );
    assert.deepEqual(codes(warning), []);
  });
});

describe('this repository', () => {
  // Break caught: the agent documents drifting from the repository in a real commit.
  it('keeps every rule', () => {
    const root = resolve(import.meta.dirname, '..');
    assert.deepEqual(findAgentDocProblems(root), []);
  });
});
