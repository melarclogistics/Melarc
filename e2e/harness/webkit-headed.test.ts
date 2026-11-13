import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * WebKit is launched headed only where MELARC_WEBKIT_HEADED says so (the Product Owner's decision D-B4 of 13 November 2026): CI sets it for the jobs that hold WebKit's runs and runs them under a virtual display
 * (xvfb-run, `.github/workflows/ci.yml`), because headless WebKit stalls in the hosted runs. The value turns on the projects of WebKit's HTTPS runs and no others (Chromium, Firefox, the plain projects and the
 * branded browsers stay as they are), a developer's machine does not set it, and a value that is not one the configuration knows is refused and not read as "not set". The configuration is loaded the way
 * Playwright loads it, once for each state of the environment.
 */
const KEY = 'MELARC_WEBKIT_HEADED';
const kept = process.env[KEY];

afterEach(() => {
  if (kept === undefined) Reflect.deleteProperty(process.env, KEY);
  else process.env[KEY] = kept;
});

interface Project {
  readonly name: string;
  readonly use?: { readonly headless?: boolean };
}

async function projectsWith(headed: string | undefined): Promise<Project[]> {
  Reflect.deleteProperty(process.env, KEY);
  if (headed !== undefined) process.env[KEY] = headed;
  vi.resetModules();
  const loaded = (await import('../playwright.config.ts')) as { default: { projects?: Project[] } };
  return loaded.default.projects ?? [];
}

const WEBKIT_PROJECTS = ['https-webkit-control', 'https-webkit', 'https-webkit-secret'];

describe('the integrated harness configuration launches WebKit headed only where MELARC_WEBKIT_HEADED says so', () => {
  // Break caught: the value read for none of WebKit's HTTPS projects (the stall is back), for only some (the refusal is headless and the proofs are headed, or the reverse), or for another engine's.
  it('turns the three projects of WebKit headed with 1, and no other project', async () => {
    const projects = await projectsWith('1');
    expect(
      projects.filter((project) => project.name.startsWith('https-webkit')).map((p) => p.name),
    ).toEqual(WEBKIT_PROJECTS);
    for (const project of projects) {
      expect(project.use?.headless, project.name).toBe(
        WEBKIT_PROJECTS.includes(project.name) ? false : undefined,
      );
    }
    // The other engines are there to be told apart from.
    expect(projects.map((project) => project.name)).toEqual(
      expect.arrayContaining([
        'chromium',
        'https-chromium',
        'https-firefox',
        'https-chrome',
        'https-msedge',
      ]),
    );
  });

  // Break caught: a developer's machine launching WebKit headed because the variable is empty, zero or not set.
  it.each([undefined, '', '  ', '0'])(
    'leaves every project headless when the value is %j',
    async (value) => {
      const projects = await projectsWith(value);
      expect(projects.length).toBeGreaterThan(8);
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
