import { join } from 'node:path';

import { test as base, expect, type Page } from '@playwright/test';

import { collectFailureArtifacts } from './artifacts.ts';
import { readCaptured, type CapturedAttempt } from './capture.ts';
import { guardBrowserContext } from './browser-guard.ts';
import { artifactSourceOf, connectionFromEnvironment, type StackConnection } from './connection.ts';
import { createFixtures, FIXED_INSTANT, type Fixtures } from './fixtures.ts';

/** What the sandbox refused during one test. */
export interface Sandbox {
  /** Attempts by the API process to reach something outside this machine since the test began. */
  outboundAttempts(): CapturedAttempt[];
  /** Requests the browser tried to make to any origin but the Ops one during the test. Each was aborted. */
  externalBrowserRequests(): string[];
}

interface TestFixtures {
  fixtures: Fixtures;
  externalRequests: string[];
  sandbox: Sandbox;
  failureArtifacts: undefined;
}

interface WorkerFixtures {
  stack: StackConnection;
}

/**
 * The test every integrated spec uses. On top of Playwright's own it provides:
 *
 *   stack       the running system: addresses, database, logs. Started once by global setup
 *   fixtures    deterministic data, seeded by the test's own title, so reordering tests changes nothing
 *   context     a browser context that can only reach the Ops origin: any other request, in any of its pages
 *               and any WebSocket, is aborted and recorded
 *   sandbox     what the sandbox refused, for the API process and for the browser
 *   (automatic) on failure, the logs of every process, the sandbox capture and a database summary are
 *               attached to the report, with passwords hidden
 */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  stack: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from its first argument's pattern and requires one even when there are none
    async ({}, use) => {
      await use(connectionFromEnvironment());
    },
    { scope: 'worker' },
  ],

  baseURL: async ({ stack }, use) => {
    await use(stack.origin);
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from its first argument's pattern and requires one even when there are none
  fixtures: async ({}, use, testInfo) => {
    await use(createFixtures(testInfo.titlePath.join(' > ')));
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from its first argument's pattern and requires one even when there are none
  externalRequests: async ({}, use) => {
    await use([]);
  },

  // The boundary is on the context, so it covers every page in it: the test's page and whatever it opens.
  context: async ({ context, stack, externalRequests }, use) => {
    await guardBrowserContext(context, stack.origin, (url) => externalRequests.push(url));
    await use(context);
  },

  sandbox: async ({ stack, externalRequests }, use) => {
    // The capture belongs to the whole run; a test is judged on what happened since it began.
    const before = readCaptured(stack.captureFile).length;
    await use({
      outboundAttempts: () => readCaptured(stack.captureFile).slice(before),
      externalBrowserRequests: () => [...externalRequests],
    });
  },

  failureArtifacts: [
    async ({ stack }, use, testInfo) => {
      await use(undefined);
      if (testInfo.status === testInfo.expectedStatus) return;
      const directory = testInfo.outputPath('stack-artifacts');
      for (const name of await collectFailureArtifacts(directory, artifactSourceOf(stack))) {
        await testInfo.attach(name, { path: join(directory, name) });
      }
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Makes the page's `Date` agree with the test clock: `new Date()` and `Date.now()` return the agreed moment, every
 * time, whatever the machine says. Timers keep running, so the application's own scheduling is unaffected.
 * (`clock.install` alone would only start a clock at that moment and let it run on.) Call it before the page
 * loads anything that reads the time.
 */
export async function freezeBrowserClock(
  page: Page,
  instant: string = FIXED_INSTANT,
): Promise<void> {
  await page.clock.install({ time: new Date(instant) });
  await page.clock.setFixedTime(new Date(instant));
}
