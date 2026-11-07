import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The choice of hub (the switcher of the top bar; surfaces/ops-portal.md section 3) is read in **one place**: `useActiveHub`, which gives the hub
 * the person narrowed the screens to, or nothing for *All hubs*. A screen that sends `hub_id`, or starts a create form with a hub, asks it and nothing
 * else; the one other reader is the switcher's own hook, `useHubChoice`, which only the shell calls (it draws the menu that makes the choice). The
 * components of `components/` present what they are given and so never import the choice at all.
 *
 * **One narrow hook besides** (audit B1 and B9, 7 November 2026): `useHubScope` gives a page the hub it is narrowed to with its name, and the one
 * thing it may do about it, *Show all hubs* (a list that shows nothing because of the hub says so, "Nothing at <hub>", and offers the way back; My
 * work says which hub its counts are for). It is for the pages (`app/pages/`) and no one else, and it cannot choose a hub.
 */
const SRC = resolve(import.meta.dirname, '../src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

describe('the choice of hub', () => {
  // Break caught: a scan over nothing, which would pass whatever the code contains.
  it('is scanned in the files that define and use it', () => {
    const names = files.map((file) => file.path);

    expect(names).toEqual(
      expect.arrayContaining([
        'platform/hub/active-hub.tsx',
        'app/shell/ShellChrome.tsx',
        'app/pages/staff/StaffListPage.tsx',
      ]),
    );
  });

  // Break caught: a screen that reads the switcher's own hook, which also gives the means to change the choice, and so becomes a second place the
  // choice is made or read.
  it('is read through useHubChoice by the shell and by nothing else', () => {
    const users = files
      .filter((file) => /\buseHubChoice\b/.test(file.text))
      .map((file) => file.path)
      .toSorted();

    expect(users).toEqual(['app/shell/ShellChrome.tsx', 'platform/hub/active-hub.tsx']);
  });

  // Break caught (audit B1): the narrow hook read by something that is not a page (a component, the shell, a platform module): the hub's name and the
  // way back to All hubs are for the pages that say "Nothing at <hub>", and everything else is given what it draws.
  it('is read through useHubScope by the pages of app/pages/ and by nothing else', () => {
    const users = files
      .filter((file) => /\buseHubScope\b/.test(file.text))
      .map((file) => file.path)
      .filter((path) => path !== 'platform/hub/active-hub.tsx');

    expect(users.length).toBeGreaterThanOrEqual(8);
    expect(users.filter((path) => !path.startsWith('app/pages/'))).toEqual([]);
  });

  // Break caught (audit B1): the narrow hook growing a way to choose a hub, which makes every page a second place the choice is made.
  it('gives a page the hub and Show all hubs, and no way to choose a hub', () => {
    const text = files.find((file) => file.path === 'platform/hub/active-hub.tsx')?.text ?? '';
    const body = /export interface HubScope \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';

    expect([...body.matchAll(/readonly (\w+)/g)].map((match) => match[1])).toEqual([
      'hub',
      'showAllHubs',
    ]);
  });

  // Break caught: a presentational component that reads the choice itself, which makes what it draws depend on something it was not given.
  it('is never imported by a component of components/', () => {
    const importers = files
      .filter((file) => file.path.startsWith('components/'))
      .filter((file) => /(?:from|import)\s+['"][^'"]*platform\/hub\//.test(file.text))
      .map((file) => file.path);

    expect(importers).toEqual([]);
  });

  // Break caught: the choice written to the browser, where the next person to use the computer would find it.
  it('is kept in memory: the module that holds it names no storage', () => {
    const text = files.find((file) => file.path === 'platform/hub/active-hub.tsx')?.text ?? '';
    const code = text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });
});
