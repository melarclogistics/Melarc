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
    ['the icon library', "import { Eye } from 'lucide-react';"],
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

  // Break caught: a second door to the icon library, so that a screen names a picture of the library instead of a meaning of the design
  // system and the one family drifts (DESIGN_SYSTEM section 24). The registry is the one file that may import it.
  it('lets only the icon registry import the icon library', () => {
    const code = "import { Eye } from 'lucide-react';";
    assert.deepEqual(messagesFor('apps/ops-web/src/components/ui/icon/icons.ts', code), []);
    for (const path of [
      'apps/ops-web/src/components/ui/icon/Icon.tsx',
      'apps/ops-web/src/components/Probe.tsx',
      'apps/ops-web/src/app/Probe.tsx',
    ]) {
      assert.match(
        messagesFor(path, code).join('\n'),
        /icon registry|icons\.ts/,
        `${path} was not refused`,
      );
    }
  });

  // Break caught: a second door to React Aria Components, so that a page draws a library's widget in the library's own terms (its types, its
  // date objects, its styling hooks) and the one look and the one API of the design system drift (DESIGN_SYSTEM section 24a). The components
  // of components/ui are the one place that may import it, and the date library it uses.
  it('lets only the components of the design system import React Aria Components and its date library', () => {
    const component = 'apps/ops-web/src/components/ui/date-picker/DatePicker.tsx';
    for (const code of [
      "import { Calendar } from 'react-aria-components';",
      "import { Button } from 'react-aria-components/Button';",
      "import { useDatePicker } from 'react-aria';",
      "import { useCalendarState } from 'react-stately';",
      "import { parseDate } from '@internationalized/date';",
      "import type { DateValue } from '@react-types/shared';",
      "import { useButton } from '@react-aria/button';",
    ]) {
      assert.deepEqual(
        messagesFor(component, code),
        [],
        `${code} was refused in a component of the design system`,
      );
      for (const path of [
        OPS,
        'apps/ops-web/src/components/Probe.tsx',
        'apps/ops-web/src/platform/Probe.ts',
        'apps/ops-web/src/showcase/Probe.tsx',
      ]) {
        assert.match(
          messagesFor(path, code).join('\n'),
          /React Aria Components/,
          `${path} was not refused: ${code}`,
        );
      }
    }
  });

  // Break caught: a door `no-restricted-imports` does not watch (it reads import declarations only): a dynamic import or a require of the
  // library, of its date library or of the icon library, which a page could use to draw a widget in the library's terms.
  it('refuses the library and the icon library by a dynamic import or a require, wherever it is written', () => {
    for (const path of [OPS, 'apps/ops-web/src/components/ui/date-picker/DatePicker.tsx']) {
      for (const code of [
        "const library = await import('react-aria-components');",
        "const state = await import('react-stately/useCalendarState');",
        "const dates = await import('@internationalized/date');",
        "const icons = await import('lucide-react');",
        "const library = require('react-aria');",
        "const types = require('@react-types/shared');",
      ]) {
        assert.match(
          messagesFor(path, code).join('\n'),
          /second door/,
          `${path} was not refused: ${code}`,
        );
      }
    }
  });

  // Break caught: the net cast so wide that it catches a package that merely begins like one of them.
  it('lets an unrelated dynamic import or require through', () => {
    for (const code of [
      "const view = await import('./Other');",
      "const aria = await import('react-ariana');",
      "const fs = require('node:fs');",
    ]) {
      assert.deepEqual(messagesFor(OPS, code), [], code);
    }
  });

  // Break caught: the helpers of the DatePicker (which hand out the date library's objects) imported by a page, so that a page holds a date as
  // an object of a library it is not to know.
  it('keeps the date helpers of the DatePicker inside the components of the design system', () => {
    const helpers = "import { dateFromText } from '../components/ui/date-picker/date-value';";
    assert.match(messagesFor(OPS, helpers).join('\n'), /holds a date as text/);
    assert.deepEqual(
      messagesFor(
        'apps/ops-web/src/components/ui/date-picker/DatePicker.tsx',
        "import { dateFromText } from './date-value';",
      ),
      [],
    );
  });

  // Break caught: the permission for the design system's components taking the other restrictions with it, so that a component could reach
  // the API or draw a second family of icons.
  it('still refuses the other restricted imports inside the components of the design system', () => {
    const component = 'apps/ops-web/src/components/ui/date-picker/DatePicker.tsx';
    for (const code of [
      "import axios from 'axios';",
      "import { Eye } from 'lucide-react';",
      "const response = fetch('/api/v1/x');",
    ]) {
      assert.notDeepEqual(messagesFor(component, code), [], `${code} was not refused`);
    }
  });

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
