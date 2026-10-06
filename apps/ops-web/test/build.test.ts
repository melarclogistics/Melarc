import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

  beforeAll(async () => {
    const outDir = await freshDirectory();
    await buildApp(outDir, {
      MELARC_TEST_SERVER_SECRET: SERVER_ONLY_SECRET,
      OPS_API_PROXY_TARGET: API_TARGET,
    });
    output = await readOutput(outDir);
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

  // Break caught: inline script or style, which a strict Content-Security-Policy refuses unless it
  // allows 'unsafe-inline'. The policy itself is not specified yet; keeping the page free of inline
  // code means whichever policy the edge adopts does not have to weaken script-src.
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
