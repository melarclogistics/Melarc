import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { expect, test } from '../harness/playwright.ts';

/**
 * The evidence policy of the specs that show a secret, **proved on what Playwright writes** (the audit of 11 October 2026, F06): a
 * synthetic spec puts a sentinel on a page and fails, under the real project definitions of `playwright.config.ts`, in a Playwright
 * run of its own; then every file that run left is searched for the sentinel. The sentinel is not a credential. Three runs:
 *
 * - the real configuration with a secret spec that fails, and one that tries to switch the recorders back on: nothing is recorded
 *   and the sentinel is in no file; the second fails before it starts;
 * - the real configuration with an ordinary spec that fails: the recorders keep their pictures (the check can see a leak) but the
 *   text snapshot of the page is not written;
 * - a bare configuration with the same ordinary spec: the text snapshot of the page, with the sentinel, **is** written, which is
 *   why the real configuration turns it off.
 */
const SENTINEL = 'SENTINEL-NOT-A-CREDENTIAL-5b2e9d7a';
const E2E = resolve(import.meta.dirname, '..');

// The sentinel reaches the page from the environment of the probe and is in no source file: Playwright prints the lines of a failing
// test's source into error-context.md and a trace holds the file, so a sentinel written in the source would be found there.
const PAGE = `const sentinel = process.env.PROBE_SENTINEL ?? '';
      await page.setContent('<main><h1>Recovery link</h1><p>' + sentinel + '</p><input value="' + sentinel + '"></main>');`;

const FILES: Readonly<Record<string, string>> = {
  'leak.secret.test.ts': `
    import { expect, test } from '../../harness/secret-test.ts';
    test('a secret spec that fails', async ({ page }) => {
      ${PAGE}
      expect(1).toBe(2);
    });`,
  'override.secret.test.ts': `
    import { test } from '../../harness/secret-test.ts';
    test.use({ trace: 'on', video: 'on', screenshot: 'on' });
    test('a secret spec that switches the recorders on', async ({ page }) => {
      ${PAGE}
    });`,
  'leak.spec.ts': `
    import { expect, test } from '@playwright/test';
    test('an ordinary spec that fails', async ({ page }) => {
      ${PAGE}
      expect(1).toBe(2);
    });`,
};

/** The real configuration, pointed at the folder of a probe: its projects, options and settings are the real ones. */
const REAL_CONFIG = `
  import { defineConfig } from '@playwright/test';
  import real from '../../playwright.config.ts';
  export default defineConfig({ ...real, testDir: '.', globalSetup: undefined, outputDir: './out', workers: 1, reporter: 'json' });`;

/** A configuration that applies none of the policy: what Playwright does when left alone. */
const BARE_CONFIG = `
  import { defineConfig, devices } from '@playwright/test';
  export default defineConfig({
    testDir: '.', outputDir: './out', workers: 1, reporter: 'json',
    use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    projects: [{ name: 'bare', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
  });`;

interface Outcome {
  readonly status: number | null;
  readonly report: { suites?: unknown[]; errors?: unknown[] };
  /** Every file the run wrote, relative to its output folder. */
  readonly files: string[];
  /** The files that hold the sentinel: in their bytes, or for an archive, in one of its entries. */
  readonly holding: string[];
  /** The names of the entries of every archive (a trace) that holds a picture of the page. */
  readonly pictures: string[];
  readonly text: (name: string) => string;
  /**
   * Removes the folder of the probe. Called when a test has passed: the folder holds TypeScript that the linter would read and
   * evidence a failing test needs, so it stays after a failure and goes after a pass.
   */
  readonly remove: () => void;
}

/** The entries of a zip archive (the stored and the deflated ones, which is all a trace holds). */
function zipEntries(archive: Buffer): { name: string; data: Buffer }[] {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) return [];
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const entries: { name: string; data: Buffer }[] = [];
  for (let index = 0; index < count; index += 1) {
    const method = archive.readUInt16LE(at + 10);
    const compressed = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    const start =
      offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    const raw = archive.subarray(start, start + compressed);
    entries.push({ name, data: method === 8 ? inflateRawSync(raw) : raw });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Runs Playwright in a folder of its own on the given files, and lists what it left behind. */
function probe(
  name: string,
  config: string,
  specs: readonly string[],
  environment: NodeJS.ProcessEnv,
): Outcome {
  const directory = join(E2E, 'test-results', `evidence-probe-${name}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'playwright.config.ts'), config);
  for (const spec of specs) writeFileSync(join(directory, spec), FILES[spec] ?? '');

  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  const run = spawnSync(
    process.execPath,
    [cli, 'test', '-c', join(directory, 'playwright.config.ts')],
    {
      cwd: directory,
      env: environment,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 100_000,
    },
  );
  const report = ((): Outcome['report'] => {
    try {
      return JSON.parse(run.stdout) as Outcome['report'];
    } catch {
      throw new Error(
        `the probe ${name} did not produce a report: ${run.stdout.slice(0, 400)} ${run.stderr.slice(0, 400)}`,
      );
    }
  })();
  const files: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder)) {
      const path = join(folder, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path.slice(join(directory, 'out').length + 1).replaceAll('\\', '/'));
    }
  };
  walk(join(directory, 'out'));
  // A file holds the sentinel when its bytes do, or, for an archive (a trace: JSON and resources, deflated), when one of its entries
  // does. An archive that holds a picture of the page names it: a resource that is an image, or a snapshot of the DOM.
  const holding: string[] = [];
  const pictures: string[] = [];
  for (const file of files) {
    const bytes = readFileSync(join(directory, 'out', file));
    if (file.endsWith('.zip')) {
      for (const entry of zipEntries(bytes)) {
        if (entry.data.includes(SENTINEL)) holding.push(`${file}!${entry.name}`);
        if (entry.name.startsWith('resources/') || /\.(?:png|jpe?g|webp)$/.test(entry.name)) {
          pictures.push(`${file}!${entry.name}`);
        }
      }
    } else if (bytes.includes(SENTINEL)) {
      holding.push(file);
    }
  }
  return {
    status: run.status,
    report,
    files,
    holding,
    pictures,
    text: (relative) => readFileSync(join(directory, 'out', relative), 'utf8'),
    remove: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** The environment of a probe: this one's, without what the running Playwright put there for its own workers. */
function cleanEnvironment(): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(
    ([key]) =>
      !(key.startsWith('PW_') || key.startsWith('PLAYWRIGHT_') || key === 'TEST_WORKER_INDEX'),
  );
  return { ...Object.fromEntries(kept), PROBE_SENTINEL: SENTINEL };
}

const resultsOf = (
  report: Outcome['report'],
): { title: string; status: string; error: string }[] => {
  const found: { title: string; status: string; error: string }[] = [];
  const visit = (suite: unknown): void => {
    const node = suite as {
      suites?: unknown[];
      specs?: {
        title: string;
        tests: { results: { status: string; error?: { message?: string } }[] }[];
      }[];
    };
    for (const child of node.suites ?? []) visit(child);
    for (const spec of node.specs ?? []) {
      for (const each of spec.tests) {
        const result = each.results[0];
        found.push({
          title: spec.title,
          status: result?.status ?? 'none',
          error: result?.error?.message ?? '',
        });
      }
    }
  };
  for (const suite of report.suites ?? []) visit(suite);
  return found;
};

test.describe('the evidence of a spec that shows a secret', () => {
  test.setTimeout(240_000);

  test('is not kept: no recording, no snapshot of the page, and a spec that switches the recorders on does not start', () => {
    const outcome = probe(
      'secret',
      REAL_CONFIG,
      ['leak.secret.test.ts', 'override.secret.test.ts'],
      cleanEnvironment(),
    );
    const results = resultsOf(outcome.report);

    expect(results.map((result) => `${result.title}: ${result.status}`).toSorted()).toEqual([
      'a secret spec that fails: failed',
      'a secret spec that switches the recorders on: failed',
    ]);
    // The override failed because the fixture refused it, and not on anything the page did.
    const override = results.find((result) => result.title.includes('switches the recorders on'));
    expect(override?.error).toContain('runs with trace, video, screenshot on');
    // The spec that failed on its own assertion has no recording at all.
    expect(outcome.files.filter((file) => file.startsWith('leak.secret'))).not.toContainEqual(
      expect.stringMatching(/trace\.zip$|\.png$|\.webm$/),
    );
    // And of everything either of them wrote (Playwright starts the trace of a test that asked for one before the fixture refuses it, so
    // a trace of the refusal may exist), none holds the sentinel and none holds a picture of a page.
    expect(outcome.holding).toEqual([]);
    expect(outcome.pictures).toEqual([]);
    expect(outcome.files.filter((file) => /\.(?:png|webm|jpe?g)$/.test(file))).toEqual([]);
    outcome.remove();
  });

  test('is kept by an ordinary spec as pictures and traces, but never as the text of the page', () => {
    const outcome = probe('ordinary', REAL_CONFIG, ['leak.spec.ts'], cleanEnvironment());

    // The control: the check below can see a leak, because the recorders of an ordinary failing spec do keep one.
    expect(outcome.files.some((file) => file.endsWith('trace.zip'))).toBe(true);
    expect(outcome.files.some((file) => file.endsWith('.png'))).toBe(true);
    expect(outcome.holding.some((entry) => entry.includes('trace.zip!'))).toBe(true);
    // And the text snapshot of the page is off for every spec: error-context.md holds the failure, not the page.
    const context = outcome.files.find((file) => file.endsWith('error-context.md'));
    expect(context).toBeDefined();
    expect(outcome.text(context ?? '')).not.toContain(SENTINEL);
    expect(outcome.holding.filter((entry) => entry.endsWith('error-context.md'))).toEqual([]);
    outcome.remove();
  });

  test('would be written as the text of the page by Playwright left alone, which is why the configuration turns it off', () => {
    const outcome = probe('bare', BARE_CONFIG, ['leak.spec.ts'], cleanEnvironment());

    const context = outcome.files.find((file) => file.endsWith('error-context.md'));
    expect(context).toBeDefined();
    expect(outcome.text(context ?? '')).toContain(SENTINEL);
    outcome.remove();
  });
});
