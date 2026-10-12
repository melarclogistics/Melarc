import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import config from '../playwright.config.ts';
import {
  NO_EVIDENCE,
  SECRET_SPECS,
  SHOWS_SECRET,
  isSecretSpec,
  recordersThatAreOn,
  withoutPageSnapshots,
} from './evidence-policy.ts';
import {
  findSecretEvidenceViolations,
  typeScriptFilesUnder,
  type SpecFile,
} from './secret-evidence.ts';

const spec = (text: string, path = 'tests/example.secret.test.ts'): SpecFile => ({ path, text });

/** A secret spec that does everything right: the one the others are variations of. */
const GOOD = `
import { expect, test } from '../harness/secret-test.ts';
// ${SHOWS_SECRET}
test('shows a recovery link', async ({ page }) => {
  await page.setContent('<p id="link">x</p>');
  await expect(page.locator('#link')).toBeVisible();
});
`;

describe('the evidence policy as data', () => {
  // Break caught: a switch that leaves one of the three recorders on, which then keeps the secret.
  it('turns the trace, the video and the screenshots off, and cannot be changed', () => {
    expect(NO_EVIDENCE).toEqual({ trace: 'off', video: 'off', screenshot: 'off' });
    expect(Object.isFrozen(NO_EVIDENCE)).toBe(true);
  });

  // Break caught: the resolved options read as strings only, so that a recorder switched on with options ({ mode: 'on' }) is missed,
  // or a shape nobody understood taken for off.
  it('reads a recorder that is on in any spelling, and an option it cannot read as on', () => {
    expect(recordersThatAreOn({ trace: 'off', video: 'off', screenshot: 'off' })).toEqual([]);
    expect(
      recordersThatAreOn({
        trace: { mode: 'off' },
        video: { mode: 'off', size: { width: 1, height: 1 } },
        screenshot: { mode: 'off', fullPage: true },
      }),
    ).toEqual([]);
    expect(recordersThatAreOn({ trace: 'on', video: 'off', screenshot: 'off' })).toEqual(['trace']);
    expect(
      recordersThatAreOn({
        trace: 'retain-on-failure',
        video: 'on-first-retry',
        screenshot: 'only-on-failure',
      }),
    ).toEqual(['trace', 'video', 'screenshot']);
    expect(recordersThatAreOn({ trace: { mode: 'on' }, video: undefined, screenshot: 7 })).toEqual([
      'trace',
      'video',
      'screenshot',
    ]);
  });

  it('recognises a secret spec by its name, at any depth', () => {
    expect(isSecretSpec('tests/a.secret.test.ts')).toBe(true);
    expect(isSecretSpec('tests/identity/deep/a.secret.test.ts')).toBe(true);
    expect(isSecretSpec('C:\\work\\tests\\a.secret.test.ts')).toBe(true);
    expect(isSecretSpec('tests/a.spec.ts')).toBe(false);
    expect(isSecretSpec('tests/secret.test.ts')).toBe(false);
    expect(isSecretSpec('tests/a.secret.test.ts.bak')).toBe(false);
  });
});

describe('the Playwright configuration', () => {
  const projects = config.projects ?? [];

  // Break caught: a secret spec that runs in the project that records (the evidence is kept in a report), or the project that does not
  // record running ordinary specs. Both projects name their specs by string literals, which the test inventory reads.
  it('runs the secret specs in a project of their own, with the recorders off, and in no other', () => {
    const normal = projects.find((project) => project.name === 'chromium');
    const secret = projects.find((project) => project.name === 'chromium-secret');

    expect(normal?.testMatch).toBe('**/*.spec.ts');
    expect(secret?.testMatch).toBe(SECRET_SPECS);
    expect(SECRET_SPECS).toBe('**/*.secret.test.ts');
    expect(secret?.use).toMatchObject(NO_EVIDENCE);
    // The ordinary project records on failure, which is what a failing ordinary test needs; the pattern of one does not match the other.
    expect(config.use?.trace).toBe('retain-on-failure');
    expect(normal?.use).not.toHaveProperty('trace');
    const secretName = 'tests/a/b.secret.test.ts';
    const ordinaryName = 'tests/a/b.spec.ts';
    expect(secretName.endsWith('.spec.ts')).toBe(false);
    expect(ordinaryName.endsWith('.secret.test.ts')).toBe(false);
    expect(projects.map((project) => project.name)).toEqual(['chromium', 'chromium-secret']);
  });

  // Break caught: the configuration leaving Playwright's page snapshot on, which writes the text of the page into error-context.md
  // whatever the recorders are set to.
  it('turns the snapshot of the page off for the runner and every worker that loads it', () => {
    expect(process.env.PLAYWRIGHT_NO_COPY_PROMPT).toBe('1');
    const environment: NodeJS.ProcessEnv = {};
    withoutPageSnapshots(environment);
    expect(environment.PLAYWRIGHT_NO_COPY_PROMPT).toBe('1');
  });
});

describe('a spec that shows a secret', () => {
  it('is accepted when it imports the secret base and records nothing', () => {
    expect(findSecretEvidenceViolations([spec(GOOD)])).toEqual([]);
  });

  // Break caught: the three ways round the old check, which looked for the text test.use(NO_EVIDENCE) and accepted it in a string, with
  // a locally defined object that records, and followed by an override that records.
  it.each([
    [
      'the switch named in a string',
      `import { test } from '@playwright/test';\nconst note = 'test.use(NO_EVIDENCE)';\ntest('x', async () => {});`,
    ],
    [
      'a local object of the same name that records',
      `import { test } from '@playwright/test';\nconst NO_EVIDENCE = { trace: 'on' };\ntest.use(NO_EVIDENCE);\ntest('x', async () => {});`,
    ],
    [
      'the recorders turned off and then on again',
      `import { test } from '../harness/secret-test.ts';\ntest.use({ trace: 'off' });\ntest.use({ trace: 'on', video: 'on' });\ntest('x', async () => {});`,
    ],
  ])('is refused when it gets round the old check by %s', (_label, text) => {
    expect(findSecretEvidenceViolations([spec(text)]).length).toBeGreaterThan(0);
  });

  it.each([
    [
      'the test of Playwright',
      `import { test, expect } from '@playwright/test';\ntest('x', () => {});`,
    ],
    ['the whole of Playwright', `import * as pw from '@playwright/test';\npw.test('x', () => {});`],
    ['a default import of playwright', `import pw from 'playwright';\npw.chromium.launch();`],
  ])('is refused when it takes %s instead of the secret base', (_label, text) => {
    const violations = findSecretEvidenceViolations([spec(text)]);
    expect(violations.join('\n')).toContain('imports test from Playwright');
    expect(violations.join('\n')).toContain('does not import test from the secret base');
  });

  it('may take expect from Playwright and test from the secret base', () => {
    expect(
      findSecretEvidenceViolations([
        spec(
          `import { expect } from '@playwright/test';\nimport { test } from '../harness/secret-test.ts';\ntest('x', () => {});`,
        ),
      ]),
    ).toEqual([]);
  });

  // Break caught: a secret spec that attaches or records by hand what the project switched off: an attachment is a file in the report.
  it.each([
    ['attaches to the report', `testInfo.attach('link', { body: link });`],
    ['takes a screenshot', `await page.screenshot({ path: 'a.png' });`],
    ['takes a screenshot by a string', `await page['screenshot']();`],
    ['starts a trace', `await context.tracing.start({ screenshots: true });`],
    ['records a video', `const context = await browser.newContext({ recordVideo: { dir: 'v' } });`],
    [
      'records a HAR',
      `const context = await browser.newContext({ recordHar: { path: 'a.har' } });`,
    ],
    ['prints a page', `await page.pdf();`],
    ['compares a screenshot', `await expect(page).toHaveScreenshot();`],
    [
      'reads the page as an ARIA snapshot',
      `const tree = await page.locator('main').ariaSnapshot();`,
    ],
    ['changes its own options', `test.use({ trace: 'on' });`],
    ['changes its own options by a string', `test['use']({ trace: 'on' });`],
    ['loads a module dynamically', `const pw = await import('@playwright/test');`],
    ['loads a module with require', `const pw = require('@playwright/test');`],
  ])('is refused when it %s', (_label, statement) => {
    const text = `import { expect, test } from '../harness/secret-test.ts';\n// ${SHOWS_SECRET}\ntest('x', async ({ page }, testInfo) => {\n  ${statement}\n});`;

    expect(findSecretEvidenceViolations([spec(text)]).length).toBeGreaterThan(0);
  });

  // Break caught: a mention taken for the thing: the check reads syntax, so a comment, a string and a name that only contains the word
  // are not calls.
  it('is not refused for a comment, a string or a longer name that mentions what it may not do', () => {
    const text = `import { expect, test } from '../harness/secret-test.ts';
// we never call page.screenshot() or test.use() here, and never attach anything
test('the log says "screenshot" and "video" but takes none', async ({ page }) => {
  const videoOfTheDay = 1;
  const screenshotsTaken = 0;
  expect(videoOfTheDay + screenshotsTaken).toBe(1);
});`;

    expect(findSecretEvidenceViolations([spec(text)])).toEqual([]);
  });

  // Break caught: a declared secret in a file that the project that records would run.
  it('must be named as one: a file that declares a secret and is not is refused, at any depth', () => {
    expect(
      findSecretEvidenceViolations([
        spec(`// ${SHOWS_SECRET}\ntest('x', async () => {});`, 'tests/enrol.spec.ts'),
        spec(`test('title ${SHOWS_SECRET}', async () => {});`, 'tests/identity/deep/enrol.spec.ts'),
      ]),
    ).toEqual([
      `tests/enrol.spec.ts declares a secret (${SHOWS_SECRET}) and is not named <name>.secret.test.ts: it would run in the project that records evidence`,
      `tests/identity/deep/enrol.spec.ts declares a secret (${SHOWS_SECRET}) and is not named <name>.secret.test.ts: it would run in the project that records evidence`,
    ]);
  });

  it('has nothing to say about a file that shows none', () => {
    expect(
      findSecretEvidenceViolations([
        spec("test('loads the shell', async () => {});", 'tests/a.spec.ts'),
      ]),
    ).toEqual([]);
  });
});

describe('finding the specs', () => {
  let root = '';
  afterEach(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true });
    root = '';
  });

  // Break caught: only the files directly in tests/ read, so that a spec in a folder is never checked.
  it('reads every TypeScript file at any depth, and nothing else', () => {
    root = mkdtempSync(join(tmpdir(), 'melarc-specs-'));
    mkdirSync(join(root, 'identity', 'deep'), { recursive: true });
    writeFileSync(join(root, 'a.spec.ts'), 'a');
    writeFileSync(join(root, 'identity', 'b.secret.test.ts'), 'b');
    writeFileSync(join(root, 'identity', 'deep', 'c.spec.ts'), 'c');
    writeFileSync(join(root, 'identity', 'notes.md'), 'd');

    expect(
      typeScriptFilesUnder(root)
        .map((file) => file.path)
        .toSorted(),
    ).toEqual(['a.spec.ts', 'identity/b.secret.test.ts', 'identity/deep/c.spec.ts']);
  });
});

describe('the specs as they are', () => {
  it('hold to the policy, at any depth', () => {
    const directory = resolve(import.meta.dirname, '..', 'tests');
    const files = typeScriptFilesUnder(directory).map((file) => ({
      ...file,
      path: `tests/${file.path}`,
    }));

    expect(files.length).toBeGreaterThan(0);
    expect(findSecretEvidenceViolations(files)).toEqual([]);
    // And at least one spec runs in the project that has the recorders off, so that the project is not empty.
    expect(files.some((file) => isSecretSpec(file.path))).toBe(true);
  });
});
