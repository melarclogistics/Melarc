import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { packageDirectory } from './support/package-directory';
import {
  entryFor,
  licenceTextOf,
  ownDirectory,
  SHADCN_ROOTS,
  SHADCN_SOURCE,
  treeOf,
} from './support/third-party-licences';

const require = createRequire(import.meta.url);
const APP_ROOT = resolve(import.meta.dirname, '..');
const CONFIG_FILE = resolve(APP_ROOT, 'vite.config.ts');
const REPOSITORY_ROOT = resolve(APP_ROOT, '../..');
const CONTRACT = resolve(REPOSITORY_ROOT, 'contracts/openapi.yaml');
const GENERATED_SCHEMA = resolve(REPOSITORY_ROOT, 'packages/api-client/src/generated/schema.ts');

// What the production bundle must not hold, as the contract and the generated file spell it. Schema names that
// exist nowhere but in the contract's wire types, and the dedicated Rider host the contract lists as a server.
const WIRE_TYPE_NAMES = ['PickupRequestCreate', 'HubIntakePreCount'];
const RIDER_HOST = 'api.melarc.example';

// Values that exist only in the build environment. None may ever appear in browser code. The first
// is deliberately named like a secret: a server-side variable that looks like one is not a problem,
// and must neither stop the build nor be bundled.
const SERVER_ONLY_SECRET = 'sentinel-server-only-7c41e9d2';
const API_TARGET = 'http://api-sentinel-3b8f.internal:3999';

const temporaryDirectories: string[] = [];

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ops-web-build-'));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Runs the real Vite build with the given environment, as `pnpm build` does. NODE_ENV is forced to
 * production because Vitest sets it to "test", and a build must not depend on that. The config is
 * loaded natively, as a future Vite major version will do by default, so a config that only works
 * with today's loader fails here instead of at an upgrade.
 */
async function buildApp(
  outDir: string,
  env: Record<string, string>,
  extra: { lib?: { entry: string; formats: ['es']; fileName: string } } = {},
): Promise<void> {
  const changes: Record<string, string> = { ...env, NODE_ENV: 'production' };
  const saved = Object.keys(changes).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, changes);
  try {
    await build({
      root: APP_ROOT,
      configFile: CONFIG_FILE,
      configLoader: 'native',
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true, ...extra },
    });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

/** Every file the build wrote, as text, keyed by its path inside the output directory. */
async function readOutput(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(directory, path).split(sep).join('/'), await readFile(path, 'utf8'));
  }
  return files;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('the production build', () => {
  let output = new Map<string, string>();
  let outputDirectory = '';

  beforeAll(async () => {
    outputDirectory = await freshDirectory();
    await buildApp(outputDirectory, {
      MELARC_TEST_SERVER_SECRET: SERVER_ONLY_SECRET,
      OPS_API_PROXY_TARGET: API_TARGET,
    });
    output = await readOutput(outputDirectory);
  });

  // Break caught: a page the browser cannot start from. The shell needs its root element, a language
  // for screen readers, a title, and a viewport so the layout works at narrower widths.
  it('produces a page with a root element, a language, a title and a viewport', () => {
    const html = output.get('index.html') ?? '';

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Melarc Ops Portal</title>');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('name="viewport"');
  });

  // Break caught: inline script in the page, which script-src (never relaxed) refuses, or an inline style or event handler that the shell
  // itself wrote. style-src allows inline style since 5 November 2026 (architecture/SECURITY_DESIGN.md), because the UI library inserts
  // <style> elements when it runs; the static page stays free of it by choice, so that the one relaxation is the one the library needs.
  it('loads code and styles only from files it ships, with nothing inline', () => {
    const html = output.get('index.html') ?? '';
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];

    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\ssrc="\/assets\/[^"]+\.js"/);
      expect(body).toBe('');
    }
    expect(html).toMatch(/<link\b[^>]*rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  // Break caught: the imports of tailwind.css (packages, which the build reads) left in the stylesheet it ships, where the page would have to
  // request them; or a stylesheet that reaches another origin, or takes a decision from the cascade with !important. scripts/design-tokens.test.ts lets
  // the Tailwind entry import packages because the shipped stylesheet has none, and this is where that is proved.
  it('ships stylesheets that import nothing, name no other origin and use no !important', () => {
    const sheets = [...output].filter(([name]) => name.endsWith('.css'));

    expect(sheets.length).toBeGreaterThan(0);
    for (const [name, css] of sheets) {
      expect(css, name).not.toMatch(/@import\b/i);
      expect(css, name).not.toMatch(/url\(\s*["']?(?:[a-z][a-z0-9+.-]*:)?\/\//i);
      expect(css, name).not.toMatch(/!\s*important\b/i);
    }
  });

  // Break caught: a typeface left out of the build, inlined as a data: URI (which `font-src 'self'` refuses), changed
  // on its way into the build, or shipped without its licence (DESIGN_SYSTEM section 5.1). Inter (everything people read) and
  // JetBrains Mono (operational codes) are held to the same terms.
  it('ships Inter and JetBrains Mono as their own files, unchanged, with their licences, and inlines nothing', async () => {
    const styles = [...output]
      .filter(([name]) => name.endsWith('.css'))
      .map(([, content]) => content)
      .join('\n');

    for (const source of [
      'inter-latin-wght-normal',
      'inter-latin-ext-wght-normal',
      'jetbrains-mono-latin-wght-normal',
    ]) {
      const shipped = [...output.keys()].filter((name) =>
        new RegExp(`^assets/${source}-[\\w-]+\\.woff2$`).test(name),
      );
      expect(shipped, source).toHaveLength(1);
      const [name = ''] = shipped;
      const original = await readFile(resolve(APP_ROOT, `src/assets/fonts/${source}.woff2`));
      const built = await readFile(join(outputDirectory, name));
      expect(built.equals(original), name).toBe(true);
      expect(styles, name).toContain(`/${name}`);
    }
    expect(styles).not.toMatch(/url\(\s*['"]?data:/i);
    for (const licence of ['Inter-OFL.txt', 'JetBrainsMono-OFL.txt']) {
      const original = await readFile(resolve(APP_ROOT, `public/licenses/${licence}`), 'utf8');
      expect(output.get(`licenses/${licence}`), licence).toBe(original);
      expect(original, licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
    }
  });

  // Break caught: the icons shipped without their licence (ISC asks that the notice appear in every copy, and the Feather icons Lucide
  // derives from carry an MIT notice of their own: the package's LICENSE file holds both), or a licence that is not the package's.
  it('ships the icons with the licence of the package that draws them, byte for byte', async () => {
    const packaged = await readFile(
      resolve(dirname(require.resolve('lucide-react/package.json')), 'LICENSE'),
      'utf8',
    );

    expect(output.get('licenses/Lucide-ISC.txt')).toBe(packaged);
    expect(packaged).toContain('ISC License');
    expect(packaged).toContain('Cole Bemis');
  });

  // Break caught: React Aria Components, or a package it brings that ends up in the bundle, shipped without its licence (Apache-2.0 asks that a
  // copy of the licence travel with the work, MIT that the notice does), or with a text that is not the package's own. The list of packages
  // is held to the lockfile by aria-licences.test.ts.
  it('ships React Aria Components and what it brings with their licences, byte for byte', async () => {
    const aria = packageDirectory(APP_ROOT, 'react-aria-components');
    const reactAria = packageDirectory(aria, 'react-aria');
    const wanted: readonly (readonly [string, string])[] = [
      ['React-Aria-Apache-2.0.txt', aria],
      ['swc-helpers-Apache-2.0.txt', packageDirectory(aria, '@swc/helpers')],
      ['use-sync-external-store-MIT.txt', packageDirectory(aria, 'use-sync-external-store')],
      ['clsx-MIT.txt', packageDirectory(reactAria, 'clsx')],
      ['aria-hidden-MIT.txt', packageDirectory(reactAria, 'aria-hidden')],
    ];

    for (const [file, directory] of wanted) {
      const licence = (await readdir(directory)).find((entry) => /^licen[cs]e$/i.test(entry));
      expect(licence, directory).toBeDefined();
      const packaged = await readFile(join(directory, licence ?? ''), 'utf8');
      expect(output.get(`licenses/${file}`), file).toBe(packaged);
    }
    expect(output.get('licenses/React-Aria-Apache-2.0.txt')).toContain('Apache License');
    expect(output.get('licenses/React-Aria-Apache-2.0.txt')).toContain('Version 2.0');
    expect(output.get('licenses/clsx-MIT.txt')).toContain('MIT License');
  });

  // Break caught: a library of the shadcn/ui primitives (Radix UI and what it brings, cmdk, sonner, the calendar and its date library, the table,
  // the class helpers, Tailwind CSS and its animations) shipped without its licence (MIT asks that the notice travel with the work, Apache-2.0 a
  // copy of the licence), with a text that is not the package's own, or without the licence of the registry's source, which the primitives are.
  // The list of packages is held to the lockfile by shadcn-licences.test.ts.
  it('ships the libraries of the shadcn/ui primitives with their licences, byte for byte', () => {
    const shipped = new Map<string, string>();
    for (const [name, directories] of treeOf(APP_ROOT, SHADCN_ROOTS)) {
      const file = entryFor(name);
      if (typeof file !== 'string') continue;
      for (const directory of directories) {
        expect(output.get(`licenses/${file}`), `${file} for ${name}`).toBe(
          licenceTextOf(directory),
        );
      }
      shipped.set(file, name);
    }
    expect(shipped.size).toBeGreaterThan(10);

    expect(output.get(`licenses/${SHADCN_SOURCE.file}`)).toBe(
      licenceTextOf(ownDirectory(APP_ROOT, SHADCN_SOURCE.package)),
    );
    for (const [file, text] of [
      ['Radix-UI-MIT.txt', 'WorkOS'],
      ['class-variance-authority-Apache-2.0.txt', 'Version 2.0'],
      ['Tailwind-CSS-MIT.txt', 'MIT License'],
      ['shadcn-ui-MIT.txt', 'shadcn'],
    ] as const) {
      expect(output.get(`licenses/${file}`), file).toContain(text);
    }
  });

  // Break caught: the logo inlined as a data: URI (Vite does that to any asset under 4 KiB, and this one is just under;
  // `img-src 'self'` refuses it, so the banner would show a broken image), left out of the build, or changed on its way
  // in (BRAND_FOUNDATION 4.3, 4.6: the artwork is shipped as it was supplied).
  it('ships the logo as its own file, unchanged, and inlines nothing', async () => {
    const original = await readFile(resolve(APP_ROOT, 'src/assets/brand/melarc-logo-primary.svg'));
    const shipped = [...output.keys()].filter((name) =>
      /^assets\/melarc-logo-primary-[\w-]+\.svg$/.test(name),
    );
    expect(shipped).toHaveLength(1);
    const [name = ''] = shipped;
    const built = await readFile(join(outputDirectory, name));
    expect(built.equals(original)).toBe(true);

    const scripts = [...output]
      .filter(([file]) => file.endsWith('.js'))
      .map(([, content]) => content)
      .join('\n');
    expect(scripts).toContain(`/${name}`);
    expect(scripts).not.toMatch(/data:image\/svg/i);
    expect(scripts).not.toContain('Layer_1-2');
  });

  // Break caught: the all-white lockup, which the banner draws on a dark ground (BRAND_FOUNDATION 4.7), inlined as a data: URI (it is under
  // 4 KiB too, and `img-src 'self'` refuses a data: URI, so the banner would show a broken image exactly where the black logo cannot be seen),
  // left out of the build, or changed on its way in.
  it('ships the all-white lockup as its own file, unchanged, and inlines nothing', async () => {
    const original = await readFile(resolve(APP_ROOT, 'src/assets/brand/melarc-logo-dark.svg'));
    const shipped = [...output.keys()].filter((name) =>
      /^assets\/melarc-logo-dark-[\w-]+\.svg$/.test(name),
    );
    expect(shipped).toHaveLength(1);
    const [name = ''] = shipped;
    const built = await readFile(join(outputDirectory, name));
    expect(built.equals(original)).toBe(true);

    const scripts = [...output]
      .filter(([file]) => file.endsWith('.js'))
      .map(([, content]) => content)
      .join('\n');
    expect(scripts).toContain(`/${name}`);
    expect(scripts).not.toMatch(/data:image\/svg/i);
  });

  // Break caught: the icon left out of the build (a 404 on every page, in the console), renamed with a hash so that the page's link
  // does not find it, inlined, or changed on its way in. It is copied from `public/` to the root of the output as it was supplied.
  it('ships the favicon at /favicon.svg, unchanged, and links it from the page', async () => {
    const original = await readFile(resolve(APP_ROOT, 'public/favicon.svg'), 'utf8');

    expect(output.get('favicon.svg')).toBe(original);
    expect(output.get('index.html') ?? '').toMatch(
      /<link\b[^>]*rel="icon"[^>]*href="\/favicon\.svg"|<link\b[^>]*href="\/favicon\.svg"[^>]*rel="icon"/,
    );
  });

  // Break caught: the test-only QR decoder shipping to users, which would be a second QR implementation in the bundle for
  // nothing; and the check passing because it looks for text that the library does not hold.
  it('does not contain the test-only QR decoder', async () => {
    const decoder = await readFile(resolve(APP_ROOT, 'node_modules/jsqr/dist/jsQR.js'), 'utf8');
    expect(decoder).toContain('inversionAttempts');

    for (const [name, content] of output) {
      expect(content, name).not.toContain('inversionAttempts');
      expect(content, name).not.toMatch(/jsQR/);
    }
  });

  // Break caught: the development showcase shipping to users, in its route, its code, its styles or its synthetic text.
  // `import.meta.env.DEV` is false in a production build, so they must be removed from the files and not merely hidden
  // from the navigation (COMPONENT_PATTERNS section 27).
  it('contains no trace of the development showcase', () => {
    expect(output.size).toBeGreaterThan(2);
    for (const [name, content] of output) {
      expect(name, name).not.toMatch(/showcase/i);
      expect(content, name).not.toMatch(/__showcase|showcase-|Component showcase|synthetic/i);
    }
  });

  // Break caught: the check above passing because it looks for text that is not in the showcase at all.
  it('looks for text that the showcase source really holds', async () => {
    const page = await readFile(resolve(APP_ROOT, 'src/showcase/ShowcasePage.tsx'), 'utf8');
    const styles = await readFile(resolve(APP_ROOT, 'src/showcase/showcase.css'), 'utf8');
    const routes = await readFile(resolve(APP_ROOT, 'src/app/routes.tsx'), 'utf8');

    expect(page).toContain('Component showcase');
    expect(page).toMatch(/synthetic/i);
    expect(styles).toContain('showcase-');
    expect(routes).toContain('__showcase');
  });

  // Break caught: a build-environment value, such as a credential or the address of the API, copied
  // into public JavaScript, for example by embedding process.env wholesale.
  it('contains no value that exists only in the build environment', () => {
    expect(output.size).toBeGreaterThan(2);
    for (const [name, content] of output) {
      expect(content, name).not.toContain(SERVER_ONLY_SECRET);
      expect(content, name).not.toContain('api-sentinel-3b8f');
    }
  });

  // Break caught: the browser being given an absolute address for the API, which would make the
  // session cookie and CSRF protection cross-origin. The API is only ever reached at a relative
  // /api/v1 (contracts/openapi.yaml, servers). A bare http://localhost is not matched: React Router
  // uses it as the base when it parses a relative path.
  it('contains no absolute address for the API', () => {
    for (const [name, content] of output) {
      expect(content, name).not.toMatch(
        /https?:\/\/(?:api\.[a-z0-9-]+|(?:localhost|127\.0\.0\.1|\[::1\]):\d+)/i,
      );
    }
  });
});

describe('the production build and the API client', () => {
  let script = '';

  beforeAll(async () => {
    const outDir = await freshDirectory();
    await buildApp(outDir, {});
    script = [...(await readOutput(outDir))]
      .filter(([name]) => name.endsWith('.js'))
      .map(([, content]) => content)
      .join('\n');
  });

  // Break caught: the API client left out of the shipped application, so that it could not reach the API
  // the way the contract requires: this origin's /api/v1, with the CSRF cookie echoed in X-CSRF-Token.
  it('ships the browser transport', () => {
    expect(script).toContain('/api/v1');
    expect(script).toContain('melarc_csrf');
    expect(script).toContain('X-CSRF-Token');
  });

  // Break caught: the generated wire types imported as values, which would put hundreds of kilobytes of
  // contract text into every visitor's download. They are compile-time only; these names exist nowhere
  // else, so finding one means the types were bundled.
  // Break caught: this test passing because the names it looks for no longer exist. A schema renamed in the
  // contract would leave "not found in the bundle" true for ever, whatever the bundle held. So each name is
  // first shown to be where it comes from, in the contract and as a declared schema of the generated file, and
  // only then is it looked for in the bundle.
  it('ships none of the generated wire types', async () => {
    const contract = await readFile(CONTRACT, 'utf8');
    const generated = await readFile(GENERATED_SCHEMA, 'utf8');

    for (const name of WIRE_TYPE_NAMES) {
      expect(contract, `${name} is no longer a schema of the contract`).toMatch(
        new RegExp(`^ {4}${name}:\\r?$`, 'm'),
      );
      expect(generated, `${name} is no longer a schema of the generated file`).toMatch(
        new RegExp(`^ {8}${name}: `, 'm'),
      );
      expect(script, `${name} is in the production bundle`).not.toContain(name);
    }
    expect(generated, 'the generated file no longer carries its marker').toContain(
      'GENERATED FILE - DO NOT EDIT',
    );
    expect(script).not.toContain('GENERATED FILE');
  });

  // Break caught: the contract's dedicated Rider host reaching the browser. Eight operations list it; the
  // browser transport never uses it, and its address must not be in the bundle. As above, the host is first
  // shown to be in the contract's server lists: were it renamed there, the check below would find nothing
  // whatever the bundle held. The generated file carries no server address, so it is not searched.
  it('does not contain the dedicated Rider host', async () => {
    const contract = await readFile(CONTRACT, 'utf8');

    expect(contract, 'the Rider host is no longer a server of the contract').toMatch(
      new RegExp(`^\\s+- url: https://${RIDER_HOST.replaceAll('.', '\\.')}/`, 'm'),
    );
    expect(script).not.toContain(RIDER_HOST);
  });
});

describe('the build guard', () => {
  // Break caught: a public build variable named like a credential, which ships it to every visitor.
  // The guard must stop the build before anything is written, and must not print the value.
  it('refuses to build when a VITE_ variable looks like a secret, and writes nothing', async () => {
    const outDir = await freshDirectory();

    const error = await buildApp(outDir, { VITE_PAYMENT_API_SECRET: 'value-must-not-appear' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('VITE_PAYMENT_API_SECRET');
    expect((error as Error).message).not.toContain('value-must-not-appear');
    expect(await readdir(outDir)).toEqual([]);
  });

  // Break caught: the environment exposure rule being widened, for example with envPrefix: '', which
  // would put every build-environment variable into browser code. The fixture reads one public and
  // one server-only variable; only the public one may come out.
  it('lets only VITE_ variables reach browser code', async () => {
    const outDir = await freshDirectory();

    await buildApp(
      outDir,
      { VITE_TEST_PUBLIC_FLAG: 'public-flag-5d2a', MELARC_TEST_SERVER_SECRET: SERVER_ONLY_SECRET },
      {
        lib: {
          entry: resolve(APP_ROOT, 'test/fixtures/read-env.ts'),
          formats: ['es'],
          fileName: 'probe',
        },
      },
    );

    const probe = (await readOutput(outDir)).get('probe.js') ?? '';
    expect(probe).toContain('public-flag-5d2a');
    expect(probe).not.toContain(SERVER_ONLY_SECRET);
  });
});
