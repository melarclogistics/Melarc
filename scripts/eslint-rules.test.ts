import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

  // Break caught: a second door to Motion, so that a page animates in the library's own terms (a duration of its own, an easing of its own, a
  // motion that ignores the person's wish for less) and the motion tokens stop being the one source (DESIGN_SYSTEM section 9 and 24a). The
  // components of components/ui are the one place that may import it.
  it('lets only the components of the design system import Motion', () => {
    const component = 'apps/ops-web/src/components/ui/side-panel/SidePanel.tsx';
    for (const code of [
      "import { motion } from 'motion/react';",
      "import { animate } from 'motion';",
      "import { m } from 'framer-motion';",
      "import { frame } from 'motion-dom';",
      "import { easeOut } from 'motion-utils';",
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
        'apps/ops-web/src/components/primitives/sheet.tsx',
      ]) {
        assert.match(
          messagesFor(path, code).join('\n'),
          /Motion is imported by the components of components\/ui only/,
          `${path} was not refused: ${code}`,
        );
      }
    }
    for (const code of [
      "import { motion } from 'motion/react/client';",
      "import { x } from 'motion/dom';",
    ]) {
      assert.match(
        messagesFor(OPS, code).join('\n'),
        /Motion is imported/,
        `${code} was not refused in a page`,
      );
    }
  });

  // Break caught: a second door to Radix UI and the libraries beside it, so that a page draws a widget in the library's own terms and the one
  // look and the one API of the design system drift (DESIGN_SYSTEM section 24a). The shadcn/ui primitives (components/primitives) are the one
  // place that may import them; the components of components/ui import a primitive and never the library under it.
  it('lets only the primitives import Radix UI, cmdk, vaul, sonner and react-day-picker', () => {
    const primitive = 'apps/ops-web/src/components/primitives/dialog.tsx';
    for (const code of [
      "import { Dialog } from 'radix-ui';",
      "import * as Dialog from '@radix-ui/react-dialog';",
      "import { Slot } from '@radix-ui/react-slot';",
      "import { Command } from 'cmdk';",
      "import { Drawer } from 'vaul';",
      "import { Toaster } from 'sonner';",
      "import { DayPicker } from 'react-day-picker';",
    ]) {
      assert.deepEqual(messagesFor(primitive, code), [], `${code} was refused in a primitive`);
      for (const path of [
        OPS,
        'apps/ops-web/src/components/Probe.tsx',
        'apps/ops-web/src/components/ui/button/Probe.tsx',
        'apps/ops-web/src/platform/Probe.ts',
        'apps/ops-web/src/showcase/Probe.tsx',
      ]) {
        assert.match(
          messagesFor(path, code).join('\n'),
          /components\/primitives/,
          `${path} was not refused: ${code}`,
        );
      }
    }
  });

  // Break caught: a page that draws a primitive, so that the Melarc component (its words, its states, its tokens) is skipped. Only the components
  // of components/ui import a primitive, and the dev-only showcase, which draws every primitive beside the components; a primitive may import
  // another (the calendar draws a button).
  it('lets only the components of the design system and the showcase import a primitive', () => {
    for (const code of [
      "import { Button } from '@/components/primitives/button';",
      "import { Button } from '../../primitives/button';",
      "import { buttonVariants } from '../primitives/button';",
    ]) {
      for (const path of [
        'apps/ops-web/src/components/ui/button/Probe.tsx',
        'apps/ops-web/src/showcase/Probe.tsx',
        'apps/ops-web/src/components/primitives/sheet.tsx',
      ]) {
        assert.deepEqual(messagesFor(path, code), [], `${path} was refused: ${code}`);
      }
      for (const path of [
        OPS,
        'apps/ops-web/src/components/Probe.tsx',
        // A folder that no longer exists (the side menu was removed in redesign step R4): a probe path is a name for the rule, and any file under
        // `components/` outside the three allowed places is refused.
        'apps/ops-web/src/components/side-menu/Probe.tsx',
        'apps/ops-web/src/platform/Probe.ts',
      ]) {
        assert.match(
          messagesFor(path, code).join('\n'),
          /primitive/,
          `${path} was not refused: ${code}`,
        );
      }
    }
  });

  // Break caught: the primitives being a second door to the icon library for everyone, or to what the rest of the code may not reach. The
  // generated source imports its own icons from the library, which is the one exception; it stays out of Motion and out of the API.
  it('lets the primitives import the icon library and still keeps Motion and the API out of them', () => {
    const primitive = 'apps/ops-web/src/components/primitives/select.tsx';
    assert.deepEqual(messagesFor(primitive, "import { CheckIcon } from 'lucide-react';"), []);
    for (const code of [
      "import { motion } from 'motion/react';",
      "import axios from 'axios';",
      "const response = fetch('/api/v1/x');",
    ]) {
      assert.notDeepEqual(messagesFor(primitive, code), [], `${code} was not refused`);
    }
    for (const path of [
      'apps/ops-web/src/components/ui/button/Probe.tsx',
      'apps/ops-web/src/showcase/Probe.tsx',
    ]) {
      assert.match(
        messagesFor(path, "import { CheckIcon } from 'lucide-react';").join('\n'),
        /icon registry|icons\.ts/,
        `${path} was not refused`,
      );
    }
  });

  // Break caught: a door `no-restricted-imports` does not watch (it reads import declarations only): a dynamic import or a require of Motion,
  // of the libraries under the primitives or of the icon library, which a page could use to animate or draw a widget in the library's terms.
  it('refuses the libraries and the icon library by a dynamic import or a require, wherever it is written', () => {
    for (const path of [
      OPS,
      'apps/ops-web/src/components/ui/date-picker/DatePicker.tsx',
      'apps/ops-web/src/components/primitives/dialog.tsx',
      'apps/ops-web/src/showcase/Probe.tsx',
    ]) {
      for (const code of [
        "const library = await import('motion/react');",
        "const library = await import('framer-motion');",
        "const dom = await import('motion-dom');",
        "const library = require('motion');",
        "const icons = await import('lucide-react');",
        "const radix = await import('radix-ui');",
        "const dialog = await import('@radix-ui/react-dialog');",
        "const palette = await import('cmdk');",
        "const drawer = await import('vaul');",
        "const toasts = await import('sonner');",
        "const days = await import('react-day-picker');",
        "const radix = require('radix-ui');",
        "const dialog = require('@radix-ui/react-dialog');",
      ]) {
        assert.match(
          messagesFor(path, code).join('\n'),
          /second door/,
          `${path} was not refused: ${code}`,
        );
      }
    }
  });

  // Break caught: a second door to TanStack Table, so that a screen builds a grid of its own beside the DataTable and its row model, its keys and its states
  // (task R5.2, M12; COMPONENT_PATTERNS section 37). The DataTable's own folder is the one place that may import it, by a static import: a dynamic import or a require is
  // refused there as everywhere, for it would be a second door.
  it('lets only the DataTable import TanStack Table', () => {
    for (const code of [
      "import { useReactTable } from '@tanstack/react-table';",
      "import { createTable } from '@tanstack/table-core';",
      "import { x } from '@tanstack/react-table/dist/index';",
    ]) {
      assert.deepEqual(
        messagesFor('apps/ops-web/src/components/ui/data-table/DataTable.tsx', code),
        [],
        `the DataTable was refused: ${code}`,
      );
      for (const path of [
        OPS,
        'apps/ops-web/src/components/Probe.tsx',
        'apps/ops-web/src/components/ui/queue-table/Probe.tsx',
        'apps/ops-web/src/components/ui/button/Probe.tsx',
        'apps/ops-web/src/components/primitives/table.tsx',
        'apps/ops-web/src/showcase/Probe.tsx',
        'apps/ops-web/src/platform/Probe.ts',
      ]) {
        assert.match(
          messagesFor(path, code).join('\n'),
          /TanStack Table is imported by the DataTable/,
          `${path} was not refused: ${code}`,
        );
      }
    }
    for (const path of [
      'apps/ops-web/src/components/ui/data-table/DataTable.tsx',
      OPS,
      'apps/ops-web/src/showcase/Probe.tsx',
    ]) {
      for (const code of [
        "const table = await import('@tanstack/react-table');",
        "const core = await import('@tanstack/table-core');",
        "const table = require('@tanstack/react-table');",
      ]) {
        assert.match(
          messagesFor(path, code).join('\n'),
          /second door/,
          `${path} was not refused: ${code}`,
        );
      }
    }
    // The DataTable's folder still keeps what every component of the design system keeps out: Radix UI, the API's other doors, and the older page header.
    assert.match(
      messagesFor(
        'apps/ops-web/src/components/ui/data-table/DataTable.tsx',
        "import { Dialog } from 'radix-ui';",
      ).join('\n'),
      /components\/primitives only/,
    );
  });

  // Break caught: the net cast so wide that it catches another TanStack package (the query client is TanStack's too, and every screen imports it).
  it('lets TanStack Query through', () => {
    assert.deepEqual(messagesFor(OPS, "import { useQuery } from '@tanstack/react-query';"), []);
    assert.deepEqual(messagesFor(OPS, "const query = await import('@tanstack/react-query');"), []);
  });

  // Break caught: a new screen that takes the older page header (`components/PageHeader`) in place of the redesign's (`components/ui/page-header`), so that the one header
  // the redesign decided on is never the only one (task R5.2, M12). The screens that are not rebuilt yet name the older one on a line of their own that carries a disable
  // directive: the directive is the list, an unused one is an error, and a screen that moves to the kit's header deletes both lines.
  it('refuses the older page header unless the import carries its own directive, and never the kit’s', () => {
    for (const code of [
      "import { PageHeader } from '../../../components/PageHeader';",
      "import { PageHeader } from '../components/PageHeader';",
      "import { PageHeader } from '@/components/PageHeader';",
    ]) {
      for (const path of [
        OPS,
        'apps/ops-web/src/app/pages/pickup/Probe.tsx',
        'apps/ops-web/src/showcase/Probe.tsx',
        'apps/ops-web/src/components/ui/panel/Probe.tsx',
        'apps/ops-web/src/components/ui/data-table/DataTable.tsx',
      ]) {
        assert.match(
          messagesFor(path, code).join('\n'),
          /Use the PageHeader of components\/ui\/page-header/,
          `${path} was not refused: ${code}`,
        );
        assert.deepEqual(
          messagesFor(
            path,
            `// eslint-disable-next-line no-restricted-imports -- grandfathered\n${code}`,
          ),
          [],
          `${path} was refused though its line carries the directive: ${code}`,
        );
      }
    }
    for (const code of [
      "import { PageHeader } from '../../../components/ui/page-header/PageHeader';",
      "import { PageHeader } from '../../components/ui/page-header/PageHeader';",
      "import { PageHeader } from '../page-header/PageHeader';",
    ]) {
      assert.deepEqual(messagesFor(OPS, code), [], `the kit's header was refused: ${code}`);
    }
  });

  // Break caught: a list that outlives what it lists, or a screen that imports the older header without being on it. The directive is the list, so the two are held
  // together here by reading the sources: every import of the older header carries the directive on the line before it, and no directive stands before a line that is
  // something else. (ESLint's own `reportUnusedDisableDirectives` says the same of a directive whose import was removed; this is the check that does not depend on it.)
  it('keeps the list of screens on the older page header exactly the screens that import it', () => {
    const directive = '// eslint-disable-next-line no-restricted-imports -- the older PageHeader';
    const olderHeader = /^import \{ PageHeader \} from '(?:\.\.\/)+components\/PageHeader';$/;
    const sources: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = resolve(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
          sources.push(full);
      }
    };
    walk(resolve(root, 'apps/ops-web/src'));
    const importers: string[] = [];
    for (const file of sources) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        const name = file.slice(root.length + 1).replaceAll('\\', '/');
        if (olderHeader.test(line)) {
          importers.push(name);
          assert.ok(
            lines[index - 1]?.startsWith(directive),
            `${name} imports the older page header without its directive`,
          );
        } else if (line.startsWith(directive)) {
          assert.match(
            lines[index + 1] ?? '',
            /components\/PageHeader'/,
            `${name} has the directive of the older page header before another line`,
          );
        }
      });
    }
    assert.ok(
      importers.length > 0,
      'no importer of the older page header was found: has the pattern moved?',
    );
  });

  // Break caught: the net cast so wide that it catches a package that merely begins like one of them.
  it('lets an unrelated dynamic import or require through', () => {
    for (const code of [
      "const view = await import('./Other');",
      "const unrelated = await import('motionless');",
      "const fs = require('node:fs');",
    ]) {
      assert.deepEqual(messagesFor(OPS, code), [], code);
    }
  });

  // Break caught: the helpers of the DatePicker (which read and write the date as the control types it) imported by a page, so that a page holds a
  // date as something other than the text the API carries.
  it('keeps the date helpers of the DatePicker inside the components of the design system', () => {
    const helpers = "import { dateFromText } from '../components/ui/date-picker/date-value';";
    assert.match(messagesFor(OPS, helpers).join('\n'), /holds a date as text/);
    assert.match(
      messagesFor(
        OPS,
        "import { readDayFirst } from '../components/ui/date-picker/day-first';",
      ).join('\n'),
      /holds a date as text/,
    );
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

  // The one exception to the ban on web storage (redesign step R4; PRODUCT_DESIGN_DIRECTION section 7): the module that keeps the person's choice
  // of theme may name `localStorage` by its bare name (the only form it uses), and nothing else is let through for it or for anything beside it.
  const THEME_MODULE = 'apps/ops-web/src/platform/theme/theme-choice.ts';

  // Break caught: the exception widened: another file beside the module (the hook next to it, a page, a component) allowed to keep something in
  // the browser, which is how a second thing gets stored without anyone deciding it.
  it('lets only the theme module name localStorage, by its bare name', () => {
    for (const code of [
      "localStorage.getItem('melarc-theme');",
      "localStorage.setItem('melarc-theme', 'dark');",
      "localStorage.removeItem('melarc-theme');",
    ]) {
      assert.deepEqual(
        messagesFor(THEME_MODULE, code),
        [],
        `${code} was refused in the theme module`,
      );
      for (const path of [
        'apps/ops-web/src/platform/theme/use-theme-choice.ts',
        'apps/ops-web/src/platform/theme/other.ts',
        'apps/ops-web/src/platform/hub/active-hub.tsx',
        'apps/ops-web/src/components/ui/app-shell/ThemeControl.tsx',
        'apps/ops-web/src/app/Probe.tsx',
      ]) {
        assert.notDeepEqual(messagesFor(path, code), [], `${code} was not refused in ${path}`);
      }
    }
  });

  // Break caught (review of 7 November 2026): the exception relaxing a second rule (`no-restricted-properties`) as well as `no-restricted-globals`, and so
  // letting the module reach storage through `window`, `globalThis` or `self`, which it has no use for: the exception is as narrow as the module.
  it('refuses window.localStorage, globalThis.localStorage and self.localStorage in the theme module too', () => {
    for (const code of [
      "window.localStorage.setItem('melarc-theme', 'dark');",
      "globalThis.localStorage.removeItem('melarc-theme');",
      "self.localStorage.getItem('melarc-theme');",
    ]) {
      assert.notDeepEqual(
        messagesFor(THEME_MODULE, code),
        [],
        `${code} was not refused in the theme module`,
      );
    }
  });

  // Break caught: the exception for one storage becoming one for all, or taking the other bans with it: `sessionStorage`, `indexedDB`, the
  // cookie, and every way to reach the network stay refused in the one module that may keep a theme.
  it('keeps every other ban in force inside the theme module', () => {
    for (const [label, code] of [
      ['sessionStorage', "sessionStorage.setItem('x', 'y');"],
      ['window.sessionStorage', "window.sessionStorage.setItem('x', 'y');"],
      ['indexedDB', "indexedDB.open('db');"],
      ['window.indexedDB', "window.indexedDB.open('db');"],
      ['document.cookie', "document.cookie = 'a=b';"],
      ['fetch', "fetch('/api/v1/x');"],
      ['window.fetch', "window.fetch('/api/v1/x');"],
      ['XMLHttpRequest', 'const request = new XMLHttpRequest();'],
      ['WebSocket', "const socket = new WebSocket('wss://x.test');"],
      ['navigator.sendBeacon', "navigator.sendBeacon('/x', 'a');"],
      ['window.open', "window.open('https://x.test');"],
      ['an innerHTML assignment', 'element.innerHTML = html;'],
      ['eval', "eval('1 + 1');"],
      ['the icon library', "import { Eye } from 'lucide-react';"],
    ] as const) {
      assert.notDeepEqual(
        messagesFor(THEME_MODULE, code),
        [],
        `${label} was not refused in the theme module`,
      );
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
