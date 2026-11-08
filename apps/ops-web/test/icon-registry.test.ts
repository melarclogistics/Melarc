import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ICON_NAMES, ICONS } from '../src/components/ui/icon/icons';

const APP_ROOT = resolve(import.meta.dirname, '..');
const SRC = join(APP_ROOT, 'src');
const REGISTRY = join(SRC, 'components/ui/icon/icons.ts');

interface Source {
  readonly path: string;
  readonly text: string;
}

/** The application's own sources (not tests, not test support, not the dev-only showcase, which looks at the icons and decides nothing). */
function applicationSources(): Source[] {
  const found: Source[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'test-support' && entry.name !== 'showcase') walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push({ path, text: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(SRC);
  return found;
}

const relativePath = (source: Source): string => relative(SRC, source.path).replaceAll('\\', '/');

describe('the icons of the design system (DESIGN_SYSTEM section 24)', () => {
  // Break caught: a second door to the icon library, so that a screen names a picture of the library and the one family drifts. The registry
  // is the one file that imports it, and the lint rule says so too.
  it('are imported from the icon library by the registry alone', () => {
    const importing = applicationSources()
      .filter((source) => /from\s+['"]lucide-react(?:\/[^'"]*)?['"]/.test(source.text))
      .map(relativePath);

    expect(importing).toEqual(['components/ui/icon/icons.ts']);
  });

  // Break caught: a hand-drawn icon back in a component, which is a second family beside the first: an <svg> with its own paths.
  it('are the only pictures drawn as SVG in the application, apart from the QR code and what the registry draws', () => {
    const drawing = applicationSources()
      .filter((source) => /<svg\b/.test(source.text))
      .map(relativePath);

    expect(drawing).toEqual(['components/ui/qr-code/QrCode.tsx']);
  });

  // Break caught: a catalogue of icons nobody uses ("until then none is installed and no icon catalogue is built"): every name of the
  // registry is used by the application, by name, outside the registry.
  it('are used: every name of the registry is named somewhere in the application', () => {
    const others = applicationSources().filter((source) => source.path !== REGISTRY);
    const unused = ICON_NAMES.filter(
      (name) =>
        !others.some(
          (source) => source.text.includes(`'${name}'`) || source.text.includes(`"${name}"`),
        ),
    );

    expect(unused).toEqual([]);
  });

  // Break caught: a name used on a screen that the registry does not have, which would draw nothing (or throw) at run time.
  it('are only named from the registry: every name the application gives <Icon> or an icon button exists', () => {
    const named = applicationSources().flatMap((source) =>
      [...source.text.matchAll(/(?:<Icon\b[^>]*?\bname|\bicon)=["']([a-z-]+)["']/g)].map(
        (match) => match[1] ?? '',
      ),
    );
    const known = new Set<string>(Object.keys(ICONS));

    expect(named.filter((name) => !known.has(name))).toEqual([]);
  });

  it('have names that say a meaning, in lower case and hyphens', () => {
    for (const name of ICON_NAMES) expect(name).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
  });
});
