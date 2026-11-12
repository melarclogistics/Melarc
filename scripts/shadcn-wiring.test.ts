import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

/**
 * How shadcn/ui is wired into the Ops Portal (DESIGN_SYSTEM section 29, apps/ops-web/CLAUDE.md): the tool that adds a component, the server an
 * agent adds one through, and the one registry both draw from. A change to any of them is a decision (a component's source is code the portal
 * runs), so each is held here to what the Product Owner approved on 5 November 2026.
 */
const root = resolve(import.meta.dirname, '..');
const app = join(root, 'apps/ops-web');

const json = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe('the shadcn MCP server an agent adds a component through', () => {
  const config = json(join(root, '.mcp.json')) as {
    mcpServers?: Record<
      string,
      { type?: string; command?: string; args?: string[]; env?: unknown }
    >;
  };
  const server = config.mcpServers?.shadcn;

  it('is configured at the root of the repository', () => {
    assert.ok(server, '.mcp.json names no shadcn server');
  });

  // Break caught: the server fetched from the network at the moment it starts (`npx shadcn@latest mcp`), so that the code an agent adds
  // components with is not the version the lockfile pins and its integrity is not checked.
  it('runs the pinned shadcn package installed in the portal, and fetches nothing', () => {
    const manifest = json(join(app, 'node_modules/shadcn/package.json')) as { bin?: string };
    assert.equal(typeof manifest.bin, 'string', 'the shadcn package declares one binary');
    const { command, args = [], env } = server ?? {};
    const binary = `apps/ops-web/node_modules/shadcn/${(manifest.bin ?? '').replace(/^\.\//, '')}`;

    assert.equal(command, 'node');
    assert.deepEqual(args, [binary, 'mcp', '--cwd', 'apps/ops-web']);
    assert.ok(existsSync(join(root, binary)), 'the binary is installed');
    assert.equal(env, undefined, 'no environment, so no token or registry address');
    assert.doesNotMatch(JSON.stringify(config), /npx|@latest|https?:/);
  });
});

describe('the shadcn CLI and its configuration', () => {
  const manifest = json(join(app, 'package.json')) as {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const components = json(join(app, 'components.json')) as {
    style?: string;
    rsc?: boolean;
    tsx?: boolean;
    tailwind?: Record<string, unknown>;
    iconLibrary?: string;
    aliases?: Record<string, string>;
    registries?: Record<string, unknown>;
  };

  // Break caught: the tool floating (a caret range takes the next release unread), or the version in package.json and the one installed disagreeing
  // so that the MCP server and the CLI differ from what the lockfile says.
  it('pins shadcn exactly, as a development dependency', () => {
    const wanted = manifest.devDependencies?.shadcn;
    assert.match(wanted ?? '', /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.dependencies?.shadcn, undefined, 'the CLI is not shipped');
    const installed = json(join(app, 'node_modules/shadcn/package.json')) as { version?: string };
    assert.equal(installed.version, wanted);
  });

  // Break caught: a component added anywhere but the primitives folder (the CLI writes where components.json says), so that source from the
  // registry lands among the Melarc components; or a second style, base colour or icon family beside the approved ones.
  it('writes the primitives into components/primitives, in the new-york style over Radix, with Lucide', () => {
    const { tailwind = {}, aliases } = components;

    assert.equal(components.style, 'new-york');
    assert.equal(components.rsc, false);
    assert.equal(components.tsx, true);
    assert.equal(components.iconLibrary, 'lucide');
    assert.equal(tailwind.baseColor, 'neutral');
    assert.equal(tailwind.cssVariables, true);
    assert.equal(tailwind.prefix, '');
    assert.equal(tailwind.config, '', 'Tailwind v4 has no configuration file');
    assert.deepEqual(aliases, {
      components: '@/components',
      utils: '@/lib/utils',
      ui: '@/components/primitives',
      lib: '@/lib',
      hooks: '@/hooks',
    });
    assert.equal(tailwind.css, 'src/styles/tailwind.css');
    assert.ok(existsSync(join(app, 'src/styles/tailwind.css')), 'the stylesheet it names exists');
  });

  // Break caught: a third-party registry configured (a namespaced one, or an address), from which the CLI and the MCP server would fetch source
  // that the portal then runs. The official shadcn registry is the only source of components.
  it('names no registry but the official one', () => {
    assert.deepEqual(components.registries ?? {}, {});
  });
});
