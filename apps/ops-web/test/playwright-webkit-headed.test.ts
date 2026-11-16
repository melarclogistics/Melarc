import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * WebKit is launched headed only where MELARC_WEBKIT_HEADED says so (the Product Owner's decision D-B4 of 13 November 2026): CI sets it for the jobs that hold WebKit's runs and runs them under a virtual display
 * (xvfb-run, `.github/workflows/ci.yml`), because headless WebKit stalls in the hosted runs. The value turns on WebKit's projects and no others, a developer's machine does not set it, and a value that is not one
 * the configuration knows is refused and not read as "not set". The configuration is loaded the way Playwright loads it, once for each state of the environment.
 */
const KEYS = ['MELARC_WEBKIT_HEADED', 'MELARC_BROWSERS', 'MELARC_BROWSER_SHARD'] as const;
type Key = (typeof KEYS)[number];
const kept: Readonly<Record<Key, string | undefined>> = {
  MELARC_WEBKIT_HEADED: process.env.MELARC_WEBKIT_HEADED,
  MELARC_BROWSERS: process.env.MELARC_BROWSERS,
  MELARC_BROWSER_SHARD: process.env.MELARC_BROWSER_SHARD,
};

afterEach(() => {
  for (const key of KEYS) {
    const value = kept[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

interface Project {
  readonly name: string;
  readonly use?: { readonly headless?: boolean };
}

/** The projects of the configuration for an environment that names every engine and sets only what the test says. */
async function projectsWith(headed: string | undefined): Promise<Project[]> {
  for (const key of KEYS) Reflect.deleteProperty(process.env, key);
  process.env.MELARC_BROWSERS = 'chromium,firefox,webkit';
  if (headed !== undefined) process.env.MELARC_WEBKIT_HEADED = headed;
  vi.resetModules();
  const loaded = (await import('../playwright.config.ts')) as { default: { projects?: Project[] } };
  return loaded.default.projects ?? [];
}

const named = (projects: readonly Project[], engine: string): Project[] =>
  projects.filter((project) => project.name.endsWith(`-${engine}`));

describe('the Ops Portal configuration launches WebKit headed only where MELARC_WEBKIT_HEADED says so', () => {
  // Break caught: the value read for no engine (WebKit stalls in CI again), read for every engine (Chromium and Firefox opening windows), or for some of WebKit's projects alone.
  it('turns every project of WebKit headed with 1, and no project of Chromium or Firefox', async () => {
    const projects = await projectsWith('1');
    const webkit = named(projects, 'webkit');
    expect(webkit.length).toBeGreaterThan(10);
    expect(webkit.map((project) => project.use?.headless)).toEqual(webkit.map(() => false));
    for (const engine of ['chromium', 'firefox']) {
      const others = named(projects, engine);
      expect(others.length).toBeGreaterThan(10);
      expect(others.map((project) => project.use?.headless)).toEqual(others.map(() => undefined));
    }
  });

  // Break caught: a developer's machine launching WebKit headed (a window for every spec) because the variable is empty, zero or not set.
  it.each([undefined, '', '  ', '0'])(
    'leaves every project headless when the value is %j',
    async (value) => {
      const projects = await projectsWith(value);
      expect(projects.length).toBeGreaterThan(30);
      expect(projects.filter((project) => project.use?.headless !== undefined)).toEqual([]);
    },
  );

  // Break caught: a typo that is read as "not set", so the run meant to be headed is headless and the stall is back, with nothing to say why.
  it.each(['true', 'yes', '2', 'headed'])('refuses the value %j', async (value) => {
    await expect(projectsWith(value)).rejects.toThrow(
      /MELARC_WEBKIT_HEADED is ".+", which is not a value here/,
    );
  });
});
