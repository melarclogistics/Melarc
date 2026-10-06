import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { anchorOf, anchorsOf, brokenLinks, brokenLinksInCheckout } from './markdown-links.ts';

const root = resolve(import.meta.dirname, '..');

const files = (...entries: [string, string][]) => entries.map(([path, text]) => ({ path, text }));
const existing =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);
const none = (): undefined => undefined;

describe('anchorOf', () => {
  // Break caught: anchors made another way than GitHub makes them, so a link that works there is reported broken or the other way round.
  for (const [heading, anchor] of [
    ['B0.10 — Bootstrap acceptance', 'b010--bootstrap-acceptance'],
    ['Carried forward from B0.2 and B0.3', 'carried-forward-from-b02-and-b03'],
    ['The `Session` schema', 'the-session-schema'],
    ['5.1 Roles, ownership and RLS', '51-roles-ownership-and-rls'],
    ['Plain **bold** heading', 'plain-bold-heading'],
  ] as const) {
    it(`makes ${heading} into ${anchor}`, () => {
      assert.equal(anchorOf(heading), anchor);
    });
  }

  it('numbers a heading that repeats', () => {
    assert.deepEqual([...anchorsOf('# A\n\n## B\n\n## B\n\n## B\n')], ['a', 'b', 'b-1', 'b-2']);
  });

  it('does not read a heading in a code block', () => {
    assert.deepEqual([...anchorsOf('# Real\n\n```md\n# Not a heading\n```\n')], ['real']);
  });
});

describe('brokenLinks', () => {
  // Break caught: a link to a file that was moved or deleted.
  it('reports a link to a file that does not exist', () => {
    const broken = brokenLinks(
      files(['docs/a.md', 'See [b](b.md) and [c](../c.md).']),
      existing('docs/b.md'),
      none,
    );

    assert.deepEqual(broken, [
      { file: 'docs/a.md', target: '../c.md', problem: 'c.md does not exist' },
    ]);
  });

  // Break caught: a heading renamed while the links to it stayed.
  it('reports an anchor that no heading makes, in another file and in the same one', () => {
    const broken = brokenLinks(
      files(
        ['a.md', '# Top\n\n[ok](b.md#the-one) [gone](b.md#renamed) [same](#top) [lost](#nowhere)'],
        ['b.md', '## The one\n'],
      ),
      existing('a.md', 'b.md'),
      none,
    );

    assert.deepEqual(
      broken.map((entry) => entry.target),
      ['b.md#renamed', '#nowhere'],
    );
  });

  it('follows an anchor into a file it was not given, when it can read it', () => {
    const broken = brokenLinks(
      files(['a.md', '[x](other.md#there) [y](other.md#not-there)']),
      existing('other.md'),
      (path) => (path === 'other.md' ? '# There\n' : undefined),
    );

    assert.deepEqual(
      broken.map((entry) => entry.target),
      ['other.md#not-there'],
    );
  });

  // Break caught: an example or an outside address being reported, which would make the check noise.
  it('does not follow an address, a mail link, or anything in code', () => {
    const text = [
      '[web](https://example.test/x#y) [mail](mailto:a@b.test) [protocol-relative](//example.test/x)',
      '`[example](missing.md)`',
      '```md',
      '[also an example](missing.md#nothing)',
      '```',
    ].join('\n');

    assert.deepEqual(brokenLinks(files(['a.md', text]), existing(), none), []);
  });

  it('does not look for an anchor in a file that is not Markdown', () => {
    assert.deepEqual(
      brokenLinks(files(['a.md', '[c](code.ts#L10)']), existing('code.ts'), none),
      [],
    );
  });

  it('reads a link with a title and a percent-encoded path', () => {
    const broken = brokenLinks(
      files(['a.md', '[t](dir/my%20file.md "A title")']),
      existing('dir/my file.md'),
      none,
    );

    assert.deepEqual(broken, []);
  });
});

describe('the repository', () => {
  // Break caught: a link between the specifications, the runbook, the design documents and the code areas that no
  // longer leads anywhere. Zero today, and a rename that breaks one is found in the pull request.
  it('has no broken relative link or anchor in any tracked Markdown file', () => {
    const tracked = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

    assert.ok(tracked.length > 50, 'expected the specification set and the documents of the areas');
    assert.deepEqual(brokenLinksInCheckout(root, tracked), []);
  });
});
