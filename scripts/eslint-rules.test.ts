import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

/**
 * The restrictions of eslint.config.mjs that exist to keep code on the one safe path, held by running the real
 * configuration over small snippets: a rule that was removed, narrowed or pointed at the wrong files makes a snippet
 * that must be refused pass. Only the blocks that carry those rules are used, and without type information, which
 * the rules do not need, so each snippet is judged in milliseconds.
 */
const root = resolve(import.meta.dirname, '..');

const RESTRICTING_RULES = [
  'no-restricted-syntax',
  'no-restricted-globals',
  'no-restricted-properties',
  'no-restricted-imports',
  'no-eval',
  'no-new-func',
  'no-script-url',
];

const loaded = (await import(pathToFileURL(resolve(root, 'eslint.config.mjs')).href)) as {
  default: Linter.Config[];
};
const blocks = loaded.default.filter((block) =>
  Object.keys(block.rules ?? {}).some((rule) => RESTRICTING_RULES.includes(rule)),
);

const linter = new Linter({ cwd: root, configType: 'flat' });

/** What the restricting rules say about a snippet written as a file at `path`. */
function messagesFor(path: string, code: string): string[] {
  return linter
    .verify(
      code,
      [
        ...blocks,
        {
          files: ['**/*.{ts,tsx}'],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
        },
      ],
      { filename: path },
    )
    .map((message) => `${message.ruleId ?? 'parse'}: ${message.message}`);
}

const OPS = 'apps/ops-web/src/app/Probe.tsx';

describe('the Ops Portal reaches the API through the generated client only', () => {
  it('the configuration has the blocks this test needs', () => {
    assert.ok(blocks.length >= 2, 'expected the API and the Ops Portal restriction blocks');
  });

  // Break caught: a request, a stored credential or a string put into the page as HTML that skips the transport
  // (CSRF header, same-origin check, credentials mode) or the escaping that React does.
  for (const [label, code] of [
    ['a call of fetch', "fetch('/api/v1/x');"],
    ['window.fetch', "window.fetch('/api/v1/x');"],
    ['globalThis.fetch', "globalThis.fetch('/api/v1/x');"],
    ['self.fetch', "self.fetch('/api/v1/x');"],
    ['an XMLHttpRequest', 'const request = new XMLHttpRequest();'],
    ['a WebSocket', "const socket = new WebSocket('wss://x.test');"],
    ['an EventSource', "const source = new EventSource('/x');"],
    ['navigator.sendBeacon', "navigator.sendBeacon('/x', 'a');"],
    ['window.open', "window.open('https://x.test');"],
    ['localStorage', "localStorage.setItem('token', 'x');"],
    ['sessionStorage', "sessionStorage.setItem('token', 'x');"],
    ['window.localStorage', "window.localStorage.getItem('token');"],
    ['indexedDB', "indexedDB.open('db');"],
    ['document.cookie', "document.cookie = 'a=b';"],
    ['document.write', "document.write('<b>x</b>');"],
    ['axios', "import axios from 'axios';"],
    ['ky', "import ky from 'ky';"],
    ['node-fetch', "import fetch from 'node-fetch';"],
    [
      'dangerouslySetInnerHTML',
      'export const A = () => <div dangerouslySetInnerHTML={{ __html: html }} />;',
    ],
    ['an innerHTML assignment', 'element.innerHTML = html;'],
    ['an outerHTML assignment', 'element.outerHTML = html;'],
    ['insertAdjacentHTML', "element.insertAdjacentHTML('beforeend', html);"],
    ['eval', "eval('1 + 1');"],
    ['a Function built from text', "const f = new Function('return 1');"],
    ['a javascript: URL', "const href = 'javascript:alert(1)';"],
  ] as const) {
    it(`refuses ${label} in application code`, () => {
      assert.notDeepEqual(messagesFor(OPS, code), [], `${code} was not refused`);
    });
  }

  it('allows the ordinary code a page is made of', () => {
    const code = [
      "import { useApiClient } from '../platform/api/api-client';",
      'export function Page({ text }: { text: string }) {',
      '  const client = useApiClient();',
      "  void client.GET('/pickup-manifests');",
      '  return <p>{text}</p>;',
      '}',
    ].join('\n');
    assert.deepEqual(messagesFor(OPS, code), []);
  });

  // Break caught: the restriction leaking into code that has to do these things: tests fake the network and the
  // storage, and the transport itself lives in another package.
  it('does not apply to tests, to the test support, or to other packages', () => {
    const code = "fetch('/x'); localStorage.clear(); element.innerHTML = '';";
    for (const path of [
      'apps/ops-web/src/app/Probe.test.tsx',
      'apps/ops-web/src/test-support/probe.tsx',
      'packages/api-client/src/browser/probe.ts',
      'apps/api/src/probe.ts',
    ]) {
      assert.deepEqual(messagesFor(path, code), [], `${path} should not be restricted`);
    }
  });
});

describe('a database driver is never handed a connection string', () => {
  const API = 'apps/api/src/platform/database/probe.ts';

  for (const [label, code] of [
    ['a connectionString property', 'const pool = make({ connectionString: url });'],
    ['a quoted connectionString property', "const pool = make({ 'connectionString': url });"],
    ['new Pool with a string', "const pool = new Pool('postgres://u:p@h/db');"],
    ['new Pool with a template', 'const pool = new Pool(`postgres://u:p@h/${name}`);'],
    ['new pg.Client with a string', "const client = new pg.Client('postgres://u:p@h/db');"],
    ['new Client with a concatenation', "const client = new Client('postgres://' + rest);"],
    ['drizzle with a string', "const db = drizzle('postgres://u:p@h/db');"],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.notDeepEqual(messagesFor(API, code), [], `${code} was not refused`);
    });
  }

  it('allows settings read out of the URL', () => {
    assert.deepEqual(
      messagesFor(
        API,
        'const pool = new Pool(postgresConnectionSettings(url)); const db = drizzle(pool);',
      ),
      [],
    );
    assert.deepEqual(
      messagesFor(API, 'const client = new pg.Client({ host, port, user, password });'),
      [],
    );
  });

  it('applies to the end-to-end harness as well', () => {
    assert.notDeepEqual(
      messagesFor('e2e/harness/probe.ts', "new Client('postgres://u:p@h/db');"),
      [],
    );
  });
});
